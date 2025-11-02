// server.mjs
// Spot Smart Radar - Aggressive + Futures + Leader + SR + Auto-learning
// Paste đè file hiện tại. Requires node >=16.
// Run: node server.mjs

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import https from 'https';
import express from 'express';

// ====== CONFIG / ENV ======
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT || '';
const API_BASE_SPOT = process.env.API_BASE_SPOT || 'https://api.binance.com';
const API_BASE_FUT = process.env.API_BASE_FUT || 'https://fapi.binance.com';
const PRIMARY_URL = process.env.PRIMARY_URL || '';
const KEEP_ALIVE_INTERVAL = Number(process.env.KEEP_ALIVE_INTERVAL || 10); // minutes
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_SEC || 60) * 1000; // default 60s
const SYMBOL_REFRESH_H = Number(process.env.SYMBOL_REFRESH_H || 6);
const SYMBOL_MIN_VOL = Number(process.env.SYMBOL_MIN_VOL || 10000000); // 10M default
const ACTIVE_FILE = path.resolve('./active_symbols.json');
const LEARN_SIGNALS_FILE = path.resolve('./signals_store.json');
const CFG_FILE = path.resolve('./config_auto.json');

// ====== DEFAULT CFG (will be adjustable by learning module) ======
const DEFAULT_CFG = {
  version: 1,
  VOL_SPIKE_MULT: 1.8,
  TAKER_MIN: 0.52,
  GOLDEN_CHANGE24: 4,
  NEARENTRY_LO: 0.992,
  NEARENTRY_HI: 1.03,
  COOLDOWNS: { PRE:5, SPOT:8, GOLDEN:10, IMF:15, EXIT:3 },
  EVALUATION_LOOKBACK_HOURS: 72,
  MIN_SIGNALS_TO_ADJUST: 3,
  ADJUST_STEP: 0.05,
  TARGET_WINRATE: 0.65
};
let CFG = loadCFG(); // function defined below

// ====== ALERT COOLDOWN (runtime map) ======
const lastAlertTs = new Map(); // key = `${level}:${symbol}` -> timestamp ms

function canSendCooldown(symbol, level) {
  try {
    const cd = (CFG.COOLDOWNS && CFG.COOLDOWNS[level]) ? CFG.COOLDOWNS[level] : (level === 'PRE' ? 5 : 10);
    const key = `${level}:${symbol}`;
    const now = Date.now();
    const last = lastAlertTs.get(key) || 0;
    if ((now - last) / 60000 >= cd) {
      lastAlertTs.set(key, now);
      return true;
    }
    return false;
  } catch (e) { return true; }
}

// ====== LOGGER ======
function logv(msg) {
  const s = `[${new Date().toLocaleString('vi-VN')}] ${msg}`;
  console.log(s);
  try { fs.appendFileSync(path.resolve('./spot_logs.txt'), s + '\n'); } catch (e) {}
}
function fmt(n){ return (typeof n === 'number') ? Number(n.toFixed(8)) : n; }

// ====== HTTP SAFE FETCH ======
async function safeFetchJSON(url, retries = 2) {
  for (let i=0;i<retries;i++){
    try {
      const r = await fetch(url);
      if (!r.ok) {
        logv(`[HTTP] ${r.status} ${url}`);
        await new Promise(r=>setTimeout(r, 200*(i+1)));
        continue;
      }
      return await r.json();
    } catch (e) {
      logv('[HTTP] fetch error ' + e.message + ' url=' + url);
      await new Promise(r=>setTimeout(r, 200*(i+1)));
    }
  }
  return null;
}
async function safeFetchJSON_FUT(url, retries = 2) {
  for (let i=0;i<retries;i++){
    try {
      const r = await fetch(url);
      if (!r.ok) { logv(`[HTTP-FUT] ${r.status} ${url}`); await new Promise(r=>setTimeout(r,300*(i+1))); continue; }
      return await r.json();
    } catch(e){
      logv('[HTTP-FUT] ' + e.message + ' url=' + url);
      await new Promise(r=>setTimeout(r,300*(i+1)));
    }
  }
  return null;
}

