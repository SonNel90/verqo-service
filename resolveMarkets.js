/**
 * resolveMarkets.js
 * 
 * Finds battles that have ended (ends_at < now) and have a market_address
 * but no winner yet, calculates the winner from scores, and calls reportPayouts.
 * 
 * Run: node resolveMarkets.js
 * Or:  node resolveMarkets.js --watch   (polls every 60s)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { enabled: false } }
);
import {
  createWalletClient,
  createPublicClient,
  http,
  keccak256,
  encodePacked,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { ADDRESSES, conditionalTokensAbi } from "./contracts.js";

// ── Clients ───────────────────────────────────────────────────────────────────

import ws from "ws";
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

console.log(`Oracle wallet: ${account.address}`);

// ── Resolve a single battle ───────────────────────────────────────────────────

async function resolveBattle(battle) {
  console.log(`\n▶ Resolving battle ${battle.id}`);
  console.log(`  Market: ${battle.market_address}`);
  console.log(`  Score A: ${battle.score_a} | Score B: ${battle.score_b}`);

  // Check not already resolved on-chain
  const denom = await publicClient.readContract({
    address: ADDRESSES.conditionalTokens,
    abi: conditionalTokensAbi,
    functionName: "payoutDenominator",
    args: [battle.condition_id],
  });
  if (denom > 0n) {
    console.log("  Already resolved on-chain — skipping");
    // Still update Supabase winner if missing
    if (!battle.winner) {
      const winner = (battle.score_a ?? 0) >= (battle.score_b ?? 0) ? "A" : "B";
      await supabase.from("battles").update({ winner, status: "SETTLED" }).eq("id", battle.id);
    }
    return;
  }

  // Determine winner from scores
  const scoreA = battle.score_a ?? 0;
  const scoreB = battle.score_b ?? 0;
  let payouts, winner;

  if (scoreA > scoreB) {
    payouts = [1n, 0n]; // outcome 0 (creator A) wins
    winner = "A";
  } else if (scoreB > scoreA) {
    payouts = [0n, 1n]; // outcome 1 (creator B) wins
    winner = "B";
  } else {
    // Tie — split evenly
    payouts = [1n, 1n];
    winner = "TIE";
  }

  console.log(`  Winner: ${winner} | Payouts: [${payouts.join(", ")}]`);

  // Derive questionId from battle id (must match deployMarkets.js)
  const questionId = keccak256(
    encodePacked(["string"], [`verqo-battle-${battle.id}`])
  );

  // Call reportPayouts on ConditionalTokens
  const txHash = await walletClient.writeContract({
    address: ADDRESSES.conditionalTokens,
    abi: conditionalTokensAbi,
    functionName: "reportPayouts",
    args: [questionId, payouts],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error("reportPayouts tx failed");
  console.log(`  ✓ Resolved on-chain (tx: ${txHash})`);

  // Update Supabase
  const { error } = await supabase
    .from("battles")
    .update({
      winner,
      status: "SETTLED",
      resolution_tx: txHash,
      settled_at: new Date().toISOString(),
    })
    .eq("id", battle.id);

  if (error) throw new Error(`Supabase update failed: ${error.message}`);
  console.log(`  ✓ Updated Supabase — winner: ${winner}`);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function run() {
  console.log("Checking for battles to resolve...");

  const now = new Date().toISOString();

  const { data: battles, error } = await supabase
    .from("battles")
    .select("id, market_address, condition_id, score_a, score_b, winner, ends_at")
    .not("market_address", "is", null)
    .not("condition_id", "is", null)
    .is("winner", null)           // not yet resolved
    .neq("status", "SETTLED")
    .lt("ends_at", now);          // ended

  if (error) {
    console.error("Supabase fetch error:", error.message);
    return;
  }

  if (!battles || battles.length === 0) {
    console.log("No battles to resolve right now.");
    return;
  }

  console.log(`Found ${battles.length} battle(s) to resolve.`);

  for (const battle of battles) {
    try {
      await resolveBattle(battle);
    } catch (e) {
      console.error(`✗ Failed for battle ${battle.id}:`, e.message);
    }
  }

  console.log("\nDone.");
}

// ── Entry point ───────────────────────────────────────────────────────────────

export { run };

// Allow direct execution
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const watchMode = process.argv.includes("--watch");
  if (watchMode) {
    console.log("Watch mode: running every 60 seconds...");
    run();
    setInterval(run, 60_000);
  } else {
    run();
  }
}