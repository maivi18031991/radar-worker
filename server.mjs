// server_final_plus_prebreakout_v4.mjs
// Spot Master v3.5 + PreBreakout full + Adaptive Flow Sync + Learning
// Copy-paste thay file hiện tại. Node >=16.

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import * as LEARN from "./learning_engine.js";
import { scanPreBreakout } from "./modules/rotation_prebreakout.js"; // nếu file đổi tên, sửa phù hợp
// import other helpers if you have them, e.g. smart_layer.js

// -------- CONFIG ----------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT || "";
const API_BASE_SPOT = process.env.API_BASE_SPOT || "https://api.binance.com";
const PRIMARY_URL = process.env.PRIMARY_URL || "";
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_SEC || 60) * 1000;
const KEEP_ALIVE_INTERVAL_MIN = Number(process.env.KEEP_ALIVE_INTERVAL || 10);
const SYMBOL_MIN_VOL = Number(process.env.SYMBOL_MIN_VOL || 2000000);
const PRE_TOP_N = Number(process.env.PRE_TOP_N || 15);
const ADAPTIVE_DEEP_CHECK_TIMEOUT_MS = 5 * 1000; // delay between deep checks
const ALERT_COOLDOWN_MIN = Number(process.env.ALERT_COOLDOWN_MIN || 15);

// storage
const DATA_DIR = path.resolve("./data");
if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive:true });
const ACTIVE_FILE = path.join(DATA_DIR, "active_spots.json");


// ---------- LOGGER ----------
function logv(msg){
  const s = `[${new Date().toLocaleString('vi-VN')}] ${msg}`;
  console.log(s);
  try{ fs.appendFileSync(path.join(DATA_DIR,'server.log'), s + '\n'); }catch(e){}
}

// ---------- TELEGRAM ----------
async function sendTelegram(text){
  if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID){
    logv('[TELEGRAM] missing token/chat id');
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true };
  try{
    const r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
    if(!r.ok) logv(`[TELEGRAM] send failed ${r.status}`);
  }catch(e){ logv('[TELEGRAM] error ' + e.message); }
}

// ---------- SAFE FETCH ----------
async function safeFetchJSON(url, retries=2){
  for(let i=0;i<retries;i++){
    try{
      const r = await fetch(url);
      if(!r.ok){
        logv(`[HTTP] ${r.status} ${url}`);
        await new Promise(res=>setTimeout(res, 200*(i+1)));
        continue;
      }
      return await r.json();
    }catch(e){
      logv('[HTTP] fetch err ' + e.message + ' url=' + url);
      await new Promise(res=>setTimeout(res, 200*(i+1)));
    }
  }
  return null;
}

// ---------- SYMBOL LOADER ----------
let SYMBOLS = [];
let lastSymbolsTs = 0;
const SYMBOL_REFRESH_H = 6;
async function loadSymbols({minVol=SYMBOL_MIN_VOL} = {}){
  try{
    const now = Date.now()/1000;
    if(lastSymbolsTs + SYMBOL_REFRESH_H*3600 > now && SYMBOLS.length) return SYMBOLS;
    const url = `${API_BASE_SPOT}/api/v3/ticker/24hr`;
    const data = await safeFetchJSON(url, 2);
    if(!Array.isArray(data)) return SYMBOLS;
    SYMBOLS = data
      .filter(s => s.symbol && s.symbol.endsWith('USDT'))
      .filter(s => !/DOWNUSDT|UPUSDT|BEARUSDT|BULLUSDT|_/.test(s.symbol))
      .map(s => ({ symbol: s.symbol, vol: Number(s.quoteVolume||0), change: Number(s.priceChangePercent||0) }))
      .filter(s => s.vol >= minVol)
      .sort((a,b)=> b.vol - a.vol)
      .map(s => s.symbol);
    lastSymbolsTs = now;
    logv(`[SYMBOLS] loaded ${SYMBOLS.length} symbols`);
    return SYMBOLS;
  }catch(e){ logv('[SYMBOLS] load error '+ e.message); return SYMBOLS; }
}

