// server.js — Radar-Signal AI Pro v11 (Node, Render-ready)
// PURPOSE: produce signals only (no trading). Includes auto-learning optimizer.
// USAGE: deploy to Render, set ENV: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, PRIMARY_URL
import express from "express";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import pLimit from "p-limit";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const PRIMARY_URL = process.env.PRIMARY_URL || ""; // e.g. https://radar-worker-yte4.onrender.com

// Data folder
const DATA_DIR = path.resolve("./data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const LOG_FILE = path.join(DATA_DIR, "logs.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

// Default config - will be overwritten if config.json exists
const DEFAULT_CONFIG = {
  BATCH_SIZE: 60,
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
  weights: {} // WEIGHT per symbol
};

// load/save helpers
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const text = fs.readFileSync(CONFIG_FILE, "utf8");
      return Object.assign({}, DEFAULT_CONFIG, JSON.parse(text));
    } else {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return DEFAULT_CONFIG;
    }
  } catch (e) {
    console.error("loadConfig error", e);
    return Object.assign({}, DEFAULT_CONFIG);
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
function appendLog(entry) {
  try {
    const arr = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE, "utf8")) : [];
    arr.push(entry);
    fs.writeFileSync(LOG_FILE, JSON.stringify(arr.slice(-5000), null, 2)); // keep last 5000
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

// util indicators
function sma(arr, n) {
  if (!arr || arr.length === 0) return 0;
  const s = arr.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}
function rsiCalc(closes, period = 14) {
  if (!closes || closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    if (i <= 0) continue;
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

// fetch helper
async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { timeout: 15000, ...opts });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// analyze a single symbol
async function analyzeSymbol(symbol = "BTCUSDT", interval = "1h") {
  const cfg = loadConfig();
  const klineUrl = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=100`;
  const tickUrl = `https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`;
  const [klines, ticker] = await Promise.all([fetchJSON(klineUrl), fetchJSON(tickUrl)]);
  if (!Array.isArray(klines) || klines.length === 0) throw new Error("No klines");
  const closes = klines.map(c => Number(c[4]));
  const vols = klines.map(c => Number(c[5]));
  const lastPrice = closes.at(-1);
  const ma20 = sma(closes, 20);
  const rsi_h1 = Math.round(rsiCalc(closes, 14));
  const volRatio = Math.max(0.01, sma(vols, 5) / Math.max(1, sma(vols, 20)));
  const takerBuyBase = Number(ticker.takerBuyBaseAssetVolume || 0);
  const baseVol = Number(ticker.volume || 1);
  const takerBuyRatio = baseVol > 0 ? Math.min(1, takerBuyBase / Math.max(1, baseVol)) : 0;
  // leaderScore heuristic
  let leaderScore = 0;
  if (volRatio > 2) leaderScore += 30;
  if (takerBuyRatio > 0.55) leaderScore += 30;
  if (rsi_h1 >= 50 && rsi_h1 <= 65) leaderScore += 20;
  if (lastPrice > ma20) leaderScore += 20;
  leaderScore = Math.min(100, Math.round(leaderScore));
  return { symbol, lastPrice, ma20, rsi_h1, volRatio: Number(volRatio.toFixed(2)), takerBuyRatio: Number(takerBuyRatio.toFixed(3)), leaderScore, closes, vols, ticker };
}

// compute signal using config and per-symbol weight
function computeSignal(item) {
  const cfg = loadConfig();
  const weight = Number(cfg.weights[item.symbol] || 1);
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
  let type = "NONE", confidence = 0;
  const IMF = item.leaderScore >= cfg.IMF_LEADERSCORE;
  if (item.volRatio >= GOLD_VOL && item.takerBuyRatio >= GOLD_TAKER && item.rsi_h1 > 48) { type = "GOLDEN"; confidence = 95; }
  else if (item.volRatio >= SPOT_VOL && item.takerBuyRatio >= SPOT_TAKER && item.rsi_h1 >= 48 && price > ma20) { type = "SPOT"; confidence = 85; }
  else if (item.volRatio >= PRE_VOL && item.takerBuyRatio >= PRE_TAKER && item.rsi_h1 >= 42 && item.rsi_h1 <= 55) { type = "PREBREAK"; confidence = 65; }
  confidence = Math.min(99, confidence + Math.round(item.leaderScore / 10));
  const last3 = item.closes.slice(-3);
  const recentMin = Math.min(...last3);
  const sl = Math.round(Math.min(price * 0.97, recentMin * 0.995) * 1000000) / 1000000;
  const tp = type === "GOLDEN" ? 12 : type === "SPOT" ? 6 : type === "PREBREAK" ? 5 : 0;
  return { type, entryLow, entryHigh, sl, tp, confidence, IMF };
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

function formatMsg(item, sig) {
  let t = `<b>${sig.type} | ${item.symbol}</b>\n`;
  t += `Giá: ${item.lastPrice} | LS:${item.leaderScore} | Vol:${item.volRatio}x | Taker:${item.takerBuyRatio}\n`;
  t += `RSI:${item.rsi_h1} | MA20:${item.ma20}\n`;
  if (sig.type !== "NONE") {
    t += `Vùng entry: ${sig.entryLow} - ${sig.entryHigh}\nTP:+${sig.tp}% | SL:${sig.sl}\nConfidence: ${sig.confidence}%\n`;
  } else {
    t += `No strong signal right now.\n`;
  }
  t += `Time: ${new Date().toISOString()}`;
  return t;
}

// throttle: cooldown map in-memory (process lifetime)
const lastAlert = {}; // key -> timestamp ms
function shouldSendNow(symbol, type) {
  const cfg = loadConfig();
  const key = `${symbol}_${type}`;
  const prev = lastAlert[key];
  if (!prev) return true;
  return Date.now() - prev > cfg.ALERT_COOLDOWN_MIN * 60 * 1000;
}
function recordSent(symbol, type) { lastAlert[`${symbol}_${type}`] = Date.now(); }

// Route: health
app.get("/", (req, res) => res.json({ status: "Radar-Signal AI Pro", time: new Date().toISOString() }));

// Route: analyze
app.get("/analyze", async (req, res) => {
  try {
    const symbol = (req.query.symbol || "BTCUSDT").toUpperCase();
    const interval = req.query.interval || "1h";
    const a = await analyzeSymbol(symbol, interval);
    res.json({ symbol: a.symbol, lastPrice: a.lastPrice, rsi_h1: a.rsi_h1, ma20: a.ma20, volRatio: a.volRatio, takerBuyRatio: a.takerBuyRatio, leaderScore: a.leaderScore, time: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Route: signal (analyze + compute + optional send Telegram)
app.get("/signal", async (req, res) => {
  try {
    const symbol = (req.query.symbol || "BTCUSDT").toUpperCase();
    const send = req.query.sendTelegram === "1" || req.query.sendTelegram === "true";
    const interval = req.query.interval || "1h";
    const a = await analyzeSymbol(symbol, interval);
    const sig = computeSignal(a);
    if (send && sig.type !== "NONE") {
      if (shouldSendNow(symbol, sig.type)) {
        const msg = formatMsg(a, sig);
        await sendTelegram(msg);
        recordSent(symbol, sig.type);
      } else {
        console.log("Suppressed (cooldown)", symbol, sig.type);
      }
    }
    const logRow = { symbol: a.symbol, type: sig.type, price: a.lastPrice, rsi_h1: a.rsi_h1, volRatio: a.volRatio, takerBuyRatio: a.takerBuyRatio, leaderScore: a.leaderScore, sl: sig.sl, tp: sig.tp, confidence: sig.confidence, time: new Date().toISOString() };
    appendLog(logRow);
    res.json({ analysis: a, signal: sig, logged: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Route: batchscan -> scan many symbols (full list from Binance USDT)
async function fetchAllUSDTsymbols() {
  const url = "https://api.binance.com/api/v3/exchangeInfo";
  const info = await fetchJSON(url);
  const syms = info.symbols.filter(s => s.quoteAsset === "USDT" && s.status === "TRADING").map(s => s.symbol);
  return syms;
}
app.get("/batchscan", async (req, res) => {
  try {
    const cfg = loadConfig();
    const symbols = await fetchAllUSDTsymbols(); // ~400+
    // optional: accept ?limit=100 to test
    const limit = Number(req.query.limit || symbols.length);
    const toScan = symbols.slice(0, limit);
    const limitP = pLimit(cfg.CONCURRENCY || 8);
    const results = [];
    await Promise.all(toScan.map(sym => limitP(async () => {
      try {
        const a = await analyzeSymbol(sym);
        const sig = computeSignal(a);
        if (sig.type !== "NONE" || sig.IMF) {
          // send immediate telegram if strong
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
    res.json({ scanned: results.length, results: results.filter(r => r.signal !== "NONE") });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Route: imfonly -> scan and return IMF true list (no Telegram)
app.get("/imfonly", async (req, res) => {
  try {
    const symbols = await fetchAllUSDTsymbols();
    const cfg = loadConfig();
    const limit = Number(req.query.limit || symbols.length);
    const toScan = symbols.slice(0, limit);
    const limitP = pLimit(cfg.CONCURRENCY || 8);
    const out = [];
    await Promise.all(toScan.map(sym => limitP(async () => {
      try {
        const a = await analyzeSymbol(sym);
        const sig = computeSignal(a);
        if (sig.IMF) out.push({ symbol: a.symbol, lastPrice: a.lastPrice, volRatio: a.volRatio, leaderScore: a.leaderScore });
      } catch (e) {}
    })));
    res.json({ count: out.length, list: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Route: exitcheck (quick 15m drop detector)
app.get("/exitcheck", async (req, res) => {
  try {
    const symbol = (req.query.symbol || "BTCUSDT").toUpperCase();
    const url15 = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=6`;
    const k15 = await fetchJSON(url15);
    const closes15 = k15.map(c => Number(c[4]));
    const last = closes15.at(-1);
    const prev = closes15.at(-2) || last;
    const change15 = ((last - prev) / prev) * 100;
    const volNow = Number(k15.at(-1)[5]);
    const volAvg = sma(k15.map((c, i) => Number(k15[i][5])), 4) || 1;
    const volSpike = volNow > volAvg * 1.8;
    const reason = [];
    if (change15 <= -3) reason.push("Fast 15m drop");
    if (volSpike && change15 < -1) reason.push("Vol spike + pullback");
    res.json({ symbol, last, change15: change15.toFixed(2) + "%", volSpike, reason, time: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Auto-learn optimizer (evaluate past signals, adjust weights)
// Simple rule-based optimizer: evaluate last N logs, compute win rate by symbol, adjust weights accordingly
async function evaluateSignalOutcome(symbol, entryPrice, entryTime, lookbackHours = 72, tpPct = 6, slPct = 3) {
  try {
    const limit = Math.min(200, Math.ceil(lookbackHours) + 10);
    const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1h&limit=${limit}`;
    const arr = await fetchJSON(url);
    // find index with timestamp >= entryTime
    // Binance klines timestamps are ms at [0]
    const t0 = new Date(entryTime).getTime();
    let startIdx = 0;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i][0] >= t0) { startIdx = i; break; }
    }
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

// Auto-learn runner: review logs and update config.weights
async function autoLearnIfDue() {
  try {
    const cfg = loadConfig();
    if (!cfg.autoLearnEnabled) return;
    const last = cfg.lastAutoLearn ? new Date(cfg.lastAutoLearn).getTime() : 0;
    const now = Date.now();
    // run once per 24h
    if (now - last < 24 * 3600 * 1000) return;
    console.log("Auto-learn starting...");
    const logs = readLogs();
    // group signals by symbol
    const stats = {};
    for (const row of logs) {
      // row shape: {symbol,type,price,rsi_h1,volRatio,takerBuyRatio,leaderScore,sl,tp,confidence,time}
      if (!row || !row.symbol) continue;
      const t = new Date(row.time).getTime();
      // skip very recent (<1h)
      if (Date.now() - t < 3600000) continue;
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
    // update weights: simple rules
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

// schedule a periodic auto-learn (runs in-process every hour, but only executes once per 24h due to lastAutoLearn check)
setInterval(() => { autoLearnIfDue().catch(e => console.error(e)); }, 60 * 60 * 1000); // hourly check

// self-ping to prevent some hosts from sleeping (Render free may still sleep; external cron recommended)
setInterval(() => {
  if (!PRIMARY_URL) return;
  fetch(PRIMARY_URL).then(() => console.log("self-ping ok")).catch(() => console.log("self-ping fail"));
}, 9 * 60 * 1000); // 9 minutes

app.listen(PORT, () => console.log(`Radar-Signal AI Pro running on port ${PORT}`));