// ====== INDICATORS ======
function sma(arr, n = 20) {
  if(!arr || arr.length < 1) return null;
  const slice = arr.slice(-n);
  const sum = slice.reduce((s,x)=>s + Number(x), 0);
  return sum / slice.length;
}
function computeRSI(closes, period = 14) {
  if(!closes || closes.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i=1;i<=period;i++){
    const d = closes[i] - closes[i-1];
    if (d>0) gains += d; else losses -= d;
  }
  let avgGain = gains/period;
  let avgLoss = losses/period || 1;
  for (let i=period+1;i<closes.length;i++){
    const d = closes[i] - closes[i-1];
    avgGain = (avgGain*(period-1) + Math.max(0,d))/period;
    avgLoss = (avgLoss*(period-1) + Math.max(0,-d))/period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain/avgLoss;
  return 100 - (100/(1+rs));
}
function pearsonCorr(a, b) {
  if(!a?.length || a.length !== b.length) return 0;
  const n = a.length;
  const meanA = a.reduce((s,x)=>s+x,0)/n;
  const meanB = b.reduce((s,x)=>s+x,0)/n;
  let num=0, denA=0, denB=0;
  for (let i=0;i<n;i++){ const da=a[i]-meanA, db=b[i]-meanB; num+=da*db; denA+=da*da; denB+=db*db; }
  const denom = Math.sqrt(denA*denB)||1;
  return num/denom;
}
function computeSR_from_klines(kjson, window=20){
  const highs = kjson.slice(-window).map(r=>Number(r[2]));
  const lows = kjson.slice(-window).map(r=>Number(r[3]));
  const resistance = Math.max(...highs);
  const support = Math.min(...lows);
  const pivot = (resistance + support) / 2;
  return { resistance, support, pivot };
}
function computeTakerRatioFromTicker(tjson){
  try{
    const takerBase = Number(tjson.takerBuyBaseVolume || tjson.takerBuyQuoteAssetVolume || 0);
    const baseVol = Number(tjson.volume || tjson.quoteVolume || 0);
    if(baseVol <= 0) return 0.5;
    return Math.min(1, Math.max(0, takerBase / (baseVol || 1)));
  }catch(e){ return 0.5; }
}

// ====== FUTURES METRICS ======
async function fetchFuturesMetrics(sym){
  try{
    const urlKl = `${API_BASE_FUT}/fapi/v1/klines?symbol=${sym}&interval=1h&limit=60`;
    const urlT  = `${API_BASE_FUT}/fapi/v1/ticker/24hr?symbol=${sym}`;
    const urlOI = `${API_BASE_FUT}/fapi/v1/openInterest?symbol=${sym}`;
    const urlFund = `${API_BASE_FUT}/fapi/v1/premiumIndex?symbol=${sym}`;
    const [kjson, tjson, oiJson, fundJson] = await Promise.all([
      safeFetchJSON_FUT(urlKl), safeFetchJSON_FUT(urlT), safeFetchJSON_FUT(urlOI), safeFetchJSON_FUT(urlFund)
    ]);
    return { kjson, tjson, oiJson, fundJson };
  } catch(e){ return {}; }
}

// ====== SYMBOL LOADER ======
let SYMBOLS = [];
let lastSymbolsTs = 0;
async function loadSymbols({minVol=SYMBOL_MIN_VOL, minChange=1} = {}) {
  try{
    const now = Date.now()/1000;
    if(lastSymbolsTs + SYMBOL_REFRESH_H*3600 > now && SYMBOLS.length) return SYMBOLS;
    const url = `${API_BASE_SPOT}/api/v3/ticker/24hr`;
    const data = await safeFetchJSON(url, 2);
    if(!Array.isArray(data)) return SYMBOLS;
    const syms = data
      .filter(s=> s.symbol && s.symbol.endsWith('USDT'))
      .filter(s=> !/UPUSDT|DOWNUSDT|BULLUSDT|BEARUSDT|_/.test(s.symbol))
      .map(s=> ({ symbol: s.symbol, vol: Number(s.quoteVolume||0), change: Number(s.priceChangePercent||0) }))
      .filter(s => s.vol >= minVol && Math.abs(s.change) >= minChange)
      .sort((a,b)=> b.vol - a.vol)
      .map(s => s.symbol);
    SYMBOLS = syms;
    lastSymbolsTs = now;
    logv(`[SYMBOLS] loaded ${SYMBOLS.length} USDT pairs (vol>=${minVol})`);
    return SYMBOLS;
  }catch(e){ logv('[SYMBOLS] load error ' + e.message); return SYMBOLS; }
}

// ====== ACTIVE TRACKING ======
const activeSpots = new Map();
function loadActiveFile() {
  try {
    if (fs.existsSync(ACTIVE_FILE)) {
      const raw = fs.readFileSync(ACTIVE_FILE,'utf8');
      const obj = JSON.parse(raw || '{}');
      for(const [k,v] of Object.entries(obj)) activeSpots.set(k,v);
      logv(`[ENTRY_TRACK] loaded ${activeSpots.size} active entries`);
    }
  } catch(e){ logv('[ENTRY_TRACK] load file err ' + e.message); }
}
function saveActiveFile() {
  try {
    const obj = Object.fromEntries(activeSpots);
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify(obj, null, 2));
  } catch(e) { logv('[ENTRY_TRACK] save error ' + e.message); }
}
async function markSpotEntry(symbol, type, meta={}) {
  activeSpots.set(symbol, { type, markedAt: Date.now(), meta });
  saveActiveFile();
  logv(`[MARK ENTRY] ${symbol} type=${type} price=${meta.price} ma20=${meta.ma20}`);
}
function clearSpotEntry(symbol) {
  if(activeSpots.has(symbol)) {
    activeSpots.delete(symbol);
    saveActiveFile();
    logv(`[CLEAR ENTRY] ${symbol}`);
  }
}

