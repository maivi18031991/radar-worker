// rotation_prebreakout.js
// ✅ Version 4.1 — fully compatible with Spot Master AI v3.9 server
// Features:
//  - Multi-endpoint Binance API rotation (anti-block)
//  - Local candle cache (avoid rate-limit)
//  - Full async + auto retry
//  - Compatible with hyper_spikes + learning engine

import fs from "fs/promises";
import path from "path";
import fetchNode from "node-fetch";
const fetch = (global.fetch || fetchNode);

// ---------- CONFIG ----------
const API_LIST = [
  "https://api-gcp.binance.com",
  "https://api1.binance.com",
  "https://api3.binance.com",
  "https://api4.binance.com",
  "https://api.binance.com",
  "https://data-api.binance.vision"
];
let apiIndex = 0;
function currentApi() { return API_LIST[apiIndex % API_LIST.length]; }
function rotateApi() {
  apiIndex = (apiIndex + 1) % API_LIST.length;
  console.log(`[CACHE] 🔁 Mirror switched to: ${currentApi()}`);
}

const DATA_DIR = path.join(process.cwd(), "data");
const HYPER_FILE = path.join(DATA_DIR, "hyper_spikes.json");
const CACHE_FILE = path.join(DATA_DIR, "cache_candles.json");
const MIN_VOL24H = 5_000_000;
const MAX_TICKERS = 120;
const CONF_THRESHOLD_SEND = 70;
const HYPER_SPIKE_THRESHOLD = 85;
const KLINES_LIMIT = 200;

// ---------- Local Candle Cache ----------
async function readCache() {
  try {
    const txt = await fs.readFile(CACHE_FILE, "utf8");
    return JSON.parse(txt || "{}");
  } catch {
    return {};
  }
}
async function writeCache(obj) {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(obj, null, 2), "utf8");
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
async function safeFetch(url, label = "BINANCE", retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "SpotMasterAI/3.9", "Accept": "application/json" },
        timeout: 8000
      });
      if (!resp.ok) {
        console.error(`[${label}] Error ${resp.status}`);
        if (resp.status === 403 || resp.status === 429) rotateApi();
        await new Promise(r => setTimeout(r, 400 * (i + 1)));
        continue;
      }
      return await resp.json();
    } catch (err) {
      console.error(`[${label}] fetch fail ${err.message}`);
      rotateApi();
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  console.error(`[${label}] failed after ${retries + 1} attempts`);
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
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ---------- File Helpers ----------
async function ensureDataDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {}
}
async function readHyperSpikes() {
  try {
    const txt = await fs.readFile(HYPER_FILE, "utf8");
    return JSON.parse(txt || "[]");
  } catch { return []; }
}
async function writeHyperSpikes(arr) {
  await ensureDataDir();
  await fs.writeFile(HYPER_FILE, JSON.stringify(arr, null, 2), "utf8");
}

