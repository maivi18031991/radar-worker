// server.js - Hybrid FUTURE + SPOT Smart Money Confirm (Radar v11 Hybrid)
// PURPOSE: signals only (no trading). Uses Futures (primary) + Spot (secondary) for confirmation.
// Deploy on Render. Set ENV: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, PRIMARY_URL

import express from "express";
// ====== LEADER GROUP MAP ======
const LEADER_GROUPS = {
  "SOLUSDT": ["SUIUSDT", "APTUSDT", "RNDRUSDT"],
  "ETHUSDT": ["ARBUSDT", "OPUSDT", "LDOUSDT"],
  "BTCUSDT": ["STXUSDT", "ORDIUSDT"],
  "INJUSDT": ["PYTHUSDT", "TNSRUSDT"],
  "LINKUSDT": ["TRBUSDT", "SNXUSDT"],
  "DOGEUSDT": ["SHIBUSDT", "BONKUSDT"],
  "AVAXUSDT": ["NEARUSDT", "FTMUSDT"],
  "SEIUSDT": ["TIAUSDT", "WUSDT"]
};
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import pLimit from "p-limit";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const PRIMARY_URL = process.env.PRIMARY_URL || `http://localhost:${PORT}`;

// API endpoints (Futures primary, Spot fallback)
const FUTURE_API = "https://fapi.binance.com";
const SPOT_API = "https://api.binance.com";
const ALT_API_FALLBACK = ["https://api-gcp.binance.com", "https://data-api.binance.vision"];

// Data files
const DATA_DIR = path.resolve("./data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const LOG_FILE = path.join(DATA_DIR, "logs.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

// Default config
const DEFAULT_CONFIG = {
  CONCURRENCY: 8,
  ALERT_COOLDOWN_MIN: 30,
  PRE_VOL: 1.8,
  PRE_TAKER: 0.52,
  SPOT_VOL: 2.5,
  SPOT_TAKER: 0.58,
  GOLD_VOL: 3.0,
  GOLD_TAKER: 0.60,
  IMF_LEADERSCORE: 85,
  OPT_LOOKBACK_HOURS: 72,
  OPT_MIN_SIGNALS: 2,
  autoLearnEnabled: true,
  lastAutoLearn: null,
  weights: {} // per-symbol weights
};

// config helpers
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const text = fs.readFileSync(CONFIG_FILE, "utf8");
      return Object.assign({}, DEFAULT_CONFIG, JSON.parse(text));
    } else {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return Object.assign({}, DEFAULT_CONFIG);
    }
  } catch (e) {
    console.error("loadConfig error", e);
    return Object.assign({}, DEFAULT_CONFIG);
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// logs
function appendLog(entry) {
  try {
    const arr = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE, "utf8")) : [];
    arr.push(entry);
    // keep recent only
    fs.writeFileSync(LOG_FILE, JSON.stringify(arr.slice(-8000), null, 2));
  } catch (e) {
    console.error("appendLog error", e);
  }
}
function readLogs() {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    return JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
  } catch (e) {
    console.error("readLogs error", e);
    return [];
  }
}

// utilities
async function safeFetchJSON(url, opts = {}, retries = 3) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { timeout: 15000, ...opts });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

