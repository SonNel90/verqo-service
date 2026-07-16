/**
 * predictions.js — Phase A.5: launch-pool edition
 *
 * The old v1 funded every market directly. Now user-created markets go
 * through the VerqoLaunchPool bootstrap:
 *
 *   1. createLaunches():   new DB row (LAUNCHING, no launch_id) →
 *                          pool.createLaunch(questionId, deadline) →
 *                          save launch_id + question_id.
 *   2. superviseLaunches(): for each LAUNCHING row with a launch_id:
 *        - threshold reached on-chain → call pool.graduate() →
 *          save market_address + condition_id, flip status → LIVE
 *        - deadline passed without graduating → flip status → INVALID
 *          (depositors self-serve refunds via claimRefund)
 *   3. checkResolvedPredictions(): LIVE rows whose condition the oracle
 *      wallet has resolved → flip status → RESOLVED + outcome, then call
 *      pool.settle() so LP claims unlock immediately.
 *
 * Self-contained on purpose — contracts.js stays untouched.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import {
  createWalletClient,
  createPublicClient,
  http,
  keccak256,
  encodePacked,
  decodeEventLog,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { ADDRESSES, conditionalTokensAbi } from "./contracts.js";

// ── VerqoLaunchPool (deployed 2026-07-14, Base Sepolia) ─────────────────────
const LAUNCH_POOL = "0x4490fc42C128340eBaa3a9F86e49FF8e38DCa9e7";

const launchPoolAbi = [
  { name: "createLaunch", type: "function", stateMutability: "nonpayable", inputs: [{ name: "questionId", type: "bytes32" }, { name: "deadline", type: "uint64" }], outputs: [{ type: "uint256" }] },
  { name: "graduate", type: "function", stateMutability: "nonpayable", inputs: [{ name: "launchId", type: "uint256" }], outputs: [] },
  { name: "settle", type: "function", stateMutability: "nonpayable", inputs: [{ name: "launchId", type: "uint256" }], outputs: [] },
  { name: "launchInfo", type: "function", stateMutability: "view", inputs: [{ name: "launchId", type: "uint256" }], outputs: [{ name: "status", type: "uint8" }, { name: "totalDeposits", type: "uint256" }, { name: "threshold", type: "uint256" }, { name: "deadline", type: "uint64" }, { name: "market", type: "address" }, { name: "payoutPool", type: "uint256" }] },
  { name: "LaunchCreated", type: "event", inputs: [{ name: "launchId", type: "uint256", indexed: true }, { name: "questionId", type: "bytes32", indexed: false }, { name: "deadline", type: "uint64", indexed: false }] },
];

const payoutNumeratorsAbi = [
  { name: "payoutNumerators", type: "function", stateMutability: "view", inputs: [{ name: "conditionId", type: "bytes32" }, { name: "index", type: "uint256" }], outputs: [{ type: "uint256" }] },
];

// Pool status enum: 0 NONE, 1 LAUNCHING, 2 GRADUATED, 3 SETTLED, 4 FAILED
const POOL = { LAUNCHING: 1, GRADUATED: 2, SETTLED: 3, FAILED: 4 };

// ── Clients (same setup as deployMarkets.js, incl. the ws transport fix) ────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { global: { fetch }, realtime: { transport: ws } }
);
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(process.env.RPC_URL || "https://sepolia.base.org") });
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(process.env.RPC_URL || "https://sepolia.base.org") });

// ── 1. Register new predictions as launches ──────────────────────────────────
async function createLaunches() {
  const { data: rows, error } = await supabase
    .from("predictions")
    .select("id, question, ends_at")
    .eq("status", "LAUNCHING")
    .is("launch_id", null);
  if (error) return console.error("[LAUNCH] fetch error:", error.message);
  if (!rows?.length) return;

  console.log(`[LAUNCH] ${rows.length} launch(es) to register on-chain.`);
  for (const p of rows) {
    try {
      const deadline = BigInt(Math.floor(new Date(p.ends_at).getTime() / 1000));
      // Contract requires deadline > now + 30 min; the API enforces ≥ 1h,
      // but guard against clock drift anyway.
      if (deadline <= BigInt(Math.floor(Date.now() / 1000)) + 1800n) {
        console.log(`[LAUNCH] ${p.id} deadline too soon — marking INVALID.`);
        await supabase.from("predictions").update({ status: "INVALID" }).eq("id", p.id);
        continue;
      }
      const questionId = keccak256(encodePacked(["string"], [`verqo-prediction-${p.id}`]));
      console.log(`▶ [LAUNCH] createLaunch for prediction ${p.id}: "${p.question}"`);
      const hash = await walletClient.writeContract({
        address: LAUNCH_POOL, abi: launchPoolAbi, functionName: "createLaunch",
        args: [questionId, deadline],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("createLaunch tx failed");

      // Pull the launchId from the LaunchCreated event
      let launchId = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== LAUNCH_POOL.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({ abi: launchPoolAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "LaunchCreated") { launchId = ev.args.launchId; break; }
        } catch { /* not our event */ }
      }
      if (launchId === null) throw new Error("LaunchCreated event not found in receipt");

      const { error: upErr } = await supabase
        .from("predictions")
        .update({ question_id: questionId, launch_id: Number(launchId) })
        .eq("id", p.id);
      if (upErr) throw new Error(upErr.message);
      console.log(`  ✓ launch ${launchId} registered (tx: ${hash})`);
    } catch (e) {
      console.error(`✗ [LAUNCH] createLaunch failed for ${p.id}:`, e.message);
    }
  }
}

