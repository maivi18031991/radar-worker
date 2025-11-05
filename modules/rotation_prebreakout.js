/// --- rotation_prebreakout.js ---
// Spot Master AI v4.1 — Pre-Breakout Radar Module
// ✅ Multi-endpoint Binance API rotation
// ✅ Local candle cache
// ✅ Auto retry + rate-limit avoidance
// ✅ Hyper spikes + learning integration
// ✅ Render-compatible (HTTP keep-alive)

// Requires Node >=16
// npm i node-fetch

import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import fetchNode from "node-fetch";
const fetch = global.fetch || fetchNode;
import http from "http";

// ---------- CONFIG ----------
const MIRRORS_DEFAULT = [
  "https://api.binance.me",
  "https://api1.binance.me",
  "https://api3.binance.me",
  "https://api4.binance.me",
  "https://api1.binance.com",
  "https://api3.binance.com",
  "https://api4.binance.com",
  "https://api.binance.us",
  "https://data-api.binance.vision"
];

// ---------- API rotation (stable) ----------
const BINANCE_MIRRORS =
  (process.env.BINANCE_MIRRORS && process.env.BINANCE_MIRRORS.split(",")) ||
  MIRRORS_DEFAULT;

let apiIndex = 0;
function currentAPI() {
  if (!Array.isArray(BINANCE_MIRRORS) || BINANCE_MIRRORS.length === 0)
    return MIRRORS_DEFAULT[0];
  return BINANCE_MIRRORS[apiIndex % BINANCE_MIRRORS.length];
}
function rotateAPI() {
  if (!Array.isArray(BINANCE_MIRRORS) || BINANCE_MIRRORS.length === 0) {
    apiIndex = (apiIndex + 1) % MIRRORS_DEFAULT.length;
    console.log(`[PRE] 🔁 Mirror switched to ${MIRRORS_DEFAULT[apiIndex]}`);
    return;
  }
  apiIndex = (apiIndex + 1) % BINANCE_MIRRORS.length;
  console.log(`[PRE] 🔁 Mirror switched to ${currentAPI()}`);
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const PRIMARY_URL = process.env.PRIMARY_URL || "";
const KEEP_ALIVE_INTERVAL_MIN = Number(process.env.KEEP_ALIVE_INTERVAL_MIN || 10);
const SCAN_INTERVAL_MS = 30 * 1000;

const DATA_DIR = path.join(process.cwd(), "data");
const HYPER_FILE = path.join(DATA_DIR, "hyper_spikes.json");
const LEARN_FILE = path.join(DATA_DIR, "learning.json");
const CACHE_FILE = path.join(DATA_DIR, "cache.json");

// ---------- Thresholds ----------
const MIN_VOL24H = 5_000_000;
const MAX_TICKERS = 120;
const CONF_THRESHOLD_SEND = 70;
const HYPER_SPIKE_THRESHOLD = 85;
const KLINES_LIMIT = 200;

// ---------- Cache Utils ----------
async function readCache() {
  try {
    const txt = await fsPromises.readFile(CACHE_FILE, "utf8");
    return JSON.parse(txt || "{}");
  } catch {
    return {};
  }
}

async function writeCache(obj) {
  try {
    await fsPromises.mkdir(DATA_DIR, { recursive: true });
    await fsPromises.writeFile(CACHE_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch {}
}

async function getCached(symbol, interval) {
  const cache = await readCache();
  const key = `${symbol}_${interval}`;
  const now = Date.now();
  if (cache[key] && now - cache[key].ts < 5 * 60 * 1000) {
    return cache[key].data;
  }
  return null;
}

async function setCached(symbol, interval, data) {
  const cache = await readCache();
  cache[`${symbol}_${interval}`] = { ts: Date.now(), data };
  await writeCache(cache);
}

// ---------- Safe Fetch with Retry ----------
async function safeFetch(url, label = "BINANCE", retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${currentAPI()}${url}`, {
        headers: { "User-Agent": "SpotMasterAI/4.1" },
        timeout: 8000
      });
      if (!res.ok) {
        if (res.status === 403 || res.status === 429) rotateAPI();
        await new Promise(r => setTimeout(r, 300 * (i + 1)));
        continue;
      }
      return await res.json();
    } catch (err) {
      console.warn(`[${label}] ${currentAPI()} fail:`, err.message);
      rotateAPI();
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  console.error(`[${label}] ❌ all mirrors failed`);
  return null;
}

// ---------- Math Helpers ----------
function sma(arr, n) {
  if (!arr.length) return NaN;
  const slice = arr.slice(-n);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

function stddev(arr, n) {
  const slice = arr.slice(-n);
  const m = sma(slice, slice.length);
  const v = slice.reduce((s, x) => s + (x - m) ** 2, 0) / slice.length;
  return Math.sqrt(v);
}

function bollingerWidth(closeArr, period = 20, mult = 2) {
  const mb = sma(closeArr, period);
  const sd = stddev(closeArr, period);
  return (2 * mult * sd) / (mb || 1);
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ---------- Hyper Spike Utils ----------
async function readHyperSpikes() {
  try {
    const txt = await fsPromises.readFile(HYPER_FILE, "utf8");
    return JSON.parse(txt || "[]");
  } catch {
    return [];
  }
}

async function writeHyperSpikes(arr) {
  await fsPromises.mkdir(DATA_DIR, { recursive: true });
  await fsPromises.writeFile(HYPER_FILE, JSON.stringify(arr, null, 2), "utf8");
}

// ---------- Fetch Binance Data ----------
async function get24hTicker() {
  return await safeFetch("/api/v3/ticker/24hr", "TICKERS");
}

async function getKlines(symbol, interval) {
  const cached = await getCached(symbol, interval);
  if (cached) return cached;
  const res = await safeFetch(
    `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${KLINES_LIMIT}`,
    symbol
  );
  if (res && Array.isArray(res)) await setCached(symbol, interval, res);
  return res || [];
}

// ---------- Confidence Logic ----------
function computeConf({ RSI_H4, RSI_H1, VolNorm, BBWidth }) {
  let conf = 0;
  if (RSI_H4 > 40 && RSI_H4 < 65) conf += 0.3;
  if (RSI_H1 > 35 && RSI_H1 < 70) conf += 0.3;
  if (VolNorm > 1.2) conf += 0.2;
  if (BBWidth < 0.05) conf += 0.2;
  return Math.min(conf, 1) * 100;
}

// ---------- Main Pre-Breakout Scan ----------
export async function scanPreBreakout() {
  try {
    const tickers = await get24hTicker();
    if (!tickers) throw new Error("no ticker data");

    const top = tickers
      .filter(t => t.symbol.endsWith("USDT") && Number(t.quoteVolume) > MIN_VOL24H)
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, MAX_TICKERS);

    const candidates = [];
    for (const t of top) {
      try {
        const data = await getKlines(t.symbol, "1h");
        if (!Array.isArray(data) || data.length < 50) continue;

        const closes = data.map(k => Number(k[4]));
        const vols = data.map(k => Number(k[5]));
        const RSI_H1 = rsi(closes, 14);
        const BB = bollingerWidth(closes, 20);
        const VolNorm = vols.at(-1) / (sma(vols, 20) || 1);
        const RSI_H4 = rsi(closes.slice(-80), 14);

        const conf = computeConf({ RSI_H4, RSI_H1, VolNorm, BBWidth: BB });

        if (conf >= CONF_THRESHOLD_SEND) {
          candidates.push({
            symbol: t.symbol,
            conf: Math.round(conf),
            RSI_H1,
            RSI_H4,
            BBWidth: BB,
            VolNorm,
          });
        }
      } catch (err) {
        console.warn("[PRE] skip", t.symbol, err.message);
      }
    }

    candidates.sort((a, b) => b.conf - a.conf);
    console.log(`[PRE] ✅ ${candidates.length} setups detected`);
    return candidates;
  } catch (err) {
    console.error("[PRE] Error:", err.message);
    return [];
  }
}

// ---------- Keep-alive for Render ----------
const PORT = process.env.PORT || 10000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("✅ Radar Worker running fine");
});
server.listen(PORT, () => {
  console.log(`[RENDER FIX] Listening on port ${PORT}`);
});

// ping to PRIMARY_URL to prevent sleeping
if (PRIMARY_URL) {
  setInterval(() => {
    try {
      fetch(PRIMARY_URL);
      console.log("[KEEPALIVE] ping sent to PRIMARY_URL");
    } catch {}
  }, KEEP_ALIVE_INTERVAL_MIN * 60 * 1000);
}
