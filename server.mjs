// ======================================================
// Spot Master+ v3.5  —  SmartFlow + Pre-Breakout + Learning Engine
// ======================================================

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import https from "https";
import express from "express";
import * as learningEngine from "./learning_engine.js";
import * as preBreakout from "./rotation_prebreakout.js"; // 🔥 PreBreakout module

// ------------ CONFIG -------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const API_BASE_SPOT = "https://api.binance.com";
const PRIMARY_URL = process.env.PRIMARY_URL || "";
const PORT = process.env.PORT || 3000;
const SCAN_INTERVAL_SEC = 60;
const SYMBOL_MIN_VOL = 2000000; // lọc volume tối thiểu
const ALERT_COOLDOWN_MIN = 15;

const ACTIVE_FILE = path.resolve("./active_spots.json");
const LOG_FILE = path.resolve("./spot_logs.txt");

// ------------ UTILS -------------
function nowStr() {
  return new Date().toLocaleString("vi-VN");
}
function fmt(n) {
  return typeof n === "number" ? Number(n.toFixed(8)) : n;
}
function logv(msg) {
  const s = `[${nowStr()}] ${msg}`;
  console.log(s);
  fs.appendFileSync(LOG_FILE, s + "\n");
}
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true };
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    logv("[TELEGRAM ERROR] " + e.message);
  }
}

// ------------ GLOBAL VARS -------------
let SYMBOLS = [];
let lastSymbolsTs = 0;
const activeSpots = new Map();
const ALERT_MEMORY = new Map();

// ------------ HELPERS -------------
function sma(arr, n = 20) {
  if (!arr || arr.length < 1) return null;
  const slice = arr.slice(-n);
  const sum = slice.reduce((s, x) => s + Number(x), 0);
  return sum / slice.length;
}
function computeRSI(closes, period = 14) {
  if (!closes || closes.length <= period) return null;
  let gains = 0,
    losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period || 1;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
function canSendAlert(symbol, level = "SPOT") {
  const key = `${level}:${symbol}`;
  const now = Date.now();
  const lastTime = ALERT_MEMORY.get(key) || 0;
  const diffMin = (now - lastTime) / 60000;
  if (diffMin >= ALERT_COOLDOWN_MIN) {
    ALERT_MEMORY.set(key, now);
    return true;
  }
  return false;
}

// ------------ SYMBOL LOADER -------------
async function safeFetchJSON(url, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      return await r.json();
    } catch {}
  }
  return null;
}
async function loadSymbols() {
  const now = Date.now() / 1000;
  if (lastSymbolsTs + 6 * 3600 > now && SYMBOLS.length) return SYMBOLS;
  const url = `${API_BASE_SPOT}/api/v3/ticker/24hr`;
  const data = await safeFetchJSON(url, 2);
  if (!Array.isArray(data)) return SYMBOLS;
  SYMBOLS = data
    .filter((s) => s.symbol.endsWith("USDT") && !s.symbol.includes("DOWN") && !s.symbol.includes("UP"))
    .filter((s) => Number(s.quoteVolume) >= SYMBOL_MIN_VOL)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .map((s) => s.symbol);
  lastSymbolsTs = now;
  logv(`[SYMBOLS] loaded ${SYMBOLS.length} USDT pairs`);
  return SYMBOLS;
}