function sma(arr, n) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const slice = arr.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}
function rsiCalc(closes, period = 14) {
  if (!closes || closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// fetch klines and tickers - FUTURES primary, SPOT fallback
async function fetchKlines(symbol, interval = "1h", limit = 100, preferFuture = true) {
  if (preferFuture) {
    try {
      const url = `${FUTURE_API}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
      const data = await safeFetchJSON(url);
      return { data, source: "future" };
    } catch (e) {
      // fallback to spot
    }
  }
  // fallback to spot
  const url2 = `${SPOT_API}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
  const data2 = await safeFetchJSON(url2);
  return { data: data2, source: "spot" };
}

async function fetchTicker(symbol, preferFuture = true) {
  if (preferFuture) {
    try {
      const url = `${FUTURE_API}/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(symbol)}`;
      const data = await safeFetchJSON(url);
      return { data, source: "future" };
    } catch (e) {}
  }
  const url2 = `${SPOT_API}/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`;
  const data2 = await safeFetchJSON(url2);
  return { data: data2, source: "spot" };
}

// open interest & funding (futures)
async function fetchOpenInterest(symbol) {
  try {
    // recent openInterest (public futures endpoint)
    const url = `${FUTURE_API}/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`;
    const data = await safeFetchJSON(url);
    return data; // { "symbol": "BTCUSDT", "openInterest": "12345.0" }
  } catch (e) { return null; }
}
async function fetchFundingRate(symbol, limit = 5) {
  try {
    const url = `${FUTURE_API}/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&limit=${limit}`;
    const data = await safeFetchJSON(url);
    return data; // array
  } catch (e) { return null; }
}

// analyze symbol (uses futures + spot info)
async function analyzeSymbolHybrid(symbol, interval = "1h") {
  // attempt futures first
  const kl = await fetchKlines(symbol, interval, 100, true);
  const tickerObj = await fetchTicker(symbol, true);
  const klines = kl.data;
  const closes = klines.map(c => Number(c[4]));
  const vols = klines.map(c => Number(c[5]));
  const lastPrice = closes.at(-1);
  const ma20 = sma(closes, 20);
  const rsi_h1 = Math.round(rsiCalc(closes, 14));
  const volRatio = Math.max(0.01, sma(vols, 5) / Math.max(1, sma(vols, 20)));
  const ticker = tickerObj.data;
  // takerBuy info on futures is not standardized; approximate with volume ratio and quoteVolume
  const takerBuyBase = Number(ticker.takerBuyBaseAssetVolume || 0);
  const baseVol = Number(ticker.volume || 1);
  const takerBuyRatio = baseVol > 0 ? Math.min(1, takerBuyBase / Math.max(1, baseVol)) : 0;
  // open interest & funding
  const oi = await fetchOpenInterest(symbol).catch(() => null);
  const funding = await fetchFundingRate(symbol, 1).catch(() => null);
  // leader score heuristic
  let leaderScore = 0;
  if (volRatio > 2) leaderScore += 30;
  if (takerBuyRatio > 0.55) leaderScore += 30;
  if (rsi_h1 >= 50 && rsi_h1 <= 65) leaderScore += 20;
  if (lastPrice > ma20) leaderScore += 20;
  leaderScore = Math.min(100, Math.round(leaderScore));
  return {
    symbol,
    lastPrice,
    ma20,
    rsi_h1,
    volRatio: Number(volRatio.toFixed(2)),
    takerBuyRatio: Number(takerBuyRatio.toFixed(3)),
    leaderScore,
    closes,
    vols,
    ticker,
    oi,
    funding,
    source: kl.source
  };
}

// compute signal using hybrid logic (futures weight + spot confirmation)
function computeSignalHybrid(item) {
  const cfg = loadConfig();
  const weight = Number(cfg.weights[item.symbol] || 1);
  // thresholds scale with weight (higher weight -> stricter for rare but higher quality)
  const PRE_VOL = cfg.PRE_VOL * weight;
  const PRE_TAKER = cfg.PRE_TAKER;
  const SPOT_VOL = cfg.SPOT_VOL * weight;
  const SPOT_TAKER = cfg.SPOT_TAKER;
  const GOLD_VOL = cfg.GOLD_VOL * weight;
  const GOLD_TAKER = cfg.GOLD_TAKER;

  const price = item.lastPrice;
  const ma20 = item.ma20 || price;
  const entryLow = +(ma20 * 0.995).toFixed(8);
  const entryHigh = +(ma20 * 1.02).toFixed(8);

  // smart confirmation logic:
  // prefer futures signals: if futures source & OI/funding confirm -> stronger
  const isFutureSource = (item.source === "future");
  const oiVal = item.oi && item.oi.openInterest ? Number(item.oi.openInterest) : null;
  const fundingLatest = Array.isArray(item.funding) && item.funding.length ? Number(item.funding[item.funding.length-1].fundingRate) : null;
  let type = "NONE";
  let confidence = 0;
  let IMF = item.leaderScore >= cfg.IMF_LEADERSCORE;

  // base decisions from futures-derived metrics
  if (item.volRatio >= GOLD_VOL && item.takerBuyRatio >= GOLD_TAKER && item.rsi_h1 > 48) {
    // if futures OI rising or funding supports longs -> stronger
    if (isFutureSource && oiVal && fundingLatest !== null && fundingLatest <= 0.001) {
      type = "GOLDEN";
      confidence = 95;
    } else {
      // require spot confirmation (price > ma20 and spot vol high) to promote to GOLDEN
      type = "SPOT"; // provisional
      confidence = 80;
    }
  } else if (item.volRatio >= SPOT_VOL && item.takerBuyRatio >= SPOT_TAKER && item.rsi_h1 >= 48 && price > ma20) {
    type = "SPOT";
    confidence = 85;
  } else if (item.volRatio >= PRE_VOL && item.takerBuyRatio >= PRE_TAKER && item.rsi_h1 >= 42 && item.rsi_h1 <= 55) {
    type = "PREBREAK";
    confidence = 65;
  }

  // cross-check with spot (if we fetched futures but spot behavior differs, reduce confidence)
  // cheap spot check: if futures is source, fetch quick spot candle (we may have spot klines earlier)
  // (Note: computeSignalHybrid assumes analyzeSymbolHybrid already used futures primary and filled item.source)
  // suggested SL:
  const recentMin = Math.min(...(item.closes.slice(-3)));
  const sl = Math.round(Math.min(price * 0.97, recentMin * 0.995) * 1000000) / 1000000;
  const tp = type === "GOLDEN" ? 12 : type === "SPOT" ? 6 : type === "PREBREAK" ? 5 : 0;
  // boost confidence by leaderScore
  confidence = Math.min(99, confidence + Math.round(item.leaderScore / 10));
  return { type, entryLow, entryHigh, sl, tp, confidence, IMF };
}

// format message for Telegram
function formatMsg(item, sig) {
  let t = `<b>${sig.type} | ${item.symbol}</b>\n`;
  t += `Giá: ${item.lastPrice} | LS:${item.leaderScore} | Vol:${item.volRatio}x | Taker:${item.takerBuyRatio}\n`;
  if (item.oi && item.oi.openInterest) {
    t += `OI:${item.oi.openInterest} `;
  }
  if (item.funding && item.funding.length) {
    t += `Funding:${item.funding[item.funding.length-1].fundingRate}\n`;
  } else t += `\n`;
  t += `RSI:${item.rsi_h1} | MA20:${item.ma20}\n`;
  if (sig.type !== "NONE") {
    t += `Vùng entry: ${sig.entryLow} - ${sig.entryHigh}\nTP:+${sig.tp}% | SL:${sig.sl}\nConfidence: ${sig.confidence}%\n`;
  } else t += `No strong signal right now.\n`;
  t += `Time: ${new Date().toISOString()}`;
  return t;
}

// Telegram send
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram not configured.");
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "post",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true })
    });
  } catch (e) {
    console.error("sendTelegram err", e.message || e);
  }
}

