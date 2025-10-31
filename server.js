import { evaluateSignal } from './smart_layer.js';
import * as LEARN from './learning_engine.js';
// server.js - Full Hybrid Smart Radar (Spot + Future + Hybrid) with Active Signals & Exit Monitor
// DO NOT put tokens here. Use ENV: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, PRIMARY_URL
import express from "express";
import fetch from "node-fetch";
import pLimit from "p-limit";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());
// ===== TELEGRAM TEST SEND =====
const sendTelegram = async (text) => {
  try {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text,
      }),
    });
  } catch (err) {
    console.error("Telegram send error:", err);
  }
};

// Gửi thông báo khi server khởi động
sendTelegram("✅ Radar Worker has started successfully on Render!");
/* ====== CONFIG ====== */
const PORT = process.env.PORT || 10000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const PRIMARY_URL = process.env.PRIMARY_URL || `http://localhost:${PORT}`;
const API_BASE_SPOT = process.env.API_BASE_SPOT || "https://api.binance.com";
const API_BASE_FUTURE = process.env.API_BASE_FUTURE || "https://fapi.binance.com";
const MAX_CONC = Number(process.env.MAX_CONC || 8);
const ALERT_THROTTLE_H = Number(process.env.ALERT_THROTTLE_H || 6);
const ALERT_DEDUPE_MIN = Number(process.env.ALERT_DEDUPE_MIN || 5);
const DATA_DIR = path.resolve("./data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ===== LOAD DYNAMIC CONFIG =====
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let DYNAMIC_CONFIG = {};
try {
  const cfgPath = path.join(__dirname, 'data', 'dynamic_config.json');
  if (fs.existsSync(cfgPath)) {
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    DYNAMIC_CONFIG = JSON.parse(raw);
    console.log('[CONFIG] dynamic config loaded:', DYNAMIC_CONFIG);
  } else {
    console.log('[CONFIG] no dynamic_config.json yet');
  }
} catch (err) {
  console.error('[CONFIG] failed to load dynamic config', err);
}
/* ====== STATIC LEADER GROUP MAP (editable) ====== */
const LEADER_GROUPS = {
  "SOLUSDT": ["SUIUSDT","APTUSDT","RNDRUSDT"],
  "ETHUSDT": ["ARBUSDT","OPUSDT","LDOUSDT"],
  "BTCUSDT": ["STXUSDT","ORDIUSDT"],
  "LINKUSDT": ["TRBUSDT","SNXUSDT"],
  "DOGEUSDT": ["SHIBUSDT","BONKUSDT"],
  "AVAXUSDT": ["NEARUSDT","FTMUSDT"],
  "SEIUSDT": ["TIAUSDT","WUSDT"]
};

/* ====== UTILITIES ====== */
function nowISO(){ return new Date().toISOString(); }
function fmt(n, d=6){ if (n === null || n === undefined) return null; return Number(n).toFixed(d); }
async function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
const limitP = pLimit(MAX_CONC);

/* ====== SAFE FETCH JSON ====== */
async function safeFetchJSON(url, opts={}, retries=3) {
  let lastErr = null;
  for (let i=0;i<retries;i++){
    try {
      const r = await fetch(url, Object.assign({timeout: 15000}, opts));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      return j;
    } catch(e) {
      lastErr = e;
      await sleep(400*(i+1));
    }
  }
  throw lastErr;
}

/* ====== TELEGRAM SENDER ====== */
async function sendTelegramRaw(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[TG] missing token/chat ->', text.slice(0,60));
    return {ok:false, error:'no-token'};
  }
  try {
    // === Learning Engine Record ===
try {
  await LEARN.recordSignal({
    symbol: signal?.symbol || 'UNKNOWN',
    type: signal?.type || 'SPOT',
    time: new Date().toISOString(),
    price: signal?.price || 0,
    rsi: signal?.rsi || 0,
    vol: signal?.vol || 0,
    funding: signal?.funding || 0,
    tpPct: signal?.tpPct || 0.06,
    slPct: signal?.slPct || 0.02,
    extra: { note: text || '' }
  });
} catch (e) {
  console.error('[LEARN] record failed', e);
}
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    const j = await res.json();
    return j;
  } catch(e) {
    console.error('[TG] err', e.message || e);
    return {ok:false, error: String(e)};
  }
}

