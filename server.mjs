// server_v2.9.mjs
// Spot SmartMoney Breakout v2.9 - Hybrid Confirm (High Winrate)
// Requires Node >= 16 (ESM). Run: node server_v2.9.mjs

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import https from 'https';
import express from 'express';

/// ===== ENV & CONFIG =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const API_BASE_SPOT = process.env.API_BASE_SPOT || 'https://api.binance.com';
const API_BASE_FUT = process.env.API_BASE_FUT || 'https://fapi.binance.com';
const PRIMARY_URL = process.env.PRIMARY_URL || '';
const PORT = process.env.PORT || 3000;
const SCAN_INTERVAL_MS = (Number(process.env.SCAN_INTERVAL_SEC) || 60) * 1000;
const SYMBOL_REFRESH_H = Number(process.env.SYMBOL_REFRESH_H || 6);
const SYMBOL_MIN_VOL = Number(process.env.SYMBOL_MIN_VOL || 10000000);
const ACTIVE_FILE = path.resolve('./active_symbols.json');
const LOG_FILE = path.resolve('./spot_logs.txt');
const SIGNAL_STORE = path.resolve('./signals_store.json');
const CFG_FILE = path.resolve('./config_auto.json');

/// ===== DEFAULT CFG =====
const DEFAULT_CFG = {
  version: 1,
  VOL_SPIKE_MULT: 1.8,
  TAKER_MIN: 0.52,
  GOLDEN_CHANGE24: 4,
  NEARENTRY_LO: 0.992,
  NEARENTRY_HI: 1.03,
  COOLDOWNS: { PRE:5, SPOT:10, GOLDEN:15, IMF:20, EXIT:5 },
  EVALUATION_LOOKBACK_HOURS: 72,
  MIN_SIGNALS_TO_ADJUST: 3,
  ADJUST_STEP: 0.05,
  TARGET_WINRATE: 0.75,
  MULTI_TF_CONFIRM: true,
  KEEP_LOG_FILE: true
};

let CFG = loadCFG();

/// ===== Utilities =====
function nowStr(){ return new Date().toLocaleString('vi-VN'); }
function fmt(n){ return (typeof n === 'number') ? Number(n.toFixed(8)) : n; }
function logv(msg){
  const s = `[${nowStr()}] ${msg}`;
  console.log(s);
  if(CFG.KEEP_LOG_FILE){
    try{ fs.appendFileSync(LOG_FILE, s + '\n'); } catch(e){}
  }
}

async function safeFetchJSON(url, retries=2){
  for(let i=0;i<retries;i++){
    try{
      const r = await fetch(url);
      if(!r.ok){ logv(`[HTTP] ${r.status} ${url}`); await new Promise(r=>setTimeout(r,200*(i+1))); continue; }
      return await r.json();
    }catch(e){
      logv('[HTTP] err '+ e.message + ' url=' + url);
      await new Promise(r=>setTimeout(r,200*(i+1)));
    }
  }
  return null;
}
async function safeFetchJSON_FUT(url, retries=2){
  for(let i=0;i<retries;i++){
    try{
      const r = await fetch(url);
      if(!r.ok){ logv(`[HTTP-FUT] ${r.status} ${url}`); await new Promise(r=>setTimeout(r,300*(i+1))); continue; }
      return await r.json();
    }catch(e){
      logv('[HTTP-FUT] err '+ e.message + ' url=' + url);
      await new Promise(r=>setTimeout(r,300*(i+1)));
    }
  }
  return null;
}

