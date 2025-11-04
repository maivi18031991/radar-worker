// --- early_pump_detector.js ---
// Spot Master AI v3.9 — Early Pump Detector PRO
// ✅ Detect compressed coins likely to pump within next 2–6 hours
// + Multi-API rotation
// + Local candle cache
// + Telegram push (optional)
// + Safe concurrent file writes

import fetchNode from "node-fetch";
const fetch = global.fetch || fetchNode;
import fs from "fs/promises";
import path from "path";
import { sendTelegram } from "../telegram.js"; // optional

const DATA_DIR = path.join(process.cwd(), "data");
const CACHE_FILE = path.join(DATA_DIR, "cache_klines.json");
const BINANCE_APIS = [
  "https://api-gcp.binance.com",
  "https://api1.binance.com",
  "https://api3.binance.com",
  "https://api4.binance.com",
  "https://data-api.binance.vision"
];
let apiIndex = 0;
function currentAPI() { return BINANCE_APIS[apiIndex % BINANCE_APIS.length]; }
function rotateAPI() {
  apiIndex = (apiIndex + 1) % BINANCE_APIS.length;
  console.log(`[EARLY] 🔁 Switched to ${currentAPI()}`);
}

const MIN_VOL24H = 2_000_000;
const MAX_TICKERS = 80;
const CONF_THRESHOLD = 65;

// --- Cache Loader ---
let cache = {};
async function loadCache() {
  try {
    const txt = await fs.readFile(CACHE_FILE, "utf8");
    cache = JSON.parse(txt || "{}");
  } catch {
    cache = {};
  }
}
async function saveCache() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch (e) {
    console.warn("[EARLY] cache save error:", e.message);
  }
}

// --- Safe Fetch with Retry & Mirror Rotation ---
async function safeFetch(url, label = "BINANCE", retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${currentAPI()}${url}`, {
        headers: { "User-Agent": "SpotMasterAI/3.9", "Accept": "application/json" },
        timeout: 8000
      });
      if (!res.ok) {
        if (res.status === 403 || res.status === 429) rotateAPI();
        await new Promise(r => setTimeout(r, 400 * (i + 1)));
        continue;
      }
      return await res.json();
    } catch (e) {
      console.warn(`[${label}] ${currentAPI()} failed:`, e.message);
      rotateAPI();
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw new Error(`[${label}] all API mirrors failed`);
}

// --- Indicators ---
function sma(a, n) { return a.slice(-n).reduce((x, y) => x + y, 0) / Math.min(a.length, n); }
function stddev(a, n) {
  const m = sma(a, n);
  return Math.sqrt(a.slice(-n).reduce((s, v) => s + (v - m) ** 2, 0) / n);
}
function bollingerWidth(a, n = 14, mult = 2) {
  const mb = sma(a, n), sd = stddev(a, n);
  return (2 * mult * sd) / (mb || 1);
}
function rsi(a, n = 14) {
  if (a.length < n + 1) return 50;
  let g = 0, l = 0;
  for (let i = a.length - n; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    if (d > 0) g += d; else l += -d;
  }
  if (l === 0) return 100;
  const rs = g / l;
  return 100 - (100 / (1 + rs));
}

// --- Detect Compression ---
function detectCompression(closes, vols) {
  const bbWidth = bollingerWidth(closes, 20, 2);
  const avgVol = sma(vols, 20);
  const volRatio = vols.at(-1) / (avgVol || 1);
  const priceSlope = (closes.at(-1) - closes.at(-10)) / closes.at(-10);
  const isCompressed = bbWidth < 0.04 && Math.abs(priceSlope) < 0.02;
  return { bbWidth, volRatio, isCompressed };
}

// --- Main Scan ---
export async function scanEarlyPump() {
  await loadCache();
  try {
    const tickers = await safeFetch("/api/v3/ticker/24hr", "TICKERS");
    const top = tickers
      .filter(t => t.symbol.endsWith("USDT") && Number(t.quoteVolume) > MIN_VOL24H)
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, MAX_TICKERS);

    const candidates = [];

    for (const t of top) {
      try {
        const key = `${t.symbol}_1h`;
        const cached = cache[key];
        let data = cached?.data;
        if (!data || Date.now() - cached.ts > 5 * 60 * 1000) {
          data = await safeFetch(`/api/v3/klines?symbol=${t.symbol}&interval=1h&limit=100`, t.symbol);
          cache[key] = { ts: Date.now(), data };
          await saveCache();
        }

        const closes = data.map(k => Number(k[4]));
        const vols = data.map(k => Number(k[5]));
        const RSI_H1 = rsi(closes, 14);
        const BB = detectCompression(closes, vols);

        let conf = 0;
        if (BB.isCompressed) conf += 0.4;
        if (RSI_H1 > 40 && RSI_H1 < 60) conf += 0.3;
        if (BB.volRatio > 1.2 && BB.volRatio < 2.5) conf += 0.2;
        conf = Math.min(conf, 1) * 100;

        if (conf >= CONF_THRESHOLD) {
          const result = {
            symbol: t.symbol,
            RSI_H1,
            bbWidth: BB.bbWidth,
            volRatio: BB.volRatio,
            conf: Math.round(conf),
            note: "Compression detected — early pump setup",
          };

          candidates.push(result);

          // optional Telegram push (nếu muốn nhận cảnh báo ngay)
          if (process.env.TELEGRAM_CHAT_ID && conf >= 75) {
            await sendTelegram(`
⚡ <b>[EARLY PUMP DETECTED]</b>
Symbol: ${t.symbol}
RSI(1h): ${RSI_H1.toFixed(1)}
BBWidth: ${(BB.bbWidth * 100).toFixed(2)}%
VolRatio: ${BB.volRatio.toFixed(2)}x
Conf: ${Math.round(conf)}%
🕒 Predicted window: next 2–6 hours
Time: ${new Date().toLocaleString("vi-VN")}
            `);
          }
        }
      } catch (e) {
        console.warn("[EARLY] skip", t.symbol, e.message);
      }
    }

    candidates.sort((a, b) => b.conf - a.conf);
    console.log(`[EARLY] ✅ ${candidates.length} potential setups`);
    return candidates;
  } catch (e) {
    console.error("[EARLY] Error:", e.message);
    return [];
  }
}