// ---------- ACTIVE ENTRIES ----------
const activeSpots = new Map();
function loadActiveFile(){
  try{
    if(fs.existsSync(ACTIVE_FILE)){
      const raw = fs.readFileSync(ACTIVE_FILE,'utf8') || '{}';
      const obj = JSON.parse(raw);
      for(const [k,v] of Object.entries(obj)) activeSpots.set(k,v);
      logv(`[ACTIVE] loaded ${activeSpots.size}`);
    }
  }catch(e){ logv('[ACTIVE] load error ' + e.message); }
}
function saveActiveFile(){
  try{
    const obj = Object.fromEntries(activeSpots);
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify(obj, null, 2));
  }catch(e){ logv('[ACTIVE] save error ' + e.message); }
}
function markActive(symbol, type, meta){
  activeSpots.set(symbol, { type, meta, markedAt: Date.now() });
  saveActiveFile();
}
function clearActive(symbol){
  if(activeSpots.has(symbol)){
    activeSpots.delete(symbol);
    saveActiveFile();
  }
}

// ---------- ALERT DEDUPE ----------
const ALERT_MEM = new Map();
function canAlert(symbol, level='SPOT'){
  const key = `${level}:${symbol}`;
  const now = Date.now();
  const last = ALERT_MEM.get(key) || 0;
  const diffMin = (now - last)/60000;
  if(diffMin >= ALERT_COOLDOWN_MIN){
    ALERT_MEM.set(key, now);
    return true;
  }
  return false;
}