function sma(arr, n=20){ if(!arr||arr.length<1) return null; const s = arr.slice(-n).reduce((a,b)=>a+Number(b),0); return s/Math.min(n, arr.length); }
function computeRSI(closes, period=14){
  if(!closes||closes.length<=period) return null;
  let gains=0, losses=0;
  for(let i=1;i<=period;i++){ const d=closes[i]-closes[i-1]; if(d>0) gains+=d; else losses-=d; }
  let avgG=gains/period, avgL=losses/period||1;
  for(let i=period+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    avgG=(avgG*(period-1)+Math.max(0,d))/period;
    avgL=(avgL*(period-1)+Math.max(0,-d))/period;
  }
  if(avgL===0) return 100;
  const rs=avgG/avgL; return 100-(100/(1+rs));
}
function pearsonCorr(a,b){
  if(!a||!b||a.length!==b.length||a.length===0) return 0;
  const n=a.length;
  const ma=a.reduce((s,x)=>s+x,0)/n, mb=b.reduce((s,x)=>s+x,0)/n;
  let num=0, da=0, db=0;
  for(let i=0;i<n;i++){ const x=a[i]-ma, y=b[i]-mb; num+=x*y; da+=x*x; db+=y*y; }
  return num/Math.sqrt(Math.max(1,da*db));
}
function computeSR(kjson, window=20){
  const slice = kjson.slice(-window);
  const highs = slice.map(r=>Number(r[2])), lows = slice.map(r=>Number(r[3]));
  return { resistance: Math.max(...highs), support: Math.min(...lows), pivot: (Math.max(...highs)+Math.min(...lows))/2 };
}
function computeTakerRatio(tjson){
  try{
    const takerBuy = Number(tjson.takerBuyQuoteAssetVolume || tjson.takerBuyBaseVolume || 0);
    const quoteVol = Number(tjson.quoteVolume || tjson.volume || 0);
    if(quoteVol<=0) return 0.5;
    return Math.min(1, Math.max(0, takerBuy / quoteVol));
  }catch(e){ return 0.5; }
}

/// ===== CFG & Signals store =====
function loadCFG(){
  try{
    if(!fs.existsSync(CFG_FILE)){ fs.writeFileSync(CFG_FILE, JSON.stringify(DEFAULT_CFG, null,2)); return JSON.parse(JSON.stringify(DEFAULT_CFG)); }
    const c = JSON.parse(fs.readFileSync(CFG_FILE,'utf8'));
    return Object.assign(JSON.parse(JSON.stringify(DEFAULT_CFG)), c);
  }catch(e){ logv('[CFG] load err '+ e.message); return JSON.parse(JSON.stringify(DEFAULT_CFG)); }
}
function saveCFG(){ try{ fs.writeFileSync(CFG_FILE, JSON.stringify(CFG, null,2)); }catch(e){ logv('[CFG] save err '+ e.message); } }
function loadSignals(){
  try{ if(!fs.existsSync(SIGNAL_STORE)) return []; const s = JSON.parse(fs.readFileSync(SIGNAL_STORE,'utf8')||'[]'); return s; }catch(e){ return []; }
}
function saveSignals(arr){ try{ fs.writeFileSync(SIGNAL_STORE, JSON.stringify(arr, null,2)); }catch(e){ logv('[LEARN] save err '+ e.message); } }

async function recordSignal(sig){
  try{
    const arr = loadSignals();
    arr.push(Object.assign({ recordedAt: Date.now() }, sig));
    if(arr.length>20000) arr.shift();
    saveSignals(arr);
    logv(`[LEARN] recorded ${sig.symbol} ${sig.type}`);
  }catch(e){ logv('[LEARN] record err '+ e.message); }
}

/// ===== SYMBOLS loader =====
let SYMBOLS = [];
let lastSymbolsTs = 0;
async function loadSymbols(minVol=SYMBOL_MIN_VOL, minChange=1){
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
      .filter(s=> s.vol >= minVol && Math.abs(s.change) >= minChange)
      .sort((a,b)=> b.vol - a.vol)
      .map(s=> s.symbol);
    SYMBOLS = syms;
    lastSymbolsTs = now;
    logv(`[SYMBOLS] loaded ${SYMBOLS.length}`);
    return SYMBOLS;
  }catch(e){ logv('[SYMBOL] load err '+ e.message); return SYMBOLS; }
}

/// ===== ACTIVE entries storage =====
const activeMap = new Map();
function loadActive(){
  try{
    if(!fs.existsSync(ACTIVE_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(ACTIVE_FILE,'utf8')||'{}');
    for(const k of Object.keys(obj)) activeMap.set(k, obj[k]);
    logv(`[ACTIVE] loaded ${activeMap.size}`);
  }catch(e){ logv('[ACTIVE] load err '+ e.message); }
}
function saveActive(){
  try{ const obj = Object.fromEntries(activeMap); fs.writeFileSync(ACTIVE_FILE, JSON.stringify(obj, null,2)); }catch(e){ logv('[ACTIVE] save err '+ e.message); }
}
function markActive(sym, type, meta){
  activeMap.set(sym, { type, markedAt: Date.now(), meta });
  saveActive();
  logv(`[MARK] ${sym} ${type}`);
}
function clearActive(sym){
  if(activeMap.has(sym)){ activeMap.delete(sym); saveActive(); logv(`[CLEAR] ${sym}`); }
}

/// ===== Tele send =====
async function sendTelegram(text){
  if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID){ logv('[TELE] missing token/chat'); return false; }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true };
  try{
    const r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
    if(!r.ok) { logv(`[TELE] send failed ${r.status}`); return false; }
    return true;
  }catch(e){ logv('[TELE] err '+ e.message); return false; }
}