/* ====== SIMPLE INDICATORS ====== */
function sma(arr, n) {
  if (!arr || arr.length === 0) return 0;
  const slice = arr.slice(-n);
  return slice.reduce((a,b)=>a+b,0)/slice.length;
}
function rsiCalc(closes, period=14) {
  if (!closes || closes.length <= period) return 50;
  let gains=0, losses=0;
  for (let i=1;i<=period;i++){
    const d = closes[i]-closes[i-1];
    if (d>0) gains+=d; else losses -= d;
  }
  let avgG = gains/period, avgL = losses/period;
  for (let i=period+1;i<closes.length;i++){
    const d = closes[i]-closes[i-1];
    avgG = (avgG*(period-1) + (d>0?d:0))/period;
    avgL = (avgL*(period-1) + (d<0?-d:0))/period;
  }
  if (avgL === 0) return 100;
  const rs = avgG/avgL;
  return 100 - 100/(1+rs);
}
function atrFromK(klines, period=14) {
  if (!klines || klines.length < period+1) return 0;
  // klines: [openTime, open, high, low, close, vol, ...]
  const trs = [];
  for (let i=1;i<klines.length;i++){
    const high = Number(klines[i][2]), low = Number(klines[i][3]), prevClose = Number(klines[i-1][4]);
    trs.push(Math.max(high-low, Math.abs(high-prevClose), Math.abs(low-prevClose)));
  }
  return sma(trs, Math.min(period, trs.length));
}