// ---------- ADAPTIVE DEEP CHECK (Pre->Spot cross-check) ----------
async function deepCheckSymbol(sym){
  // quick deep check: 1h + 15m analysis to confirm entry zone and compute SL/TP
  try{
    const k1 = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/klines?symbol=${sym}&interval=1h&limit=100`);
    const k15 = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/klines?symbol=${sym}&interval=15m&limit=40`);
    const t24 = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/ticker/24hr?symbol=${sym}`);
    if(!k1 || !k15 || !t24) return null;
    const closes1 = k1.map(r=>Number(r[4]));
    const closes15 = k15.map(r=>Number(r[4]));
    const price = Number(t24.lastPrice || closes1.at(-1));
    // MA20 1h
    const ma20_1h = sma(closes1, 20) || price;
    // simple RSI
    const rsi1h = computeRSIlocal(closes1.slice(-40));
    const rsi15 = computeRSIlocal(closes15.slice(-40));
    // vol ratio 1h
    const vols1 = k1.map(r=>Number(r[5]));
    const volAvg1 = sma(vols1, Math.min(vols1.length,20)) || 1;
    const volNow1 = vols1.at(-1) || 0;
    const volRatio1 = volNow1 / Math.max(1, volAvg1);
    // decide
    const nearEntry = price >= ma20_1h*0.995 && price <= ma20_1h*1.02;
    const spotConfirm = (price > ma20_1h && volRatio1 > 1.8 && rsi1h >= 50 && rsi1h <= 65);
    const earlyEntry = nearEntry && volRatio1 > 1.2 && rsi1h >= 45 && rsi1h <= 58;
    const chosen = spotConfirm ? 'SPOT' : (earlyEntry ? 'PRE' : null);
    const slTp = chosen ? computeSLTP(price, chosen) : null;
    return { symbol: sym, price, ma20_1h, rsi1h, rsi15, volRatio1, chosen, slTp };
  }catch(e){ logv('[DEEP] '+sym+' err '+e.message); return null; }
}

// small helpers reused
function sma(arr, n=20){
  if(!arr || arr.length<1) return null;
  const slice = arr.slice(-n);
  const sum = slice.reduce((s,x)=> s + Number(x), 0);
  return sum / slice.length;
}
function computeRSIlocal(closes, period=14){
  if(!closes || closes.length <= period) return 50;
  let gains=0, losses=0;
  for(let i=1;i<=period;i++){
    const d = closes[i] - closes[i-1];
    if(d>0) gains+=d; else losses -= d;
  }
  let avgGain = gains/period;
  let avgLoss = losses/period || 1;
  for(let i=period+1;i<closes.length;i++){
    const d = closes[i] - closes[i-1];
    avgGain = (avgGain*(period-1) + Math.max(0,d))/period;
    avgLoss = (avgLoss*(period-1) + Math.max(0,-d))/period;
  }
  if(avgLoss===0) return 100;
  const rs = avgGain/avgLoss;
  return Math.round((100 - (100/(1+rs))) * 10)/10;
}
function fmt(n){ return typeof n === 'number' ? Number(n.toFixed(8)) : n; }
function computeSLTP(entry, type){
  const cfg = {
    PRE: { slPct: 0.01, tpPct: 0.05 },
    SPOT: { slPct: 0.015, tpPct: 0.06 },
    GOLDEN: { slPct: 0.02, tpPct: 0.10 },
    IMF: { slPct: 0.03, tpPct: 0.15 }
  }[type] || { slPct:0.02, tpPct:0.08 };
  const sl = fmt(entry * (1 - cfg.slPct));
  const tp = fmt(entry * (1 + cfg.tpPct));
  return { sl, tp, slPct: cfg.slPct, tpPct: cfg.tpPct };
}

// ---------- PROCESS PRE-BREAKOUT LIST (Adaptive Sync) ----------
async function processPreBreakouts(){
  try{
    const preList = await scanPreBreakout(); // expected array of {symbol, conf, ...}
    if(!Array.isArray(preList)) return;
    logv(`[PRE] got ${preList.length} items`);
    // take top N
    const top = preList.slice(0, PRE_TOP_N);
    for(const it of top){
      const sym = it.symbol;
      // deep check for this symbol to confirm entry / compute SLTP
      await new Promise(r=>setTimeout(r, ADAPTIVE_DEEP_CHECK_TIMEOUT_MS));
      const deep = await deepCheckSymbol(sym);
      if(!deep) {
        logv(`[PRE] deep check failed ${sym}`);
        continue;
      }
      // rule: if deep suggests SPOT or PRE => alert
      if(deep.chosen && canAlert(sym, deep.chosen)){
        const msgLines = [];
        msgLines.push(`<b>[${deep.chosen}] ${sym}</b>`);
        msgLines.push(`Conf(Pre): ${Math.round(it.conf)}% | VolRatio(4h): ${it.volRatio?.toFixed(2)||'NA'}`);
        msgLines.push(`Price: ${fmt(deep.price)} | MA20(1h): ${fmt(deep.ma20_1h)}`);
        msgLines.push(`RSI1h: ${deep.rsi1h} | RSI15m: ${deep.rsi15}`);
        if(deep.slTp) msgLines.push(`SL: ${deep.slTp.sl} | TP: ${deep.slTp.tp}`);
        msgLines.push(`Time: ${new Date().toLocaleString('vi-VN')}`);
        const text = msgLines.join('\n');
        await sendTelegram(text);
        logv(`[ALERT] ${deep.chosen} ${sym} confPre=${Math.round(it.conf)} deepChosen=${deep.chosen}`);
        markActive(sym, deep.chosen, { price: deep.price, confPre: it.conf, metaDeep: deep });
        // record for learning
        try{ await LEARN.recordSignal && await LEARN.recordSignal({ symbol: sym, type: deep.chosen, time: new Date().toISOString(), price: deep.price, conf: it.conf }); }catch(e){}
      } else {
        logv(`[PRE] not alerted ${sym} (deep.chosen=${deep.chosen})`);
      }
    }
  }catch(e){ logv('[PRE_PROC] err ' + e.message); }
}

// ---------- EXIT MONITOR ----------
async function checkExits(){
  try{
    if(activeSpots.size === 0) return;
    for(const [sym, info] of activeSpots.entries()){
      try{
        // fetch 1h klines
        const k1 = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/klines?symbol=${sym}&interval=1h&limit=30`);
        const t24 = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/ticker/24hr?symbol=${sym}`);
        if(!k1 || !t24) continue;
        const closes = k1.map(r=>Number(r[4]));
        const price = Number(t24.lastPrice || closes.at(-1));
        const ma20 = sma(closes, 20) || price;
        const rsiNow = computeRSIlocal(closes.slice(-30)) || 50;
        let exitReason = null;
        if(info.type === 'GOLDEN') {
          if(price < ma20 * 0.998) exitReason = 'Price cut below MA20';
        } else if(info.type === 'SPOT' || info.type === 'PRE') {
          // RSI collapse OR price below MA20 * 0.995
          const rsiPrev = computeRSIlocal(closes.slice(-31,-1)) || 50;
          if(rsiPrev > 50 && rsiNow < 45) exitReason = 'RSI collapse';
          if(price < ma20 * 0.995) exitReason = 'Price below MA20';
        } else if(info.type === 'IMF'){
          if(price < ma20 * 0.995 || rsiNow < 45) exitReason = 'IMF rejection';
        }
        if(exitReason && canAlert(sym, 'EXIT')){
          const msg = [
            `<b>[EXIT] ${sym} (${info.type})</b>`,
            `Reason: ${exitReason}`,
            `Entry: ${info.meta?.price || 'NA'}`,
            `Now: ${fmt(price)} | MA20: ${fmt(ma20)} | RSI: ${rsiNow}`,
            `Time: ${new Date().toLocaleString('vi-VN')}`
          ].join('\n');
          await sendTelegram(msg);
          logv(`[EXIT] ${sym} reason=${exitReason}`);
          clearActive(sym);
          try{ await LEARN.recordOutcome && await LEARN.recordOutcome({ symbol: sym, result: 'EXIT', time: new Date().toISOString()}); }catch(e){}
        }
      }catch(e){ logv('[EXITCHK] '+sym+' err '+e.message); }
      await new Promise(r=>setTimeout(r, 250));
    }
  }catch(e){ logv('[EXIT] err ' + e.message); }
}

// ---------- SCHEDULER MAIN LOOP ----------
let running = false;
async function mainLoop(){
  if(running) return;
  running = true;
  try{
    await loadSymbols();
    // 1) run PreBreakout scan + adaptive deep check
    await processPreBreakouts();
    // 2) exit checks for active items
    await checkExits();
    // 3) periodic learning job: quick check (non-blocking)
    try{
      if(LEARN && LEARN.quickCheckPending) {
        LEARN.quickCheckPending().catch(e => logv('[LEARN] quickCheck err '+e.message));
      }
    }catch(e){}
  }catch(e){ logv('[MAIN] err ' + e.message); }
  finally{ running = false; }
}

// ---------- INIT ----------
loadActiveFile();
logv("[SPOT MASTER AI v3.5] Starting server v4 (PreBreakout + Adaptive Flow Sync)");

// quick notify
(async ()=>{
  logv('[INIT] sending startup msg');
  if(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    await sendTelegram(`<b>[SPOT MASTER AI v3.5]</b>\nStarted. Adaptive PreBreakout & Flow Sync active.`);
  }
})().catch(e=>logv('[INIT] send err '+e.message));

// run immediate
mainLoop().catch(e=>logv('[MAIN] immediate err '+e.message));
// schedule
setInterval(mainLoop, SCAN_INTERVAL_MS);

// keepalive ping to PRIMARY_URL
import https from "https";
if(PRIMARY_URL){
  setInterval(()=>{
    try{ https.get(PRIMARY_URL); logv('[KEEPALIVE] pinged'); }catch(e){}
  }, KEEP_ALIVE_INTERVAL_MIN * 60 * 1000);
}

// expose basic express for healthcheck (optional)
import express from "express";
const app = express();
app.get('/', (req,res)=> res.send('Spot Master AI OK'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> logv(`HTTP server listening on ${PORT}`));