/// ===== cooldown per symbol/type =====
const lastAlert = new Map();
function canSend(sym, type){
  try{
    const cd = (CFG.COOLDOWNS && CFG.COOLDOWNS[type]) ? CFG.COOLDOWNS[type] : 10;
    const key = `${type}:${sym}`;
    const now = Date.now();
    const last = lastAlert.get(key) || 0;
    if((now - last)/60000 >= cd){ lastAlert.set(key, now); return true; }
    return false;
  }catch(e){ return true; }
}

/// ===== FUTURE helper =====
async function fetchFutureMetrics(sym){
  try{
    const kUrl = `${API_BASE_FUT}/fapi/v1/klines?symbol=${sym}&interval=1h&limit=60`;
    const tUrl = `${API_BASE_FUT}/fapi/v1/ticker/24hr?symbol=${sym}`;
    const oiUrl = `${API_BASE_FUT}/fapi/v1/openInterest?symbol=${sym}`;
    const fundUrl = `${API_BASE_FUT}/fapi/v1/premiumIndex?symbol=${sym}`;
    const [kjson, tjson, oiJson, fundJson] = await Promise.all([
      safeFetchJSON_FUT(kUrl), safeFetchJSON_FUT(tUrl), safeFetchJSON_FUT(oiUrl), safeFetchJSON_FUT(fundUrl)
    ]);
    return { kjson, tjson, oiJson, fundJson };
  }catch(e){ return {}; }
}

