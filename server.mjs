// server_final.mjs
// Spot Master AI v3.6 - Full SmartFlow + Hyper Breakout + Auto-Learning
// Single-file deploy (ESM). Node >=16.
// Usage: set TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, PRIMARY_URL (optional), then: node server_final.mjs

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import https from 'https';
import express from 'express';
import * as LEARN from './learning_engine.js'; // optional - provide module

// ========== CONFIG ==========
const API_BASE_SPOT = process.env.API_BASE_SPOT || 'https://api.binance.com';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const PRIMARY_URL = process.env.PRIMARY_URL || '';
const KEEP_ALIVE_MIN = Number(process.env.KEEP_ALIVE_INTERVAL || 10);
const SYMBOL_REFRESH_H = Number(process.env.SYMBOL_REFRESH_H || 6);
const SYMBOL_MIN_VOL = Number(process.env.SYMBOL_MIN_VOL || 2_000_000); // default 2M
const SCAN_ROTATION_LIMIT = Number(process.env.SCAN_ROTATION_LIMIT || 200); // max symbols per rotation
const LOG_FILE = path.resolve('./spot_logs.txt');
const ACTIVE_FILE = path.resolve('./active_spots.json');

// ========== UTIL ==========
function logv(msg){
  const s = `[${new Date().toLocaleString('vi-VN')}] ${msg}`;
  console.log(s);
  try { fs.appendFileSync(LOG_FILE, s + '\n'); } catch(e){}
}
async function sendTelegram(text){
  if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) { logv('[TELEGRAM] missing token/chat'); return; }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview:true };
  try{
    const res = await fetch(url, { method: 'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
    if(!res.ok) logv(`[TELEGRAM] send failed ${res.status}`);
  }catch(e){ logv('[TELEGRAM] error ' + e.message); }
}
async function safeFetchJSON(url, retries=2){
  for(let i=0;i<retries;i++){
    try{
      const r = await fetch(url, { timeout: 15000 });
      if(r.ok) return await r.json();
      logv(`[HTTP] ${r.status} ${url}`);
    }catch(e){
      logv('[HTTP] fetch err ' + (e.message||e));
    }
    await new Promise(r=>setTimeout(r, 250*(i+1)));
  }
  return null;
}
function sma(arr, n=20){
  if(!arr || arr.length===0) return null;
  const slice = arr.slice(-Math.min(n, arr.length));
  return slice.reduce((s,x)=>s + Number(x), 0)/slice.length;
}
function computeRSI(closes, period=14){
  if(!closes || closes.length <= period) return 50;
  let gains=0, losses=0;
  for(let i=1;i<=period;i++){
    const d = closes[i]-closes[i-1];
    if(d>0) gains += d; else losses -= d;
  }
  let avgGain = gains/period, avgLoss = losses/period || 1;
  for(let i=period+1;i<closes.length;i++){
    const d = closes[i]-closes[i-1];
    avgGain = (avgGain*(period-1) + Math.max(0,d))/period;
    avgLoss = (avgLoss*(period-1) + Math.max(0,-d))/period;
  }
  if(avgLoss === 0) return 100;
  const rs = avgGain/avgLoss;
  return 100 - (100/(1+rs));
}
function fmt(n, d=8){ return typeof n === 'number' ? Number(n.toFixed(d)) : n; }

// ========== ALERT DEDUPE / COOLDOWN ==========
const lastAlert = new Map(); // key = `${type}:${symbol}` -> timestamp
function canSendAlert(symbol, type, cooldownMin){
  const key = `${type}:${symbol}`;
  const now = Date.now();
  const prev = lastAlert.get(key) || 0;
  if((now - prev) / 60000 >= cooldownMin){
    lastAlert.set(key, now);
    return true;
  }
  return false;
}

// ========== SYMBOL LIST ==========
let SYMBOLS = [];
let symbolsLoadedAt = 0;
async function loadSymbols(minVol = SYMBOL_MIN_VOL){
  const nowSec = Date.now()/1000;
  if(SYMBOLS.length && (symbolsLoadedAt + SYMBOL_REFRESH_H*3600 > nowSec)) return SYMBOLS;
  const url = `${API_BASE_SPOT}/api/v3/ticker/24hr`;
  const data = await safeFetchJSON(url, 2);
  if(!Array.isArray(data)) return SYMBOLS;
  SYMBOLS = data
    .filter(s => s.symbol && s.symbol.endsWith('USDT'))
    .filter(s => !/UPUSDT|DOWNUSDT|BULLUSDT|BEARUSDT|_/.test(s.symbol))
    .map(s => ({ symbol: s.symbol, vol: Number(s.quoteVolume||0), change: Number(s.priceChangePercent||0) }))
    .filter(s => s.vol >= minVol)
    .sort((a,b)=> b.vol - a.vol)
    .map(s => s.symbol);
  symbolsLoadedAt = nowSec;
  logv(`[SYMBOLS] loaded ${SYMBOLS.length} pairs (minVol=${minVol})`);
  return SYMBOLS;
}

// ========== ACTIVE ENTRY STORAGE ==========
const activeMap = new Map();
function loadActive(){
  try{
    if(fs.existsSync(ACTIVE_FILE)){
      const raw = fs.readFileSync(ACTIVE_FILE, 'utf8');
      const obj = JSON.parse(raw || '{}');
      for(const k of Object.keys(obj)) activeMap.set(k, obj[k]);
      logv(`[ACTIVE] loaded ${activeMap.size} entries`);
    }
  }catch(e){ logv('[ACTIVE] load err ' + e.message); }
}
function saveActive(){
  try{
    const obj = Object.fromEntries(activeMap);
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify(obj, null, 2));
  }catch(e){ logv('[ACTIVE] save err ' + e.message); }
}
function markActive(symbol, type, meta){
  activeMap.set(symbol, { type, meta, markedAt: Date.now() });
  saveActive();
}
function clearActive(symbol){
  if(activeMap.has(symbol)){
    activeMap.delete(symbol);
    saveActive();
  }
}

