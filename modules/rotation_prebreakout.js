// --- rotation_prebreakout.js ---
// v3.6: Pre-Breakout Rotation Scanner + Confidence Engine + HyperSpikes Autosave
// Auto-detect fastest Binance API mirror.
// Author: ViXuan System Build

import fs from "fs/promises";
import path from "path";
import fetchNode from "node-fetch";
const fetch = global.fetch || fetchNode;

// ===================== AUTO PICK BINANCE API =====================
async function autoPickBinanceAPI() {
  const mirrors = [
    "https://api-gcp.binance.com",
    "https://api1.binance.com",
    "https://api3.binance.com",
    "https://api4.binance.com",
    "https://data-api.binance.vision"
  ];

  for (const url of mirrors) {
    try {
      const res = await fetch(`${url}/api/v3/ticker/24hr`);
      if (res.ok) {
        console.log(`[PREBREAKOUT] ✅ Selected Binance mirror: ${url}`);
        return url;
      } else {
        console.log(`[PREBREAKOUT] ⚠️ Mirror ${url} failed (${res.status})`);
      }
    } catch (e) {
      console.log(`[PREBREAKOUT] ❌ Mirror ${url} error: ${e.message}`);
    }
  }

  console.log("[PREBREAKOUT] ⚠️ All mirrors failed → fallback to data-api");
  return "https://data-api.binance.vision";
}

// --- Tự động chọn endpoint ---
const BINANCE_API = await autoPickBinanceAPI();
console.log("[PREBREAKOUT] Using Binance API:", BINANCE_API);

// ===================== CONFIG =====================
const MIN_VOL24H = 5_000_000;
const MAX_TICKERS = 120;
const CONF_THRESHOLD_SEND = 70;
const HYPER_SPIKE_THRESHOLD = 85;
const DATA_DIR = path.join(process.cwd(), "data");
const HYPER_FILE = path.join(DATA_DIR, "hyper_spikes.json");
const KLINES_LIMIT = 200;

// ===================== SAFE FETCH =====================
async function safeFetch(url, label = "BINANCE", retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (SpotMasterAI/3.6)",
          "Accept": "application/json",
        },
      });
      if (!resp.ok) {
        console.warn(`[${label}] Retry ${i + 1}/${retries + 1} → Status ${resp.status}`);
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
        continue;
      }
      return await resp.json();
    } catch (err) {
      console.warn(`[${label}] Retry ${i + 1}/${retries + 1} → ${err.message}`);
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw new Error(`${label} fetch failed after ${retries + 1} attempts`);
}

// ===================== UTIL =====================
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
function bollingerWidth(closeArr, period = 14, mult = 2) {
  const mb = sma(closeArr, period);
  const sd = stddev(closeArr, period);
  const up = mb + mult * sd;
  const dn = mb - mult * sd;
  const width = (up - dn) / (mb || 1);
  return { mb, up, dn, width };
}
function rsiFromArray(closes, period = 14) {
  if (closes.length < period + 1) return NaN;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ===================== FS HELPERS =====================
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {}
}
async function readHyperSpikes() {
  try {
    const txt = await fs.readFile(HYPER_FILE, "utf8");
    return JSON.parse(txt || "[]");
  } catch {
    return [];
  }
}
async function writeHyperSpikes(arr) {
  await ensureDataDir();
  await fs.writeFile(HYPER_FILE, JSON.stringify(arr, null, 2), "utf8");
}

// ===================== BINANCE WRAPPERS =====================
async function get24hTicker() {
  return await safeFetch(`${BINANCE_API}/api/v3/ticker/24hr`, "BINANCE 24h");
}
async function getKlines(symbol, interval = "1h", limit = KLINES_LIMIT) {
  return await safeFetch(`${BINANCE_API}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, "BINANCE KLINES");
}
function klinesCloseArray(klines) {
  return klines.map((k) => Number(k[4]));
}
function klinesVolumeArray(klines) {
  return klines.map((k) => Number(k[5]));
}

// ===================== CORE FORMULAS =====================
function computeConf({ RSI_H4, RSI_H1, VolNowRatio, BBWidth_H4, BTC_RSI }) {
  let Conf = 0;
  if (RSI_H4 > 45 && RSI_H4 < 60) Conf += 0.25;
  if (RSI_H1 > 50 && RSI_H1 < 70) Conf += 0.20;
  if (VolNowRatio > 1.8 && VolNowRatio < 3.5) Conf += 0.20;
  if (BBWidth_H4 < 0.6 * 1.0) Conf += 0.15;
  if (BTC_RSI > 35 && BTC_RSI < 65) Conf += 0.15;
  if (RSI_H1 > 75 || VolNowRatio > 4.5) Conf -= 0.15;
  return Math.round(Math.min(Math.max(Conf, 0), 1) * 100);
}

function isCompressed({ price, mb, up, dn, bbWidth, MA20 }) {
  if (bbWidth > 0.08) return false;
  const nearMA20 = Math.abs(price - MA20) / (MA20 || 1) < 0.03;
  const nearMiddle = Math.abs(price - mb) / (mb || 1) < 0.06;
  const notNearUpper = price < mb + (up - mb) * 0.7;
  return (nearMA20 || nearMiddle) && notNearUpper;
}

// ===================== MAIN SCANNER =====================
export async function scanRotationFlow() {
  try {
    const all24 = await get24hTicker();
    const usdt = all24
      .filter((t) => t.symbol.endsWith("USDT