/// ===== Analyze symbol with v2.9 rules =====
async function analyzeSymbol(sym){
  try{
    const kUrl = `${API_BASE_SPOT}/api/v3/klines?symbol=${sym}&interval=1h&limit=60`;
    const tUrl = `${API_BASE_SPOT}/api/v3/ticker/24hr?symbol=${sym}`;
    const kUrl15 = `${API_BASE_SPOT}/api/v3/klines?symbol=${sym}&interval=15m&limit=60`;
    const kUrlBTC = `${API_BASE_SPOT}/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=60`;

    const [kjson, tjson, k15json, kBTC] = await Promise.all([safeFetchJSON(kUrl), safeFetchJSON(tUrl), safeFetchJSON(kUrl15), safeFetchJSON(kUrlBTC)]);
    if(!kjson || !tjson || !k15json || !kBTC) return;

    const closes = kjson.map(r=>Number(r[4]));
    const vols = kjson.map(r=>Number(r[5]));
    const price = Number(tjson.lastPrice || closes.at(-1));
    const change24 = Number(tjson.priceChangePercent || 0);
    const volNow = vols.at(-1)||0;
    const volAvg = Math.max(1, sma(vols, 20) || 1);
    const ma20 = sma(closes,20) || closes.at(-1);
    const rsi = computeRSI(closes.slice(-30)) || 50;
    const taker = computeTakerRatio(tjson) || 0.5;
    const sr = computeSR(kjson, 20);
    // leader corr (recent)
    const btcCloses = kBTC.map(r=>Number(r[4]));
    const L = Math.min(24, closes.length, btcCloses.length);
    const retA=[], retB=[];
    for(let i=closes.length-L;i<closes.length;i++){
      if(i<=0) continue;
      retA.push((closes[i]-closes[i-1])/closes[i-1]);
      const bi = btcCloses[btcCloses.length-(closes.length-i)];
      const bip = btcCloses[btcCloses.length-(closes.length-i)-1];
      if(bip) retB.push((bi-bip)/bip);
    }
    const leaderCorr = Math.abs(pearsonCorr(retA, retB))||0;

    // future metrics
    const fut = await fetchFutureMetrics(sym);
    const futFund = fut.fundJson ? Number(fut.fundJson.lastFundingRate||0) : 0;
    const futOI = fut.oiJson ? Number(fut.oiJson.openInterest||0) : 0;
    const futPrice = fut.tjson ? Number(fut.tjson.lastPrice||price) : price;

    // BASIC NOISE FILTERS
    if(rsi < 30 || rsi > 90) return;
    if(Math.abs(change24) > 50) return; // crazy coins
    // SmartMoney signals
    const volSpike = volNow > volAvg * (CFG.VOL_SPIKE_MULT || 1.8);
    const takerOk = taker > (CFG.TAKER_MIN || 0.52);
    const futureLongBias = futFund > 0.0003 || (futOI > 0 && futPrice > ma20*1.01);

    const nearEntry = price >= ma20*(CFG.NEARENTRY_LO||0.992) && price <= ma20*(CFG.NEARENTRY_HI||1.03);

    // FAKE BREAKOUT conditions
    const fakeBreak1 = (price > ma20 * 1.05 && volNow < volAvg * 1.2);
    const fakeBreak2 = (rsi > 80 && volNow < volAvg * 1.3);
    const fakeBreak3 = (futFund > 0.0015); // FOMO unrealistic
    if(fakeBreak1 || fakeBreak2 || fakeBreak3) {
      logv(`[FAKE] ${sym} filtered (fakeBreak) rsi=${rsi} volNow=${volNow} volAvg=${volAvg} futFund=${futFund}`);
      return;
    }

    // DEFINE SIGNALS
    const isIMF = volSpike && (takerOk || leaderCorr > 0.45) && price > ma20*0.995;
    const isGolden = (price > sr.resistance*1.005 && change24 >= (CFG.GOLDEN_CHANGE24||4) && volSpike && (takerOk || futureLongBias) && leaderCorr > 0.35 && price <= ma20*1.05);
    const isSpot = (price > ma20*1.002 && volNow > volAvg*1.6 && rsi >= 48 && rsi <= 72 && (takerOk || leaderCorr>0.25));
    const isPre = (nearEntry && volNow > volAvg*1.1 && rsi >= 42 && rsi <= 60 && (leaderCorr>0.15 || takerOk));

    // Multi-timeframe confirm (15m)
    let tfConfirm = true;
    if(CFG.MULTI_TF_CONFIRM){
      try{
        const closes15 = k15json.map(r=>Number(r[4]));
        const ma20_15 = sma(closes15,20) || closes15.at(-1);
        const rsi15 = computeRSI(closes15.slice(-30)) || 50;
        if(isSpot && rsi15 < 45) tfConfirm = false;
        if(isGolden && !(closes15.at(-1) > ma20_15*1.0)) tfConfirm = false;
        // PRE can be allowed without 15m confirm
      }catch(e){ tfConfirm = true; }
    }

    // PRIORITY: IMF > GOLDEN > SPOT > PRE
    let chosen = null;
    if(isIMF && canSend(sym,'IMF')) chosen = 'IMF';
    else if(isGolden && tfConfirm && canSend(sym,'GOLDEN')) chosen = 'GOLDEN';
    else if(isSpot && tfConfirm && canSend(sym,'SPOT')) chosen = 'SPOT';
    else if(isPre && canSend(sym,'PRE')) chosen = 'PRE';

    if(!chosen) return;

    // HOLD ABOVE MA check for GOLDEN (require hold on last 3 H1)
    if(chosen === 'GOLDEN'){
      const last3 = closes.slice(-3);
      if(last3.length===3 && !(last3.every(c=>c>ma20))) { logv(`[GOLDEN-FILTER] ${sym} not hold 3H1`); return; }
    }

    // compute SL/TP
    const entry = price;
    const { sl, tp } = (()=>{
      const map = { PRE:{slPct:0.01,tpPct:0.05}, SPOT:{slPct:0.015,tpPct:0.06}, GOLDEN:{slPct:0.02,tpPct:0.10}, IMF:{slPct:0.03,tpPct:0.15} };
      const cfg = map[chosen] || map.SPOT;
      return { sl: fmt(entry*(1-cfg.slPct)), tp: fmt(entry*(1+cfg.tpPct)), slPct: cfg.slPct, tpPct: cfg.tpPct };
    })();

    // confidence scoring
    let conf = 50;
    if(volSpike) conf += 12;
    if(takerOk) conf += 8;
    if(futureLongBias) conf += 8;
    if(leaderCorr>0.4) conf += 10;
    if(isGolden) conf += 12;
    if(isIMF) conf += 15;
    conf = Math.min(99, Math.round(conf));

    // Build message
    const lines = [];
    const emoji = (chosen==='IMF') ? '🔥⚡' : (chosen==='GOLDEN' ? '✨' : (chosen==='SPOT' ? '✅' : '🔎'));
    lines.push(`<b>${emoji} [${chosen}] ${sym}</b>`);
    lines.push(`Price: ${entry} | MA20: ${fmt(ma20)} | Conf: ${conf}%`);
    lines.push(`EntryZone(SR): ${fmt(sr.support)} - ${fmt(sr.resistance)}`);
    lines.push(`SL: ${sl} | TP: ${tp}`);
    lines.push(`VolNow:${Math.round(volNow)} VolAvg:${Math.round(volAvg)} | 24h:${change24}%`);
    lines.push(`Taker:${(taker*100).toFixed(1)}% | Funding:${futFund} | OI:${futOI}`);
    lines.push(`leaderCorr:${(leaderCorr*100).toFixed(1)}% | Time: ${nowStr()}`);

    const msg = lines.join('\n');

    // send & record
    await sendTelegram(msg);
    await recordSignal({ symbol: sym, type: chosen, timeISO: new Date().toISOString(), price: entry, rsi, vol: volNow, change24, slPct: (sl/entry-1)*-1, tpPct:(tp/entry-1), conf });

    markActive(sym, chosen, { price: entry, ma20: fmt(ma20), rsi, vol: volNow, change24, conf });
    logv(`[ALERT] ${chosen} ${sym} sent conf=${conf}`);
  }catch(e){
    logv(`[ANALYZE] ${sym} err ${e.message}`);
  }
}