// ========== MARKET CONTEXT (BTC TREND) ==========
let BTC_CONTEXT = { trend: 'NEUTRAL', rsi: 50, last: 0, updated: 0 };
async function updateBTCContext(){
  try{
    const k = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=50`);
    if(!k) return;
    const closes = k.map(r => Number(r[4]));
    const ma20 = sma(closes, 20) || closes.at(-1);
    const rsi4 = computeRSI(closes.slice(-30));
    const last = closes.at(-1);
    let trend = 'NEUTRAL';
    if(last > ma20*1.01 && rsi4 > 55) trend = 'UP';
    if(last < ma20*0.99 && rsi4 < 45) trend = 'DOWN';
    BTC_CONTEXT = { trend, rsi: rsi4, last, updated: Date.now() };
    logv(`[BTC] trend=${trend} rsi=${rsi4.toFixed(1)} last=${last}`);
  }catch(e){ logv('[BTC] ctx err ' + e.message); }
}

// ========== DECISION / TIERS ==========
/*
Tier rules summary (implemented):
- PRE (1h): early test near MA20, volRatio >=1.2 && <1.8, RSI 40-55. Cooldown 6h.
- SPOT (2h/4h confirm): price > MA20, volRatio >=1.5, RSI 50-65, requires PRE within 8-12h to boost.
- GOLDEN (4h): price > MA20*1.03 && change24>=6, RSI >=60, cooldown 12h.
- IMF (1h smart money): volRatio >=3, price > ma20*0.995, RSI 55-70, BTC not strong UP, cooldown 8h.
- HYPER (4h stack): stacking of signals or extreme vol+change -> highest conviction. cooldown 24h.
*/
function determineTier({price, ma20, volNow, volAvg, rsi, change24, btcCtx, lastPreMarked}){
  const volRatio = volNow / (volAvg || 1);
  const nearMA_low = ma20 * 0.995;
  const nearMA_high = ma20 * 1.02;
  const out = { tier: null, conf: 0, volRatio };
  // PRE
  if(price >= nearMA_low && price <= nearMA_high && volRatio >= 1.2 && volRatio < 1.8 && rsi >= 40 && rsi <= 55){
    out.tier = 'PRE';
    out.conf = 60 + Math.round((volRatio-1.2)/0.6*15);
  }
  // IMF (priority)
  if(volRatio >= 3 && price > ma20*0.995 && rsi >= 55 && rsi <= 70 && (!btcCtx || btcCtx.trend !== 'UP')){
    out.tier = 'IMF';
    out.conf = Math.max(out.conf, 80 + Math.round((volRatio-3)*10));
  }
  // GOLDEN
  if(price > ma20 * 1.03 && change24 >= 6 && rsi >= 60){
    out.tier = 'GOLDEN';
    out.conf = Math.max(out.conf, 80 + Math.round(Math.min(20, change24)));
  }
  // SPOT confirm (requires price>ma20 and volRatio >=1.5)
  if(price > ma20 && volRatio >= 1.5 && rsi >=50 && rsi <= 65){
    // if had PRE recently, boost confidence
    const boost = lastPreMarked && (Date.now() - lastPreMarked.markedAt) < (12*3600000) ? 10 : 0;
    out.tier = 'SPOT';
    out.conf = Math.max(out.conf, 70 + boost + Math.round((volRatio-1.5)*10));
  }
  // HYPER breakout (stacking)
  if((rsi >= 60 && volRatio >= 2.5 && change24 >= 8) || (out.tier === 'GOLDEN' && volRatio >= 2.5)){
    out.tier = 'HYPER';
    out.conf = Math.max(out.conf, 90 + Math.min(9, Math.round((volRatio-2.5)*5)));
  }
  out.conf = Math.min(100, Math.round(out.conf));
  return out;
}

// ========== ANALYZE SYMBOL ==========
async function analyzeSymbol(sym){
  try{
    // fetch both 1h and 4h
    const k1 = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/klines?symbol=${sym}&interval=1h&limit=60`);
    const k4 = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/klines?symbol=${sym}&interval=4h&limit=60`);
    const t24 = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/ticker/24hr?symbol=${sym}`);
    if(!k1 || !k4 || !t24) return null;

    const closes1 = k1.map(r=>Number(r[4]));
    const vols1 = k1.map(r=>Number(r[5]));
    const closes4 = k4.map(r=>Number(r[4]));
    const ma20_1 = sma(closes1, 20) || closes1.at(-1);
    const ma20_4 = sma(closes4, 20) || closes4.at(-1);
    const price = Number(t24.lastPrice || closes1.at(-1));
    const change24 = Number(t24.priceChangePercent || 0);
    const volNow = vols1.at(-1) || 0;
    const volAvg = sma(vols1, 20) || 1;
    const rsi1 = computeRSI(closes1.slice(-30));
    const rsi4 = computeRSI(closes4.slice(-30));
    // get last PRE mark if any
    const lastPre = activeMap.get(sym) && activeMap.get(sym).type === 'PRE' ? activeMap.get(sym) : null;

    // use BTC context
    const btcCtx = BTC_CONTEXT;

    // determine tier with multi-timeframe consideration
    // prefer ma20_4 for long-term tiers but compare 1h ma for entry zones
    const decision = determineTier({
      price,
      ma20: ma20_1,
      volNow,
      volAvg,
      rsi: rsi1,
      change24,
      btcCtx,
      lastPreMarked: lastPre
    });

    if(!decision.tier) return null;

    // map cooldowns (mins) per tier
    const cooldown = { PRE: 360, SPOT: 480, GOLDEN: 720, IMF: 480, HYPER: 1440 };
    const tier = decision.tier;
    if(!canSendAlert(sym, tier, cooldown[tier])) return null;

    // compute entry zone & sl/tp conservatively (refine later or learned)
    const entryLow = fmt(ma20_1 * 0.995);
    const entryHigh = fmt(Math.max(price, ma20_1 * 1.02));
    const entry = price;
    const sltpMap = {
      PRE: { slPct: 0.01, tpPct: 0.05 },
      SPOT: { slPct: 0.015, tpPct: 0.06 },
      GOLDEN: { slPct: 0.02, tpPct: 0.10 },
      IMF: { slPct: 0.03, tpPct: 0.15 },
      HYPER: { slPct:0.025, tpPct:0.12 }
    };
    const cfg = sltpMap[tier] || sltpMap.SPOT;
    const sl = fmt(entry * (1 - cfg.slPct));
    const tp = fmt(entry * (1 + cfg.tpPct));

    // build message
    const lines = [];
    lines.push(`<b>[${tier}] ${sym}</b>`);
    lines.push(`Price: ${fmt(price)} | EntryZone: ${entryLow} - ${entryHigh}`);
    lines.push(`MA20(1h): ${fmt(ma20_1)} | RSI1h: ${rsi1?.toFixed(1)} | RSI4h: ${rsi4?.toFixed(1)}`);
    lines.push(`VolRatio: ${decision.volRatio.toFixed(2)} | 24h%: ${change24}% | Conf: ${decision.conf}%`);
    lines.push(`SL: ${sl} | TP: ${tp}`);
    lines.push(`Notes: ${tier === 'IMF' ? 'Smart-money flow' : tier === 'HYPER' ? 'High conviction' : ''}`);
    lines.push(`Time: ${new Date().toLocaleString('vi-VN')}`);
    const msg = lines.join('\n');

    // send
    await sendTelegram(msg);
    logv(`[ALERT] ${tier} ${sym} conf=${decision.conf} price=${price} volRatio=${decision.volRatio.toFixed(2)}`);
    markActive(sym, tier, { price, entryLow, entryHigh, sl, tp, conf: decision.conf, ma20_1, ma20_4, rsi1, rsi4 });
    return { sym, tier, conf: decision.conf };

  }catch(e){
    logv(`[ANALYZE] ${sym} err ${e.message}`);
    return null;
  }
}

