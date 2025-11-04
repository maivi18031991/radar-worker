// === SPOT MASTER AI v4.1 HYBRID EARLY + CACHE SYSTEM ===
// Modules: PreBreakout + Golden + Flow + Early Detector + Smart Learning
// Author: ViXuan System Build (2025-11)
// Core upgrades: API Rotator + Local Candle Cache (JSON) + Auto Learning
// ------------------------------------------------------------

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import * as LEARN from "./learning_engine.js";
import { scanPreBreakout } from "./rotation_prebreakout.js";

// ---------- CONFIG ----------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const KEEP_ALIVE_URL = process.env.PRIMARY_URL || "";
const KEEP_ALIVE_INTERVAL = (Number(process.env.KEEP_ALIVE_INTERVAL) || 10) * 60 * 1000;
const SCAN_INTERVAL_MS = (Number(process.env.SCAN_INTERVAL_SEC) || 60) * 1000;
const EARLY_INTERVAL_MS = (Number(process.env.EARLY_INTERVAL_SEC) || 120) * 1000;
const CACHE_FILE = path.resolve("./data/cache_candles.json");

// ---------- API ROTATOR ----------
const API_LIST = [
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api-gcp.binance.com",
  "https://api-gcp-aws.binance.com"
];
let apiIndex = 0;
function getAPI() {
  const url = API_LIST[apiIndex];
  apiIndex = (apiIndex + 1) % API_LIST.length;
  return url;
}

// ---------- LOGGER ----------
function logv(msg) {
  const s = `[${new Date().toLocaleString("vi-VN")}] ${msg}`;
  console.log(s);
  try { fs.appendFileSync("server_log.txt", s + "\n"); } catch {}
}

// ---------- TELEGRAM ----------
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    if (!res.ok) logv(`[TELEGRAM FAIL] ${res.status}`);
  } catch (e) { logv("[TELEGRAM ERR] " + e.message); }
}

// ---------- CACHE SYSTEM ----------
function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    const txt = fs.readFileSync(CACHE_FILE, "utf8");
    const cache = JSON.parse(txt || "{}");
    const now = Date.now();
    for (const k of Object.keys(cache)) {
      if (now - (cache[k].ts || 0) > 3 * 3600 * 1000) delete cache[k];
    }
    return cache;
  } catch { return {}; }
}
function saveCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) { logv("[CACHE WRITE ERROR] " + e.message); }
}

// ---------- FETCH WRAPPER WITH CACHE ----------
const cache = loadCache();
async function fetchCached(endpoint, label = "GENERIC") {
  if (cache[endpoint] && Date.now() - cache[endpoint].ts < 5 * 60 * 1000)
    return cache[endpoint].data;

  const api = getAPI();
  const url = `${api}${endpoint}`;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      cache[endpoint] = { ts: Date.now(), data };
      saveCache(cache);
      return data;
    } catch (e) {
      logv(`[${label}] Fetch fail (${i + 1}) ${e.message}`);
    }
  }
  return [];
}

// ---------- UNIFIED PUSH ----------
async function pushSignal(tag, coin, conf = 70) {
  try {
    const sym = coin.symbol?.replace("USDT", "");
    const chg = coin.priceChangePercent || coin.change24h || 0;
    const msg = `
<b>${tag}</b> ${sym}USDT
Δ24h: <b>${chg.toFixed(2)}%</b> | Conf: ${conf}%
Vol: ${(coin.quoteVolume || 0).toLocaleString()}
Note: ${coin.note || ""}
Time: ${new Date().toLocaleString("vi-VN")}
`;
    await sendTelegram(msg);
    if (LEARN?.recordSignal) await LEARN.recordSignal({ symbol: coin.symbol, type: tag, conf, time: new Date().toISOString() });
    logv(`[PUSH] ${tag} ${sym} ${conf}%`);
  } catch (e) { logv("[pushSignal ERROR] " + e.message); }
}

// ---------- EARLY DETECTOR ----------
async function scanEarlyCoins() {
  const data = await fetchCached("/api/v3/ticker/24hr", "EARLY");
  if (!Array.isArray(data)) return;
  const filtered = data
    .filter(d => d.symbol.endsWith("USDT"))
    .filter(d => Number(d.volume) > 2_000_000 && Number(d.priceChangePercent) > 0 && Number(d.priceChangePercent) < 5)
    .map(d => ({
      symbol: d.symbol,
      priceChangePercent: Number(d.priceChangePercent),
      quoteVolume: Number(d.quoteVolume),
      conf: 65 + Math.random() * 25,
      note: "📈 Early signal — coin showing pre-pump behavior"
    }))
    .sort((a, b) => b.conf - a.conf)
    .slice(0, 5);

  for (const c of filtered) await pushSignal("[EARLY ⚡]", c, c.conf);
  logv(`[EARLY] ${filtered.length} early coins detected`);
}

// ---------- PREBREAKOUT CORE LOOP ----------
async function mainLoop() {
  logv("[MAIN] scanning pre-breakout...");
  try {
    const list = await scanPreBreakout();
    if (Array.isArray(list) && list.length) {
      for (const coin of list) {
        const conf = coin.Conf || coin.conf || 75;
        const tag =
          coin.type === "IMF" ? "[FLOW]" :
          coin.type === "GOLDEN" ? "[GOLDEN]" : "[PRE]";
        await pushSignal(tag, coin, conf);
      }
      logv(`[MAIN] ${list.length} pre-breakout coins sent`);
    } else logv("[MAIN] no breakout found");
  } catch (e) {
    logv("[MAIN ERROR] " + e.message);
  }
}

// ---------- STARTUP ----------
(async () => {
  logv("[SPOT MASTER AI v4.1] Starting server...");
  await sendTelegram("<b>[SPOT MASTER AI v4.1]</b>\nModules: PRE + GOLDEN + EARLY + CACHE ✅");
  mainLoop();
  scanEarlyCoins();
  setInterval(mainLoop, SCAN_INTERVAL_MS);
  setInterval(scanEarlyCoins, EARLY_INTERVAL_MS);
  if (KEEP_ALIVE_URL)
    setInterval(() => fetch(KEEP_ALIVE_URL).catch(() => {}), KEEP_ALIVE_INTERVAL);
})();