// ── 2. Graduate full pools / invalidate expired ones ─────────────────────────
async function superviseLaunches() {
  const { data: rows, error } = await supabase
    .from("predictions")
    .select("id, launch_id, ends_at")
    .eq("status", "LAUNCHING")
    .not("launch_id", "is", null);
  if (error) return console.error("[LAUNCH] fetch error:", error.message);
  if (!rows?.length) return;

  for (const p of rows) {
    try {
      const info = await publicClient.readContract({
        address: LAUNCH_POOL, abi: launchPoolAbi, functionName: "launchInfo",
        args: [BigInt(p.launch_id)],
      });
      const [status, totalDeposits, threshold] = info;
      const market = info[4];

      if (Number(status) === POOL.LAUNCHING && totalDeposits >= threshold) {
        console.log(`▶ [LAUNCH] ${p.launch_id} hit threshold — graduating...`);
        const hash = await walletClient.writeContract({
          address: LAUNCH_POOL, abi: launchPoolAbi, functionName: "graduate",
          args: [BigInt(p.launch_id)],
        });
        const r = await publicClient.waitForTransactionReceipt({ hash });
        if (r.status !== "success") throw new Error("graduate tx failed");
        console.log(`  ✓ graduated (tx: ${hash})`);
        continue; // next tick reads the fresh state and records the market
      }

      if (Number(status) === POOL.GRADUATED && market !== "0x0000000000000000000000000000000000000000") {
        // conditionId is deterministic: oracle = this wallet, 2 outcomes
        const questionId = keccak256(encodePacked(["string"], [`verqo-prediction-${p.id}`]));
        const conditionId = await publicClient.readContract({
          address: ADDRESSES.conditionalTokens, abi: conditionalTokensAbi,
          functionName: "getConditionId", args: [account.address, questionId, 2n],
        });
        const { error: upErr } = await supabase
          .from("predictions")
          .update({ market_address: market, condition_id: conditionId, status: "LIVE" })
          .eq("id", p.id);
        if (upErr) throw new Error(upErr.message);
        console.log(`[LAUNCH] ${p.launch_id} recorded LIVE — market ${market}`);
        continue;
      }

      // Deadline passed, never graduated → INVALID (refunds self-serve on-chain)
      if (new Date(p.ends_at).getTime() <= Date.now() && Number(status) === POOL.LAUNCHING) {
        await supabase.from("predictions").update({ status: "INVALID" }).eq("id", p.id);
        console.log(`[LAUNCH] ${p.launch_id} expired below threshold — INVALID (refunds open).`);
      }
    } catch (e) {
      console.error(`✗ [LAUNCH] supervise failed for ${p.id}:`, e.message);
    }
  }
}

// ── 3. Detect oracle resolutions → RESOLVED, then settle the pool ────────────
async function checkResolvedPredictions() {
  const { data: rows, error } = await supabase
    .from("predictions")
    .select("id, condition_id, launch_id")
    .eq("status", "LIVE")
    .not("condition_id", "is", null);
  if (error) return console.error("[PREDICTION] fetch error:", error.message);
  if (!rows?.length) return;

  for (const p of rows) {
    try {
      const denom = await publicClient.readContract({
        address: ADDRESSES.conditionalTokens, abi: conditionalTokensAbi,
        functionName: "payoutDenominator", args: [p.condition_id],
      });
      if (denom === 0n) continue;

      const pay0 = await publicClient.readContract({
        address: ADDRESSES.conditionalTokens, abi: payoutNumeratorsAbi,
        functionName: "payoutNumerators", args: [p.condition_id, 0n],
      });
      const outcome = pay0 === denom ? 0 : 1;

      const { error: upErr } = await supabase
        .from("predictions")
        .update({ status: "RESOLVED", outcome, resolved_at: new Date().toISOString() })
        .eq("id", p.id);
      if (upErr) throw new Error(upErr.message);
      console.log(`[PREDICTION] ${p.id} resolved → ${outcome === 0 ? "YES" : "NO"} won.`);

      // Unlock LP claims right away (idempotent: reverts once settled — ignored)
      if (p.launch_id != null) {
        try {
          const hash = await walletClient.writeContract({
            address: LAUNCH_POOL, abi: launchPoolAbi, functionName: "settle",
            args: [BigInt(p.launch_id)],
          });
          await publicClient.waitForTransactionReceipt({ hash });
          console.log(`  ✓ launch ${p.launch_id} settled — LP claims open (tx: ${hash})`);
        } catch (e) {
          if (!/not graduated/i.test(e.message || "")) console.error(`  settle failed for ${p.launch_id}:`, e.message);
        }
      }
    } catch (e) {
      console.error(`✗ [PREDICTION] resolve-check failed for ${p.id}:`, e.message);
    }
  }
}

export async function run() {
  await createLaunches();
  await superviseLaunches();
  await checkResolvedPredictions();
}