// ========== EXIT MONITOR ==========
async function checkExits(){
  for(const [sym, data] of activeMap.entries()){
    try{
      const k1 = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/klines?symbol=${sym}&interval=1h&limit=20`);
      if(!k1) continue;
      const closes = k1.map(r=>Number(r[4]));
      const price = closes.at(-1);
      const ma20 = sma(closes, 20) || closes.at(-1);
      const rsiNow = computeRSI(closes.slice(-30));
      let reason = null;
      // rules
      if(data.type === 'GOLDEN'){
        if(price < ma20 * 0.998) reason = 'Price cut below MA20';
      } else if(data.type === 'SPOT' || data.type === 'PRE'){
        if(rsiNow < 45) reason = 'RSI collapse';
        else if(price < ma20 * 0.995) reason = 'Price under MA20';
      } else if(data.type === 'IMF'){
        if(price < ma20 * 0.995 || rsiNow < 45) reason = 'IMF rejection';
      } else if(data.type === 'HYPER'){
        if(rsiNow < 50 || price < data.meta.sl * 0.995) reason = 'HYPER breakdown';
      }
      if(reason){
        const msg = `<b>[EXIT] ${sym} (${data.type})</b>\nReason: ${reason}\nNow: ${fmt(price)} | Entry: ${data.meta.price}\nTime: ${new Date().toLocaleString('vi-VN')}`;
        if(canSendAlert(sym, 'EXIT', 10)){
          await sendTelegram(msg);
          logv(`[EXIT] ${sym} type=${data.type} reason=${reason}`);
        } else logv(`[EXIT] suppressed ${sym}`);
        clearActive(sym);
      }
    }catch(e){ logv(`[EXITCHK] ${sym} err ${e.message}`); }
    await new Promise(r=>setTimeout(r, 200)); // polite pace
  }
}

// ========== MAIN ROTATION SCAN ==========
let rotationRunning = false;
async function rotationScan(){
  if(rotationRunning) return;
  rotationRunning = true;
  try{
    await updateBTCContext();
    await loadSymbols();
    if(!SYMBOLS.length) SYMBOLS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT'];
    const slice = SYMBOLS.slice(0, Math.min(SYMBOLS.length, SCAN_ROTATION_LIMIT));
    logv(`[SCAN] scanning ${slice.length} symbols`);
    for(const s of slice){
      await analyzeSymbol(s);
      await new Promise(r=>setTimeout(r, 300)); // avoid rate limit
    }
    // check exits after scan
    await checkExits();
    logv('[SCAN] cycle complete');
  }catch(e){ logv('[SCAN] fatal ' + e.message); }
  rotationRunning = false;
}

// ========== SCHEDULERS & LEARNING ==========
loadActive();
rotationScan(); // immediate
setInterval(rotationScan, 60*60*1000); // 1h main rotation (keeps noise low); can lower if needed

// quick learn schedule 48h (calls learning_engine.quickLearn48h if exists)
if(LEARN && typeof LEARN.quickLearn48h === 'function'){
  setInterval(async ()=>{
    try{ await LEARN.quickLearn48h(); logv('[LEARN] quickLearn48h executed'); }
    catch(e){ logv('[LEARN] err ' + e.message); }
  }, 48*3600*1000);
  // optional immediate warm-up
  setTimeout(async ()=>{
    try{ await LEARN.quickLearn48h(); logv('[LEARN] quickLearn48h initial run'); }catch(e){}
  }, 5000);
}

// keep-alive ping to PRIMARY_URL
if(PRIMARY_URL){
  setInterval(()=>{
    try{ https.get(PRIMARY_URL); logv('[KEEPALIVE] ping'); } catch(e){}
  }, KEEP_ALIVE_MIN*60*1000);
}

// minimal express for health
const app = express();
app.get('/', (req,res) => res.send('Spot Master AI v3.6 OK'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> logv(`Server listening on port ${PORT}`));

// quick startup notification
(async ()=>{
  logv('[SYSTEM] Spot Master AI v3.6 started');
  if(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) await sendTelegram(`<b>Spot Master AI v3.6</b>\nStarted. Rotation scan active.`);
})();
