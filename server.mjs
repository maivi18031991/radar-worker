// server_full_no_trim_v1.mjs
// SPOT MASTER AI - Full single-file build
// - PreBreakout (real-data), Early Pump Detector, Spot/Golden routing
// - Auto-rotate Binance API mirrors (handles 429/451/403/5xx)
// - Learning engine hooks (recordSignal/checkOutcomes/auto-adjust skeleton)
// - Push to Telegram
// - Keep-alive ping, interval: 30s (configurable)
// Author: integrated for ViXuan system (based on user's code)

// Requires Node >=16 and install node-fetch if running in Node env:
// npm i node-fetch

import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import http from "http";
import fetchNode from "node-fetch"; // keep for Node envs
const fetch = (global.fetch || fetchNode);
const LOG_DEBUG = process.env.LOG_DEBUG === "true";
// ---------- CONFIG ----------
// === Full mirror list (v3.8 anti-451) ===
const MIRRORS_DEFAULT = [
  "https://api.binance.me",             // global mirror (preferred)
  "https://api1.binance.me",
  "https://api3.binance.me",
  "https://api4.binance.me",
  "https://api1.binance.com",
  "https://api3.binance.com",
  "https://api4.binance.com",
  "https://api.binance.us",             // ✅ bypass 451 (US mirror)
  "https://data-api.binance.vision"     // ✅ open data proxy
];

const BINANCE_MIRRORS = (process.env.BINANCE_MIRRORS && process.env.BINANCE_MIRRORS.split(",")) || MIRRORS_DEFAULT;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const PRIMARY_URL = process.env.PRIMARY_URL || "";
const KEEP_ALIVE_INTERVAL_MIN = Number(process.env.KEEP_ALIVE_INTERVAL || 10); // minutes
const SCAN_INTERVAL_MS = 30 * 1000; // user requested 30s
const DATA_DIR = path.join(process.cwd(), "data");
const HYPER_FILE = path.join(DATA_DIR, "hyper_spikes.json");
const LEARN_FILE = path.join(DATA_DIR, "learning.json");
const DYN_CONFIG_FILE = path.join(DATA_DIR, "dynamic_config.json");

// PreBreakout settings
const MIN_VOL24H = Number(process.env.MIN_VOL24H || 5_000_000);
const MAX_TICKERS = Number(process.env.MAX_TICKERS || 120);
const CONF_THRESHOLD_SEND = Number(process.env.CONF_THRESHOLD_SEND || 70);
const HYPER_SPIKE_THRESHOLD = Number(process.env.HYPER_SPIKE_THRESHOLD || 85);
const KLINES_LIMIT = Number(process.env.KLINES_LIMIT || 200);

// Early detector settings
const EARLY_VOL_MULT = Number(process.env.EARLY_VOL_MULT || 2.2); // vol vs avg24h
const EARLY_PRICE_CHANGE_MAX = Number(process.env.EARLY_PRICE_CHANGE_MAX || 10); // 24h price change threshold for "still early"

// Learning engine defaults
const TRAIN_FAST_MODE = false;
const MIN_SIGNALS_TO_TUNE = Number(process.env.MIN_SIGNALS_TO_TUNE || 20);
const CHECK_HOURS = Number(process.env.LEARNING_CHECK_HOURS || 24);

// Logger util
function logv(msg) {
  const s = `[${new Date().toLocaleString("vi-VN")}] ${msg}`;
  console.log(s);
  try { fs.appendFileSync(path.resolve("./server_log.txt"), s + "\n"); } catch (e) {}
}

// ---------------- API rotation & safe fetch ----------------
let SELECTED_BINANCE = null;