// cooldown per symbol/type
const lastAlert = {};
function shouldSendNow(symbol, type) {
  const cfg = loadConfig();
  const key = `${symbol}_${type}`;
  const prev = lastAlert[key];
  if (!prev) return true;
  return Date.now() - prev > cfg.ALERT_COOLDOWN_MIN * 60 * 1000;
}
function recordSent(symbol, type) { lastAlert[`${symbol}_${type}`] = Date.now(); }

// endpoints

app.get("/", (req, res) => res.json({ status: "Radar Hybrid FUTURE+SPOT OK", time: new Date().toISOString() }));

// /analyze?symbol=...&interval=1h  => returns hybrid analysis (futures primary)
app.get("/analyze", async (req, res) => {
  try {
    const symbol = (req.query.symbol || "BTCUSDT").toUpperCase();
    const interval = req.query.interval || "1h";
    const a = await analyzeSymbolHybrid(symbol, interval);
    res.json({
      symbol: a.symbol, lastPrice: a.lastPrice, rsi_h1: a.rsi_h1, ma20: a.ma20,
      volRatio: a.volRatio, takerBuyRatio: a.takerBuyRatio, leaderScore: a.leaderScore, oi: a.oi, funding: a.funding, source: a.source
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// /signal?symbol=...&sendTelegram=1
app.get("/signal", async (req, res) => {
  try {
    const symbol = (req.query.symbol || "BTCUSDT").toUpperCase();
    const send = req.query.sendTelegram === "1" || req.query.sendTelegram === "true";
    const interval = req.query.interval || "1h";
    const a = await analyzeSymbolHybrid(symbol, interval);
    const sig = computeSignalHybrid(a);
    if (send && sig.type !== "NONE") {
      if (shouldSendNow(symbol, sig.type)) {
        const msg = formatMsg(a, sig);
        await sendTelegram(msg);
        recordSent(symbol, sig.type);
      } else {
        console.log("Suppressed (cooldown)", symbol, sig.type);
      }
    }
    const logRow = { symbol: a.symbol, type: sig.type, price: a.lastPrice, rsi_h1: a.rsi_h1, volRatio: a.volRatio, takerBuyRatio: a.takerBuyRatio, leaderScore: a.leaderScore, sl: sig.sl, tp: sig.tp, confidence: sig.confidence, oi: a.oi, funding: a.funding, time: new Date().toISOString() };
    appendLog(logRow);
    res.json({ analysis: a, signal: sig, logged: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// helper: fetch all USDT symbols from exchangeInfo
async function fetchAllUSDTsymbols() {
  const url = `${SPOT_API}/api/v3/exchangeInfo`;
  const info = await safeFetchJSON(url);
  return info.symbols.filter(s => s.quoteAsset === "USDT" && s.status === "TRADING").map(s => s.symbol);
}

// /batchscan?limit=436
app.get("/batchscan", async (req, res) => {
  try {
    const cfg = loadConfig();
    // prefer full list but can use static if exchangeInfo is blocked
    let symbols = [];
    try { symbols = await fetchAllUSDTsymbols(); } catch (e) { symbols = []; }
    if (!symbols || symbols.length === 0) {
      // fallback static list (extend later)
      symbols = ["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT","DOGEUSDT","ADAUSDT","MATICUSDT","AVAXUSDT","DOTUSDT","LINKUSDT","SUIUSDT","TONUSDT","INJUSDT","NEARUSDT","ATOMUSDT","FILUSDT","ETCUSDT","SEIUSDT"];
    }
    const limit = Number(req.query.limit || symbols.length);
    const toScan = symbols.slice(0, limit);
    const limitP = pLimit(cfg.CONCURRENCY || 6);
    const results = [];
    await Promise.all(toScan.map(sym => limitP(async () => {
      try {
        const a = await analyzeSymbolHybrid(sym);
        const sig = computeSignalHybrid(a);
        // send Telegram only for strong signals or IMF
        if ((sig.type !== "NONE" && sig.confidence >= 75) || sig.IMF) {
          if (shouldSendNow(sym, sig.type || "IMF")) {
            const msg = formatMsg(a, sig);
            await sendTelegram(msg);
            recordSent(sym, sig.type || "IMF");
          }
        }
        appendLog({ symbol: a.symbol, type: sig.type, price: a.lastPrice, rsi_h1: a.rsi_h1, volRatio: a.volRatio, takerBuyRatio: a.takerBuyRatio, leaderScore: a.leaderScore, sl: sig.sl, tp: sig.tp, confidence: sig.confidence, time: new Date().toISOString() });
        results.push({ symbol: a.symbol, signal: sig.type, leaderScore: a.leaderScore });
      } catch (e) {
        // skip
      }
    })));
    res.json({ scanned: toScan.length, results: results.filter(r => r.signal !== "NONE") });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// /leaderchain - detect leaders and suggest followers
app.get("/leaderchain", async (req, res) => {
  try {
    const cfg = loadConfig();
    const limitP = pLimit(cfg.CONCURRENCY || 6);
    const leaders = [];

    // Step 1: scan all USDT pairs quickly
    const symbols = Object.keys(LEADER_GROUPS);
    await Promise.all(symbols.map(sym => limitP(async () => {
      try {
        const a = await analyzeSymbolHybrid(sym);
        const sig = computeSignalHybrid(a);
        if ((sig.type === "GOLDEN" || sig.type === "SPOT") && sig.confidence >= 80) {
          leaders.push({ symbol: sym, price: a.lastPrice, vol: a.volRatio, rsi: a.rsi_h1 });
        }
      } catch (e) {}
    })));

    // Step 2: for each leader, check group followers
    const results = [];
    for (const leader of leaders) {
      const group = LEADER_GROUPS[leader.symbol] || [];
      const followers = [];
      await Promise.all(group.map(fol => limitP(async () => {
        try {
          const a2 = await analyzeSymbolHybrid(fol);
          if (a2.volRatio < 1.5 && a2.rsi_h1 < 50) {
            followers.push({ symbol: fol, price: a2.lastPrice, vol: a2.volRatio, rsi: a2.rsi_h1 });
          }
        } catch (e) {}
      })));
      if (followers.length > 0) {
        const msg = `🚨 CHUỖI HỆ ĐANG CHẠY!\nLeader: ${leader.symbol} | Vol:${leader.vol}x | RSI:${leader.rsi}\nFollowers chưa chạy: ${followers.map(f => f.symbol).join(", ")}\nGợi ý: Entry sớm vùng MA20–MA50\n${new Date().toISOString()}`;
        await sendTelegram(msg);
        results.push({ leader: leader.symbol, followers });
      }
    }
    res.json({ leaders: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// /imfonly?limit=200
app.get("/imfonly", async (req, res) => {
  try {
    let symbols = [];
    try { symbols = await fetchAllUSDTsymbols(); } catch (e) { symbols = []; }
    if (!symbols || symbols.length === 0) symbols = ["BTCUSDT","ETHUSDT","SOLUSDT","SUIUSDT","INJUSDT"];
    const limit = Number(req.query.limit || symbols.length);
    const toScan = symbols.slice(0, limit);
    const cfg = loadConfig();
    const limitP = pLimit(cfg.CONCURRENCY || 6);
    const out = [];
    await Promise.all(toScan.map(sym => limitP(async () => {
      try {
        const a = await analyzeSymbolHybrid(sym);
        const s = computeSignalHybrid(a);
        if (s.IMF) out.push({ symbol: a.symbol, lastPrice: a.lastPrice, leaderScore: a.leaderScore, volRatio: a.volRatio });
      } catch (e) {}
    })));
    res.json({ count: out.length, list: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// /exitcheck?symbol=...
app.get("/exitcheck", async (req, res) => {
  try {
    const symbol = (req.query.symbol || "BTCUSDT").toUpperCase();
    // use futures 15m klines ideally
    const kl = await fetchKlines(symbol, "15m", 6, true);
    const arr = kl.data;
    const closes = arr.map(r => Number(r[4]));
    const last = closes.at(-1);
    const prev = closes.at(-2) || last;
    const change15 = ((last - prev) / prev) * 100;
    const volNow = Number(arr.at(-1)[5]);
    const volAvg = sma(arr.map((c, i) => Number(arr[i][5])), 4) || 1;
    const volSpike = volNow > volAvg * 1.8;
    const reason = [];
    if (change15 <= -3) reason.push("Fast 15m drop");
    if (volSpike && change15 < -1) reason.push("Vol spike + pullback");
    res.json({ symbol, last, change15: change15.toFixed(2) + "%", volSpike, reason, time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// evaluate signal outcome for optimizer
async function evaluateSignalOutcome(symbol, entryPrice, entryTime, lookbackHours = 72, tpPct = 6, slPct = 3) {
  try {
    const limit = Math.min(200, Math.ceil(lookbackHours) + 10);
    // use futures 1h klines for outcome check
    const url = `${FUTURE_API}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1h&limit=${limit}`;
    const arr = await safeFetchJSON(url);
    const t0 = new Date(entryTime).getTime();
    let startIdx = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i][0] >= t0) { startIdx = i; break; }
    const checkCount = Math.min(arr.length - startIdx, Math.ceil(lookbackHours));
    if (checkCount <= 0) return "NEUTRAL";
    const tpPrice = entryPrice * (1 + tpPct / 100);
    const slPrice = entryPrice * (1 - slPct / 100);
    for (let i = startIdx; i < startIdx + checkCount; i++) {
      const high = Number(arr[i][2]), low = Number(arr[i][3]);
      if (high >= tpPrice && low <= slPrice) return "AMBIG";
      if (high >= tpPrice) return "WIN";
      if (low <= slPrice) return "LOSE";
    }
    return "NEUTRAL";
  } catch (e) {
    return "NEUTRAL";
  }
}

// auto-learn: review logs and adjust cfg.weights
async function autoLearnIfDue() {
  try {
    const cfg = loadConfig();
    if (!cfg.autoLearnEnabled) return;
    const last = cfg.lastAutoLearn ? new Date(cfg.lastAutoLearn).getTime() : 0;
    const now = Date.now();
    if (now - last < 24 * 3600 * 1000) return;
    console.log("Auto-learn starting...");
    const logs = readLogs();
    const stats = {};
    for (const row of logs) {
      if (!row || !row.symbol) continue;
      const t = new Date(row.time).getTime();
      if (Date.now() - t < 3600000) continue; // wait 1h
      const sym = row.symbol;
      if (!stats[sym]) stats[sym] = { signals: [], wins: 0, loses: 0, amb: 0, neutral: 0 };
      stats[sym].signals.push(row);
    }
    for (const sym of Object.keys(stats)) {
      const rec = stats[sym];
      for (const s of rec.signals) {
        const outcome = await evaluateSignalOutcome(sym, Number(s.price || 0), s.time, DEFAULT_CONFIG.OPT_LOOKBACK_HOURS, s.tp || 6, 3);
        if (outcome === "WIN") rec.wins++;
        else if (outcome === "LOSE") rec.loses++;
        else if (outcome === "AMBIG") rec.amb++;
        else rec.neutral++;
      }
      rec.total = rec.wins + rec.loses + rec.amb + rec.neutral;
    }
    const cfg2 = loadConfig();
    for (const sym of Object.keys(stats)) {
      const r = stats[sym];
      if (r.total < DEFAULT_CONFIG.OPT_MIN_SIGNALS) continue;
      const winRate = r.wins / Math.max(1, r.total);
      const curW = Number(cfg2.weights[sym] || 1);
      let newW = curW;
      if (winRate >= 0.7) newW = Math.min(1.4, curW + 0.05);
      else if (winRate < 0.6) newW = Math.max(0.7, curW - 0.05);
      cfg2.weights[sym] = Number(newW.toFixed(2));
    }
    cfg2.lastAutoLearn = new Date().toISOString();
    saveConfig(cfg2);
    console.log("Auto-learn finished. Config saved.");
  } catch (e) {
    console.error("autoLearnIfDue error", e);
  }
}

// periodic hourly checker for auto-learn
setInterval(() => { autoLearnIfDue().catch(e => console.error(e)); }, 60 * 60 * 1000);

// self-ping to keep awake (internal)
setInterval(() => {
  if (!PRIMARY_URL) return;
  fetch(PRIMARY_URL).catch(() => {});
}, 9 * 60 * 1000);

app.listen(PORT, () => console.log(`Radar Hybrid FUTURE+SPOT running on port ${PORT}`));