/* ====== MARKET TYPE DETECTION ====== */
async function hasFutureSymbol(sym) {
  try {
    const url = `${API_BASE_FUTURE}/fapi/v1/exchangeInfo`;
    const info = await safeFetchJSON(url);
    if (!info || !info.symbols) return false;
    return info.symbols.some(s=>s.symbol === sym && s.status === 'TRADING');
  } catch(e){ return false; }
}
async function hasSpotSymbol(sym) {
  try {
    const url = `${API_BASE_SPOT}/api/v3/exchangeInfo`;
    const info = await safeFetchJSON(url);
    if (!info || !info.symbols) return false;
    return info.symbols.some(s=>s.symbol === sym && s.status === 'TRADING');
  } catch(e){ return false; }
}
async function detectMarketType(sym) {
  // fast heuristic: try futures ticker first
  const futOk = await (async ()=>{
    try { const r = await safeFetchJSON(`${API_BASE_FUTURE}/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(sym)}`, {}, 1); return !!r; } catch(e){ return false; }
  })();
  const spotOk = await (async ()=>{
    try { const r = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/ticker/24hr?symbol=${encodeURIComponent(sym)}`, {}, 1); return !!r; } catch(e){ return false; }
  })();
  if (spotOk && futOk) return 'HYBRID';
  if (futOk) return 'FUTURE_ONLY';
  if (spotOk) return 'SPOT_ONLY';
  return 'UNKNOWN';
}

/* ====== ANALYZERS ====== */
// analyzeSpot: fetch spot klines + ticker
async function analyzeSpot(sym, interval='1h', limit=50) {
  const urlK = `${API_BASE_SPOT}/api/v3/klines?symbol=${encodeURIComponent(sym)}&interval=${interval}&limit=${limit}`;
  const urlT = `${API_BASE_SPOT}/api/v3/ticker/24hr?symbol=${encodeURIComponent(sym)}`;
  const [klines, ticker] = await Promise.all([safeFetchJSON(urlK).catch(()=>null), safeFetchJSON(urlT).catch(()=>null)]);
  if (!klines || !ticker) return null;
  const closes = klines.map(r=>Number(r[4]));
  const vols = klines.map(r=>Number(r[5]));
  const price = Number(ticker.lastPrice || closes.at(-1) || 0);
  const ma20 = sma(closes, 20);
  const rsi_h1 = Math.round(rsiCalc(closes, 14) || 50);
  const volAvg5 = sma(vols, 5) || 1;
  const volAvg20 = sma(vols, 20) || 1;
  const vol_ratio = volAvg20>0? (volAvg5/volAvg20) : 1;
  const takerBuyRatio = (()=> {
    try {
      const takerBuy = Number(ticker.takerBuyBaseAssetVolume || 0);
      const quoteVol = Number(ticker.quoteVolume || 1);
      return quoteVol>0 ? Math.min(1, takerBuy/quoteVol) : 0;
    } catch(e){ return 0; }
  })();
  return {
    symbol: sym, source: 'spot', price, ma20, rsi_h1,
    vol_ratio: Number(vol_ratio.toFixed(3)), takerBuyRatio: Number(takerBuyRatio.toFixed(3)),
    closes, vols, rawTicker: ticker, klines
  };
}

// analyzeFuture: fetch futures klines + ticker + OI + funding
async function analyzeFuture(sym, interval='1h', limit=50) {
  const urlK = `${API_BASE_FUTURE}/fapi/v1/klines?symbol=${encodeURIComponent(sym)}&interval=${interval}&limit=${limit}`;
  const urlT = `${API_BASE_FUTURE}/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(sym)}`;
  const urlOI = `${API_BASE_FUTURE}/fapi/v1/openInterest?symbol=${encodeURIComponent(sym)}`;
  const urlFund = `${API_BASE_FUTURE}/fapi/v1/fundingRate?symbol=${encodeURIComponent(sym)}&limit=3`;
  const [klines, ticker, oiObj, fundArr] = await Promise.all([
    safeFetchJSON(urlK).catch(()=>null),
    safeFetchJSON(urlT).catch(()=>null),
    safeFetchJSON(urlOI).catch(()=>null),
    safeFetchJSON(urlFund).catch(()=>null)
  ]);
  if (!klines || !ticker) return null;
  const closes = klines.map(r=>Number(r[4]));
  const vols = klines.map(r=>Number(r[5]));
  const price = Number(ticker.lastPrice || closes.at(-1) || 0);
  const ma20 = sma(closes, 20);
  const rsi_h1 = Math.round(rsiCalc(closes, 14) || 50);
  const volAvg5 = sma(vols, 5) || 1;
  const volAvg20 = sma(vols, 20) || 1;
  const vol_ratio = volAvg20>0? (volAvg5/volAvg20) : 1;
  const takerBuyRatio = (()=> {
    try {
      const takerBuy = Number(ticker.takerBuyBaseAssetVolume || 0);
      const quoteVol = Number(ticker.quoteVolume || 1);
      return quoteVol>0 ? Math.min(1, takerBuy/quoteVol) : 0;
    } catch(e){ return 0; }
  })();
  const oi = oiObj ? Number(oiObj.openInterest || 0) : null;
  const funding = Array.isArray(fundArr) && fundArr.length ? fundArr : null;
  return {
    symbol: sym, source: 'future', price, ma20, rsi_h1,
    vol_ratio: Number(vol_ratio.toFixed(3)), takerBuyRatio: Number(takerBuyRatio.toFixed(3)),
    closes, vols, rawTicker: ticker, klines, oi, funding
  };
}

// analyzeHybrid: combine spot & future (prefer future metrics for scoring)
async function analyzeHybrid(sym) {
  // attempt futures first and spot
  const [fut, spot] = await Promise.allSettled([analyzeFuture(sym).catch(()=>null), analyzeSpot(sym).catch(()=>null)]);
  const future = fut.status === 'fulfilled' ? fut.value : null;
  const s = spot.status === 'fulfilled' ? spot.value : null;
  // merge
  const source = future? 'future' : (s? 'spot' : 'none');
  const base = Object.assign({}, future || s || {});
  base.source = source;
  // if both exist compute correlation quick (price closes corr)
  if (future && s) {
    try {
      const a = future.closes.slice(-20), b = s.closes.slice(-20);
      // simple correlation: pearson
      const meanA = sma(a, a.length), meanB = sma(b, b.length);
      let num=0, denA=0, denB=0;
      for (let i=0;i<a.length;i++){ num += (a[i]-meanA)*(b[i]-meanB); denA += (a[i]-meanA)**2; denB += (b[i]-meanB)**2; }
      const corr = denA>0 && denB>0 ? (num/Math.sqrt(denA*denB)) : 0;
      base.correlation = Number(corr.toFixed(3));
    } catch(e){ base.correlation = 0; }
    // prefer future vol_ratio if present
    base.vol_ratio = future.vol_ratio || s.vol_ratio;
    base.takerBuyRatio = future.takerBuyRatio || s.takerBuyRatio;
    // funding and oi from future
    base.oi = future.oi;
    base.funding = future.funding;
  } else {
    base.correlation = null;
    // if only spot, ensure vol_ratio exists
    base.vol_ratio = base.vol_ratio || (s? s.vol_ratio : 0);
  }
  // leaderScore heuristic
  let leaderScore = 0;
  if (base.vol_ratio > 2) leaderScore += 30;
  if (base.takerBuyRatio > 0.55) leaderScore += 25;
  if (base.rsi_h1 >= 50 && base.rsi_h1 <= 65) leaderScore += 20;
  if (base.price > (base.ma20 || 0)) leaderScore += 15;
  if (base.oi && Number(base.oi) > 0) leaderScore += 10;
  base.leaderScore = Math.min(100, Math.round(leaderScore));
  return base;
}

/* ====== SIGNAL DECIDER (PRE / SPOT / GOLDEN / IMF) & entry/sl/tp ====== */
function smartStop(entry, closes) {
  try {
    if (!closes || closes.length < 3) return Math.round(entry * 0.95 * 1e6)/1e6;
    const lows = closes.slice(-3).map(x=>Number(x));
    const min3 = Math.min(...lows);
    const sl = Math.min(entry * 0.95, min3 * 0.995);
    return Math.round(sl * 1000000)/1000000;
  } catch(e) { return Math.round(entry * 0.95 * 1e6)/1e6; }
}
function computeEntryZone(ma20) {
  const low = +(ma20 * 0.99);
  const high = +(ma20 * 1.02);
  return { entryLow: Number(low.toFixed(8)), entryHigh: Number(high.toFixed(8)) };
}
function detectSignalType(item) {
  // item: merged analysis

  // === Load dynamicConfig for runtime adaptation ===
  const cfg = typeof dynamicConfig !== 'undefined' ? dynamicConfig : {};
  const RSI_PRE_MIN = cfg.RSI_PRE_MIN || 42;
  const RSI_PRE_MAX = cfg.RSI_PRE_MAX || 65;
  const VOL_RATIO_MIN = cfg.VOL_RATIO_MIN || 1.8;
  const TAKERS_MIN = cfg.TAKERS_MIN || 0.52;

  const v = item.vol_ratio || 0;
  const t = item.takerBuyRatio || 0;
  const r = item.rsi_h1 || 50;
  const ma20 = item.ma20 || item.price;

  // === Apply adaptive thresholds ===
  if (v >= VOL_RATIO_MIN && t >= TAKERS_MIN && r >= RSI_PRE_MIN && r <= RSI_PRE_MAX) {
    // logic giữ nguyên như cũ, phía dưới mày có các if() riêng cho từng type
  }
  // rules (keep original thresholds)
  if (v >= 3 && t >= 0.6 && (item.rsi_h4 && item.rsi_h4 > 50 ? true : r>48)) return 'GOLDEN';
  if (v >= 2.5 && t >= 0.58 && item.price > ma20) return 'SPOT';
  if (v >= 1.8 && t >= 0.52 && r >= 42 && r <= 55) return 'PREBREAK';
  // IMF heuristics: big OI + funding swing + high leaderScore
  if (item.oi && item.funding && item.leaderScore >= 85) {
    // examine funding last record
    try {
      const f = Array.isArray(item.funding) ? Number(item.funding[item.funding.length-1].fundingRate || 0) : 0;
      if (f >= 0.001 || (item.oi && Number(item.oi) > 0)) return 'IMF';
    } catch(e){}
  }
  return 'NONE';
}
function computeSignal(item) {
  const type = detectSignalType(item);
  const ma20 = item.ma20 || item.price;
  const zone = computeEntryZone(ma20);
  const entry = item.price;
  const sl = smartStop(entry, item.closes || []);
  let tp = 0, conf = 0;
  if (type === 'GOLDEN') { tp = 10; conf = Math.min(99, 70 + Math.round(item.leaderScore/1.2)); }
  else if (type === 'SPOT') { tp = 6; conf = Math.min(95, 60 + Math.round(item.leaderScore/1.3)); }
  else if (type === 'PREBREAK') { tp = 5; conf = Math.min(85, 50 + Math.round(item.leaderScore/1.5)); }
  else if (type === 'IMF') { tp = 12; conf = Math.min(99, 80 + Math.round(item.leaderScore/1.1)); }
  else { tp = 0; conf = 0; }
  const marketTag = item.source === 'future' ? (item.correlation ? (item.correlation>0.5?'HYBRID':'FUTURE_ONLY') : 'FUTURE_ONLY') : (item.source === 'spot' ? 'SPOT_ONLY' : 'UNKNOWN');
  return {
    type, market: marketTag, entryLow: zone.entryLow, entryHigh: zone.entryHigh, sl, tp, confidence: conf
  };
}

/* ====== ACTIVE SIGNALS persistence & scale logic ====== */
const ACTIVE_PATH = path.join(DATA_DIR, 'active_signals.json');
function loadActive(){
  try { if (!fs.existsSync(ACTIVE_PATH)) return {}; return JSON.parse(fs.readFileSync(ACTIVE_PATH,'utf8')||'{}'); }
  catch(e){ console.error('loadActive', e); return {}; }
}
function saveActive(obj){ try { fs.writeFileSync(ACTIVE_PATH, JSON.stringify(obj,null,2)); } catch(e){ console.error('saveActive', e); } }
const VOL_FACTORS = { PREBREAK:0.2, SPOT:0.5, GOLDEN:1.0, IMF:1.5 };

function buildSignalScaleMessage(rec, lastSig) {
  const lines = [];
  lines.push(`<b>${lastSig.type} | ${rec.symbol} | ${rec.marketType || ''}</b>`);
  lines.push(`Signals: ${rec.signalCount} (last: ${lastSig.type} | conf:${lastSig.confidence}%)`);
  lines.push(`Vùng entry: ${rec.entryLow || 'n/a'} - ${rec.entryHigh || 'n/a'} | Giá hiện: ${rec.entrySuggested}`);
  lines.push(`Gợi ý Vol factor: ${rec.recommendedVolFactor}× (tham khảo)`);
  lines.push(`Hold until: ${rec.holdUntil}`);
  if (lastSig.type === 'PREBREAK') lines.push('Lưu ý: PRE -> dùng vol nhỏ, chờ confirm.');
  if (lastSig.type === 'GOLDEN') lines.push('GOLDEN -> tín hiệu mạnh, cân nhắc tăng vol.');
  if (lastSig.type === 'IMF') lines.push('IMF -> money flow lớn, scale up nếu hợp lý, canh SL.');
  lines.push(`Time: ${nowISO()}`);
  return lines.join('\n');
}

function recordSignalAndDecide(item, sig) {
  const act = loadActive();
  const sym = item.symbol;
  const now = nowISO();
  const existing = act[sym] || null;
  const lastSigObj = { type: sig.type, confidence: sig.confidence || 0, time: now };
  // ===== SMART LAYER CHECK =====
let learnStats = {};
try {
  learnStats = await LEARN.getStats?.() || {};
} catch(e) {
  console.log('[SMART] learning stats unavailable:', e.message);
}

const smart = evaluateSignal(
  item,
  sig.type || 'FUTURE',
  DYNAMIC_CONFIG || {},
  learnStats
);

sig.smart = smart;

// Nếu Smart Layer không confirm -> bỏ qua tín hiệu
if (!smart.confirm) {
  console.log(`[SMART] ❌ Skip ${sym} | type=${sig.type} | score=${smart.score}`);
  return { rec: existing, action: 'SKIP_SMART' };
}

// Nếu confirm thì tiếp tục như bình thường
console.log(`[SMART] ✅ Confirm ${sym} | type=${sig.type} | score=${smart.score}`);
  if (!existing) {
    const rec = {
      symbol: sym,
      signals: [lastSigObj],
      firstSignal: now,
      lastSignal: now,
      signalCount: 1,
      marketType: sig.market || (item.source || 'HYBRID'),
      entrySuggested: item.price || item.lastPrice || 0,
      entryLow: sig.entryLow || null,
      entryHigh: sig.entryHigh || null,
      recommendedVolFactor: VOL_FACTORS[sig.type] || 0.5,
      holdUntil: new Date(Date.now() + (sig.type==='IMF'?48: sig.type==='GOLDEN'?24 : sig.type==='SPOT'?12:6)*3600000).toISOString(),
      status: 'ACTIVE'
    };
    act[sym] = rec; saveActive(act);
    return { rec, action:'NEW', message: buildSignalScaleMessage(rec, lastSigObj) };
  } else {
    existing.signals.push(lastSigObj);
    existing.lastSignal = now;
    existing.signalCount = (existing.signalCount || 0) + 1;
    const addFactor = (sig.type === 'GOLDEN' || sig.type === 'IMF') ? 0.5 : (sig.type === 'SPOT' ? 0.2 : 0.1);
    existing.recommendedVolFactor = Math.min(3.0, (existing.recommendedVolFactor || VOL_FACTORS[sig.type]) + addFactor);
    const extendH = (sig.type === 'GOLDEN' ? 12 : (sig.type === 'IMF' ? 24 : (sig.type === 'SPOT' ? 6 : 3)));
    existing.holdUntil = new Date(Date.parse(existing.holdUntil) + extendH*3600000).toISOString();
    if (sig.entryLow) existing.entryLow = sig.entryLow;
    if (sig.entryHigh) existing.entryHigh = sig.entryHigh;
    existing.status = 'ACTIVE';
    act[sym] = existing; saveActive(act);
    return { rec: existing, action:'UPDATE', message: buildSignalScaleMessage(existing, lastSigObj) };
  }
}

/* ====== ALERT THROTTLE & DEDUPE ====== */
// store last alerts in memory (also could persist)
const lastAlert = {}; // key -> {ts, type, conf}
function shouldSendNow(sym, type, conf=0) {
  const key = `${sym}_${type}`;
  const prev = lastAlert[key];
  const now = Date.now();
  if (!prev) return true;
  const diffMin = (now - prev.ts)/60000;
  if (prev.type !== type) return true;
  if (diffMin > ALERT_DEDUPE_MIN) return true;
  if (conf - (prev.conf||0) >= 8) return true; // allow update if confidence jump
  return false;
}
function recordSent(sym, type, conf=0) {
  const key = `${sym}_${type}`;
  lastAlert[key] = { ts: Date.now(), type, conf };
}

/* ====== EXIT MONITOR (simple) ====== */
async function checkExitForSymbol(sym) {
  try {
    const kl = await safeFetchJSON(`${API_BASE_FUTURE}/fapi/v1/klines?symbol=${encodeURIComponent(sym)}&interval=15m&limit=6`).catch(()=>null);
    if (!kl) return null;
    const closes = kl.map(r=>Number(r[4]));
    const last = closes.at(-1), prev = closes.at(-2) || last;
    const change15 = prev>0 ? ((last-prev)/prev)*100 : 0;
    const vols = kl.map(r=>Number(r[5]));
    const volNow = vols.at(-1) || 0;
    const volAvg = sma(vols, Math.min(6, vols.length)) || 1;
    const volSpike = volNow > volAvg * 1.8;
    const reason = [];
    if (change15 <= -3) reason.push('Fast 15m drop');
    if (volSpike && change15 < -1) reason.push('Vol spike + pullback');
    return { symbol: sym, last, change15: Number(change15.toFixed(2)), volSpike, reason, time: nowISO() };
  } catch(e) { return null; }
}

/* ====== ENDPOINTS ====== */
app.get('/', (req,res)=> res.json({ status:'Radar Hybrid OK', time: nowISO() }));

// TEST endpoint to verify Telegram
app.get('/test', async (req,res) => {
  const msg = `<b>Radar Test</b>\nTime: ${new Date().toLocaleString()}\nURL: ${PRIMARY_URL}`;
  const r = await sendTelegramRaw(msg);
  res.json({ ok:true, tg: r });
});

// ANALYZE single symbol
app.get('/signal', async (req,res) => {
  try {
    const s = (req.query.symbol || req.query.s || 'BTCUSDT').toUpperCase();
    const prefer = (req.query.prefer || 'hybrid');
    const a = await analyzeHybrid(s);
    if (!a) return res.status(500).json({error:'no-data'});
    const sig = computeSignal(a);
    // record active & send depending
    if (sig.type !== 'NONE') {
      const decision = recordSignalAndDecide(Object.assign({symbol:s, price:a.price}, a), sig);
      if (shouldSendNow(s, sig.type, sig.confidence) || decision.action === 'UPDATE') {
        await sendTelegramRaw(decision.message);
        recordSent(s, sig.type, sig.confidence);
      }
      return res.json({ analysis: a, signal: sig, decision });
    } else {
      // still log
      const log = { symbol:s, time: nowISO(), analysis: a };
      res.json({ analysis: a, signal: sig });
    }
  } catch(e){
    res.status(500).json({ error: e.message || String(e) });
  }
});

// BATCHSCAN (scan a list or exchangeInfo limited)
app.get('/batchscan', async (req,res) => {
  try {
    // attempt to fetch exchangeInfo spot list (fallback static)
    let symbols = [];
    try {
      const info = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/exchangeInfo`);
      symbols = info.symbols.filter(s=>s.quoteAsset==='USDT' && s.status==='TRADING').map(s=>s.symbol);
    } catch(e){
      symbols = Object.keys(LEADER_GROUPS).concat(...Object.values(LEADER_GROUPS)).slice(0,200);
    }
    const limit = Math.min(symbols.length, Number(req.query.limit||200));
    const toScan = symbols.slice(0, limit);
    const results = [];
    await Promise.all(toScan.map(sym => limitP(async ()=>{
      try {
        const a = await analyzeHybrid(sym);
        if (!a) return;
        const sig = computeSignal(a);
        // send only if strong or IMF
        if ((sig.type !== 'NONE' && sig.confidence >= 75) || sig.type === 'IMF') {
          const decision = recordSignalAndDecide(Object.assign({symbol:sym, price:a.price}, a), sig);
          if (shouldSendNow(sym, sig.type, sig.confidence) || decision.action === 'UPDATE') {
            await sendTelegramRaw(decision.message);
            recordSent(sym, sig.type, sig.confidence);
          }
        }
        results.push({ symbol: sym, signal: sig.type, conf: sig.confidence, score: a.leaderScore });
      } catch(e) {}
    })));
    res.json({ scanned: toScan.length, results });
  } catch(e){
    res.status(500).json({ error: e.message || String(e) });
  }
});

