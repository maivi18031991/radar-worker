// rotation_prebreakout.js
// v2: real-data pre-breakout rotation scanner + conf calc + hyper_spikes autosave
// Requires Node >=16. Uses native fetch (node-fetch) if not present you should install / polyfill.

import fs from "fs/promises";
import path from "path";
import fetchNode from "node-fetch"; // keep for Node envs
const fetch = (global.fetch || fetchNode);

// ---------- CONFIG ----------
const MIN_VOL24H = 5_000_000;       // filter minimum 24h vol
const MAX_TICKERS = 120;           // max tickers to evaluate (top by vol)
const CONF_THRESHOLD_SEND = 70;    // >= send alert
const HYPER_SPIKE_THRESHOLD = 85;  // auto-save >= this
const DATA_DIR = path.join(process.cwd(), "data");
const HYPER_FILE = path.join(DATA_DIR, "hyper_spikes.json");

const BINANCE_API = "https://api-gcp.binance.com";
console.log("[PREBREAKOUT] Using Binance API:", BINANCE_API);
const KLINES_LIMIT = 200; // enough candles for indicators

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
// RSI (14) simple implementation
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
  const url = `${BINANCE_API}/api/v3/ticker/24hr`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("Binance 24h tickers failed");
  return await resp.json(); // array
}
async function getKlines(symbol, interval = "1h", limit = KLINES_LIMIT) {
  const url = `${BINANCE_API}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("Binance klines failed: " + symbol);
  return await resp.json(); // array of arrays
}

// safe parse price from klines
function klinesCloseArray(klines) { return klines.map(k => Number(k[4])); }
function klinesVolumeArray(klines) { return klines.map(k => Number(k[5])); }

// ---------- Confidence formula (from doc) ----------
function computeConf({ RSI_H4, RSI_H1, VolNowRatio, BBWidth_H4, BTC_RSI }) {
  let Conf = 0;
  if (RSI_H4 > 45 && RSI_H4 < 60) Conf += 0.25;
  if (RSI_H1 > 50 && RSI_H1 < 70) Conf += 0.20;
  if (VolNowRatio > 1.8 && VolNowRatio < 3.5) Conf += 0.20;
  if (BBWidth_H4 < BBWidth_H4_avg_factor(BBWidth_H4)) Conf += 0.15; // placeholder logic below
  if (BTC_RSI > 35 && BTC_RSI < 65) Conf += 0.15;

  // trap debias: reduce when H1 too high or huge vol spike
  if (RSI_H1 > 75 || VolNowRatio > 4.5) Conf -= 0.15;

  // clamp 0..1 then *100
  Conf = Math.min(Math.max(Conf, 0), 1) * 100;
  return Math.round(Conf);
}
// Small helper: compare BBWidth to historical average — we'll use threshold * 0.6 in doc
function BBWidth_H4_avg_factor(bbWidth) {
  // doc used: if (BBWidth_H4 < BBWidth_H4_avg * 0.6) Conf += ...
  // Here we don't have avg precomputed per-symbol; approximate by small constant 0.6 threshold
  return 0.6; // used as multiplier; callers check bbWidth < avg*0.6 -> we evaluate externally
}

// ---------- Compression filter: is coin "still compressed / not yet flown" ----------
function isCompressed({ price, mb, up, dn, bbWidth, MA20 }) {
  // heuristics:
  // - BBWidth low (bbWidth < 0.7 * averageFactor) -> currently using absolute threshold
  // - price within band near middle or lower (not near top)
  // - price close to MA20 (within 2%)
  if (bbWidth > 0.08) return false; // if BBWidth rather wide -> not compressed (tweakable)
  const nearMA20 = Math.abs(price - MA20) / (MA20 || 1) < 0.03; // within 3% of MA20
  const nearMiddle = Math.abs(price - mb) / (mb || 1) < 0.06;
  const notNearUpper = price < (mb + (up - mb) * 0.7);
  return (nearMA20 || nearMiddle) && notNearUpper;
}

// ---------- Main scan function ----------
export async function scanRotationFlow() {
  try {
    // 1) get 24h tickers, sort by quoteVolume desc to pick top (gives bigger pool)
    const all24 = await get24hTicker();
    // filter USDT pairs, numeric volume and min vol
    const usdt = all24.filter(t => t.symbol.endsWith("USDT"))
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

    // optional: fetch BTC RSI to add market bias
    let BTC_RSI = 50;
    try {
      const btc1h = await getKlines("BTCUSDT", "1h", 100);
      BTC_RSI = rsiFromArray(klinesCloseArray(btc1h), 14);
    } catch (e) { /* ignore */ }

    for (const t of usdt) {
      const symbol = t.symbol;
      try {
        // fetch klines 4h and 1h
        const k4 = await getKlines(symbol, "4h", 100).catch(()=>[]);
        const k1 = await getKlines(symbol, "1h", 100).catch(()=>[]);
        if (!k4.length || !k1.length) continue;

        const closes4 = klinesCloseArray(k4);
        const closes1 = klinesCloseArray(k1);
        const vols1 = klinesVolumeArray(k1);

        const RSI_H4 = Number((rsiFromArray(closes4, 14) || 0).toFixed(1));
        const RSI_H1 = Number((rsiFromArray(closes1, 14) || 0).toFixed(1));
        const bb = bollingerWidth(closes4, 14, 2);
        const BBWidth_H4 = Number((bb.width || 0).toFixed(3));
        const MA20 = sma(closes4, 20) || closes4[closes4.length-1];

        // VolNow: use latest 1h vol vs avg 24h: approximate avg24h = t.baseVolume / 24
        const VolNow = Number(vols1[vols1.length - 1] || 0);
        const avg24h_base = Number(t.baseVolume || 1) / 24;
        const VolNowRatio = avg24h_base ? VolNow / avg24h_base : 1;

        // price
        const price = closes1[closes1.length - 1];

        // compute Conf using documented heuristic
        const confInput = { RSI_H4, RSI_H1, VolNowRatio, BBWidth_H4, BTC_RSI };
        // use slightly refined conf formula:
        let Conf = 0;
        if (RSI_H4 > 45 && RSI_H4 < 60) Conf += 0.25;
        if (RSI_H1 > 50 && RSI_H1 < 70) Conf += 0.20;
        if (VolNowRatio > 1.8 && VolNowRatio < 3.5) Conf += 0.20;
        if (BBWidth_H4 < 0.6 * 1.0) Conf += 0.15; // using 0.6*1.0 as doc suggests (approx)
        if (BTC_RSI > 35 && BTC_RSI < 65) Conf += 0.15;
        // debias
        if (RSI_H1 > 75 || VolNowRatio > 4.5) Conf -= 0.15;
        Conf = Math.min(Math.max(Conf, 0), 1) * 100;
        Conf = Math.round(Conf);

        // compression filter
        const compressed = isCompressed({ price, mb: bb.mb, up: bb.up, dn: bb.dn, bbWidth: BBWidth_H4, MA20 });

        // build result
        const res = {
          symbol,
          price,
          RSI_H4, RSI_H1,
          BBWidth_H4,
          VolNow, VolNowRatio: Number(VolNowRatio.toFixed(2)),
          MA20: Number((MA20 || 0).toFixed(6)),
          Conf,
          BTC_RSI: Number((BTC_RSI || 0).toFixed(1)),
          compressed
        };

        // decide to send/save
        if (Conf >= CONF_THRESHOLD_SEND && compressed) {
          // message text
          const msg = [
            `🚀 [ROTATION FLOW | PRE-BREAKOUT]`,
            `Symbol: <b>${symbol}</b>`,
            `RSI(4h): ${RSI_H4.toFixed(1)} | RSI(1h): ${RSI_H1.toFixed(1)}`,
            `VolNow/Vol24h: ${VolNowRatio.toFixed(2)}x`,
            `BB(4h) Width: ${BBWidth_H4.toFixed(2)}`,
            `Conf: ${Conf}%`,
            `Bias: BTC ${BTC_RSI > 55 ? "UP" : BTC_RSI < 45 ? "DOWN" : "neutral"}`,
            `Note: SmartFlow Pre-Breakout Detected ✅`,
            `Time: ${new Date().toLocaleString("vi-VN")}`
          ].join("\n");

          // try to call global sendTelegram if exists
          try {
            if (typeof global.sendTelegram === "function") {
              await global.sendTelegram(msg);
            } else if (typeof sendTelegram === "function") { // fallback if available
              await sendTelegram(msg);
            } else {
              // do nothing (server can read returned results)
            }
          } catch (e) {
            console.log("[ROTATION] sendTelegram error:", e.message || e);
          }
        }

        // autosave hyper spikes
        if (Conf >= HYPER_SPIKE_THRESHOLD && compressed) {
          hyper.push({ ...res, ts: Date.now() });
        }

        results.push(res);

      } catch (e) {
        // skip symbol on error
        console.log("[ROTATION] err for", t.symbol, e.message || e);
      }
    } // end for

    // dedupe and write hyper
    if (hyper.length) {
      // keep last 500 entries max
      const uniq = hyper.slice(-500);
      await writeHyperSpikes(uniq);
    }

    // sort results by Conf desc
    results.sort((a,b) => b.Conf - a.Conf);

    console.log(`[ROTATION] scanned ${results.length} symbols, top Conf: ${results[0]?.symbol || "none"} ${results[0]?.Conf || 0}%`);
    return results;

  } catch (err) {
    console.error("[ROTATION] main error:", err?.message || err);
    return [];
  }
}

// ✅ Export chuẩn cho server_final_plus_prebreakout_v4.mjs
// Giúp server nhận tín hiệu từ PreBreakout full
export async function scanPreBreakout() {
  try {
    const data = await scanRotationFlow();   // Gọi core PreBreakout cũ
    if (!Array.isArray(data)) {
      console.warn("[PREBREAKOUT] scanRotationFlow() trả về không phải array");
      return [];
    }
    // lọc tín hiệu hợp lệ: có symbol + conf > 60%
    const valid = data.filter(x => x.symbol && x.conf >= 60);
    console.log(`[PREBREAKOUT] xuất ${valid.length} tín hiệu hợp lệ`);
    return valid;
  } catch (e) {
    console.error("[PREBREAKOUT] lỗi: " + e.message);
    return [];
  }
}
