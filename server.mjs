// server_v3.6_master_hyper_adaptive_full.mjs
// SPOT MASTER AI v3.6 - SmartFlow + Hyper Breakout + Auto-learning + Adaptive Rotation
// Node >=16

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import https from "https";
import express from "express";
import * as learningEngine from "./learning_engine.js";
import { rotationFlowScan } from "./rotation_flow_live.js";
import { scanRotationFlow } from "./modules/rotation_prebreakout.js"; // ✅ Pre-breakout module

// ========== CONFIG ==========
let SCAN_INTERVAL_SEC = 60;
const MIN_VOL_24H = 5_000_000;
const ALERT_COOLDOWN_MIN = 15;
const API_BASE_SPOT = "https://api.binance.com";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const PRIMARY_URL = process.env.PRIMARY_URL || "";
const KEEP_ALIVE_MIN = 10;

// ========== CORE HELPERS ==========
function logv(msg) {
  const s = `[${new Date().toLocaleString("vi-VN")}] ${msg}`;
  console.log(s);
}
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" };
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    logv("[TELEGRAM ERROR] " + e.message);
  }
}
async function safeFetchJSON(url, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { timeout: 15000 });
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}
function sma(arr, n = 20) {
  if (!arr || arr.length < n) return null;
  const slice = arr.slice(-n);
  return slice.reduce((s, x) => s + Number(x), 0) / slice.length;
}
function computeRSI(closes, period = 14) {
  if (!closes || closes.length <= period) return 50;
  let gains = 0,
    losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  const rs = (gains / period) / ((losses || 1) / period);
  return 100 - 100 / (1 + rs);
}

// ========== SYMBOL SCAN ==========
let scanning = false;
let SYMBOLS = [];

async function loadSymbols() {
  const data = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/ticker/24hr`);
  if (!Array.isArray(data)) return [];
  SYMBOLS = data
    .filter(
      (s) =>
        s.symbol.endsWith("USDT") &&
        !/UPUSDT|DOWNUSDT|BULLUSDT|BEARUSDT/.test(s.symbol) &&
        Number(s.quoteVolume) > MIN_VOL_24H
    )
    .map((s) => s.symbol);
  logv(`[SYMBOLS] Loaded ${SYMBOLS.length} USDT pairs`);
  return SYMBOLS;
}

// ========== MAIN SCAN ==========
async function analyzeSymbol(sym) {
  const kUrl = `${API_BASE_SPOT}/api/v3/klines?symbol=${sym}&interval=1h&limit=60`;
  const tUrl = `${API_BASE_SPOT}/api/v3/ticker/24hr?symbol=${sym}`;
  const [kjson, tjson] = await Promise.all([safeFetchJSON(kUrl), safeFetchJSON(tUrl)]);
  if (!kjson || !tjson) return;

  const closes = kjson.map((r) => Number(r[4]));
  const vols = kjson.map((r) => Number(r[5]));
  const ma20 = sma(closes, 20) || closes.at(-1);
  const price = Number(tjson.lastPrice);
  const change24 = Number(tjson.priceChangePercent);
  const volNow = vols.at(-1);
  const volRatio = volNow / (sma(vols, 20) || 1);
  const rsi = computeRSI(closes);

  // ---- CONFIDENCE FORMULA ----
  let conf = 0;
  if (rsi >= 55 && rsi <= 70) conf += 25;
  if (volRatio >= 1.5 && volRatio < 2.5) conf += 25;
  else if (volRatio >= 2.5) conf += 35;
  if (change24 >= 4 && change24 <= 20) conf += 25;
  if (price > ma20 * 1.02) conf += 10;

  // ---- HYPER BREAKOUT ----
  if (rsi >= 60 && volRatio >= 3 && change24 >= 8) conf += 15;

  const confRounded = Math.min(conf, 100);

  if (confRounded < 70) return;

  const type =
    confRounded >= 85 ? "HYPER BREAKOUT" : confRounded >= 70 ? "PRE-BREAKOUT" : null;
  if (!type) return;

  const msg = `
🚀 [ROTATION FLOW | ${type}]
<b>${sym}</b>
RSI: ${rsi.toFixed(1)} | VolRatio: ${volRatio.toFixed(2)} | Δ24h: ${change24}%
MA20: ${ma20.toFixed(6)}
Conf: ${confRounded}%
Time: ${new Date().toLocaleString("vi-VN")}
  `;
  await sendTelegram(msg);
  logv(`[ROTATION] ${sym} → ${type} (${confRounded}%)`);
}

// ========== AUTO-SCAN LOOP ==========
async function rotationScanLoop() {
  if (scanning) return;
  scanning = true;
  try {
    if (!SYMBOLS.length) await loadSymbols();
    for (const sym of SYMBOLS.slice(0, 50)) {
      await analyzeSymbol(sym);
      await new Promise((r) => setTimeout(r, 300));
    }
    logv("[ROTATION] Scan cycle complete");
  } catch (e) {
    logv("[ROTATION ERROR] " + e.message);
  } finally {
    scanning = false;
  }
}

// ========== AUTO-LEARN ==========
setInterval(async () => {
  try {
    await learningEngine.quickLearn48h?.();
    logv("[LEARNING] quickLearn48h executed");
  } catch (e) {
    logv("[LEARNING ERROR] " + e.message);
  }
}, 48 * 3600 * 1000);

// ========== SCHEDULER ==========
setInterval(rotationScanLoop, 6 * 3600 * 1000); // quét mỗi 6 tiếng
setTimeout(rotationScanLoop, 8000); // chạy sớm khi startup

// ========== KEEPALIVE ==========
const app = express();
app.get("/", (req, res) => res.send("SPOT MASTER AI v3.6 OK"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logv(`Server listening on ${PORT}`));
if (PRIMARY_URL)
  setInterval(() => {
    try {
      https.get(PRIMARY_URL);
      logv("[KEEPALIVE] ping");
    } catch {}
  }, KEEP_ALIVE_MIN * 60 * 1000);