// LEADERCHAIN quick: detect leaders in LEADER_GROUPS
app.get('/leaderchain', async (req,res) => {
  try {
    const groups = LEADER_GROUPS;
    const leaders = [];
    await Promise.all(Object.keys(groups).map(sym => limitP(async ()=>{
      try {
        const a = await analyzeHybrid(sym);
        const sig = computeSignal(a);
        if (sig.type === 'GOLDEN' || sig.type === 'SPOT' || sig.type === 'IMF') {
          leaders.push({ leader: sym, type: sig.type, conf: sig.confidence, price: a.price, vol: a.vol_ratio, rsi: a.rsi_h1 });
        }
      } catch(e){}
    })));
    // for leaders, scan followers quickly
    const resOut = [];
    for (const L of leaders) {
      const followers = LEADER_GROUPS[L.leader] || [];
      const notStarted = [];
      await Promise.all(followers.map(f => limitP(async ()=>{
        try {
          const a2 = await analyzeHybrid(f);
          if (!a2) return;
          if (a2.vol_ratio < 1.5 && a2.rsi_h1 < 50) notStarted.push({symbol:f, price: a2.price, vol: a2.vol_ratio, rsi: a2.rsi_h1});
        } catch(e){}
      })));
      if (notStarted.length) {
        const msg = `🚨 CHAIN ALERT\nLeader: ${L.leader} | ${L.type} | Price:${L.price} | Vol:${L.vol}\nFollowers chưa chạy: ${notStarted.map(x=>x.symbol).join(', ')}\nTime: ${nowISO()}`;
        await sendTelegramRaw(msg);
      }
      resOut.push({ leader: L.leader, followers_not_started: notStarted });
    }
    res.json({ leaders, resOut });
  } catch(e){ res.status(500).json({ error: e.message || String(e) }); }
});

