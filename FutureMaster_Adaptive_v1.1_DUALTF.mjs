// FutureMaster_Adaptive_v1.1_DUALTF.mjs
// Future Master Adaptive v1.1 - DUAL_TF enabled (4H main + 1H confirm)
// Node >= 16
//
// Default env expectations (can override in platform):
// TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, API_BASE_FUTURE (defaults to https://fapi.binance.com)
// PRIMARY_URL (optional), PORT (optional)
//
// Adaptive scan defaults (can override):
// SCAN_INTERVAL_MIN=45
// SCAN_INTERVAL_MAX=150
// DUAL_TF=true
// DUAL_TF_CONF_BONUS=10
// DUAL_TF_MIN_VOL_RATIO_1H=1.3
// MIN_VOLUME_USDT=3000000
// ALERT_COOLDOWN_MIN=20

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import https from "https";
import express from "express";

/* ========== CONFIG (env + defaults) ========== */
const API_BASE_FUTURE = process.env.API_BASE_FUTURE || 'https://fapi.binance.com';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT || '';
const PRIMARY_URL = process.env.PRIMARY_URL || '';
const KEEP_ALIVE_MIN = Number(process.env.KEEP_ALIVE_INTERVAL || 10);

const SCAN_INTERVAL_MIN = Number(process.env.SCAN_INTERVAL_MIN || 45); // seconds
const SCAN_INTERVAL_MAX = Number(process.env.SCAN_INTERVAL_MAX || 150); // seconds
const SCAN_BASE_SEC = Number(process.env.SCAN_BASE_SEC || 90);

const MIN_VOLUME_USDT = Number(process.env.MIN_VOLUME_USDT || 3_000_000);
const ALERT_COOLDOWN_MIN = Number(process.env.ALERT_COOLDOWN_MIN || 20);

const SIGNAL_STORE_FILE = path.resolve('./signals_store_future.json');
const ACTIVE_FILE = path.resolve('./active_futures.json');
const LOG_FILE = path.resolve('./future_logs.txt');

const AUTO_LEARN_48H_MS = 48 * 3600 * 1000;
const AUTO_LEARN_7D_MS = 7 * 24 * 3600 * 1000;

/* DUAL TF defaults */
const DUAL_TF_ENABLED = (String(process.env.DUAL_TF || 'true').toLowerCase() === 'true');
const DUAL_TF_CONF_BONUS = Number(process.env.DUAL_TF_CONF_BONUS || 10);
const DUAL_TF_MIN_VOL_RATIO_1H = Number(process.env.DUAL_TF_MIN_VOL_RATIO_1H || 1.3);

/* ========== STATE ========== */
let SYMBOLS = [];
let lastSymbolsTs = 0;
const SYMBOL_REFRESH_H = 6;
const ALERT_MEMORY = new Map(); // key: `${level}:${symbol}` -> timestamp
const activeFutures = new Map(); // symbol -> { type, meta }
let scanning = false;

