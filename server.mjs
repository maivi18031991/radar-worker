// server.mjs
// Spot Smart Radar (PRE / SPOT / GOLDEN / IMF)
// 1m scan, cooldown per type, no duplicate alert, auto clean 48h, backup active 24h

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import https from "https";
import express from "express";

// === Config ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT || "";
const API_BASE_SPOT = process.env.API_BASE_SPOT || "https://api.binance.com";
const PRIMARY_URL = process.env.PRIMARY_URL || "";
const KEEP_ALIVE_INTERVAL = Number(process.env.KEEP_ALIVE_INTERVAL || 10); // phút
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_SEC || 60) * 1000; // 1 phút
const SYMBOL_REFRESH_H = 6;
const SYMBOL_MIN_VOL = Number(process.env.SYMBOL_MIN_VOL || 10000000);
const SYMBOL_MIN_CHANGE = Number(process.env.SYMBOL_MIN_CHANGE || 5);
const ACTIVE_FILE = path.resolve("./active_spots.json");
const LAST_ALERTS_FILE = path.resolve("./last_alerts.json");
const BACKUP_DIR = path.resolve("./backups");

// === Logger ===
function logv(msg) {
  const s = `[${new Date().toLocaleString("vi-VN")}] ${msg}`;
  console.log(s);
  try { fs.appendFileSync("./spot_logs.txt", s + "\n"); } catch {}
}

// === Telegram ===
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true })
    });
    if (!res.ok) logv(`[TELEGRAM] send failed ${res.status}`);
  } catch (e) { logv(`[TELEGRAM] error ${e.message}`); }
}

// === Fetch Helper ===
async function safeFetchJSON(url, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      logv(`[HTTP] ${url} -> ${e.message}`);
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  return null;
}