// Try mirrors and pick first that returns ok for 24hr endpoint
async function autoPickBinanceAPI() {
  for (const url of BINANCE_MIRRORS) {
    try {
      const test = await fetch(`${url}/api/v3/ticker/24hr`, { method: "GET", headers: { "User-Agent": "SpotMasterAI/3.6" }, timeout: 5000 });
      if (test && test.ok) {
        logv(`[API] ✅ Selected working endpoint: ${url}`);
        SELECTED_BINANCE = url;
        return url;
      } else {
        logv(`[API] mirror failed (${url}) status:${test?.status}`);
      }
    } catch (e) {
      logv(`[API] mirror error ${url} -> ${e.message}`);
    }
  }
  // fallback to first mirror if none respond
  SELECTED_BINANCE = BINANCE_MIRRORS[0];
  logv(`[API] ⚠ No mirror passed test - fallback to ${SELECTED_BINANCE}`);
  return SELECTED_BINANCE;
}

// rotate to next mirror in list (used when 429/451/403/5xx encountered)
function rotateBinanceAPI() {
  try {
    const idx = BINANCE_MIRRORS.indexOf(SELECTED_BINANCE);
    const next = BINANCE_MIRRORS[(idx + 1) % BINANCE_MIRRORS.length];
    SELECTED_BINANCE = next;
    logv(`[API] 🔁 rotated endpoint -> ${SELECTED_BINANCE}`);
    return SELECTED_BINANCE;
  } catch (e) {
    SELECTED_BINANCE = BINANCE_MIRRORS[0];
    return SELECTED_BINANCE;
  }
}

// === Safe fetch with intelligent rotate + retry ===
async function safeFetchJSON(urlPath, label = "API", retries = 3) {
  let base = SELECTED_BINANCE || (await autoSelectBinance());
  const headers = { "User-Agent": "RadarWorker/1.0" };

  for (let attempt = 0; attempt <= retries; attempt++) {
    const url = urlPath.startsWith("http") ? urlPath : `${base}${urlPath}`;

    try {
      const res = await fetch(url, { headers });

      if (!res) throw new Error("No response from fetch");
      if (!res.ok) {
        const status = res.status;

        // nếu bị chặn 451 hoặc lỗi 429 -> rotate endpoint
        if ([429, 451, 403, 502, 503, 504].includes(status)) {
          logv(`[API] Detected blocked (${status}), rotating...`);
          rotateBinanceAPI();

          // nếu là 451 thì thử vision API
          if (status === 451) {
            try {
              const alt = url.replace(base, "https://data-api.binance.vision");
              const altRes = await fetch(alt, { headers });
              if (altRes.ok) {
                logv(`[API] ✅ vision fallback ok`);
                return await altRes.json();
              }
            } catch (e2) {
              logv(`[API] vision fallback failed: ${e2.message}`);
            }
          }
        }

        // đợi 300ms rồi thử lại
        await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }

      // nếu OK thì parse JSON
      const j = await res.json();
      return j;

    } catch (err) {
      logv(`[SAFEFETCH] Fetch failed for ${url}: ${err.message}`);
      base = rotateBinanceAPI(); // thử mirror khác
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }

  // nếu vẫn thất bại sau retries lần
  throw new Error(`${label} fetch failed after ${retries} retries`);
}
// ------------------ FS helpers ------------------
async function ensureDataDir() {
  try { await fsPromises.mkdir(DATA_DIR, { recursive: true }); } catch (e) {}
}
async function readHyperSpikes() {
  try { const txt = await fsPromises.readFile(HYPER_FILE, "utf8"); return JSON.parse(txt || "[]"); } catch (e) { return []; }
}
async function writeHyperSpikes(arr) {
  try { await ensureDataDir(); await fsPromises.writeFile(HYPER_FILE, JSON.stringify(arr, null, 2), "utf8"); } catch (e) { logv("[FS] writeHyperSpikes error " + e.message); }
}
async function loadLearningData() {
  try { const txt = await fsPromises.readFile(LEARN_FILE, "utf8"); return JSON.parse(txt); } catch (e) { return { signals: {}, stats: {} }; }
}
async function saveLearningData(d) {
  try { await ensureDataDir(); await fsPromises.writeFile(LEARN_FILE, JSON.stringify(d, null, 2), "utf8"); } catch (e) { logv("[LEARN] save error " + e.message); }
}
async function saveDynamicConfig(cfg) {
  try { await ensureDataDir(); await fsPromises.writeFile(DYN_CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8"); } catch (e) { logv("[LEARN] save dyn config error " + e.message); }
}

// ------------------ Indicators & utils ------------------
function sma(arr, n) {
  if (!arr || !arr.length) return NaN;
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
  if (!closes || closes.length < period + 1) return NaN;
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
function klinesCloseArray(klines) { return klines.map(k => Number(k[4])); }
function klinesVolumeArray(klines) { return klines.map(k => Number(k[5])); }

// ------------------ Confidence & compression ------------------
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

// ------------------ Telegram ------------------
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    logv("[TELEGRAM] missing TOKEN/CHAT_ID");
    return;
  }

  const mainUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };

  try {
    // --- kiểm tra Telegram token có hoạt động không ---
    const testUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe`;
    const t = await fetch(testUrl);
    logv(`[TELEGRAM TEST] status ${t.status}`);
    // ---------------------------------------------------

    const res = await fetch(mainUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      logv(`[TELEGRAM] send failed ${res.status}`);

      // nếu bị block hoặc timeout → fallback sang proxy an toàn
      if ([403, 404, 408, 429, 502, 503, 504].includes(res.status)) {
        const proxyUrl = `https://api-tg.vercel.app/bot${TELEGRAM_TOKEN}/sendMessage`;
        try {
          const r2 = await fetch(proxyUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
          });
          logv(`[TELEGRAM] fallback proxy ${r2.ok ? "✅ success" : "❌ failed"} (${r2.status})`);
        } catch (e2) {
          logv(`[TELEGRAM] proxy fetch error ${e2.message}`);
        }
      }
    }
  } catch (e) {
    logv("[TELEGRAM] error " + e.message);
  }
}