/* ========== UTILITIES ========== */
function logv(msg){
  const s = `[${new Date().toLocaleString('vi-VN')}] ${msg}`;
  console.log(s);
  try{ fs.appendFileSync(LOG_FILE, s + '\n'); }catch(e){}
}
async function sendTelegram(text){
  if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID){ logv('[TG] missing token/chat'); return; }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true };
  try{
    const res = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
    if(!res.ok) logv(`[TG] send failed ${res.status}`);
  }catch(e){ logv('[TG] err ' + (e.message||e)); }
}
async function safeFetchJSON(url, retries=2){
  for(let i=0;i<retries;i++){
    try{
      const r = await fetch(url, { timeout: 15000 });
      if(!r.ok){ logv(`[HTTP] ${r.status} ${url}`); await new Promise(r=>setTimeout(r,200*(i+1))); continue; }
      return await r.json();
    }catch(e){ logv('[HTTP] fetch err ' + (e.message||e) + ' url=' + url); await new Promise(r=>setTimeout(r,200*(i+1))); }
  }
  return null;
}
function sma(arr,n=20){ if(!Array.isArray(arr)||arr.length===0) return null; const s = arr.slice(-n).reduce((a,b)=>a+Number(b),0); return s/Math.min(n, arr.length); }
function computeRSI(closes, period=14){
  if(!Array.isArray(closes) || closes.length <= period) return 50;
  let gains=0, losses=0;
  for(let i=1;i<=period;i++){ const d = closes[i]-closes[i-1]; if(d>0) gains+=d; else losses -= d; }
  let avgG = gains/period, avgL = (losses||1)/period;
  for(let i=period+1;i<closes.length;i++){ const d = closes[i]-closes[i-1]; avgG = (avgG*(period-1) + Math.max(0,d))/period; avgL = (avgL*(period-1) + Math.max(0,-d))/period; }
  if(avgL === 0) return 100;
  const rs = avgG/avgL; return 100 - (100/(1+rs));
}
function fmt(n,d=6){ return (typeof n === 'number') ? Number(n.toFixed(d)) : n; }
function canSendAlert(symbol, level='FUTURE'){
  const key = `${level}:${symbol}`; const now = Date.now(); const last = ALERT_MEMORY.get(key) || 0;
  if((now - last) / 60000 >= ALERT_COOLDOWN_MIN){ ALERT_MEMORY.set(key, now); return true; } return false;
}

function loadActiveFile(){ try{ if(fs.existsSync(ACTIVE_FILE)){ const obj = JSON.parse(fs.readFileSync(ACTIVE_FILE,'utf8')||'{}'); for(const k of Object.keys(obj)) activeFutures.set(k, obj[k]); logv(`[ACTIVE] loaded ${activeFutures.size}`); } }catch(e){ logv('loadActive err ' + e.message); } }
function saveActiveFile(){ try{ fs.writeFileSync(ACTIVE_FILE, JSON.stringify(Object.fromEntries(activeFutures), null, 2)); }catch(e){ logv('saveActive err ' + e.message); } }
function storeSignal(sig){ try{ const arr = fs.existsSync(SIGNAL_STORE_FILE) ? JSON.parse(fs.readFileSync(SIGNAL_STORE_FILE,'utf8')||'[]') : []; arr.push(sig); if(arr.length>40000) arr.splice(0, arr.length-30000); fs.writeFileSync(SIGNAL_STORE_FILE, JSON.stringify(arr, null, 2)); }catch(e){ logv('storeSignal err ' + e.message); }}

/* ========== SYMBOLS LOADING ========== */
async function loadFutureSymbols(minVol = MIN_VOLUME_USDT){
  try{
    const now = Date.now()/1000;
    if(lastSymbolsTs + SYMBOL_REFRESH_H*3600 > now && SYMBOLS.length) return SYMBOLS;
    const data = await safeFetchJSON(`${API_BASE_FUTURE}/fapi/v1/ticker/24hr`, 2);
    if(!Array.isArray(data)) return SYMBOLS;
    const syms = data
      .filter(s => s.symbol && s.symbol.endsWith('USDT') && !/UP|DOWN|BULL|BEAR/.test(s.symbol))
      .map(s => ({ symbol:s.symbol, vol: Number(s.quoteVolume||0), change: Number(s.priceChangePercent||0) }))
      .filter(s => s.vol >= minVol)
      .sort((a,b)=> b.vol - a.vol)
      .map(s => s.symbol);
    SYMBOLS = syms;
    lastSymbolsTs = now;
    logv(`[SYMBOLS] loaded ${SYMBOLS.length} FUT pairs (minVol=${minVol})`);
    return SYMBOLS;
  }catch(e){ logv('loadFutureSymbols err ' + e.message); return SYMBOLS; }
}

