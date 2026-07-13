/**
 * predictions.js — Phase A: user-created prediction markets
 *
 * Job 1 (deployPredictions): finds rows in `predictions` with status
 *   LAUNCHING, deploys a condition + LMSR market for each (same flow as
 *   deployMarkets.js uses for battles), writes back question_id /
 *   condition_id / market_address, and flips status → LIVE.
 *
 * Job 2 (checkResolvedPredictions): finds LIVE predictions and checks the
 *   chain — once the oracle wallet has called reportPayouts (from the
 *   frontend resolve panel), payoutDenominator > 0. The service then reads
 *   which outcome won and flips status → RESOLVED with the outcome saved.
 *
 * Deliberately self-contained: duplicates the deploy steps from
 * deployMarkets.js rather than modifying that working file. If the deploy
 * flow ever changes, change it in both places.
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
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  ADDRESSES,
  factoryAbi,
  conditionalTokensAbi,
  mockUsdcAbi,
  FEE_2PCT,
  INITIAL_FUNDING,
} from "./contracts.js";

// payoutNumerators isn't in contracts.js — declared locally so that file
// stays untouched.
const payoutNumeratorsAbi = [
  {
    name: "payoutNumerators",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "conditionId", type: "bytes32" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
];

// ── Clients (same setup as deployMarkets.js, incl. the ws transport fix) ────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { global: { fetch }, realtime: { transport: ws } }
);

const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.RPC_URL || "https://sepolia.base.org"),
});

const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(process.env.RPC_URL || "https://sepolia.base.org"),
});

// ── Deploy one prediction market ─────────────────────────────────────────────
async function deployMarketForPrediction(p) {
  console.log(`\n▶ [PREDICTION] Deploying market for prediction ${p.id}: "${p.question}"`);

  // 1. Unique questionId — NOTE the prediction-specific prefix, so a
  //    prediction can never collide with a battle's questionId.
  const questionId = keccak256(
    encodePacked(["string"], [`verqo-prediction-${p.id}`])
  );
  console.log(`  questionId: ${questionId}`);

  // 2. Deterministic conditionId
  const conditionId = await publicClient.readContract({
    address: ADDRESSES.conditionalTokens,
    abi: conditionalTokensAbi,
    functionName: "getConditionId",
    args: [account.address, questionId, 2n],
  });
  console.log(`  conditionId: ${conditionId}`);

  // 3. Prepare condition (idempotent — reverts if already prepared)
  console.log("  Preparing condition...");
  try {
    const prepHash = await walletClient.writeContract({
      address: ADDRESSES.conditionalTokens,
      abi: conditionalTokensAbi,
      functionName: "prepareCondition",
      args: [account.address, questionId, 2n],
    });
    await publicClient.waitForTransactionReceipt({ hash: prepHash });
    console.log(`  ✓ Condition prepared (tx: ${prepHash})`);
  } catch (e) {
    if (/already prepared|already exists/i.test(e.message || "")) {
      console.log("  ✓ Condition already prepared — skipping");
    } else {
      throw e;
    }
  }

  // 4. Mint funding USDC (testnet open mint)
  console.log(`  Minting ${INITIAL_FUNDING} USDC for funding...`);
  const mintHash = await walletClient.writeContract({
    address: ADDRESSES.mockUsdc,
    abi: mockUsdcAbi,
    functionName: "mint",
    args: [account.address, INITIAL_FUNDING],
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });

  // 5. Approve factory
  console.log("  Approving USDC for factory...");
  const approveHash = await walletClient.writeContract({
    address: ADDRESSES.mockUsdc,
    abi: mockUsdcAbi,
    functionName: "approve",
    args: [ADDRESSES.lmsrFactory, INITIAL_FUNDING],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  // 6. Create the LMSR market
  console.log("  Creating LMSR market...");
  const createHash = await walletClient.writeContract({
    address: ADDRESSES.lmsrFactory,
    abi: factoryAbi,
    functionName: "createLMSRMarketMaker",
    args: [
      ADDRESSES.conditionalTokens,
      ADDRESSES.mockUsdc,
      [conditionId],
      FEE_2PCT,
      "0x0000000000000000000000000000000000000000",
      INITIAL_FUNDING,
    ],
  });
  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  console.log(`  ✓ Market created (tx: ${createHash})`);

  // 7. Extract the new market address from the receipt (same two-step
  //    detection as deployMarkets.js)
  const EVENT_SIG = "0x6867cd3ddf1a2f1ce80923be4ebe91b6cdab90ef2266e1b5c38c3e509ad0d8f8";
  let marketAddress = null;
  for (const log of createReceipt.logs) {
    if (log.topics[0]?.toLowerCase() === EVENT_SIG.toLowerCase()) {
      const raw = log.data.slice(2);
      marketAddress = "0x" + raw.slice(24, 64);
      break;
    }
  }
  if (!marketAddress) {
    const AMMCreated = "0x631ac92e0a879a687b1bd27a7dcbf3ec0be307aa0a1046c0df4109be02c49307";
    for (const log of createReceipt.logs) {
      if (log.topics[0]?.toLowerCase() === AMMCreated.toLowerCase()) {
        marketAddress = log.address;
        break;
      }
    }
  }
  if (!marketAddress) throw new Error("Could not find market address in receipt logs");
  console.log(`  ✓ Market address: ${marketAddress}`);

  // 8. Write back + flip LAUNCHING → LIVE
  const { error } = await supabase
    .from("predictions")
    .update({
      question_id: questionId,
      condition_id: conditionId,
      market_address: marketAddress,
      status: "LIVE",
    })
    .eq("id", p.id);
  if (error) throw new Error(`Supabase update failed: ${error.message}`);
  console.log("  ✓ Saved to Supabase — prediction is LIVE");

  return { marketAddress, conditionId };
}

// ── Job 1: deploy all LAUNCHING predictions ──────────────────────────────────
async function deployPredictions() {
  const { data: rows, error } = await supabase
    .from("predictions")
    .select("id, question, ends_at, status")
    .eq("status", "LAUNCHING")
    .is("market_address", null);

  if (error) {
    console.error("[PREDICTION] Supabase fetch error:", error.message);
    return;
  }
  if (!rows || rows.length === 0) return;

  console.log(`[PREDICTION] ${rows.length} market(s) to deploy.`);
  for (const p of rows) {
    // Expired before we ever deployed it? Don't put a dead market on-chain.
    if (new Date(p.ends_at).getTime() <= Date.now()) {
      console.log(`[PREDICTION] ${p.id} expired before deploy — marking INVALID.`);
      await supabase.from("predictions").update({ status: "INVALID" }).eq("id", p.id);
      continue;
    }
    try {
      await deployMarketForPrediction(p);
    } catch (e) {
      console.error(`✗ [PREDICTION] Failed for ${p.id}:`, e.message);
    }
  }
}

// ── Job 2: detect on-chain resolutions of LIVE predictions ───────────────────
async function checkResolvedPredictions() {
  const { data: rows, error } = await supabase
    .from("predictions")
    .select("id, condition_id, status")
    .eq("status", "LIVE")
    .not("condition_id", "is", null);

  if (error) {
    console.error("[PREDICTION] Supabase fetch error:", error.message);
    return;
  }
  if (!rows || rows.length === 0) return;

  for (const p of rows) {
    try {
      const denom = await publicClient.readContract({
        address: ADDRESSES.conditionalTokens,
        abi: conditionalTokensAbi,
        functionName: "payoutDenominator",
        args: [p.condition_id],
      });
      if (denom === 0n) continue; // not resolved yet

      // Which outcome won? index 0 = YES, index 1 = NO
      const pay0 = await publicClient.readContract({
        address: ADDRESSES.conditionalTokens,
        abi: payoutNumeratorsAbi,
        functionName: "payoutNumerators",
        args: [p.condition_id, 0n],
      });
      const outcome = pay0 === denom ? 0 : 1;

      const { error: upErr } = await supabase
        .from("predictions")
        .update({ status: "RESOLVED", outcome, resolved_at: new Date().toISOString() })
        .eq("id", p.id);
      if (upErr) throw new Error(upErr.message);
      console.log(`[PREDICTION] ${p.id} resolved on-chain → outcome ${outcome === 0 ? "YES" : "NO"}.`);
    } catch (e) {
      console.error(`✗ [PREDICTION] resolve-check failed for ${p.id}:`, e.message);
    }
  }
}

// ── Entry ─────────────────────────────────────────────────────────────────────
export async function run() {
  await deployPredictions();
  await checkResolvedPredictions();
}