// ------------------ Unified push (with anti-spam) ------------------
let lastPush = {}; // cache tín hiệu đã gửi để tránh spam

async function pushSignal(tag, data, conf = 70) {
  try {
    if (!data || !data.symbol) return;
    const sym = data.symbol.replace("USDT", "");
    const vol = (data.quoteVolume || data.VolNow || 0).toLocaleString();
    const chg = data.priceChangePercent || data.change24h || 0;
    const note = data.note || "Auto signal";

    const key = `${tag}_${sym}`;
    const now = Date.now();

    // --- chống spam: nếu đã gửi trong vòng 5 phút thì bỏ qua ---
    if (lastPush[key] && now - lastPush[key] < 5 * 60 * 1000) {
      logv(`[PUSH] skip duplicate ${sym} (sent <5min)`);
      return;
    }
    lastPush[key] = now;
    // ------------------------------------------------------------

    const msg = `
<b>${tag}</b> ${sym}USDT
Δ24h: <b>${(typeof chg === "number" ? chg.toFixed(2) : Number(chg || 0).toFixed(2))}%</b> | Conf: ${conf}%
Vol: ${vol}
Note: ${note}
Time: ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Ho_Chi_Minh" })}
`;

    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) await sendTelegram(msg);
    logv("[PUSH] " + sym + " " + (typeof chg === "number" ? chg.toFixed(2) : Number(chg || 0).toFixed(2)) + "% sent");
  } catch (err) {
    console.error("[pushSignal ERROR]", err.message || err);
  }
}
// ------------------ PreBreakout core (rotation) ------------------
async function get24hTickers() {
  // returns array
  const j = await safeFetchJSON(`/api/v3/ticker/24hr`, "BINANCE 24h", 2, 7000);
  if (!Array.isArray(j)) throw new Error("24hr ticker response not array");
  return j;
}
async function getKlines(symbol, interval = "1h", limit = KLINES_LIMIT) {
  const q = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const j = await safeFetchJSON(q, "BINANCE KLINES", 2, 9000);
  if (!Array.isArray(j)) throw new Error(`klines not array for ${symbol}`);
  return j;
}