/// ===== EXIT detection for actives =====
async function detectExitFor(sym, data){
  try{
    const kUrl = `${API_BASE_SPOT}/api/v3/klines?symbol=${sym}&interval=1h&limit=40`;
    const kjson = await safeFetchJSON(kUrl);
    if(!kjson) return;
    const closes = kjson.map(r=>Number(r[4]));
    const ma20 = sma(closes,20) || closes.at(-1);
    const price = closes.at(-1);
    const rsiNow = computeRSI(closes.slice(-30)) || 50;
    let reason = null;
    if(data.type==='GOLDEN'){ if(price < ma20*0.998) reason = 'Price cut below MA20'; }
    else if(data.type==='SPOT' || data.type==='PRE'){
      const rsiPrev = computeRSI(closes.slice(-31,-1)) || 50;
      if(rsiPrev > 50 && rsiNow < 45) reason = 'RSI collapse';
      if(price < ma20*0.995) reason = 'Price broke MA20';
    } else if(data.type==='IMF'){
      if(price < ma20*0.995 || rsiNow < 45) reason = 'IMF rejection';
    }
    if(reason){
      const msg = `<b>[SPOT EXIT] (${data.type}) ${sym}</b>\nReason: ${reason}\nEntryAt: ${data.meta?.price||'NA'}\nNow: ${price}\nMA20:${fmt(ma20)} | RSI:${rsiNow.toFixed(1)}\nTime: ${nowStr()}`;
      await sendTelegram(msg);
      clearActive(sym);
    }
  }catch(e){ logv('[EXIT] '+ e.message); }
}

/// ===== LEARNING scheduler & adjustments =====
async function evaluateSignalOutcome(sig){
  try{
    const lookbackHours = CFG.EVALUATION_LOOKBACK_HOURS || 72;
    const limit = Math.min(200, lookbackHours + 10);
    const url = `${API_BASE_SPOT}/api/v3/klines?symbol=${sig.symbol}&interval=1h&limit=${limit}`;
    const arr = await safeFetchJSON(url, 2);
    if(!arr) return { result: 'UNKNOWN' };
    const t0 = new Date(sig.timeISO).getTime();
    let startIdx = 0;
    for(let i=0;i<arr.length;i++){ if(Number(arr[i][0]) >= t0) { startIdx = i; break; } }
    const checkCount = Math.min(arr.length - startIdx, Math.ceil(lookbackHours));
    if(checkCount <= 0) return { result: 'NEUTRAL' };
    const tp = sig.price * (1 + (sig.tpPct || 0.06));
    const sl = sig.price * (1 - (sig.slPct || 0.02));
    for(let i=startIdx;i<startIdx+checkCount;i++){
      const high = Number(arr[i][2]), low = Number(arr[i][3]);
      if(high >= tp && low <= sl) return { result: 'AMBIG' };
      if(high >= tp) return { result: 'WIN' };
      if(low <= sl) return { result: 'LOSE' };
    }
    return { result: 'NEUTRAL' };
  }catch(e){ return { result: 'ERR' }; }
}

