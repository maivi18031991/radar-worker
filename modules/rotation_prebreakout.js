// rotation_prebreakout.js
// v2: real-data pre-breakout rotation scanner + conf calc + hyper_spikes autosave
// Requires Node >=16. Uses native fetch (node-fetch) if not present you should install / polyfill.

import fs from "fs/promises";
import path from "path";
import fetchNode from "node-fetch"; // keep for Node envs
const fetch = (global.fetch || fetchNode);

// ---------- CONFIG ----------
const BINANCE_API = process.env.BINANCE_API || "https://api-gcp.binance.com";  // ✅ fix endpoint Render
const MIN_VOL24H = 5_000_000;       // filter minimum 24h vol
const MAX_TICKERS = 120;           // max tickers to evaluate (top by vol)
const CONF_THRESHOLD_SEND = 70;    // >= send alert
const HYPER_SPIKE_THRESHOLD = 85;  // auto-save >= this
const DATA_DIR = path.join(process.cwd(), "data");
const HYPER_FILE = path.join(DATA_DIR, "hyper_spikes.json");
const KLINES_LIMIT = 200; // enough candles for indicators

console.log("[PREBREAKOUT] Using Binance API:", BINANCE_API);

// ---------- Safe fetch helper ----------
async function safeFetch(url, label = "BINANCE", retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (SpotMasterAI/3.6)",
          "Accept": "application/json"
        }
      });
      if (!resp.ok) {
        console.error(`[${label}] Fetch failed (${resp.status})`);
        await new Promise(r => setTimeout(r, 300 * (i + 1)));
        continue;
      }
      return await resp.json();
    } catch (err) {
      console.error(`[${label}] Fetch error:`, err.message);
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw new Error(`${label} fetch failed after ${retries + 1} attempts`);
}

// ---------- UTIL: basic indicators ----------
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

// ---------- FS helpers ----------
async function ensureDataDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch (e) {}
}
async function readHyperSpikes() {
  try {
    const txt = await fs.readFile(HYPER_FILE, "utf8");
    return JSON.parse(txt || "[]");
  } catch (e) { return []; }
}
async function writeHyperSpikes(arr) {
  await ensureDataDir();
  await fs.writeFile(HYPER_FILE, JSON.stringify(arr, null, 2), "utf8");
}

// ---------- Binance helpers ----------
async function get24hTicker() {
  return await safeFetch(`${BINANCE_API}/api/v3/ticker/24hr`, "BINANCE 24h");
}
async function getKlines(symbol, interval = "1h", limit = KLINES_LIMIT) {
  return await safeFetch(`${BINANCE_API}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, "BINANCE KLINES");
}

function klinesCloseArray(klines) { return klines.map(k => Number(k[4])); }
function klinesVolumeArray(klines) { return klines.map(k => Number(k[5])); }

// ---------- Confidence formula ----------
function computeConf({ RSI_H4, RSI_H1, VolNowRatio, BBWidth_H4, BTC_RSI }) {
  let Conf = 0;
  if (RSI_H4 > 45 && RSI_H4 < 60) Conf += 0.25;
  if (RSI_H1 > 50 && RSI_H1 < 70) Conf += 0.20;
  if (VolNowRatio > 1.8 && VolNowRatio < 3.5) Conf += 0.20;
  if (BBWidth_H4 < 0.6 * 1.0) Conf += 0.15;
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

// ---------- Main scan ----------
export async function scanRotationFlow() {
  try {
    const all24 = await get24hTicker();
    const usdt = all24
      .filter(t => t.symbol.endsWith("USDT"))
      .map(t => ({ symbol: t.symbol, vol24: Number(t.quoteVolume || t.volume || 0), baseVolume: Number(t.volume || 0) }))
      .filter(t => t.vol24 >= MIN_VOL24H)
      .sort((a,b) => b.vol24 - a.vol24)
      .slice(0, MAX_TICKERS);

    if (!usdt.length) {
      console.log("[ROTATION] no USDT tickers pass min vol");
      return [];
    }

    const results = [];
    const hyper = await readHyperSpikes();
    let BTC_RSI = 50;
    try {
      const btc1h = await getKlines("BTCUSDT", "1h", 100);
      BTC_RSI = rsiFromArray(klinesCloseArray(btc1h), 14);
    } catch {}

    for (const t of usdt) {
      try {
        const k4 = await getKlines(t.symbol, "4h", 100).catch(()=>[]);
        const k1 = await getKlines(t.symbol, "1h", 100).catch(()=>[]);
        if (!k4.length || !k1.length) continue;

        const closes4 = klinesCloseArray(k4);
        const closes1 = klinesCloseArray(k1);
        const vols1 = klinesVolumeArray(k1);

        const RSI_H4 = rsiFromArray(closes4, 14);
        const RSI_H1 = rsiFromArray(closes1, 14);
        const bb = bollingerWidth(closes4, 14, 2);
        const BBWidth_H4 = bb.width;
        const MA20 = sma(closes4, 20);
        const VolNow = vols1[vols1.length - 1];
        const avg24h = t.baseVolume / 24;
        const VolNowRatio = avg24h ? VolNow / avg24h : 1;
        const price = closes1[closes1.length - 1];
        const Conf = computeConf({ RSI_H4, RSI_H1, VolNowRatio, BBWidth_H4, BTC_RSI });
        const compressed = isCompressed({ price, mb: bb.mb, up: bb.up, dn: bb.dn, bbWidth: BBWidth_H4, MA20 });

        const res = { symbol: t.symbol, price, RSI_H4, RSI_H1, BBWidth_H4, VolNowRatio, Conf, compressed };
        if (Conf >= CONF_THRESHOLD_SEND && compressed) console.log(`[PREBREAKOUT] ${t.symbol} Conf=${Conf}`);
        if (Conf >= HYPER_SPIKE_THRESHOLD && compressed) hyper.push({ ...res, ts: Date.now() });
        results.push(res);
      } catch (e) { console.log("[ROTATION] err for", t.symbol, e.message); }
    }

    if (hyper.length) await writeHyperSpikes(hyper.slice(-500));
    results.sort((a,b) => b.Conf - a.Conf);
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