async function scanRotationFlow() {
  try {
    const all24 = await get24hTickers(); // may throw
    const usdt = all24.filter(t => t.symbol && t.symbol.endsWith("USDT"))
      .map(t => ({ symbol: t.symbol, vol24: Number(t.quoteVolume || t.volume || 0), baseVolume: Number(t.volume || 0), priceChangePercent: Number(t.priceChangePercent || 0), quoteVolume: Number(t.quoteVolume || 0) }))
      .filter(t => t.vol24 >= MIN_VOL24H)
      .sort((a,b) => b.vol24 - a.vol24)
      .slice(0, MAX_TICKERS);
    if (!usdt.length) {
      logv("[ROTATION] no USDT tickers pass min vol");
      return [];
    }
    if (LOG_DEBUG) logv(`[DEBUG] Scanning ${usdt.length} tickers with minVol ${MIN_VOL24H}`);
    const results = [];
    const hyper = await readHyperSpikes();
    // btc rsi
    let BTC_RSI = 50;
    try {
      const btc1h = await getKlines("BTCUSDT", "1h", 100);
      BTC_RSI = rsiFromArray(klinesCloseArray(btc1h), 14);
    } catch (e) {}
    for (const t of usdt) {
      try {
        const k4 = await getKlines(t.symbol, "4h", 100).catch(()=>[]);
        const k1 = await getKlines(t.symbol, "1h", 100).catch(()=>[]);
        if (!k4.length || !k1.length) continue;
        if (LOG_DEBUG) logv(`[DEBUG] Checking ${t.symbol} | 24hVol: ${t.vol24.toFixed(0)} | Δ${t.priceChangePercent}%`);
        const closes4 = klinesCloseArray(k4);
        const closes1 = klinesCloseArray(k1);
        const vols1 = klinesVolumeArray(k1);
        const RSI_H4 = Number((rsiFromArray(closes4, 14) || 0).toFixed(1));
        const RSI_H1 = Number((rsiFromArray(closes1, 14) || 0).toFixed(1));
        const bb = bollingerWidth(closes4, 14, 2);
        const BBWidth_H4 = Number((bb.width || 0).toFixed(3));
        const MA20 = Number((sma(closes4, 20) || closes4[closes4.length-1]).toFixed(6));
        const VolNow = Number(vols1[vols1.length - 1] || 0);
        const avg24h_base = Number(t.baseVolume || 1) / 24;
        const VolNowRatio = avg24h_base ? Number((VolNow / avg24h_base).toFixed(2)) : 1;
        const price = Number(closes1[closes1.length - 1] || 0);
        const Conf = computeConf({ RSI_H4, RSI_H1, VolNowRatio, BBWidth_H4, BTC_RSI });
        const compressed = isCompressed({ price, mb: bb.mb, up: bb.up, dn: bb.dn, bbWidth: BBWidth_H4, MA20 });
        const res = {
          symbol: t.symbol,
          price,
          RSI_H4, RSI_H1,
          BBWidth_H4,
          VolNow,
          VolNowRatio,
          MA20,
          Conf,
          BTC_RSI: Number((BTC_RSI || 0).toFixed(1)),
          compressed,
          quoteVolume: t.quoteVolume || 0,
          priceChangePercent: t.priceChangePercent || 0,
        };
        if (Conf >= CONF_THRESHOLD_SEND && compressed) {
          logv(`[PREBREAKOUT] ${t.symbol} Conf=${Conf}`);
        }
        if (Conf >= HYPER_SPIKE_THRESHOLD && compressed) hyper.push({ ...res, ts: Date.now() });
        results.push(res);
      } catch (e) {
        console.log("[ROTATION] err for", t.symbol, e?.message || e);
      }
    }
    if (hyper.length) await writeHyperSpikes(hyper.slice(-500));
    results.sort((a,b) => b.Conf - a.Conf);
    logv(`[ROTATION] scanned ${results.length} symbols, top: ${results[0]?.symbol || "none"} ${results[0]?.Conf || 0}%`);
    return results;
  } catch (err) {
    logv("[ROTATION] main error: " + err.message);
    return [];
  }
}
async function scanPreBreakout() {
  try {
    const data = await scanRotationFlow();
    if (!Array.isArray(data)) return [];
    const valid = data.filter(x => x.symbol && x.Conf >= 60);
    logv(`[PREBREAKOUT] xuất ${valid.length} tín hiệu hợp lệ`);
    return valid;
  } catch (e) {
    logv("[PREBREAKOUT] lỗi: " + e.message);
    return [];
  }
}

