/**
 * index.js — Verqo Service entry point
 * Runs on Render (always-on). Polls every 60s to:
 * 1. Deploy markets for new battles that don't have one yet
 * 2. Resolve battles that have ended
 *
 * Also exposes a minimal HTTP server so Render doesn't kill the process
 * (Render expects a web service to listen on a port)
 */

import "dotenv/config";
import http from "http";
import { run as deployMarkets } from "./deployMarkets.js";
import { run as resolveMarkets } from "./resolveMarkets.js";

const PORT = process.env.PORT || 3000;

// ── Minimal HTTP server (keeps Render happy) ──────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", service: "verqo-service", time: new Date().toISOString() }));
});

server.listen(PORT, () => {
  console.log(`Verqo service running on port ${PORT}`);
});

// ── Main polling loop ─────────────────────────────────────────────────────────
async function tick() {
  console.log(`\n[${new Date().toISOString()}] Running tick...`);
  try {
    await deployMarkets();
  } catch (e) {
    console.error("deployMarkets error:", e.message);
  }
  try {
    await resolveMarkets();
  } catch (e) {
    console.error("resolveMarkets error:", e.message);
  }
}

// Run immediately on startup, then every 60 seconds
tick();
setInterval(tick, 60_000);