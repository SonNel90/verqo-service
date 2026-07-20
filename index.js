/**
 * index.js — Verqo Service entry point
 * - Polls every 60s to deploy markets + resolve ended battles
 * - Exposes HTTP endpoints for Supabase webhooks
 */

import "dotenv/config";
import http from "http";
import { run as deployMarkets } from "./deployMarkets.js";
import { run as resolveMarkets } from "./resolveMarkets.js";
import { run as runPredictions } from "./predictions.js";
import { run as runPriceHistory } from "./priceHistory.js";
import { run as runLeaderboard } from "./leaderboard.js";

const PORT = process.env.PORT || 3000;

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "verqo-service", time: new Date().toISOString() }));
    return;
  }

  // Supabase webhook: new battle inserted → deploy its market immediately
  if (req.method === "POST" && url.pathname === "/deploy") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: true }));
    // Run deploy in background (don't await — webhook needs fast response)
    console.log(`[WEBHOOK] /deploy triggered at ${new Date().toISOString()}`);
    deployMarkets().catch(e => console.error("webhook deployMarkets error:", e.message));
    return;
  }

  // Health check — 200 for uptime pingers (keeps the free instance awake
  // AND turns the status page green)
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
    return;
  }

  // Instant price snapshot — the frontend pings this right after every
  // confirmed trade, so the chart gets a point within seconds of the fill
  // (and the ping itself wakes a sleeping free-tier instance).
  if (url.pathname === "/snap") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    runPriceHistory().catch(e => console.error("snap error:", e.message));
    return;
  }

  // Supabase webhook: new prediction inserted → deploy its market immediately
  if (req.method === "POST" && url.pathname === "/predictions-deploy") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: true }));
    console.log(`[WEBHOOK] /predictions-deploy triggered at ${new Date().toISOString()}`);
    runPredictions().catch(e => console.error("webhook runPredictions error:", e.message));
    return;
  }

  // Supabase webhook: battle updated → check if needs resolving
  if (req.method === "POST" && url.pathname === "/resolve") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: true }));
    console.log(`[WEBHOOK] /resolve triggered at ${new Date().toISOString()}`);
    resolveMarkets().catch(e => console.error("webhook resolveMarkets error:", e.message));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Verqo service running on port ${PORT}`);
});

// ── Polling loop (backup — runs even if webhooks miss something) ──────────────
async function tick() {
  console.log(`\n[${new Date().toISOString()}] Polling tick...`);
  try { await deployMarkets(); } catch (e) { console.error("deployMarkets error:", e.message); }
  try { await resolveMarkets(); } catch (e) { console.error("resolveMarkets error:", e.message); }
  try { await runPredictions(); } catch (e) { console.error("predictions error:", e.message); }
  try { await runPriceHistory(); } catch (e) { console.error("priceHistory error:", e.message); }
  try { await runLeaderboard(); } catch (e) { console.error("leaderboard error:", e.message); }
}

// Run immediately on startup, then every 60 seconds
tick();
setInterval(tick, 60_000);