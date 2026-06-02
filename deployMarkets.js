/**
 * deployMarkets.js
 * 
 * Finds battles in Supabase that don't have an on-chain market yet,
 * deploys one for each, and writes the market_address + condition_id back.
 * 
 * Run: node deployMarkets.js
 * Or:  node deployMarkets.js --watch   (polls every 60s for new battles)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import {
  createWalletClient,
  createPublicClient,
  http,
  keccak256,
  encodePacked,
  parseUnits,
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

// ── Clients ──────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
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

// ── Core deploy function ──────────────────────────────────────────────────────

async function deployMarketForBattle(battle) {
  console.log(`\n▶ Deploying market for battle ${battle.id}`);

  // 1. Derive a unique questionId from the battle id
  //    keccak256(abi.encodePacked("verqo-battle-", battleId))
  const questionId = keccak256(
    encodePacked(["string"], [`verqo-battle-${battle.id}`])
  );
  console.log(`  questionId: ${questionId}`);

  // 2. Compute what the conditionId will be (deterministic, no tx needed)
  const conditionId = await publicClient.readContract({
    address: ADDRESSES.conditionalTokens,
    abi: conditionalTokensAbi,
    functionName: "getConditionId",
    args: [account.address, questionId, 2n],
  });
  console.log(`  conditionId: ${conditionId}`);

  // 3. Check if condition already prepared (idempotent)
  // prepareCondition is safe to call twice but wastes gas — skip if already done
  // We detect by checking if conditionId exists (payoutDenominator returns 0 for unprepared too,
  // so we just always prepare — the contract ignores duplicates gracefully)
  console.log("  Preparing condition...");
  const prepHash = await walletClient.writeContract({
    address: ADDRESSES.conditionalTokens,
    abi: conditionalTokensAbi,
    functionName: "prepareCondition",
    args: [account.address, questionId, 2n],
  });
  await publicClient.waitForTransactionReceipt({ hash: prepHash });
  console.log(`  ✓ Condition prepared (tx: ${prepHash})`);

  // 4. Mint funding USDC to deployer wallet (testnet — open mint)
  console.log(`  Minting ${INITIAL_FUNDING} USDC for funding...`);
  const mintHash = await walletClient.writeContract({
    address: ADDRESSES.mockUsdc,
    abi: mockUsdcAbi,
    functionName: "mint",
    args: [account.address, INITIAL_FUNDING],
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });
  console.log(`  ✓ Minted (tx: ${mintHash})`);

  // 5. Approve factory to pull the funding USDC
  console.log("  Approving USDC for factory...");
  const approveHash = await walletClient.writeContract({
    address: ADDRESSES.mockUsdc,
    abi: mockUsdcAbi,
    functionName: "approve",
    args: [ADDRESSES.lmsrFactory, INITIAL_FUNDING],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log(`  ✓ Approved (tx: ${approveHash})`);

  // 6. Create the LMSR market
  console.log("  Creating LMSR market...");
  const createHash = await walletClient.writeContract({
    address: ADDRESSES.lmsrFactory,
    abi: factoryAbi,
    functionName: "createLMSRMarketMaker",
    args: [
      ADDRESSES.conditionalTokens, // pmSystem
      ADDRESSES.mockUsdc,           // collateralToken
      [conditionId],                // conditionIds array
      FEE_2PCT,                     // fee (2%)
      "0x0000000000000000000000000000000000000000", // whitelist (none = open)
      INITIAL_FUNDING,              // funding
    ],
  });
  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  console.log(`  ✓ Market created (tx: ${createHash})`);

  // 7. Extract the new market address from the LMSRMarketMakerCreation event
  //    Event sig: LMSRMarketMakerCreation(address,LMSRMarketMaker,...)
  //    The market address is the second topic (first indexed param)
  const EVENT_SIG = "0x6867cd3ddf1a2f1ce80923be4ebe91b6cdab90ef2266e1b5c38c3e509ad0d8f8";
  let marketAddress = null;
  for (const log of createReceipt.logs) {
    if (log.topics[0]?.toLowerCase() === EVENT_SIG.toLowerCase()) {
      // The market address is ABI-encoded in the data or topics
      // From the ABI: LMSRMarketMakerCreation(address indexed,LMSRMarketMaker,...)
      // topics[1] = creator (deployer), topics[2] would be market if indexed
      // Actually the market is in the data — parse it
      // Data layout: (LMSRMarketMaker marketMaker, ConditionalTokens, IERC20, bytes32[], uint64, uint256)
      // marketMaker is first 32 bytes (address, padded)
      const raw = log.data.slice(2); // remove 0x
      marketAddress = "0x" + raw.slice(24, 64); // first 32 bytes, last 20 = address
      break;
    }
  }

  // Fallback: scan for AMMCreated event which logs the market address as the emitter
  if (!marketAddress) {
    // The market itself emits AMMCreated — find a new contract address in logs
    const AMMCreated = "0x631ac92e0a879a687b1bd27a7dcbf3ec0be307aa0a1046c0df4109be02c49307";
    for (const log of createReceipt.logs) {
      if (log.topics[0]?.toLowerCase() === AMMCreated.toLowerCase()) {
        marketAddress = log.address;
        break;
      }
    }
  }

  if (!marketAddress) {
    throw new Error("Could not find market address in transaction receipt logs");
  }

  console.log(`  ✓ Market address: ${marketAddress}`);

  // 8. Write back to Supabase
  const { error } = await supabase
    .from("battles")
    .update({
      market_address: marketAddress,
      condition_id: conditionId,
    })
    .eq("id", battle.id);

  if (error) throw new Error(`Supabase update failed: ${error.message}`);
  console.log(`  ✓ Saved to Supabase`);

  return { marketAddress, conditionId };
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function run() {
  console.log("Checking for battles without markets...");

  const { data: battles, error } = await supabase
    .from("battles")
    .select("id, status, starts_at, ends_at")
    .is("market_address", null)
    .in("status", ["UPCOMING", "LIVE"]);

  if (error) {
    console.error("Supabase fetch error:", error.message);
    return;
  }

  if (!battles || battles.length === 0) {
    console.log("No battles need markets right now.");
    return;
  }

  console.log(`Found ${battles.length} battle(s) needing markets.`);

  for (const battle of battles) {
    try {
      await deployMarketForBattle(battle);
    } catch (e) {
      console.error(`✗ Failed for battle ${battle.id}:`, e.message);
      // Continue to next battle rather than crashing
    }
  }

  console.log("\nDone.");
}

// ── Entry point ───────────────────────────────────────────────────────────────

const watchMode = process.argv.includes("--watch");

if (watchMode) {
  console.log("Watch mode: running every 60 seconds...");
  run();
  setInterval(run, 60_000);
} else {
  run();
}