// ACTIVE signals view
app.get('/active', (req,res) => {
  const act = loadActive();
  res.json({ count: Object.keys(act).length, list: act });
});

// manual close
app.post('/close', (req,res) => {
  const sym = (req.body && req.body.symbol || '').toUpperCase();
  if (!sym) return res.status(400).json({ error: 'symbol required' });
  const act = loadActive();
  if (!act[sym]) return res.status(404).json({ error: 'not found' });
  act[sym].status = 'CLOSED'; act[sym].closedTime = nowISO(); saveActive(act);
  sendTelegramRaw(`🛑 Position closed (manual) ${sym} | reason: ${req.body.reason || 'manual'}`);
  res.json({ ok:true });
});

// manual scale
app.post('/scale', (req,res) => {
  const sym = (req.body && req.body.symbol || '').toUpperCase();
  const factor = Number(req.body && req.body.factor || 0);
  const act = loadActive();
  if (!act[sym]) return res.status(404).json({ error: 'not found' });
  act[sym].recommendedVolFactor = Math.min(3, (act[sym].recommendedVolFactor || 1) + factor);
  act[sym].signals.push({ type:'MANUAL_SCALE', confidence:0, time: nowISO(), note: req.body.note || '' });
  saveActive(act);
  sendTelegramRaw(`🔁 Manual scale ${sym} -> new vol factor ${act[sym].recommendedVolFactor}×`);
  res.json({ ok:true, newFactor: act[sym].recommendedVolFactor });
});