// ====== SL/TP helper ======
function computeSLTP(entry, type) {
  const cfg = {
    PRE: { slPct: 0.01, tpPct: 0.05 },
    SPOT: { slPct: 0.015, tpPct: 0.06 },
    GOLDEN: { slPct: 0.02, tpPct: 0.10 },
    IMF: { slPct: 0.03, tpPct: 0.15 }
  }[type] || { slPct: 0.02, tpPct: 0.08 };
  const sl = fmt(entry * (1 - cfg.slPct));
  const tp = fmt(entry * (1 + cfg.tpPct));
  return { sl, tp, slPct: cfg.slPct, tpPct: cfg.tpPct };
}

// ====== TELEGRAM SENDER & SMART ALERT ======
async function sendTelegram(text) {
  if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    logv('[TELEGRAM] missing TOKEN/CHAT_ID');
    return false;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) { logv(`[TELEGRAM] send failed ${res.status}`); return false; }
    return true;
  } catch(e) { logv('[TELEGRAM] error ' + e.message); return false; }
}

// Learning module functions will be used by sendSmartAlert to record signals
// recordSignal defined later in LEARNING MODULE

async function sendSmartAlert(symbol, level, msg) {
  try {
    if (!canSendCooldown(symbol, level)) {
      logv(`[SUPPRESS] ${level} ${symbol} suppressed by cooldown`);
      return false;
    }
    const ok = await sendTelegram(msg);
    if (ok) {
      logv(`[SENT] ${level} ${symbol}`);
      // record to activeSpots meta if present
      const meta = activeSpots.get(symbol) || {};
      // recordSignal will be available from learning module loaded below
      try { await recordSignal({ symbol, type: level, timeISO: new Date().toISOString(), price: meta?.meta?.price || null, rsi: meta?.meta?.rsi || null, vol: meta?.meta?.vol || null, change24: meta?.meta?.change24 || null, slPct: null, tpPct: null, extra: '' }); } catch(e){}
      return true;
    } else {
      logv(`[FAIL] telegram send for ${symbol}`);
      return false;
    }
  } catch(e){ logv('[sendSmartAlert] ' + e.message); return false; }
}

