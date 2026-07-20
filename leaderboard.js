/**
 * leaderboard.js — incremental event indexer for LP standings
 *
 * Scans VerqoLaunchPool events (Deposited / Withdrawn / Refunded / Claimed)
 * in chunks each tick, maintaining net active LP capital per (launch, wallet)
 * in `lp_balances`. Progress persists in `indexer_state`, so each tick only
 * scans NEW blocks. This is the seed of the mainnet event indexer.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { createPublicClient, http, parseAbi, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";

const LAUNCH_POOL = "0x4490fc42C128340eBaa3a9F86e49FF8e38DCa9e7";
const CHUNK = 10000n;          // blocks per getLogs call
const MAX_CHUNKS_PER_TICK = 20; // bound runtime per tick
const LOOKBACK = 600000n;      // first-run history window (~2 weeks of Base blocks)

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { global: { fetch }, realtime: { transport: ws } }
);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(process.env.RPC_URL || "https://sepolia.base.org") });

const poolEvents = parseAbi([
  "event Deposited(uint256 indexed launchId, address indexed user, uint256 credited, uint256 skim)",
  "event Withdrawn(uint256 indexed launchId, address indexed user, uint256 returned, uint256 skim)",
  "event Refunded(uint256 indexed launchId, address indexed user, uint256 amount)",
  "event Claimed(uint256 indexed launchId, address indexed user, uint256 paid, uint256 skim)",
]);

const u = (v) => Number(formatUnits(v, 6));

export async function run() {
  try {
    const latest = await publicClient.getBlockNumber();
    const { data: st } = await supabase.from("indexer_state").select("value").eq("key", "pool_events").maybeSingle();
    let from = st?.value != null ? BigInt(st.value) + 1n : (latest > LOOKBACK ? latest - LOOKBACK : 0n);
    if (from > latest) return;

    // key `${launchId}|${wallet}` → { delta, zero }
    const touched = new Map();
    const bump = (launchId, user, delta, zero = false) => {
      const k = `${launchId}|${user.toLowerCase()}`;
      const cur = touched.get(k) || { delta: 0, zero: false };
      if (zero) { cur.zero = true; cur.delta = 0; }
      else if (!cur.zero) cur.delta += delta;
      touched.set(k, cur);
    };

    let scanned = 0;
    let to = from;
    while (from <= latest && scanned < MAX_CHUNKS_PER_TICK) {
      to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n;
      const logs = await publicClient.getLogs({ address: LAUNCH_POOL, events: poolEvents, fromBlock: from, toBlock: to });
      for (const log of logs) {
        const { launchId, user } = log.args;
        if (log.eventName === "Deposited") bump(launchId, user, u(log.args.credited));
        else if (log.eventName === "Withdrawn") bump(launchId, user, -(u(log.args.returned) + u(log.args.skim)));
        else if (log.eventName === "Refunded") bump(launchId, user, 0, true);   // full exit
        else if (log.eventName === "Claimed") bump(launchId, user, 0, true);     // LP position closed
      }
      from = to + 1n;
      scanned++;
    }

    if (touched.size > 0) {
      const keys = [...touched.keys()];
      const pairs = keys.map((k) => { const [l, w] = k.split("|"); return { launch_id: Number(l), wallet: w }; });
      // read existing nets for touched pairs
      const { data: existing } = await supabase
        .from("lp_balances")
        .select("launch_id, wallet, net")
        .in("launch_id", [...new Set(pairs.map((p) => p.launch_id))]);
      const cur = new Map((existing || []).map((r) => [`${r.launch_id}|${r.wallet}`, Number(r.net)]));
      const upserts = keys.map((k) => {
        const [l, w] = k.split("|");
        const t = touched.get(k);
        const net = t.zero ? 0 : Math.max(0, (cur.get(k) || 0) + t.delta);
        return { launch_id: Number(l), wallet: w, net };
      });
      const { error } = await supabase.from("lp_balances").upsert(upserts, { onConflict: "launch_id,wallet" });
      if (error) throw new Error(error.message);
      console.log(`[LB] indexed ${upserts.length} LP position(s) through block ${to}`);
    }

    await supabase.from("indexer_state").upsert({ key: "pool_events", value: Number(to) }, { onConflict: "key" });
  } catch (e) {
    console.error("[LB] indexer error:", e.message);
  }
}