async function checkOutcomesAndAdjust(){
  try{
    const arr = loadSignals();
    let updated = 0;
    for(const s of arr){
      if(s.evaluatedAt) continue;
      if(Date.now() - new Date(s.timeISO).getTime() < 3600000) continue; // wait 1h
      const r = await evaluateSignalOutcome(s);
      s.evaluatedAt = Date.now(); s.evalResult = r.result; updated++;
      await new Promise(r=>setTimeout(r,150));
    }
    if(updated) { saveSignals(arr); logv(`[LEARN] evaluated ${updated}`); }
    // compute adjustments
    const byType = {};
    const lookback = (CFG.EVALUATION_LOOKBACK_HOURS||72) * 3600000;
    const now = Date.now();
    for(const s of arr){ if(!s.evaluatedAt) continue; if(now - s.recordedAt > lookback) continue;
      const t = s.type || 'SPOT'; if(!byType[t]) byType[t]={win:0,lose:0,total:0}; byType[t].total++;
      if(s.evalResult==='WIN') byType[t].win++; else if(s.evalResult==='LOSE') byType[t].lose++;
    }
    let changed = false;
    for(const [t,st] of Object.entries(byType)){
      if(st.total < (CFG.MIN_SIGNALS_TO_ADJUST||3)) continue;
      const wr = st.win / st.total;
      if(wr < (CFG.TARGET_WINRATE||0.75)){
        // tighten
        CFG.VOL_SPIKE_MULT = +(CFG.VOL_SPIKE_MULT * (1 + (CFG.ADJUST_STEP||0.05))).toFixed(3);
        CFG.TAKER_MIN = +(Math.min(0.99, CFG.TAKER_MIN * (1 + (CFG.ADJUST_STEP||0.05)))).toFixed(3);
        changed = true;
      }else if(wr > (CFG.TARGET_WINRATE||0.75) + 0.05){
        // relax slightly to catch more signals
        CFG.VOL_SPIKE_MULT = +(CFG.VOL_SPIKE_MULT * (1 - (CFG.ADJUST_STEP||0.03))).toFixed(3);
        CFG.TAKER_MIN = +(Math.max(0.01, CFG.TAKER_MIN * (1 - (CFG.ADJUST_STEP||0.03)))).toFixed(3);
        changed = true;
      }
    }
    if(changed){ saveCFG(); logv('[LEARN] CFG adjusted: ' + JSON.stringify({VOL_SPIKE_MULT:CFG.VOL_SPIKE_MULT, TAKER_MIN:CFG.TAKER_MIN})); }
  }catch(e){ logv('[LEARN] check err '+ e.message); }
}

setInterval(async ()=>{ try{ await checkOutcomesAndAdjust(); }catch(e){ logv('[LEARN] sched err '+ e.message); } }, (Number(process.env.LEARN_POLL_MIN) || 30)*60*1000);

/// ===== MAIN SCAN LOOP =====
let scanning=false;
async function scanOnce(){
  if(scanning) return; scanning = true;
  try{
    await loadSymbols();
    if(SYMBOLS.length===0) SYMBOLS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT'];
    logv(`[SCAN] scanning ${SYMBOLS.length}`);
    for(const sym of SYMBOLS){
      try{ await analyzeSymbol(sym); }catch(e){ logv(`[SCAN] ${sym} err ${e.message}`); }
      await new Promise(r=>setTimeout(r,200));
    }
    // exits
    if(activeMap.size>0){
      logv(`[EXIT] checking ${activeMap.size} actives`);
      for(const [sym, data] of activeMap.entries()){
        await detectExitFor(sym, data);
        await new Promise(r=>setTimeout(r,200));
      }
    }
    logv('[SCAN] cycle done');
  }catch(e){ logv('[SCAN] fatal '+ e.message); }
  finally{ scanning=false; }
}

loadActive();
setInterval(scanOnce, SCAN_INTERVAL_MS);
await scanOnce();

/// ===== Keep alive & health =====
if(PRIMARY_URL){
  setInterval(()=>{ try{ https.get(PRIMARY_URL); logv('[KEEPALIVE] ping'); }catch(e){} }, (Number(process.env.KEEP_ALIVE_INTERVAL) || 10)*60*1000);
}
const app = express();
app.get('/', (req,res)=> res.send('Spot SmartMoney Breakout v2.9 OK'));
app.get('/cfg', (req,res)=> res.json(CFG));
app.get('/actives', (req,res)=> res.json(Object.fromEntries(activeMap)));
app.listen(PORT, ()=> logv(`Server listening ${PORT}`));

export default { scanOnce, analyzeSymbol, CFG };