// exit check quick
app.get('/exitcheck', async (req,res) => {
  const sym = (req.query.symbol || 'BTCUSDT').toUpperCase();
  const out = await checkExitForSymbol(sym);
  res.json(out || { error:'no-data' });
});

/* ====== SIMPLE AUTO-LEARN / OPTIMIZER SKELETON (runs daily) ====== */
const OPT_PATH = path.join(DATA_DIR, 'opt_stats.json');
function loadOpt(){ try{ if (!fs.existsSync(OPT_PATH)) return {}; return JSON.parse(fs.readFileSync(OPT_PATH,'utf8')||'{}'); }catch(e){return{}} }
function saveOpt(o){ try{ fs.writeFileSync(OPT_PATH, JSON.stringify(o,null,2)); }catch(e){console.error(e);} }

async function optimizerDaily() {
  try {
    const opt = loadOpt();
    // simple: count signals in active_signals.json and adjust weights (demo)
    const act = loadActive();
    for (const sym of Object.keys(act)) {
      const rec = act[sym];
      // naive scoring
      const wins = (opt[sym] && opt[sym].wins) || 0;
      const loses = (opt[sym] && opt[sym].loses) || 0;
      opt[sym] = { wins, loses, lastChecked: nowISO() };
    }
    saveOpt(opt);
    console.log('optimizerDaily done at', nowISO());
  } catch(e){ console.error('optimizerDaily err', e); }
}
// run once per 24h (but also can be triggered externally)
setInterval(()=>{ optimizerDaily().catch(()=>{}); }, 24*3600*1000);