// ====== ENHANCED ANALYZE (AGGRESSIVE) ======
async function analyzeSymbol(sym) {
  try {
    const kUrl = `${API_BASE_SPOT}/api/v3/klines?symbol=${sym}&interval=1h&limit=60`;
    const tUrl = `${API_BASE_SPOT}/api/v3/ticker/24hr?symbol=${sym}`;
    const kUrlBTC = `${API_BASE_SPOT}/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=60`;

    const [kjson, tjson, kjsonBTC] = await Promise.all([safeFetchJSON(kUrl), safeFetchJSON(tUrl), safeFetchJSON(kUrlBTC)]);
    if (!kjson || !tjson || !kjsonBTC) return;

    const closes = kjson.map(c => Number(c[4]));
    const vols = kjson.map(c => Number(c[5]));
    const price = Number(tjson.lastPrice || closes.at(-1));
    const change24 = Number(tjson.priceChangePercent || 0);
    const vol = Number(tjson.quoteVolume || 0);
    const ma20 = sma(closes, 20) || closes.at(-1);
    const rsi = computeRSI(closes.slice(-30)) || 50;
    const volAvg = sma(vols, 20) || 1;
    const volNow = vols.at(-1) || 0;

    // taker ratio & SR
    const takerRatio = computeTakerRatioFromTicker(tjson) || 0.5;
    const sr = computeSR_from_klines(kjson, 20);
    const nearSupport = price <= sr.support * 1.01 && price >= sr.support * 0.985;

    // leader correlation
    const btcCloses = kjsonBTC.map(c => Number(c[4]));
    const L = Math.min(24, closes.length, btcCloses.length);
    const retA = [], retB = [];
    for (let i = closes.length - L; i < closes.length; i++) {
      if (i <= 0) continue;
      retA.push((closes[i] - closes[i - 1]) / closes[i - 1]);
      const bi = btcCloses[btcCloses.length - (closes.length - i)];
      const biPrev = btcCloses[btcCloses.length - (closes.length - i) - 1];
      if (biPrev) retB.push((bi - biPrev) / biPrev);
    }
    const leaderCorr = Math.abs(pearsonCorr(retA, retB)) || 0;

    // futures metrics
    let futMetrics = await fetchFuturesMetrics(sym).catch(()=>({}));
    const futFund = futMetrics.fundJson ? Number(futMetrics.fundJson.lastFundingRate || 0) : 0;
    const futOI = futMetrics.oiJson ? Number(futMetrics.oiJson.openInterest || 0) : 0;
    const futPrice = futMetrics.tjson ? Number(futMetrics.tjson.lastPrice || price) : price;

    // noise filters (aggressive tolerances)
    if (rsi < 35 || rsi > 85) return;
    if (vol < volAvg * 0.5) return;
    if (Math.abs(change24) > 30) return;

    // smartmoney signals using CFG
    const sm_volSpike = volNow > volAvg * (CFG.VOL_SPIKE_MULT || 1.8);
    const sm_taker = takerRatio > (CFG.TAKER_MIN || 0.52);
    const sm_future_long_bias = futFund > 0.0003 || (futPrice > ma20 * 1.015 && futOI > 0);

    const nearEntry = price >= ma20 * (CFG.NEARENTRY_LO || 0.992) && price <= ma20 * (CFG.NEARENTRY_HI || 1.03);

    const isIMF = sm_volSpike && (sm_taker || leaderCorr > 0.5) && price > ma20 * 0.992;
    const isGolden = (price > ma20 * 1.03 && change24 >= (CFG.GOLDEN_CHANGE24 || 4) && sm_volSpike && (sm_taker || sm_future_long_bias) && leaderCorr > 0.3);
    const isSpotConfirm = price > ma20 * 1.001 && vol > volAvg * 1.6 && rsi >= 48 && rsi <= 70 && (takerRatio > 0.50 || leaderCorr > 0.25);
    const isPre = nearEntry && vol > volAvg * 1.1 && rsi >= 42 && rsi <= 60 && Math.abs(change24) < 10 && (nearSupport || takerRatio > 0.50);

    let chosen = null;
    if (isIMF) chosen = 'IMF';
    else if (isGolden) chosen = 'GOLDEN';
    else if (isSpotConfirm) chosen = 'SPOT';
    else if (isPre) chosen = 'PRE';
    if (!chosen) return;

    const entry = price;
    let { sl, tp } = computeSLTP(entry, chosen);
    if (nearSupport) { sl = Math.max(sl, fmt(sr.support * 0.997)); }

    let conf = 55;
    if (takerRatio > 0.54) conf += 8;
    if (sm_volSpike) conf += 12;
    if (sm_future_long_bias) conf += 8;
    if (leaderCorr > 0.45) conf += 10;
    if (isGolden) conf += 12;
    conf = Math.min(99, conf);

    const lines = [];
    lines.push(`<b>[SPOT ${chosen}] ${sym}</b>`);
    lines.push(`Price: ${entry} | MA20: ${fmt(ma20)} | Conf: ${Math.round(conf)}%`);
    lines.push(`Entry zone(SR): ${fmt(sr.support * 0.997)} - ${fmt(sr.resistance * 1.003)} (S:${fmt(sr.support)} R:${fmt(sr.resistance)})`);
    lines.push(`SL: ${sl} | TP: ${tp}`);
    lines.push(`VolNow:${Math.round(volNow)} VolAvg:${Math.round(volAvg)} | 24h:${change24}% | taker:${(takerRatio*100).toFixed(1)}%`);
    lines.push(`FutureFunding:${futFund} | FutureOI:${futOI} | leaderCorr:${(leaderCorr*100).toFixed(1)}%`);
    lines.push(`Time: ${new Date().toLocaleString('vi-VN')}`);

    const msg = lines.join('\n');

    // send via smart alert (handles cooldown & recording)
    await sendSmartAlert(sym, chosen, msg);

    // mark active entry
    markSpotEntry(sym, chosen, { price: entry, ma20: fmt(ma20), vol, change24, rsi, conf });

  } catch (e) {
    logv(`[ANALYZE-AGG] ${sym} error ${e.message}`);
  }
}

