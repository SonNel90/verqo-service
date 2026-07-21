/**
 * predictions.js — v3: dual-pool orchestration
 * V1 pool keeps settling its legacy markets. ALL new markets register on V2:
 * creator-bound, multi-outcome, fixed threshold, 3h grace, deadline pause.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { createWalletClient, createPublicClient, http, keccak256, encodePacked, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { ADDRESSES, conditionalTokensAbi } from "./contracts.js";

const V1_POOL = "0x4490fc42C128340eBaa3a9F86e49FF8e38DCa9e7";
const V2_POOL = "0x1648015321d7D948BA48afb590C2484Ce94A9Cd4";
const GRACE_S = 3 * 3600;
const SPLIT = 8; // outcome code for split resolutions

const v1Abi = [
  { name: "settle", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { name: "launchInfo", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "uint64" }, { type: "address" }, { type: "uint256" }] },
  { name: "graduate", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
];
const v2Abi = [
  { name: "createLaunch", type: "function", stateMutability: "nonpayable", inputs: [{ name: "questionId", type: "bytes32" }, { name: "deadline", type: "uint64" }, { name: "outcomeCount", type: "uint8" }, { name: "creator", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "graduate", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { name: "settle", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { name: "pauseAtDeadline", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { name: "graduationThreshold", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "launches", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [
    { name: "questionId", type: "bytes32" }, { name: "conditionId", type: "bytes32" }, { name: "creator", type: "address" },
    { name: "deadline", type: "uint64" }, { name: "thresholdAt", type: "uint64" }, { name: "outcomeCount", type: "uint8" },
    { name: "status", type: "uint8" }, { name: "totalDeposits", type: "uint256" }, { name: "market", type: "address" },
    { name: "payoutPool", type: "uint256" }, { name: "settledDeposits", type: "uint256" }] },
  { name: "LaunchCreated", type: "event", inputs: [{ name: "launchId", type: "uint256", indexed: true }, { name: "questionId", type: "bytes32", indexed: false }, { name: "creator", type: "address", indexed: true }, { name: "deadline", type: "uint64", indexed: false }, { name: "outcomeCount", type: "uint8", indexed: false }] },
];
const numAbi = [{ name: "payoutNumerators", type: "function", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint256" }], outputs: [{ type: "uint256" }] }];

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { global: { fetch }, realtime: { transport: ws } });
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(process.env.RPC_URL || "https://sepolia.base.org") });
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(process.env.RPC_URL || "https://sepolia.base.org") });
const qid = (id) => keccak256(encodePacked(["string"], [`verqo-prediction-${id}`]));

async function createLaunches() {
  const { data: rows, error } = await supabase.from("predictions")
    .select("id, question, ends_at, creator_address, outcome_count").eq("status", "LAUNCHING").is("launch_id", null);
  if (error) return console.error("[LAUNCH] fetch:", error.message);
  for (const p of rows || []) {
    try {
      const deadline = BigInt(Math.floor(new Date(p.ends_at).getTime() / 1000));
      if (deadline <= BigInt(Math.floor(Date.now() / 1000)) + 1800n) {
        await supabase.from("predictions").update({ status: "INVALID" }).eq("id", p.id); continue;
      }
      const n = Math.min(8, Math.max(2, p.outcome_count || 2));
      console.log(`▶ [LAUNCH v2] createLaunch #${p.id} (${n} outcomes): "${p.question}"`);
      const hash = await walletClient.writeContract({ address: V2_POOL, abi: v2Abi, functionName: "createLaunch",
        args: [qid(p.id), deadline, n, p.creator_address] });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("createLaunch failed");
      let launchId = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== V2_POOL.toLowerCase()) continue;
        try { const ev = decodeEventLog({ abi: v2Abi, data: log.data, topics: log.topics });
          if (ev.eventName === "LaunchCreated") { launchId = ev.args.launchId; break; } } catch {}
      }
      if (launchId === null) throw new Error("LaunchCreated not found");
      await supabase.from("predictions").update({ question_id: qid(p.id), launch_id: Number(launchId), pool_version: 2 }).eq("id", p.id);
      console.log(`  ✓ v2 launch ${launchId} (tx: ${hash})`);
    } catch (e) { console.error(`✗ [LAUNCH] #${p.id}:`, e.message); }
  }
}

let cachedThreshold = null;
async function superviseLaunches() {
  const { data: rows, error } = await supabase.from("predictions")
    .select("id, launch_id, ends_at, outcome_count, pool_version").eq("status", "LAUNCHING").not("launch_id", "is", null);
  if (error) return console.error("[LAUNCH] fetch:", error.message);
  for (const p of rows || []) {
    try {
      if ((p.pool_version ?? 1) === 2) {
        if (cachedThreshold === null) cachedThreshold = await publicClient.readContract({ address: V2_POOL, abi: v2Abi, functionName: "graduationThreshold" });
        const L = await publicClient.readContract({ address: V2_POOL, abi: v2Abi, functionName: "launches", args: [BigInt(p.launch_id)] });
        const [, , , deadline, thresholdAt, outcomeCount, status, total, market] = L;
        const now = Math.floor(Date.now() / 1000);
        if (Number(status) === 2 && market !== "0x0000000000000000000000000000000000000000") {
          const conditionId = await publicClient.readContract({ address: ADDRESSES.conditionalTokens, abi: conditionalTokensAbi, functionName: "getConditionId", args: [account.address, qid(p.id), BigInt(outcomeCount)] });
          await supabase.from("predictions").update({ market_address: market, condition_id: conditionId, status: "LIVE" }).eq("id", p.id);
          console.log(`[LAUNCH v2] ${p.launch_id} LIVE — ${market}`); continue;
        }
        // Auto-graduate only AFTER the creator's 3h window
        if (Number(status) === 1 && total >= cachedThreshold && Number(thresholdAt) > 0 && now >= Number(thresholdAt) + GRACE_S && now < Number(deadline)) {
          console.log(`▶ [LAUNCH v2] ${p.launch_id} grace over — graduating...`);
          const h = await walletClient.writeContract({ address: V2_POOL, abi: v2Abi, functionName: "graduate", args: [BigInt(p.launch_id)] });
          await publicClient.waitForTransactionReceipt({ hash: h }); continue;
        }
        if (now >= Number(deadline) && Number(status) === 1) {
          await supabase.from("predictions").update({ status: "INVALID" }).eq("id", p.id);
          console.log(`[LAUNCH v2] ${p.launch_id} expired — INVALID.`);
        }
      } else {
        const info = await publicClient.readContract({ address: V1_POOL, abi: v1Abi, functionName: "launchInfo", args: [BigInt(p.launch_id)] });
        const [status, total, threshold] = info; const market = info[4];
        if (Number(status) === 1 && total >= threshold) {
          const h = await walletClient.writeContract({ address: V1_POOL, abi: v1Abi, functionName: "graduate", args: [BigInt(p.launch_id)] });
          await publicClient.waitForTransactionReceipt({ hash: h }); continue;
        }
        if (Number(status) === 2 && market !== "0x0000000000000000000000000000000000000000") {
          const conditionId = await publicClient.readContract({ address: ADDRESSES.conditionalTokens, abi: conditionalTokensAbi, functionName: "getConditionId", args: [account.address, qid(p.id), 2n] });
          await supabase.from("predictions").update({ market_address: market, condition_id: conditionId, status: "LIVE" }).eq("id", p.id); continue;
        }
        if (new Date(p.ends_at).getTime() <= Date.now() && Number(status) === 1) {
          await supabase.from("predictions").update({ status: "INVALID" }).eq("id", p.id);
        }
      }
    } catch (e) { console.error(`✗ [LAUNCH] supervise #${p.id}:`, e.message); }
  }
}

async function pauseEndedMarkets() {
  const { data: rows, error } = await supabase.from("predictions")
    .select("id, launch_id, ends_at").eq("status", "LIVE").eq("pool_version", 2).is("paused_at", null).not("launch_id", "is", null);
  if (error) return console.error("[PAUSE] fetch:", error.message);
  for (const p of rows || []) {
    if (new Date(p.ends_at).getTime() > Date.now()) continue;
    try {
      const h = await walletClient.writeContract({ address: V2_POOL, abi: v2Abi, functionName: "pauseAtDeadline", args: [BigInt(p.launch_id)] });
      await publicClient.waitForTransactionReceipt({ hash: h });
      await supabase.from("predictions").update({ paused_at: new Date().toISOString() }).eq("id", p.id);
      console.log(`[PAUSE] #${p.id} trading paused on-chain.`);
    } catch (e) {
      if (/paused|invalid.*stage|revert/i.test(e.message || "")) {
        await supabase.from("predictions").update({ paused_at: new Date().toISOString() }).eq("id", p.id);
      } else console.error(`✗ [PAUSE] #${p.id}:`, e.message);
    }
  }
}

async function checkResolvedPredictions() {
  const { data: rows, error } = await supabase.from("predictions")
    .select("id, condition_id, launch_id, outcome_count, pool_version").eq("status", "LIVE").not("condition_id", "is", null);
  if (error) return console.error("[PREDICTION] fetch:", error.message);
  for (const p of rows || []) {
    try {
      const denom = await publicClient.readContract({ address: ADDRESSES.conditionalTokens, abi: conditionalTokensAbi, functionName: "payoutDenominator", args: [p.condition_id] });
      if (denom === 0n) continue;
      const n = Math.min(8, Math.max(2, p.outcome_count || 2));
      const pays = [];
      for (let i = 0; i < n; i++) pays.push(await publicClient.readContract({ address: ADDRESSES.conditionalTokens, abi: numAbi, functionName: "payoutNumerators", args: [p.condition_id, BigInt(i)] }));
      const winners = pays.map((v, i) => [v, i]).filter(([v]) => v === denom);
      const outcome = winners.length === 1 ? winners[0][1] : SPLIT;
      await supabase.from("predictions").update({ status: "RESOLVED", outcome, resolved_at: new Date().toISOString() }).eq("id", p.id);
      console.log(`[PREDICTION] #${p.id} resolved → ${outcome === SPLIT ? "SPLIT" : `outcome ${outcome}`}.`);
      if (p.launch_id != null) {
        try {
          const pool = (p.pool_version ?? 1) === 2 ? V2_POOL : V1_POOL;
          const abi = (p.pool_version ?? 1) === 2 ? v2Abi : v1Abi;
          const h = await walletClient.writeContract({ address: pool, abi, functionName: "settle", args: [BigInt(p.launch_id)] });
          await publicClient.waitForTransactionReceipt({ hash: h });
          console.log(`  ✓ settled — LP claims open.`);
        } catch (e) { if (!/not graduated/i.test(e.message || "")) console.error(`  settle #${p.launch_id}:`, e.message); }
      }
    } catch (e) { console.error(`✗ [PREDICTION] #${p.id}:`, e.message); }
  }
}

export async function run() {
  await createLaunches();
  await superviseLaunches();
  await pauseEndedMarkets();
  await checkResolvedPredictions();
}