// ------------------ Early Pump Detector ------------------
async function scanEarlyPump() {
  try {
    const all24 = await get24hTickers();
    if (LOG_DEBUG) logv(`[DEBUG] Starting Early Pump scan...`);
    const usdt = all24.filter(t => t.symbol && t.symbol.endsWith("USDT"))
      .map(t => ({ symbol: t.symbol, vol24: Number(t.quoteVolume || t.volume || 0), baseVolume: Number(t.volume || 0), priceChangePercent: Number(t.priceChangePercent || 0), quoteVolume: Number(t.quoteVolume || 0) }))
      .filter(t => t.vol24 >= 200_000) // lower threshold so early can see smaller but real moves
      .sort((a,b) => Number(b.priceChangePercent) - Number(a.priceChangePercent))
      .slice(0, 250); // scan reasonable set for early signals

    const results = [];
    for (const t of usdt) {
      try {
        // simple early heuristic: 1h vol spike vs avg24h_base and priceChange not already huge
        const k1 = await getKlines(t.symbol, "1h", 24).catch(()=>[]);
        if (!k1.length) continue;
        const vols1 = klinesVolumeArray(k1);
        const VolNow = Number(vols1[vols1.length - 1] || 0);
        const avg24h_base = Number(t.baseVolume || 1) / 24;
        const volRatio = avg24h_base ? VolNow / avg24h_base : 1;
        const priceChange = Number(t.priceChangePercent || 0);
        if (volRatio >= EARLY_VOL_MULT && priceChange <= EARLY_PRICE_CHANGE_MAX) {
          results.push({ symbol: t.symbol, volRatio: Number(volRatio.toFixed(2)), priceChange, quoteVolume: t.quoteVolume, note: "Early volume spike", conf: Math.min(90, 50 + Math.round((volRatio - 1) * 10)) });
        }
      } catch (e) {
        // continue
      }
    }
    results.sort((a,b) => b.conf - a.conf);
    logv(`[EARLY] found ${results.length} early candidates`);
    return results.slice(0, 30);
  } catch (e) {
    logv("[EARLY] error " + e.message);
    return [];
  }
}

// ------------------ Learning Engine (basic integ) ------------------
async function recordSignalLearning(item) {
  try {
    const data = await loadLearningData();
    data.signals[item.symbol] = data.signals[item.symbol] || [];
    data.signals[item.symbol].push({
      id: Date.now() + "-" + Math.random().toString(36).slice(2,6),
      ...item,
      time: new Date().toISOString(),
      checked: false,
      result: null
    });
    await saveLearningData(data);
    logv(`[LEARN] recorded ${item.symbol}`);
  } catch (e) {
    logv("[LEARN] record error " + e.message);
  }
}

