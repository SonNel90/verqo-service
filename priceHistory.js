/**
 * priceHistory.js — lightweight price indexer (testnet edition)
 *
 * Every tick, reads the live YES price from each LIVE market's LMSR
 * contract and snapshots it into `price_history`. Writes only when the
 * price actually moved (≥0.5c) or 15 minutes passed since the last point
 * (heartbeat, so charts stay continuous through quiet stretches).
 *
 * This is the seed of the full event indexer planned for mainnet.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { global: { fetch }, realtime: { transport: ws } }
);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(process.env.RPC_URL || "https://sepolia.base.org") });

const lmsrPriceAbi = [
  { name: "calcMarginalPrice", type: "function", stateMutability: "view", inputs: [{ name: "outcomeTokenIndex", type: "uint8" }], outputs: [{ type: "uint256" }] },
];
const PRICE_DENOMINATOR = 2n ** 64n;

export async function run() {
  const { data: rows, error } = await supabase
    .from("predictions")
    .select("id, market_address")
    .eq("status", "LIVE")
    .not("market_address", "is", null);
  if (error) return console.error("[PRICE] fetch error:", error.message);
  if (!rows?.length) return;

  for (const p of rows) {
    try {
      const raw = await publicClient.readContract({
        address: p.market_address, abi: lmsrPriceAbi,
        functionName: "calcMarginalPrice", args: [0],
      });
      const yes = Math.round(Number((raw * 10000n) / PRICE_DENOMINATOR) / 10) / 10; // cents, 1dp

      const { data: last } = await supabase
        .from("price_history")
        .select("yes_price, created_at")
        .eq("prediction_id", p.id)
        .order("created_at", { ascending: false })
        .limit(1);

      const prev = last?.[0];
      const moved = !prev || Math.abs(Number(prev.yes_price) - yes) >= 0.1;
      const stale = !prev || Date.now() - new Date(prev.created_at).getTime() > 15 * 60 * 1000;
      if (!moved && !stale) continue;

      const { error: insErr } = await supabase
        .from("price_history")
        .insert({ prediction_id: p.id, yes_price: yes });
      if (insErr) throw new Error(insErr.message);
    } catch (e) {
      console.error(`✗ [PRICE] snapshot failed for ${p.id}:`, e.message);
    }
  }
}