/* ====== SELF PING (keep alive) ====== */
setInterval(()=>{ if (PRIMARY_URL) fetch(PRIMARY_URL).catch(()=>{}); }, 9*60*1000);

/* ====== LEARNING SCHEDULER ====== */
setInterval(async ()=>{
  try {
    const n = await LEARN.checkOutcomesForPending();
    if (n > 0) {
      console.log(`[LEARN] checked ${n} signals`);
    }

    const adjust = await LEARN.computeAdjustments();
    if (adjust.adjust) {
  console.log('[LEARN] adjustments suggested:', adjust);
  await LEARN.applyAdjustments(adjust.changes);
}
  } catch (e) {
    console.error('learning scheduler error', e);
  }
}, Number(process.env.LEARNING_POLL_MINUTES || 30) * 60 * 1000);

/* ====== AUTO RELOAD CONFIG ====== */
import { readFileSync } from 'fs';
let dynamicConfig = {};

function loadDynamicConfig(){
  try {
    const raw = readFileSync('./data/dynamic_config.json', 'utf8');
    dynamicConfig = JSON.parse(raw);
    console.log('[CONFIG] dynamic config loaded:', dynamicConfig);
  } catch(e){
    console.warn('[CONFIG] no dynamic_config.json yet');
  }
}

// Load ban đầu
loadDynamicConfig();

// Tự reload mỗi 5 phút
setInterval(loadDynamicConfig, 5 * 60 * 1000);

/* ====== START SERVER ====== */
app.listen(PORT, ()=>console.log(`Radar Hybrid running on port ${PORT}`));

// === Keep Render awake ===
import https from 'https';
const KEEP_ALIVE_INTERVAL = process.env.KEEP_ALIVE_INTERVAL || 10;

setInterval(() => {
  https.get(process.env.PRIMARY_URL || 'https://radar-worker-yte4.onrender.com');
  console.log(`[KeepAlive] Ping sent to self at ${new Date().toLocaleTimeString()}`);
}, KEEP_ALIVE_INTERVAL * 60 * 1000);
