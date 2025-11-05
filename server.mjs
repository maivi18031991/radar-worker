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
import fetchNode from "node-fetch";

const fetch = (global.fetch || fetchNode);
const LOG_DEBUG = process.env.LOG_DEBUG === "true";

// --- Utility: fetch kline (candlestick) data from Binance
async function getKlines(symbol, interval = "1h", limit = 100) {
  const urls = [
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `https://api1.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `https://api-gw.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  ];

  for (let url of urls) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          return data;
        }
      } else {
        logv(`[BINANCE] Kline fetch failed (${url}) status: ${res.status}`);
      }
    } catch (e) {
      logv(`[BINANCE] Kline error (${url}): ${e.message}`);
    }
  }

  logv(`[BINANCE] ❌ All mirrors failed fetching klines for ${symbol}`);
  return [];
}
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
  let base = SELECTED_BINANCE || (await autoPickBinanceAPI());
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
// ------------------ Confidence Scoring (Smart Unified Ver.) ------------------
function computeConf({ RSI_H4, RSI_H1, VolNowRatio, BBWidth_H4, BTC_RSI }) {
  let score = 0;

  // 🎯 1️⃣ RSI — phản ánh sức bật
  if (RSI_H4 >= 35 && RSI_H4 <= 55) score += 20;     // vùng gom lý tưởng
  else if (RSI_H4 > 55 && RSI_H4 <= 65) score += 10; // có lực nhẹ
  else if (RSI_H4 < 30 || RSI_H4 > 75) score -= 10;  // quá yếu / quá nóng

  if (RSI_H1 >= 35 && RSI_H1 <= 60) score += 15;
  else if (RSI_H1 > 60 && RSI_H1 <= 75) score += 5;
  else score -= 5;

  // 💰 2️⃣ Volume Ratio — sức mạnh gom
  if (VolNowRatio >= 2 && VolNowRatio < 3) score += 15;
  else if (VolNowRatio >= 3 && VolNowRatio < 5) score += 25;
  else if (VolNowRatio >= 5) score += 30; // vol bất thường cực mạnh
  else if (VolNowRatio < 1.5) score -= 10;

  // 🌀 3️⃣ Bollinger Width — độ nén
  if (BBWidth_H4 < 0.05) score += 20; // nén mạnh
  else if (BBWidth_H4 < 0.08) score += 10;
  else score -= 5;

  // 🧭 4️⃣ BTC RSI — xu hướng chung thị trường
  if (BTC_RSI >= 50 && BTC_RSI <= 65) score += 10; // thị trường khỏe vừa
  else if (BTC_RSI >= 35 && BTC_RSI < 50) score += 5; // tạm ổn
  else score -= 5; // tránh khi BTC yếu hoặc quá nóng

  // 🧮 Chuẩn hóa về 0–100
  score = Math.max(0, Math.min(100, score));

  // 🎯 Độ tin cậy tổng hợp
  const conf = Math.round(score);
  return conf;
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

    let res;
try {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000); // timeout 7s
  res = await fetch(mainUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: controller.signal
  });
  clearTimeout(timeout);
} catch (err) {
  logv(`[TELEGRAM] fetch error: ${err.message} → retry via proxy...`);
  const proxyUrl = `https://api-tg.vercel.app/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    await fetch(proxyUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    logv("[TELEGRAM] proxy retry success ✅");
  } catch (e2) {
    logv("[TELEGRAM] proxy retry failed ❌ " + e2.message);
  }
  return; // dừng hàm tại đây để không chạy xuống if (!res.ok)
}
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
// ------------------ Smart PreBreakout Detector vFinal ------------------
async function scanPreBreakout() {
  try {
    logv("[PREBREAKOUT] Starting Smart PreBreakout scan...");

    const all24 = await get24hTickers();
    const usdt = all24
      .filter(t => t.symbol && t.symbol.endsWith("USDT"))
      .map(t => ({
        symbol: t.symbol,
        vol24: Number(t.quoteVolume || 0),
        priceChangePercent: Number(t.priceChangePercent || 0)
      }))
      .sort((a, b) => b.vol24 - a.vol24);

    if (!usdt.length) {
      logv("[PREBREAKOUT] no USDT tickers found");
      return [];
    }

    // Lọc top 25% volume
    const topCut = Math.floor(usdt.length * 0.25);
    const topVol = usdt.slice(0, topCut);

    // Bộ nhớ chống trùng cảnh báo
    const alertCache = new Map(); // { symbol: timestamp }

    // RSI của BTC để lọc thị trường
    const btc4h = await getKlines("BTCUSDT", "4h", 120).catch(() => []);
    const BTC_RSI = btc4h.length ? rsiFromArray(klinesCloseArray(btc4h), 14) : 50;
    if (BTC_RSI < 40 || BTC_RSI > 75) {
      logv(`[PREBREAKOUT] Market unstable (BTC_RSI=${BTC_RSI.toFixed(1)})`);
      return [];
    }

    const results = [];

    for (const t of topVol) {
      try {
        const k4 = await getKlines(t.symbol, "4h", 120).catch(() => []);
        const k1 = await getKlines(t.symbol, "1h", 100).catch(() => []);
        if (!k4.length || !k1.length) continue;

        const closes4 = klinesCloseArray(k4);
        const closes1 = klinesCloseArray(k1);

        const lastPrice = closes1.at(-1);
        const ma20 = smaFromArray(closes4, 20);
        const bb = bollingerWidth(closes4, 20, 2);

        // Vùng nén chuẩn bị bật
        if (bb.width > 0.08) continue; // bỏ coin band còn rộng
        if (lastPrice < ma20 * 0.99) continue; // chưa tiệm cận MA20

        // RSI báo hiệu sắp breakout
        const RSI_H1 = rsiFromArray(closes1, 14);
        if (RSI_H1 < 48 || RSI_H1 > 75) continue;

        // Tăng nhẹ 24h và vol đang nhích
        const chg = t.priceChangePercent;
        if (chg < -4 || chg > 8) continue;

        const vols1 = klinesVolumeArray(k1);
        const avgVol = vols1.slice(-30, -5).reduce((a, b) => a + b, 0) / 25;
        const volNow = vols1.at(-1);
        const volRatio = avgVol ? volNow / avgVol : 1;

        if (volRatio < 1.5) continue; // cần có tín hiệu gom nhẹ

        // Tính độ tin cậy Conf (đơn giản mà chính xác)
        const conf = Math.min(
          45 +
            (volRatio - 1.5) * 15 +
            (RSI_H1 - 45) * 0.8 +
            (0.08 - bb.width) * 400,
          92
        );

        const msg = {
          symbol: t.symbol,
          quoteVolume: t.vol24,
          priceChangePercent: chg,
          note: "Smart PreBreakout candidate",
          conf,
          RSI_H1,
          volRatio,
          bbWidth: bb.width,
        };

        results.push(msg);

        // 🚨 Gửi cảnh báo ngay khi đạt Conf >= 72
        if (conf >= 72) {
          const now = Date.now();
          const lastAlert = alertCache.get(t.symbol) || 0;
          const timeDiff = (now - lastAlert) / 1000 / 60;

          if (timeDiff > 10) {
            const entryLow = (chg - 0.8).toFixed(2);
            const entryHigh = (chg + 1.2).toFixed(2);
            const entryZone = `${entryLow}% → ${entryHigh}%`;

            const alertMsg = `
<b>[PREBREAKOUT ALERT]</b> ${t.symbol}
Δ24h: <b>${chg.toFixed(2)}%</b> | Conf: ${conf.toFixed(0)}%
Vol x${volRatio.toFixed(2)} | BB ${bb.width.toFixed(3)}
Entry zone: ${entryZone}
Note: Price testing upper band — watch for real breakout ⚡
Time: ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Ho_Chi_Minh" })}
`;

            await sendTelegram(alertMsg);
            alertCache.set(t.symbol, now);
            logv(`[ALERT] Sent breakout alert ${t.symbol} | Conf=${conf.toFixed(1)}`);
          } else {
            logv(`[ALERT] Skipped duplicate ${t.symbol}, last alert ${timeDiff.toFixed(1)}m ago`);
          }
        }

        // Log chi tiết
        logv(`[PRE] ${t.symbol} | Conf ${conf.toFixed(1)}% | RSI ${RSI_H1.toFixed(1)} | BB ${bb.width.toFixed(3)} | vol x${volRatio.toFixed(2)}`);
      } catch (e) {
        logv(`[PREBREAKOUT] error ${t.symbol}: ${e.message}`);
      }
    }

    results.sort((a, b) => b.conf - a.conf);

    if (results.length) {
      const top = results[0];
      await pushSignal("[PRE]", top, top.conf);
      logv(`[PREBREAKOUT] pushed ${top.symbol} Conf=${top.conf}`);
    } else {
      logv("[PREBREAKOUT] xuất 0 tín hiệu hợp lệ");
    }

    return results;
  } catch (err) {
    logv("[PREBREAKOUT] main error: " + err.message);
    return [];
  }
}
// ------------------ Smart Early Pump Detector vFinal ------------------
async function scanEarlyPump() {
  try {
    logv("[EARLY] Starting Smart Early Pump scan...");

    // Lấy dữ liệu 24h
    const all24 = await get24hTickers();
    const usdt = all24
      .filter(t => t.symbol && t.symbol.endsWith("USDT"))
      .map(t => ({
        symbol: t.symbol,
        vol24: Number(t.quoteVolume || 0),
        priceChangePercent: Number(t.priceChangePercent || 0)
      }))
      .sort((a, b) => b.vol24 - a.vol24);

    if (!usdt.length) {
      logv("[EARLY] no USDT tickers found");
      return [];
    }

    // Chỉ quét top 20% volume đầu bảng
    const topVolCut = Math.floor(usdt.length * 0.2);
    const topVol = usdt.slice(0, topVolCut);

    // Bộ nhớ chống trùng cảnh báo
    const alertCache = new Map(); // { symbol: timestamp }

    // RSI của BTC để lọc thị trường
    const btc1h = await getKlines("BTCUSDT", "1h", 100).catch(() => []);
    const BTC_RSI = btc1h.length ? rsiFromArray(klinesCloseArray(btc1h), 14) : 50;

    const results = [];

    for (const t of topVol) {
      try {
        const k1 = await getKlines(t.symbol, "1h", 100).catch(() => []);
        const k4 = await getKlines(t.symbol, "4h", 100).catch(() => []);
        if (!k1.length || !k4.length) continue;

        const closes1 = klinesCloseArray(k1);
        const vols1 = klinesVolumeArray(k1);
        const closes4 = klinesCloseArray(k4);

        // Bollinger Bands – chỉ giữ coin đang nén
        const bb = bollingerWidth(closes4, 14, 2);
        if (bb.width > 0.05) continue; // coin đã bung band thì bỏ

        // RSI H1 – vùng gom an toàn
        const RSI_H1 = rsiFromArray(closes1, 14);
        if (RSI_H1 < 30 || RSI_H1 > 60) continue;

        // Volume spike thực – có dòng tiền gom
        const avgVol = vols1.slice(-30, -5).reduce((a, b) => a + b, 0) / 25;
        const volNow = vols1[vols1.length - 1];
        const volRatio = avgVol ? volNow / avgVol : 1;
        const volSpike = vols1.slice(-3).filter(v => v > avgVol * 2).length >= 2;
        if (volRatio < 2.2 || !volSpike) continue;

        // Giá chưa chạy quá xa
        const chg = t.priceChangePercent;
        if (chg < -12 || chg > 10) continue;

        // BTC RSI phải trong vùng ổn định
        if (BTC_RSI < 45 || BTC_RSI > 70) continue;

        // Tính độ tin cậy (Conf)
        const conf = Math.min(
          50 +
            (volRatio - 2) * 10 +
            (60 - Math.abs(RSI_H1 - 45)) / 2 +
            (0.06 - bb.width) * 500,
          90
        );

        const msg = {
          symbol: t.symbol,
          quoteVolume: t.vol24,
          priceChangePercent: chg,
          note: "Smart Early Pump candidate",
          conf,
          RSI_H1,
          volRatio,
          bbWidth: bb.width,
        };

        results.push(msg);

        // 🚨 Gửi cảnh báo ngay nếu đạt ngưỡng mạnh (Conf ≥ 70)
        if (conf >= 70) {
          const now = Date.now();
          const lastAlert = alertCache.get(t.symbol) || 0;
          const timeDiff = (now - lastAlert) / 1000 / 60; // phút

          // chỉ gửi nếu chưa gửi trong 10 phút gần nhất
          if (timeDiff > 10) {
            const entryLow = (chg - 1).toFixed(2);
            const entryHigh = (chg + 1).toFixed(2);
            const entryZone = `${entryLow}% → ${entryHigh}%`;

            const alertMsg = `
<b>[EARLY ALERT]</b> ${t.symbol}
Δ24h: <b>${chg.toFixed(2)}%</b> | Conf: ${conf.toFixed(0)}%
Vol: ${volNow.toLocaleString()}
Entry zone: ${entryZone}
Note: Price entering smart accumulation band 🧠
Time: ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Ho_Chi_Minh" })}
`;

            await sendTelegram(alertMsg);
            alertCache.set(t.symbol, now);
            logv(`[ALERT] Sent immediate ${t.symbol} | Conf=${conf.toFixed(1)}`);
          } else {
            logv(`[ALERT] Skipped duplicate ${t.symbol}, last alert ${timeDiff.toFixed(1)}m ago`);
          }
        }

        // Ghi log chi tiết
        logv(`[EARLY] ${t.symbol} | Conf ${conf.toFixed(1)}% | vol x${volRatio.toFixed(2)} | RSI ${RSI_H1.toFixed(1)} | BB ${bb.width.toFixed(3)}`);
      } catch (e) {
        logv(`[EARLY] error ${t.symbol}: ${e.message}`);
      }
    }

    // Sắp xếp theo độ tin cậy giảm dần
    results.sort((a, b) => b.conf - a.conf);

    if (results.length) {
      const top = results[0];
      await pushSignal("[EARLY]", top, top.conf);
      logv(`[EARLY] pushed ${top.symbol} Conf=${top.conf}`);
    } else {
      logv("[EARLY] no early candidates");
    }

    return results;
  } catch (err) {
    logv("[EARLY] main error: " + err.message);
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
    // --- Run PreBreakout scan ---
    const preList = await scanPreBreakout();

    if (preList && preList.length > 0) {
      for (const coin of preList) {
        const conf = coin.conf || coin.Conf || 70;
        const tag = "[PRE]";
        await pushSignal(tag, coin, conf);
        await recordSignalLearning({ symbol: coin.symbol, type: "PRE" });
      }
      logv(`[MAIN] ${preList.length} PreBreakout coins processed`);
    } else {
      logv("[MAIN] no breakout candidates found");
    }

    // --- Run Early Pump scan ---
    const earlyList = await scanEarlyPump();

    if (earlyList && earlyList.length > 0) {
      for (const e of earlyList) {
        await pushSignal("[EARLY]", e, e.conf);
        await recordSignalLearning({ symbol: e.symbol, type: "EARLY" });
      }
      logv(`[MAIN] ${earlyList.length} Early Pump coins processed`);
    } else {
      logv("[MAIN] no early candidates found");
    }

    // --- Optional: log trùng lặp Early + Pre ---
    if (preList && earlyList) {
      const preSymbols = preList.map(c => c.symbol);
      const match = earlyList.filter(e => preSymbols.includes(e.symbol));
      if (match.length > 0) {
        for (const m of match) {
          logv(`[MATCH] ${m.symbol} appears in both EARLY + PRE — strong confluence!`);
        }
      }
    }

    // --- Push summary top signals ---
    await pushTopSignals(preList, "[PRE]");
    await pushTopSignals(earlyList, "[EARLY]");

    logv("[MAIN] cycle complete ✅");
  } catch (err) {
    logv("[MAIN] error: " + err.message);
  }
}
// ------------------ Auto Prioritizer: chọn tín hiệu mạnh nhất ------------------
async function pushTopSignals(list, tag = "[AUTO]") {
  try {
    if (!Array.isArray(list) || !list.length) return;
    // Ưu tiên theo Conf, sau đó theo volume
    const sorted = [...list].sort((a, b) => {
      const c1 = (b.Conf || b.conf || 0) - (a.Conf || a.conf || 0);
      if (c1 !== 0) return c1;
      return (b.quoteVolume || 0) - (a.quoteVolume || 0);
    });

    // Lấy top 3 coin mạnh nhất (Conf >= 70)
    const top = sorted.filter(x => (x.Conf || x.conf || 0) >= 70).slice(0, 3);
    if (!top.length) {
      logv("[AUTO] No high-confidence signals to push");
      return;
    }

    logv(`[AUTO] pushing top ${top.length} high-Conf signals`);

    for (const coin of top) {
      const conf = coin.Conf || coin.conf || 70;
      const sym = coin.symbol?.replace("USDT", "");
      const msg = `
<b>${tag}</b> ${sym}USDT
Δ24h: <b>${(coin.priceChangePercent || 0).toFixed(2)}%</b> | Conf: ${conf}%
Vol: ${(coin.quoteVolume || 0).toLocaleString()}
Note: High-Confidence Candidate
Time: ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Ho_Chi_Minh" })}
`;
      await sendTelegram(msg);
      logv(`[AUTO] pushed ${sym} | Conf ${conf}%`);
    }
  } catch (e) {
    logv("[AUTO] error " + e.message);
  }
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