// check outcomes for pending signals (non-blocking)
async function checkOutcomesForPending() {
  try {
    const data = await loadLearningData();
    const now = Date.now();
    const toCheck = [];
    for (const sym of Object.keys(data.signals || {})) {
      for (const s of data.signals[sym]) {
        if (!s.checked && now - new Date(s.time).getTime() >= CHECK_HOURS * 3600 * 1000) toCheck.push(s);
      }
    }
    let checked = 0;
    for (const s of toCheck) {
      try {
        const res = await checkOutcome(s);
        s.checked = true;
        s.result = res;
        updateStats(data, s);
        checked++;
      } catch (e) {}
    }
    if (checked) await saveLearningData(data);
    return checked;
  } catch (e) {
    logv("[LEARN] checkOutcomes error " + e.message);
    return 0;
  }
}

async function checkOutcome(signal) {
  try {
    const LOOK_HOURS = Number(process.env.LEARNING_LOOK_HOURS || 24);
    const TP_PCT = Number(signal.tpPct || 0.06);
    const SL_PCT = Number(signal.slPct || 0.02);
    const apiBase = process.env.API_BASE_SPOT || SELECTED_BINANCE || BINANCE_MIRRORS[0];
    if (!apiBase) return "NO";
    const url = `${apiBase}/api/v3/klines?symbol=${signal.symbol}&interval=1h&limit=${LOOK_HOURS + 1}`;
    const r = await fetch(url);
    if (!r.ok) return "NO";
    const candles = await r.json();
    if (!Array.isArray(candles) || !candles.length) return "NO";
    const entry = Number(signal.price);
    let tp = false, sl = false;
    for (const c of candles) {
      const high = Number(c[2]);
      const low = Number(c[3]);
      if (high >= entry * (1 + TP_PCT)) tp = true;
      if (low <= entry * (1 - SL_PCT)) sl = true;
      if (tp || sl) break;
    }
    if (tp && !sl) return "TP";
    if (sl && !tp) return "SL";
    return "NO";
  } catch (e) {
    return "NO";
  }
}

function updateStats(data, s) {
  data.stats = data.stats || { overall: { total: 0, wins: 0 }, byType: {}, bySymbol: {} };
  const st = data.stats;
  st.overall.total++;
  if (s.result === "TP") st.overall.wins++;
  const t = s.type || "UNKNOWN";
  st.byType[t] = st.byType[t] || { total: 0, wins: 0 };
  st.byType[t].total++;
  if (s.result === "TP") st.byType[t].wins++;
  st.bySymbol[s.symbol] = st.bySymbol[s.symbol] || { total: 0, wins: 0 };
  st.bySymbol[s.symbol].total++;
  if (s.result === "TP") st.bySymbol[s.symbol].wins++;
}

async function computeAdjustments() {
  try {
    const data = await loadLearningData();
    const byType = data.stats?.byType || {};
    const result = { adjust: false, reasons: [], changes: {} };
    for (const [type, rec] of Object.entries(byType)) {
      if (rec.total < MIN_SIGNALS_TO_TUNE) continue;
      const wr = rec.wins / rec.total;
      if (wr < 0.45) {
        result.adjust = true;
        result.reasons.push(`${type} WR ${Math.round(wr * 100)}% → tighten`);
        result.changes[type] = { rsiMinDelta: +3, volMinPctDelta: +10 };
      } else if (wr > 0.75) {
        result.adjust = true;
        result.reasons.push(`${type} WR ${Math.round(wr * 100)}% → relax`);
        result.changes[type] = { rsiMinDelta: -2, volMinPctDelta: -5 };
      }
    }
    if (result.adjust) {
      await applyAdjustments(result.changes);
    }
    return result;
  } catch (e) {
    logv("[LEARN] computeAdjustments error " + e.message);
    return { adjust: false };
  }
}
async function applyAdjustments(changes) {
  try {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(DYN_CONFIG_FILE, "utf8")); } catch (e) { cfg = {}; }
    for (const [key, val] of Object.entries(changes)) {
      cfg[key] = { ...(cfg[key] || {}), ...val };
    }
    await saveDynamicConfig(cfg);
    logv("[LEARN] dynamic config updated");
    return cfg;
  } catch (e) {
    logv("[LEARN] applyAdjustments error " + e.message);
  }
}