// ---------- Binance Data Fetchers ----------
async function get24hTicker() {
  return await safeFetch(`${currentApi()}/api/v3/ticker/24hr`, "24h");
}
async function getKlines(symbol, interval = "1h", limit = KLINES_LIMIT) {
  const cached = await getCached(symbol, interval);
  if (cached) return cached;
  const res = await safeFetch(`${currentApi()}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, "KLINES");
  if (res && Array.isArray(res)) await setCached(symbol, interval, res);
  return res || [];
}

// ---------- Confidence ----------
function computeConf({ RSI_H4, RSI_H1, VolNowRatio, BBWidth_H4, BTC_RSI }) {
  let Conf = 0;
  if (RSI_H4 > 45 && RSI_H4 < 60) Conf += 0.25;
  if (RSI_H1 > 50 && RSI_H1 < 70) Conf += 0.20;
  if (VolNowRatio > 1.8 && VolNowRatio < 3.5) Conf += 0.20;
  if (BBWidth_H4 < 0.6) Conf += 0.15;
  if (BTC_RSI > 35 && BTC_RSI < 65) Conf += 0.15;
  if (RSI_H1 > 75 || VolNowRatio > 4.5) Conf -= 0.15;
  Conf = Math.min(Math.max(Conf, 0), 1) * 100;
  return Math.round(Conf);
}
function isCompressed({ price, mb, up, dn, bbWidth, MA20 }) {
  if (bbWidth > 0.08) return false;
  const nearMA20 = Math.abs(price - MA20) / (MA20 || 1) < 0.03;
  const nearMiddle = Math.abs(price - mb) / (mb || 1) < 0.06;
  const notNearUpper = price < (mb + (up - mb) * 0.7);
  return (nearMA20 || nearMiddle) && notNearUpper;
}

// ---------- Main Scan ----------
export async function scanRotationFlow() {
  try {
    const all24 = await get24hTicker();
    if (!all24) return [];

    const usdt = all24
      .filter(t => t.symbol.endsWith("USDT"))
      .map(t => ({ symbol: t.symbol, vol24: Number(t.quoteVolume || t.volume || 0), baseVolume: Number(t.volume || 0) }))
      .filter(t => t.vol24 >= MIN_VOL24H)
      .sort((a, b) => b.vol24 - a.vol24)
      .slice(0, MAX_TICKERS);

    if (!usdt.length) {
      console.log("[ROTATION] No tickers pass min vol");
      return [];
    }

    const results = [];
    const hyper = await readHyperSpikes();
    let BTC_RSI = 50;
    try {
      const btc1h = await getKlines("BTCUSDT", "1h", 100);
      BTC_RSI = rsiFromArray(btc1h.map(k => Number(k[4])), 14);
    } catch {}

    for (const t of usdt) {
      try {
        const k4 = await getKlines(t.symbol, "4h", 100);
        const k1 = await getKlines(t.symbol, "1h", 100);
        if (!k4.length || !k1.length) continue;

        const closes4 = k4.map(k => Number(k[4]));
        const closes1 = k1.map(k => Number(k[4]));
        const vols1 = k1.map(k => Number(k[5]));

        const RSI_H4 = rsiFromArray(closes4, 14);
        const RSI_H1 = rsiFromArray(closes1, 14);
        const bb = bollingerWidth(closes4, 14, 2);
        const BBWidth_H4 = bb.width;
        const MA20 = sma(closes4, 20);
        const VolNow = vols1.at(-1);
        const avg24h = t.baseVolume / 24;
        const VolNowRatio = avg24h ? VolNow / avg24h : 1;
        const price = closes1.at(-1);
        const Conf = computeConf({ RSI_H4, RSI_H1, VolNowRatio, BBWidth_H4, BTC_RSI });
        const compressed = isCompressed({ price, mb: bb.mb, up: bb.up, dn: bb.dn, bbWidth: BBWidth_H4, MA20 });

        const res = { symbol: t.symbol, price, RSI_H4, RSI_H1, BBWidth_H4, VolNowRatio, Conf, compressed };

        if (Conf >= CONF_THRESHOLD_SEND && compressed)
          console.log(`[PREBREAKOUT] ${t.symbol} Conf=${Conf}`);
        if (Conf >= HYPER_SPIKE_THRESHOLD && compressed)
          hyper.push({ ...res, ts: Date.now() });

        results.push(res);
      } catch (e) {
        console.log("[ROTATION] err for", t.symbol, e.message);
      }
    }

    if (hyper.length) await writeHyperSpikes(hyper.slice(-500));
    results.sort((a, b) => b.Conf - a.Conf);
    console.log(`[ROTATION] scanned ${results.length} symbols, top: ${results[0]?.symbol || "none"} ${results[0]?.Conf || 0}%`);
    return results;

  } catch (err) {
    console.error("[ROTATION] main error:", err.message);
    return [];
  }
}

export async function scanPreBreakout() {
  try {
    const data = await scanRotationFlow();
    if (!Array.isArray(data)) return [];
    const valid = data.filter(x => x.symbol && x.Conf >= 60);
    console.log(`[PREBREAKOUT] xuất ${valid.length} tín hiệu hợp lệ`);
    return valid;
  } catch (e) {
    console.error("[PREBREAKOUT] lỗi:", e.message);
    return [];
  }
}