// ====== MAIN SCAN LOOP ======
let scanning = false;
async function scanOnce() {
  if (scanning) return;
  scanning = true;
  try {
    await loadSymbols();
    if (SYMBOLS.length === 0) SYMBOLS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT'];
    logv(`[SCAN] start scanning ${SYMBOLS.length} symbols`);
    for (const sym of SYMBOLS) {
      try { await analyzeSymbol(sym); } catch(e) { logv(`[SCAN] ${sym} err ${e.message}`); }
      await new Promise(r=>setTimeout(r, 250));
    }
    // check exits
    if (activeSpots.size > 0) {
      logv(`[EXIT_SCAN] checking ${activeSpots.size} actives`);
      for (const [sym, data] of activeSpots.entries()) {
        await detectExitForActive(sym, data);
        await new Promise(r=>setTimeout(r, 250));
      }
    }
    logv('[SCAN] cycle complete');
  } catch (e) { logv('[SCAN] fatal ' + e.message); }
  finally { scanning = false; }
}

// ====== EXIT DETECTION ======
async function detectExitForActive(sym, data) {
  try {
    const kUrl = `${API_BASE_SPOT}/api/v3/klines?symbol=${sym}&interval=1h&limit=40`;
    const kjson = await safeFetchJSON(kUrl);
    if (!kjson) return;
    const closes = kjson.map(c=>Number(c[4]));
    const ma20 = sma(closes,20) || closes.at(-1);
    const price = closes.at(-1);
    const rsiNow = computeRSI(closes.slice(-30)) || 50;
    let exitReason = null;
    if (data.type === 'GOLDEN') {
      if (price < ma20 * 0.998) exitReason = 'Giá cắt xuống MA20';
    } else if (data.type === 'SPOT' || data.type === 'PRE') {
      const rsiPrev = computeRSI(closes.slice(-31,-1)) || 50;
      if (rsiPrev > 50 && rsiNow < 45) exitReason = 'RSI giảm mạnh';
      if (price < ma20 * 0.995) exitReason = 'Giá giảm xuyên MA20';
    } else if (data.type === 'IMF') {
      if (price < ma20 * 0.995 || rsiNow < 45) exitReason = 'IMF rejection / RSI giảm';
    }
    if (exitReason) {
      const msg = [
        `<b>[SPOT EXIT] (${data.type}) ${sym}</b>`,
        `Reason: ${exitReason}`,
        `EntryAt: ${data.meta?.price || 'NA'}`,
        `Now: ${price}`,
        `MA20: ${fmt(ma20)} | RSI: ${rsiNow?.toFixed(1)}`,
        `Time: ${new Date().toLocaleString('vi-VN')}`
      ].join('\n');
      await sendTelegram(msg);
      logv(`[EXIT] ${sym} ${exitReason} now=${price}`);
      clearSpotEntry(sym);
    }
  } catch(e) { logv('[EXIT_CHECK] ' + e.message); }
}