// ------------ ANALYZE SYMBOL -------------
async function analyzeSymbol(sym) {
  try {
    const kUrl = `${API_BASE_SPOT}/api/v3/klines?symbol=${sym}&interval=1h&limit=60`;
    const tUrl = `${API_BASE_SPOT}/api/v3/ticker/24hr?symbol=${sym}`;
    const [kjson, tjson] = await Promise.all([safeFetchJSON(kUrl), safeFetchJSON(tUrl)]);
    if (!kjson || !tjson) return;

    const closes = kjson.map((c) => Number(c[4]));
    const ma20 = sma(closes, 20) || closes.at(-1);
    const price = Number(tjson.lastPrice);
    const change24 = Number(tjson.priceChangePercent);
    const vol = Number(tjson.quoteVolume);
    const rsi = computeRSI(closes.slice(-30)) || 50;
    const vols = kjson.map((c) => Number(c[5]));
    const volAvg = sma(vols, 20);
    const volNow = vols.at(-1);
    const volRatio = volNow / (volAvg || 1);

    // ---- ENTRY CONDITIONS ----
    const isPre = price >= ma20 * 0.995 && price <= ma20 * 1.02 && rsi >= 45 && rsi <= 60 && volRatio >= 1.2;
    const isSpot = price > ma20 && rsi >= 50 && rsi <= 70 && volRatio >= 1.5;
    const isGolden = price > ma20 * 1.03 && change24 >= 6 && volRatio >= 1.8;
    const isIMF = volRatio >= 3 && price > ma20 * 0.995 && rsi >= 55;

    let level = null;
    if (isIMF) level = "IMF";
    else if (isGolden) level = "GOLDEN";
    else if (isSpot) level = "SPOT";
    else if (isPre) level = "PRE";

    if (!level || !canSendAlert(sym, level)) return;

    const conf = learningEngine.getConfidence(sym, { level, rsi, volRatio, change24 });
    const msg = `<b>[SPOT ${level}]</b> ${sym}\nPrice: ${fmt(price)} | MA20: ${fmt(ma20)} | RSI: ${rsi.toFixed(
      1
    )}\nVolRatio: ${volRatio.toFixed(2)} | 24h: ${change24}%\nConf: ${Math.round(conf)}%\nTime: ${nowStr()}`;
    await sendTelegram(msg);
    logv(msg);
  } catch (e) {
    logv(`[ANALYZE ERR] ${sym} - ${e.message}`);
  }
}

// ------------ MAIN SCAN LOOP -------------
let scanning = false;
async function scanOnce() {
  if (scanning) return;
  scanning = true;
  try {
    await loadSymbols();
    for (const sym of SYMBOLS) {
      await analyzeSymbol(sym);
      await new Promise((r) => setTimeout(r, 250));
    }
    logv("[SCAN] done");
  } catch (e) {
    logv("[SCAN] error " + e.message);
  } finally {
    scanning = false;
  }
}

// ------------ PRE-BREAKOUT MODULE -------------
async function runPreBreakout() {
  try {
    const results = await preBreakout.scanPreBreakout();
    if (Array.isArray(results) && results.length) {
      logv(`[PREBREAKOUT] ${results.length} candidates`);
      for (const c of results) {
        const msg = `<b>[PRE-ROTATION]</b> ${c.symbol}\nBBWidth: ${c.bbWidth.toFixed(4)} | RSI4h: ${c.rsi4h.toFixed(
          1
        )} | VolRatio: ${c.volRatio?.toFixed(2) || "?"}\nConf: ${Math.round(c.conf || 0)}%\n${nowStr()}`;
        await sendTelegram(msg);
        logv(msg);
      }
    } else logv(`[PREBREAKOUT] no signal`);
  } catch (e) {
    logv(`[PREBREAKOUT ERR] ${e.message}`);
  }
}

// ------------ INIT -------------
(async () => {
  logv("[SPOT MASTER+] Started SmartFlow + PreBreakout");
  await sendTelegram(`<b>[SPOT MASTER+]</b>\nStarted scanning SmartFlow + PreBreakout\n${nowStr()}`);

  await scanOnce();
  setInterval(scanOnce, SCAN_INTERVAL_SEC * 1000);
  runPreBreakout();
  setInterval(runPreBreakout, 30 * 60 * 1000);

  setTimeout(() => {
    learningEngine.quickLearn48h();
    logv("[FAST-LEARN] Manual 48h learning triggered");
  }, 5000);
})();

// ------------ KEEP ALIVE -------------
if (PRIMARY_URL) {
  setInterval(() => {
    try {
      https.get(PRIMARY_URL);
    } catch {}
  }, 600000);
}

// ------------ EXPRESS -------------
const app = express();
app.get("/", (req, res) => res.send("Spot SmartFlow+ OK"));
app.listen(PORT, () => logv(`[HTTP] listening on port ${PORT}`));