// === Math Helper ===
function sma(arr, n = 20) {
  if (!arr?.length) return null;
  const slice = arr.slice(-n);
  return slice.reduce((a, b) => a + Number(b), 0) / slice.length;
}
function computeRSI(closes, period = 14) {
  if (closes.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period || 1;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period;
  }
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function fmt(n) { return typeof n === "number" ? Number(n.toFixed(8)) : n; }

// === Symbol Loader ===
let SYMBOLS = [];
let lastSymbolsTs = 0;
async function loadSymbols() {
  try {
    const now = Date.now() / 1000;
    if (lastSymbolsTs + SYMBOL_REFRESH_H * 3600 > now && SYMBOLS.length) return SYMBOLS;
    const data = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/ticker/24hr`);
    SYMBOLS = data
      .filter(s => s.symbol.endsWith("USDT"))
      .filter(s => !/UPUSDT|DOWNUSDT|BULL|BEAR|_/.test(s.symbol))
      .map(s => ({ sym: s.symbol, vol: +s.quoteVolume, change: +s.priceChangePercent }))
      .filter(s => s.vol >= SYMBOL_MIN_VOL && Math.abs(s.change) >= SYMBOL_MIN_CHANGE)
      .sort((a, b) => b.vol - a.vol)
      .map(s => s.sym);
    lastSymbolsTs = now;
    logv(`[SYMBOLS] Loaded ${SYMBOLS.length} pairs`);
    return SYMBOLS;
  } catch (e) {
    logv(`[SYMBOLS] load error ${e.message}`);
    return SYMBOLS;
  }
}

// === Active Entry Tracking ===
const activeSpots = new Map();
function loadActiveFile() {
  try {
    if (!fs.existsSync(ACTIVE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(ACTIVE_FILE, "utf-8"));
    for (const [k, v] of Object.entries(data)) activeSpots.set(k, v);
    logv(`[ENTRY] Loaded ${activeSpots.size} actives`);
  } catch {}
}
function saveActiveFile() {
  try {
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify(Object.fromEntries(activeSpots), null, 2));
  } catch {}
}

// === Alert System ===
const ALERT_COOLDOWN_MAP = { PRE: 10, SPOT: 15, GOLDEN: 15, IMF: 25, EXIT: 5 };
const ALERT_EXPIRE_MS = 48 * 60 * 60 * 1000;

function loadLastAlerts() {
  try {
    if (!fs.existsSync(LAST_ALERTS_FILE)) return {};
    return JSON.parse(fs.readFileSync(LAST_ALERTS_FILE, "utf-8"));
  } catch { return {}; }
}
function saveLastAlerts(map) {
  try { fs.writeFileSync(LAST_ALERTS_FILE, JSON.stringify(map, null, 2)); } catch {}
}
function getCooldown(level) { return ALERT_COOLDOWN_MAP[level] || 15; }

// ✅ chỉ báo coin mới, skip coin đã báo gần đây
async function sendSmartAlert(symbol, level, msg) {
  const all = loadLastAlerts();
  const key = `${symbol}_${level}`;
  const now = Date.now();
  const last = all[key] || 0;
  const diffMin = (now - last) / 60000;
  const cooldown = getCooldown(level);

  if (!last || diffMin >= cooldown) {
    await sendTelegram(msg);
    all[key] = now;
    saveLastAlerts(all);
    logv(`[SENT] ${symbol} ${level} OK (cooldown ${cooldown}m)`);
  } else {
    const remain = (cooldown - diffMin).toFixed(1);
    logv(`[SKIP] ${symbol} ${level} (sent ${diffMin.toFixed(1)}m ago, còn ${remain}m)`);
  }
}

// Clean log mỗi 48h
setInterval(() => {
  try {
    const all = loadLastAlerts();
    const now = Date.now();
    const cleaned = Object.fromEntries(Object.entries(all).filter(([_, t]) => now - t < ALERT_EXPIRE_MS));
    saveLastAlerts(cleaned);
    logv(`[CLEAN] last_alerts refreshed (${Object.keys(cleaned).length})`);
  } catch (e) { logv(`[CLEAN] error ${e.message}`); }
}, 48 * 60 * 60 * 1000);

// Backup actives mỗi 24h
setInterval(() => {
  try {
    if (!fs.existsSync(ACTIVE_FILE)) return;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path.join(BACKUP_DIR, `active_spots_${ts}.json`);
    fs.copyFileSync(ACTIVE_FILE, backup);
    logv(`[BACKUP] active_spots -> ${backup}`);
  } catch (e) { logv(`[BACKUP] error ${e.message}`); }
}, 24 * 60 * 60 * 1000);

// === Indicator Logic ===
function computeEntryZoneFromMA(ma20) {
  if (!ma20) return { entryLow: null, entryHigh: null };
  return { entryLow: fmt(ma20 * 0.995), entryHigh: fmt(ma20 * 1.02) };
}
function computeSLTP(entry, type) {
  const cfg = { PRE: { slPct: 0.01, tpPct: 0.05 }, SPOT: { slPct: 0.015, tpPct: 0.06 }, GOLDEN: { slPct: 0.02, tpPct: 0.1 }, IMF: { slPct: 0.03, tpPct: 0.15 } }[type];
  return { sl: fmt(entry * (1 - cfg.slPct)), tp: fmt(entry * (1 + cfg.tpPct)) };
}
function buildEntryMsg({ symbol, type, entryLow, entryHigh, sl, tp, ma20, vol, change24, rsi }) {
  return [
    `<b>[SPOT] ${type} | ${symbol}</b>`,
    `Vùng entry: ${entryLow} - ${entryHigh}`,
    `MA20: ${fmt(ma20)} | RSI: ${rsi?.toFixed(1)}`,
    `Vol(24h): ${vol.toFixed(0)} | 24h: ${change24}%`,
    `SL: ${sl} | TP: ${tp}`,
    `Time: ${new Date().toLocaleString("vi-VN")}`
  ].join("\n");
}

// === Analyze Symbol ===
async function analyzeSymbol(sym) {
  try {
    const [kjson, tjson] = await Promise.all([
      safeFetchJSON(`${API_BASE_SPOT}/api/v3/klines?symbol=${sym}&interval=1h&limit=60`),
      safeFetchJSON(`${API_BASE_SPOT}/api/v3/ticker/24hr?symbol=${sym}`)
    ]);
    if (!kjson || !tjson) return;
    const closes = kjson.map(c => +c[4]);
    const vols = kjson.map(c => +c[5]);
    const ma20 = sma(closes, 20);
    const price = +tjson.lastPrice;
    const change24 = +tjson.priceChangePercent;
    const vol = +tjson.quoteVolume;
    const rsi = computeRSI(closes.slice(-30));
    const volAvg = sma(vols, 20);
    const volNow = vols.at(-1);

    const nearEntry = price >= ma20 * 0.995 && price <= ma20 * 1.02;
    const isGolden = price > ma20 * 1.03 && change24 >= 6;
    const isSpot = price > ma20 && vol > volAvg * 1.8 && rsi >= 50 && rsi <= 60;
    const isPre = nearEntry && vol > volAvg * 1.2 && rsi >= 45 && rsi <= 55;
    const isIMF = volNow > volAvg * 3 && price > ma20 * 0.995;

    let chosen = isIMF ? "IMF" : isGolden ? "GOLDEN" : isSpot ? "SPOT" : isPre ? "PRE" : null;
    if (!chosen) return;

    const { sl, tp } = computeSLTP(price, chosen);
    const entryZone = computeEntryZoneFromMA(ma20);
    const msg = buildEntryMsg({ symbol: sym, type: chosen, entryLow: entryZone.entryLow, entryHigh: entryZone.entryHigh, sl, tp, ma20, vol, change24, rsi });
    await sendSmartAlert(sym, chosen, msg);

    activeSpots.set(sym, { type: chosen, markedAt: Date.now(), meta: { price, ma20, vol, change24, rsi } });
    saveActiveFile();
  } catch (e) { logv(`[ANALYZE] ${sym} err ${e.message}`); }
}

// === Exit Detection ===
async function detectExitForActive(sym, data) {
  try {
    const kjson = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/klines?symbol=${sym}&interval=1h&limit=40`);
    if (!kjson) return;
    const closes = kjson.map(c => +c[4]);
    const ma20 = sma(closes, 20);
    const price = closes.at(-1);
    const rsiNow = computeRSI(closes.slice(-30));
    let reason = null;
    if (data.type === "GOLDEN" && price < ma20 * 0.998) reason = "Giá cắt xuống MA20";
    if (["SPOT", "PRE"].includes(data.type) && price < ma20 * 0.995) reason = "Giá xuyên MA20";
    if (data.type === "IMF" && (price < ma20 * 0.995 || rsiNow < 45)) reason = "IMF rejection";
    if (reason) {
      await sendSmartAlert(sym, "EXIT", `<b>[SPOT EXIT] ${sym}</b>\nReason: ${reason}\nNow: ${price}\nMA20: ${fmt(ma20)} | RSI: ${rsiNow.toFixed(1)}`);
      activeSpots.delete(sym);
      saveActiveFile();
      logv(`[EXIT] ${sym} ${reason}`);
    }
  } catch (e) { logv(`[EXIT_CHECK] ${sym} ${e.message}`); }
}

// === Scan Loop ===
let scanning = false;
async function scanOnce() {
  if (scanning) return;
  scanning = true;
  try {
    await loadSymbols();
    if (!SYMBOLS.length) SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT"];
    logv(`[SCAN] start scanning ${SYMBOLS.length} symbols`);
    for (const sym of SYMBOLS) {
      await analyzeSymbol(sym);
      await new Promise(r => setTimeout(r, 250));
    }
    if (activeSpots.size) {
      logv(`[EXIT_SCAN] checking ${activeSpots.size}`);
      for (const [sym, data] of activeSpots.entries()) await detectExitForActive(sym, data);
    }
    logv(`[SCAN] done`);
  } catch (e) { logv(`[SCAN] fatal ${e.message}`); } finally { scanning = false; }
}

// === Start ===
loadActiveFile();
setInterval(scanOnce, SCAN_INTERVAL_MS);
await scanOnce();

if (PRIMARY_URL) setInterval(() => { try { https.get(PRIMARY_URL); logv(`[KEEPALIVE] ping sent`); } catch {} }, KEEP_ALIVE_INTERVAL * 60 * 1000);

const app = express();
app.get("/", (req, res) => res.send("Spot Smart Radar OK"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logv(`Server listening on port ${PORT}`));