/* ========== ENTRY RULES & HELPERS ========== */
function computeSlTpFuture(entry, type){
  const cfg = {
    SCALP: { slPct: 0.006, tpPct: 0.02 },
    SWING: { slPct: 0.02, tpPct: 0.12 },
    BREAKOUT: { slPct: 0.02, tpPct: 0.10 },
    REVERSAL: { slPct: 0.03, tpPct: 0.08 },
    LIQUIDITY_SWEEP: { slPct: 0.02, tpPct: 0.06 }
  }[type] || { slPct:0.02,tpPct:0.08};
  const sl = fmt(entry * (1 - cfg.slPct));
  const tp = fmt(entry * (1 + cfg.tpPct));
  return { sl, tp, slPct: cfg.slPct, tpPct: cfg.tpPct };
}

/* analyzeFutureSymbol with DUAL_TF integration */
async function analyzeFutureSymbol(sym, marketState = { volatility: 'normal', confMin: 56 }){
  try{
    const url4h = `${API_BASE_FUTURE}/fapi/v1/klines?symbol=${sym}&interval=4h&limit=60`;
    const url1h = `${API_BASE_FUTURE}/fapi/v1/klines?symbol=${sym}&interval=1h&limit=60`;
    const url15m = `${API_BASE_FUTURE}/fapi/v1/klines?symbol=${sym}&interval=15m&limit=40`;
    const urlTicker = `${API_BASE_FUTURE}/fapi/v1/ticker/24hr?symbol=${sym}`;
    const urlFund = `${API_BASE_FUTURE}/fapi/v1/premiumIndex?symbol=${sym}`;

    const [k4, k1, k15, tjson, fjson] = await Promise.all([
      safeFetchJSON(url4h,2), safeFetchJSON(url1h,2), safeFetchJSON(url15m,2),
      safeFetchJSON(urlTicker,2), safeFetchJSON(urlFund,2)
    ]);
    if(!k4 || !tjson) return null;

    const closes4 = k4.map(r=>Number(r[4]));
    const closes1 = Array.isArray(k1) ? k1.map(r=>Number(r[4])) : [];
    const closes15 = Array.isArray(k15) ? k15.map(r=>Number(r[4])) : [];
    const price = Number(tjson.lastPrice || closes4.at(-1));
    const change24 = Number(tjson.priceChangePercent || 0);
    const funding = Number(fjson?.lastFundingRate || 0);

    const ma20_4h = sma(closes4, 20) || price;
    const vol4 = k4.map(r=>Number(r[5]||0));
    const volAvg4 = Math.max(1, sma(vol4, Math.min(20, vol4.length)));
    const volNow4 = vol4.at(-1) || 0;
    const ma20_1h = sma(closes1, 20) || price;
    const rsi4 = computeRSI(closes4.slice(-40), 14);
    const rsi1 = computeRSI(closes1.slice(-50), 14);
    const rsi15 = computeRSI(closes15.slice(-40), 14);

    // compute vol ratio 4h
    const volRatio4 = volAvg4 > 0 ? volNow4 / volAvg4 : 1;

    // DUAL_TF: compute 1H vol ratio and potential 1H breakout
    let oneHConfirm = false;
    let volRatio1 = 1;
    if(Array.isArray(k1) && k1.length){
      try{
        const vols1 = k1.map(r=>Number(r[5]||0));
        const volAvg1 = Math.max(1, sma(vols1, Math.min(20, vols1.length)));
        const volNow1 = vols1.at(-1) || 0;
        volRatio1 = volAvg1 > 0 ? volNow1 / volAvg1 : 1;
        const breakout1h_long = (price > ma20_1h * 1.02 && rsi1 > 55 && volRatio1 >= DUAL_TF_MIN_VOL_RATIO_1H);
        const breakout1h_short = (price < ma20_1h * 0.98 && rsi1 < 45 && volRatio1 >= DUAL_TF_MIN_VOL_RATIO_1H);
        if(DUAL_TF_ENABLED && (breakout1h_long || breakout1h_short)){
          oneHConfirm = true;
        }
      }catch(e){}
    }

    // heuristics
    const breakout4h = (price > ma20_4h * 1.03 && change24 >= 6 && volRatio4 > 1.6);
    const last4 = k4.at(-1);
    const high4 = last4 ? Number(last4[2]) : price;
    const low4 = last4 ? Number(last4[3]) : price;
    const body4 = Math.abs(price - Number(last4 ? last4[1] : price));
    const upperWick4 = high4 - price;
    const upperWickRatio = body4 > 0 ? (upperWick4 / body4) : 0;
    const liquiditySweep = (upperWickRatio > 2.0 && volRatio4 > 2.5 && change24 > 3);
    const momentumShort = (rsi1 > 60 && rsi15 > 60 && (price > ma20_1h));
    const scalp = (momentumShort && Math.abs(funding) < 0.0007);
    const swing = (rsi4 >= 50 && rsi4 <= 75 && (breakout4h || volRatio4 > 1.8));

    let chosen = null;
    let reason = '';
    let conf = 0;

    // priority and reason/conf estimates
    if(liquiditySweep){
      chosen = 'LIQUIDITY_SWEEP';
      reason = 'Upper wick sweep + vol spike';
      conf = 60 + Math.min(30, (volRatio4-1)*10);
    } else if(breakout4h){
      chosen = 'BREAKOUT';
      reason = '4h breakout + vol';
      conf = 60 + Math.min(30, change24*2);
    } else if(swing){
      chosen = 'SWING';
      reason = '4h trend + vol';
      conf = 55 + Math.min(25, volRatio4*5);
    } else if(scalp){
      chosen = 'SCALP';
      reason = '1h/15m momentum';
      conf = 50 + Math.min(25, (rsi1-50));
    }

    if(!chosen) return null;

    // apply oneHConfirm bonus
    if(oneHConfirm){
      conf = (conf || 50) + DUAL_TF_CONF_BONUS;
      reason = (reason ? reason + ' | ' : '') + `EARLY_CONFIRM(1H volRatio=${volRatio1.toFixed(2)})`;
    }

    // requirement: conf must exceed threshold
    const confThreshold = marketState.confMin || 56;
    if(conf < confThreshold) return null;

    // decide side suggestion
    let side = 'LONG';
    if(price < ma20_4h) side = 'SHORT';
    if(funding < -0.0006) side = 'SHORT';
    if(funding > 0.0006) side = 'LONG';

    // compute SL/TP
    const { sl, tp, slPct, tpPct } = computeSlTpFuture(price, chosen);

    // cooldown
    if(!canSendAlert(sym, chosen)){
      if(!activeFutures.has(sym)){
        activeFutures.set(sym, { type: chosen, meta: { price, ma20_4h:fmt(ma20_4h), rsi4, conf, side, time: new Date().toISOString() }});
        saveActiveFile();
      }
      return null;
    }

    // Build message
    const lines = [];
    lines.push(`<b>[FUTURE] ${chosen} | ${sym} | ${side}</b>`);
    lines.push(`Type: ${chosen} | Conf: ${Math.round(conf)}%`);
    lines.push(`Price: ${fmt(price)} | 4h MA20: ${fmt(ma20_4h)}`);
    lines.push(`rsi4:${Math.round(rsi4)} | rsi1:${Math.round(rsi1)} | rsi15:${Math.round(rsi15)}`);
    lines.push(`VolRatio4: ${volRatio4.toFixed(2)}x | 24h%: ${fmt(change24,3)}%`);
    lines.push(`Funding: ${fmt(funding,6)} | Reason: ${reason}`);
    if(oneHConfirm) lines.push(`EARLY_CONFIRM: 1H ✅ (bonus ${DUAL_TF_CONF_BONUS}, volRatio1=${volRatio1.toFixed(2)})`);
    lines.push(`SideSuggestion: ${side} | Entry: ${fmt(price)} | SL: ${sl} | TP: ${tp}`);
    lines.push(`Note: MAIN_T