// schedule learning cycle
setInterval(async () => {
  try {
    const checked = await checkOutcomesForPending();
    if (checked > 0) {
      const adj = await computeAdjustments();
      logv("[LEARN] cycle complete: " + JSON.stringify(adj));
    }
  } catch (e) {
    logv("[LEARN] periodic error " + e.message);
  }
}, 6 * 3600 * 1000); // every 6h

// ------------------ MAIN server loop ------------------
async function mainLoop() {
  logv("[MAIN] cycle started");
  try {
    // Run PreBreakout scan
    const preList = await scanPreBreakout();
    if (preList && preList.length > 0) {
      for (const coin of preList) {
        const conf = coin.Conf || coin.conf || 75;
        // tag heuristics (could be improved by learning_engine)
        const tag = coin.type === "IMF" ? "[FLOW]" : coin.type === "GOLDEN" ? "[GOLDEN]" : "[PRE]";
        // push
        await pushSignal(tag, coin, conf);
        // record to learning engine with extra fields
        await recordSignalLearning({ symbol: coin.symbol, price: coin.price, type: "PRE", conf, time: new Date().toISOString() });
      }
      logv(`[MAIN] ${preList.length} coins processed`);
    } else {
      logv("[MAIN] no breakout candidates found");
    }

    // Early detector
    const earlyList = await scanEarlyPump();
    if (earlyList && earlyList.length) {
      for (const e of earlyList) {
        await pushSignal("[EARLY]", { symbol: e.symbol, priceChangePercent: e.priceChange, quoteVolume: e.quoteVolume, note: e.note }, e.conf);
        await recordSignalLearning({ symbol: e.symbol, price: null, type: "EARLY", conf: e.conf, time: new Date().toISOString() });
      }
      logv(`[MAIN] EARLY ${earlyList.length} pushed`);
    }

  } catch (err) {
    logv("[MAIN ERROR] " + (err?.message || err));
  }
  logv("[MAIN] cycle complete");
}

// --- startup & scheduling ---
(async () => {
  logv("[SPOT MASTER AI] Starting server (single-file full)");
  await autoPickBinanceAPI();
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    await sendTelegram("<b>[SPOT MASTER AI]</b>\nServer Started ✅");
  }
})().catch(e => logv("[INIT] " + e.message));

// run immediate then schedule
mainLoop().catch(e => logv("[MAIN] immediate err " + e.message));
setInterval(mainLoop, SCAN_INTERVAL_MS);

// run a quick rotate-check periodically (in case selected mirror gets blocked)
setInterval(async () => {
  try {
    await safeFetchJSON(`/api/v3/ticker/24hr`, "BINANCE 24h", 1, 6000);
  } catch (e) {
    logv("[HEALTH] heartbeat failed, rotating API");
    rotateBinanceAPI();
  }
}, 5 * 60 * 1000);

// KEEP-ALIVE ping to PRIMARY_URL if provided
if (PRIMARY_URL) {
  setInterval(() => {
    try {
      fetch(PRIMARY_URL);
      logv("[KEEPALIVE] ping sent to PRIMARY_URL");
    } catch (e) { /* no-op */ }
  }, KEEP_ALIVE_INTERVAL_MIN * 60 * 1000);
}

// === RENDER FREE FIX (final keep-alive) ===

const PORT = process.env.PORT || 10000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("✅ Spot Master AI (Render Free) is running fine.\n");
});

server.listen(PORT, () => {
  console.log(`[RENDER FIX] Web listener active on port ${PORT}`);
});

// KEEP PROCESS ALIVE (ping log mỗi 10 phút)
setInterval(() => {
  console.log(`[KEEPALIVE] Server still running at ${new Date().toLocaleTimeString()}`);
}, 10 * 60 * 1000);