// ====== LEARNING / OPTIMIZER MODULE ======
function loadCFG() {
  try {
    if (!fs.existsSync(CFG_FILE)) { fs.writeFileSync(CFG_FILE, JSON.stringify(DEFAULT_CFG, null, 2)); return JSON.parse(JSON.stringify(DEFAULT_CFG)); }
    return JSON.parse(fs.readFileSync(CFG_FILE,'utf8'));
  } catch(e) { logv('[LEARN] loadCFG err ' + e.message); return JSON.parse(JSON.stringify(DEFAULT_CFG)); }
}
function saveCFG(cfg){ try { fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2)); } catch(e){ logv('[LEARN] saveCFG err ' + e.message); } }

function loadSignalsStore() {
  try { if(!fs.existsSync(LEARN_SIGNALS_FILE)) return []; return JSON.parse(fs.readFileSync(LEARN_SIGNALS_FILE,'utf8')||'[]'); } catch(e){ logv('[LEARN] loadSignals err ' + e.message); return []; }
}
function saveSignalsStore(arr){ try { fs.writeFileSync(LEARN_SIGNALS_FILE, JSON.stringify(arr, null, 2)); } catch(e){ logv('[LEARN] saveSignals err ' + e.message); } }

async function recordSignal(signal) {
  try {
    const arr = loadSignalsStore();
    arr.push(Object.assign({ recordedAt: Date.now() }, signal));
    if (arr.length > 20000) arr.shift();
    saveSignalsStore(arr);
    logv(`[LEARN] recorded ${signal.symbol} ${signal.type}`);
    return true;
  } catch(e){ logv('[LEARN] record err ' + e.message); return false; }
}

async function evaluateSignalOutcome(sig) {
  try {
    const lookbackHours = CFG.EVALUATION_LOOKBACK_HOURS || 72;
    const url = `${API_BASE_SPOT}/api/v3/klines?symbol=${sig.symbol}&interval=1h&limit=${Math.min(200, lookbackHours+10)}`;
    const res = await safeFetchJSON(url, 2);
    if (!res || !Array.isArray(res) || res.length === 0) return { result: 'UNKNOWN' };
    const t0 = new Date(sig.timeISO).getTime();
    let startIdx = 0;
    for (let i=0;i<res.length;i++){ if (Number(res[i][0]) >= t0) { startIdx = i; break; } }
    const checkCount = Math.min(res.length - startIdx, Math.ceil(lookbackHours));
    if (checkCount <= 0) return { result: 'NEUTRAL' };
    const tpPrice = sig.price * (1 + (sig.tpPct || 0.06));
    const slPrice = sig.price * (1 - (sig.slPct || 0.02));
    for (let i = startIdx; i < startIdx + checkCount; i++){
      const high = Number(res[i][2]), low = Number(res[i][3]);
      if (high >= tpPrice && low <= slPrice) return { result: 'AMBIG' };
      if (high >= tpPrice) return { result: 'WIN' };
      if (low <= slPrice) return { result: 'LOSE' };
    }
    return { result: 'NEUTRAL' };
  } catch(e){ logv('[LEARN] eval err ' + e.message); return { result: 'ERR' }; }
}

async function checkOutcomesForPending() {
  try {
    const arr = loadSignalsStore();
    const now = Date.now();
    let updated = 0;
    for (let s of arr) {
      if (s.evaluatedAt) continue;
      if (now - new Date(s.timeISO).getTime() < 60*60*1000) continue;
      const res = await evaluateSignalOutcome(s);
      s.evaluatedAt = Date.now();
      s.evalResult = res.result;
      updated++;
      await new Promise(r=>setTimeout(r,200));
    }
    if (updated) { saveSignalsStore(arr); logv(`[LEARN] evaluated ${updated}`); }
    return updated;
  } catch(e){ logv('[LEARN] checkOut err ' + e.message); return 0; }
}

function computeAdjustmentsFromHistory() {
  try {
    const arr = loadSignalsStore();
    const now = Date.now();
    const lookback = (CFG.EVALUATION_LOOKBACK_HOURS || 72) * 3600000;
    const byType = {};
    for (const s of arr) {
      if (!s.evaluatedAt) continue;
      if (now - s.recordedAt > lookback) continue;
      const t = s.type || 'SPOT';
      if (!byType[t]) byType[t] = { total:0, win:0, lose:0, ambig:0 };
      byType[t].total++;
      if (s.evalResult === 'WIN') byType[t].win++;
      else if (s.evalResult === 'LOSE') byType[t].lose++;
      else if (s.evalResult === 'AMBIG') byType[t].ambig++;
    }
    const adjustments = { changes: {}, didAdjust: false, summary: byType };
    for (const [type, stats] of Object.entries(byType)) {
      if (stats.total < (CFG.MIN_SIGNALS_TO_ADJUST || 3)) continue;
      const winRate = stats.win / Math.max(1, stats.total);
      const delta = winRate - (CFG.TARGET_WINRATE || 0.65);
      if (Math.abs(delta) < 0.03) continue;
      const step = CFG.ADJUST_STEP || 0.05;
      if (delta < 0) {
        CFG.VOL_SPIKE_MULT = +(CFG.VOL_SPIKE_MULT * (1 + step)).toFixed(3);
        CFG.TAKER_MIN = +(Math.min(0.99, CFG.TAKER_MIN * (1 + step))).toFixed(3);
        adjustments.changes[type] = { VOL_SPIKE_MULT: CFG.VOL_SPIKE_MULT, TAKER_MIN: CFG.TAKER_MIN };
        adjustments.didAdjust = true;
      } else {
        CFG.VOL_SPIKE_MULT = +(CFG.VOL_SPIKE_MULT * (1 - step)).toFixed(3);
        CFG.TAKER_MIN = +(Math.max(0.01, CFG.TAKER_MIN * (1 - step))).toFixed(3);
        adjustments.changes[type] = { VOL_SPIKE_MULT: CFG.VOL_SPIKE_MULT, TAKER_MIN: CFG.TAKER_MIN };
        adjustments.didAdjust = true;
      }
    }
    if (adjustments.didAdjust) { saveCFG(CFG); logv('[LEARN] adjustments: ' + JSON.stringify(adjustments.changes)); }
    else logv('[LEARN] no adjustments');
    return adjustments;
  } catch(e){ logv('[LEARN] computeAdj err ' + e.message); return { didAdjust: false }; }
}

// scheduler
const LEARN_POLL_MIN = Number(process.env.LEARN_POLL_MIN || 30);
setInterval(async () => {
  try {
    const n = await checkOutcomesForPending();
    if (n>0) logv(`[LEARN-SCHED] processed ${n}`);
    const adj = computeAdjustmentsFromHistory();
    if (adj.didAdjust) await sendTelegram(`<b>[LEARN] Auto adjustments applied</b>\n${JSON.stringify(adj.changes)}`);
  } catch(e){ logv('[LEARN] sched err ' + e.message); }
}, LEARN_POLL_MIN * 60 * 1000);

// ====== BOOT & SCHEDULER ======
loadActiveFile();
setInterval(scanOnce, SCAN_INTERVAL_MS);
await scanOnce();

// keep-alive ping primary url
if (PRIMARY_URL) {
  setInterval(()=> {
    try { https.get(PRIMARY_URL); logv('[KEEPALIVE] ping'); } catch(e){}
  }, KEEP_ALIVE_INTERVAL * 60 * 1000);
}

// express health
const app = express();
app.get('/', (req,res)=> res.send('Spot Smart Radar OK'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> logv(`Server listening on port ${PORT}`));

// ====== EXPORT (optional) ======
export default { scanOnce, analyzeSymbol, CFG };
