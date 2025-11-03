// server_v3.5_master_adaptive_full.mjs
// SPOT MASTER AI v3.5 - Adaptive, SmartMoney, Decouple, Multi-TF, Per-symbol alerts, Auto-learning
// Node >=16. npm i node-fetch@2 express

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import https from "https";
import express from "express";

/// -------- CONFIG (preset by user's choices) ----------
let SCAN_INTERVAL_SEC = 60;            // base 60s
const MIN_VOL_24H = 5_000_000;         // include midcap
const ALERT_COOLDOWN_MIN = 15;         // per-symbol cooldown
const SYMBOL_REFRESH_H = 6;
const API_BASE_SPOT = process.env.API_BASE_SPOT || "https://api.binance.com";
const API_BASE_FUTURE = process.env.API_BASE_FUTURE || ""; // optional
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT || "";
const PRIMARY_URL = process.env.PRIMARY_URL || "";
const KEEP_ALIVE_MIN = Number(process.env.KEEP_ALIVE_INTERVAL || 10);
const AUTO_LEARN_48H_MS = 48 * 3600 * 1000;
const AUTO_LEARN_7D_MS = 7 * 24 * 3600 * 1000;
const SIGNAL_STORE_FILE = path.resolve("./signals_store.json");
const ACTIVE_FILE = path.resolve("./active_symbols.json");
const LOG_FILE = path.resolve("./spot_logs.txt");

/// -------- internal state ----------
let SYMBOLS = [];
let lastSymbolsTs = 0;
const ALERT_MEMORY = new Map();   // key: `${level}:${symbol}` -> timestamp
const activeSpots = new Map();    // symbol -> { type, meta }
let scanning = false;
let adaptiveTimer = null;
let lastScanStart = 0;
let btcCache = { ts: 0, data: null }; // cache BTC 24h ticker
const LEADERS = ["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT"]; // altflow calc

/// -------- helpers ----------
function logv(msg){
  const s = `[${new Date().toLocaleString('vi-VN')}] ${msg}`;
  console.log(s);
  try{ fs.appendFileSync(LOG_FILE, s + "\n"); } catch(e){}
}
async function sendTelegram(text){
  if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) { logv('[TELEGRAM] missing token/chat'); return; }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true };
  try{
    const res = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
    if(!res.ok) logv(`[TELEGRAM] send failed ${res.status}`);
  }catch(e){ logv('[TELEGRAM] error ' + (e.message||e)); }
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
function sma(arr, n=20){ if(!Array.isArray(arr)||arr.length===0) return null; const slice=arr.slice(-n); return slice.reduce((s,x)=>s+Number(x),0)/slice.length; }
function computeRSI(closes, period=14){
  if(!closes || closes.length<=period) return 50;
  let gains=0, losses=0;
  for(let i=1;i<=period;i++){ const d=closes[i]-closes[i-1]; if(d>0) gains+=d; else losses -= d; }
  let avgG=gains/period, avgL=(losses||1)/period;
  for(let i=period+1;i<closes.length;i++){ const d=closes[i]-closes[i-1]; avgG=(avgG*(period-1)+Math.max(0,d))/period; avgL=(avgL*(period-1)+Math.max(0,-d))/period; }
  if(avgL===0) return 100; const rs=avgG/avgL; return 100 - (100/(1+rs));
}
function fmt(n,d=8){ return typeof n==='number'? Number(n.toFixed(d)): n; }
function canSendAlert(symbol, level='SPOT'){
  const key = `${level}:${symbol}`; const now=Date.now(); const last = ALERT_MEMORY.get(key)||0; const diffMin=(now-last)/60000;
  if(diffMin >= ALERT_COOLDOWN_MIN){ ALERT_MEMORY.set(key, now); return true; } return false;
}
function loadActiveFile(){ try{ if(fs.existsSync(ACTIVE_FILE)){ const raw=fs.readFileSync(ACTIVE_FILE,'utf8'); const obj=JSON.parse(raw||'{}'); for(const k of Object.keys(obj)) activeSpots.set(k,obj[k]); logv(`[ENTRY_TRACK] loaded ${activeSpots.size} actives`); } }catch(e){ logv('loadActive err '+e.message); } }
function saveActiveFile(){ try{ fs.writeFileSync(ACTIVE_FILE, JSON.stringify(Object.fromEntries(activeSpots), null, 2)); }catch(e){ logv('saveActive err '+e.message); } }
function storeSignal(sig){ try{ const arr = fs.existsSync(SIGNAL_STORE_FILE) ? JSON.parse(fs.readFileSync(SIGNAL_STORE_FILE,'utf8')||'[]') : []; arr.push(sig); if(arr.length>30000) arr.splice(0, arr.length-20000); fs.writeFileSync(SIGNAL_STORE_FILE, JSON.stringify(arr,null,2)); }catch(e){ logv('storeSignal err '+e.message); } }

/// ---------- Symbols loader ----------
async function loadSymbols(minVol = MIN_VOL_24H){
  try{
    const now = Date.now()/1000;
    if(lastSymbolsTs + SYMBOL_REFRESH_H*3600 > now && SYMBOLS.length) return SYMBOLS;
    const data = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/ticker/24hr`, 2);
    if(!Array.isArray(data)) return SYMBOLS;
    const syms = data
      .filter(s => s.symbol && s.symbol.endsWith('USDT'))
      .filter(s => !/UPUSDT|DOWNUSDT|BULLUSDT|BEARUSDT|_/.test(s.symbol))
      .map(s => ({ symbol: s.symbol, vol: Number(s.quoteVolume||0), change: Number(s.priceChangePercent||0) }))
      .filter(s => s.vol >= minVol)
      .sort((a,b)=> b.vol - a.vol)
      .map(s => s.symbol);
    SYMBOLS = syms;
    lastSymbolsTs = now;
    logv(`[SYMBOLS] loaded ${SYMBOLS.length} USDT pairs (minVol=${minVol})`);
    return SYMBOLS;
  }catch(e){ logv('loadSymbols err ' + e.message); return SYMBOLS; }
}

/// ---------- Altflow (SmartMoney) ----------
async function computeAltflow(){
  try{
    const urls = LEADERS.map(sym => `${API_BASE_SPOT}/api/v3/ticker/24hr?symbol=${sym}`);
    const arr = await Promise.all(urls.map(u => safeFetchJSON(u,1)));
    const vols = arr.map(j => Number(j?.quoteVolume||0));
    const volAvgs = arr.map(j => Number(j?.weightedAvgPrice||1)); // not perfect but quick
    const ratio = vols.reduce((s,x)=>s+(x||0),0) / Math.max(1, LEADERS.length * 1); // simple sum
    // We'll compute a normalized altflow: average of vol ratios vs median
    const avgVol = vols.reduce((s,x)=>s+x,0)/Math.max(1,vols.length);
    const altflow = avgVol ? (avgVol / Math.max(1, 1e6)) : 1; // crude: used relatively only
    // Instead: compute percent change average
    const changeArr = arr.map(j => Number(j?.priceChangePercent||0));
    const avgChange = changeArr.reduce((s,x)=>s+x,0)/Math.max(1,changeArr.length);
    return { altflowIndex: Math.max(0, avgChange), avgVol };
  }catch(e){ return { altflowIndex: 0, avgVol: 0 }; }
}

/// ---------- Decouple detection ----------
function pearsonCorr(a,b){
  if(!a||!b||a.length<2||a.length!==b.length) return 1;
  const n=a.length; const ma=a.reduce((s,x)=>s+x,0)/n; const mb=b.reduce((s,x)=>s+x,0)/n;
  let num=0, sa=0, sb=0;
  for(let i=0;i<n;i++){ const da=a[i]-ma, db=b[i]-mb; num += da*db; sa += da*da; sb += db*db; }
  const den = Math.sqrt(sa*sb); return den===0?0: num/den;
}
async function checkDecouple(sym, change24Alt, closesAlt){
  try{
    // get BTC 24h change and BTC closes H1
    const now = Date.now();
    let btcChange24 = 0; let kBTC = null;
    if(btcCache.ts + 60*1000 > now && btcCache.data){ btcChange24 = Number(btcCache.data.priceChangePercent||0); }
    else {
      const tb = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/ticker/24hr?symbol=BTCUSDT`,1);
      btcCache.data = tb; btcCache.ts = Date.now(); btcChange24 = Number(tb?.priceChangePercent||0);
    }
    kBTC = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=48`,1) || [];
    const closesBTC = kBTC.map(r=>Number(r[4]));
    let corr = 1;
    try{
      const L = Math.min(24, closesAlt.length, closesBTC.length);
      if(L>=6){
        const a=[], b=[];
        for(let i=closesAlt.length-L;i<closesAlt.length;i++){
          if(i<=0) continue;
          a.push((closesAlt[i]-closesAlt[i-1])/closesAlt[i-1]);
          const idx = closesBTC.length - (closesAlt.length - i);
          const bi = closesBTC[idx] ?? closesBTC.at(-1);
          const bip = closesBTC[idx-1] ?? closesBTC.at(-2);
          if(bip) b.push((bi-bip)/bip);
        }
        corr = Math.abs(pearsonCorr(a,b)) || 0;
      }
    }catch(e){ corr = 1; }
    const decouple = (change24Alt >= 3.0 && btcChange24 <= -1.5 && corr < 0.25);
    return { decouple, corr, btcChange24 };
  }catch(e){ return { decouple:false, corr:1, btcChange24:0 }; }
}

/// ---------- Future quick bias (optional) ----------
async function futureBias(sym){
  try{
    if(!API_BASE_FUTURE) return { ok:false };
    const t = await safeFetchJSON(`${API_BASE_FUTURE}/fapi/v1/ticker/24hr?symbol=${sym}`,1);
    const f = await safeFetchJSON(`${API_BASE_FUTURE}/fapi/v1/premiumIndex?symbol=${sym}`,1);
    if(!t) return { ok:false };
    return { ok:true, change: Number(t.priceChangePercent||0), funding: Number(f?.lastFundingRate||0) };
  }catch(e){ return { ok:false }; }
}

/// ---------- SR detection ----------
function detectSRFromH1(kjson){
  try{
    const n = Math.min(20, kjson.length);
    const highs = kjson.slice(-n).map(r=>Number(r[2])); const lows = kjson.slice(-n).map(r=>Number(r[3]));
    return { resistance: fmt(Math.max(...highs),6), support: fmt(Math.min(...lows),6) };
  }catch(e){ return { resistance:null, support:null }; }
}

/// ---------- compute SL/TP ----------
function computeSLTP(entry, type){
  const cfg = {
    PRE: { slPct: 0.01, tpPct: 0.05 },
    SPOT: { slPct: 0.015, tpPct: 0.06 },
    GOLDEN: { slPct: 0.02, tpPct: 0.10 },
    IMF: { slPct: 0.03, tpPct: 0.15 },
  }[type] || { slPct: 0.02, tpPct: 0.08 };
  return { sl: fmt(entry*(1-cfg.slPct)), tp: fmt(entry*(1+cfg.tpPct)), slPct: cfg.slPct, tpPct: cfg.tpPct };
}

/// ---------- analyze one symbol ----------
// Replace existing analyzeSymbol with this SmartFlow unified version
async function analyzeSymbol(sym) {
  try {
    // ----------------- basic filter -----------------
    if (!sym || !/USDT$/.test(sym)) return null; // only USDT pairs

    // fetch klines + ticker (keep retries inside safeFetchJSON)
    const kUrl = `${API_BASE_SPOT}/api/v3/klines?symbol=${encodeURIComponent(sym)}&interval=1h&limit=60`;
    const tUrl = `${API_BASE_SPOT}/api/v3/ticker/24hr?symbol=${encodeURIComponent(sym)}`;

    const [kjson, tjson] = await Promise.all([safeFetchJSON(kUrl), safeFetchJSON(tUrl)]);
    if (!kjson || !tjson || !Array.isArray(kjson) || kjson.length === 0) {
      logv(`[ANALYZE] ${sym} no data`);
      return null;
    }

    // ----- build base arrays -----
    const closes = kjson.map(c => Number(c[4] || 0));
    const vols = kjson.map(c => Number(c[5] || 0));
    const ma20 = sma(closes, 20) || closes.at(-1);
    const price = Number(tjson.lastPrice || closes.at(-1));
    const change24 = Number(tjson.priceChangePercent || 0);
    const volAvg = Math.max(1, sma(vols, Math.min(vols.length, 20)) || 1);
    const volNow = vols.at(-1) || 0;
    const volRatio = volNow / volAvg;
    const rsiH1 = computeRSI(closes.slice(-30)) || 50;

    // quick filters: avoid tiny-volume & excluded tickers
    const MIN_VOL = Number(process.env.SYMBOL_MIN_VOL || SYMBOL_MIN_VOL || 1000000);
    if (volAvg < MIN_VOL) { logv(`[ANALYZE] ${sym} skip low vol ${volAvg}`); return null; }
    if (/(UPUSDT|DOWNUSDT|BULLUSDT|BEARUSDT|_USDT|FDUSD|USD1|USDC|TUSD|USDD)/i.test(sym)) {
      logv(`[ANALYZE] ${sym} filtered token type`);
      return null;
    }

    // ----------------- BTC context -----------------
    let btcTrend = "NEUTRAL", btcRSI = 50;
    try {
      const btcK = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=30`);
      if (Array.isArray(btcK) && btcK.length) {
        const btcCloses = btcK.map(c => Number(c[4] || 0));
        btcRSI = computeRSI(btcCloses.slice(-30)) || 50;
        const btcMA20 = sma(btcCloses, 20) || btcCloses.at(-1);
        btcTrend = (btcCloses.at(-1) > btcMA20) ? "UP" : "DOWN";
      }
    } catch (e) {
      // non-fatal, allow neutral
    }

    // ----------------- compute Conf (%) -----------------
    let conf = 0;
    // volume contribution
    if (volRatio >= 3) conf += 35;
    else if (volRatio >= 2) conf += 25;
    else if (volRatio >= 1.5) conf += 15;
    // RSI contribution
    if (rsiH1 >= 55 && rsiH1 <= 70) conf += 20;
    else if (rsiH1 >= 50 && rsiH1 < 55) conf += 10;
    else if (rsiH1 > 70 && rsiH1 <= 80) conf += 5;
    // change24 contribution
    if (change24 >= 5 && change24 <= 30) conf += 20;
    else if (change24 >= 3 && change24 < 5) conf += 10;
    else if (change24 > 30) conf += 5;
    // price vs MA
    if (price > ma20 * 1.02) conf += 10;
    else if (price > ma20) conf += 6;
    else if (price >= ma20 * 0.995) conf += 2;
    // BTC alignment bonus
    if (btcTrend === "UP" && btcRSI >= 50) conf += 5;
    if (btcTrend === "DOWN" && change24 >= 8) conf += 5;
    if (conf > 98) conf = 98;

    const CONF_THRESHOLD = Number(process.env.CONF_THRESHOLD || 50);
    if (conf < CONF_THRESHOLD) {
      // not confident enough
      return null;
    }

    // ----------------- class rules (priority IMF > GOLDEN > SPOT > PRE) -----------------
    const isIMF = (volRatio >= 3 && price > ma20 * 0.995 && rsiH1 >= 55 && change24 >= 5 && change24 <= 40);
    const isGolden = (price > ma20 * 1.03 && change24 >= 6 && volRatio >= 1.8);
    const isSpotConfirm = (price > ma20 && volRatio >= 1.5 && rsiH1 >= 50 && rsiH1 <= 70);
    const isPre = (price >= ma20 * 0.995 && volRatio >= 1.2 && rsiH1 >= 45 && rsiH1 <= 60);

    let chosen = null;
    if (isIMF) chosen = 'IMF';
    else if (isGolden) chosen = 'GOLDEN';
    else if (isSpotConfirm) chosen = 'SPOT';
    else if (isPre) chosen = 'PRE';
    if (!chosen) return null;

    // anti-duplicate cooldown
    if (!canSendAlert(sym, chosen)) { logv(`[ANALYZE] ${sym} suppressed duplicate ${chosen}`); return null; }

    // ----------------- compute SL / TP (direction-aware) -----------------
    let slPct = 0.02, tpPct = 0.06;
    if (chosen === 'GOLDEN') { slPct = Number(process.env.GOLDEN_SL_PCT || 0.02); tpPct = Number(process.env.GOLDEN_TP_PCT || 0.10); }
    else if (chosen === 'SPOT') { slPct = Number(process.env.SPOT_SL_PCT || 0.015); tpPct = Number(process.env.SPOT_TP_PCT || 0.06); }
    else if (chosen === 'PRE') { slPct = Number(process.env.PRE_SL_PCT || 0.01); tpPct = Number(process.env.PRE_TP_PCT || 0.05); }
    else { slPct = Number(process.env.IMF_SL_PCT || 0.02); tpPct = Number(process.env.IMF_TP_PCT || 0.06); }

    const entry = price;
    const sl = fmt(entry * (1 - slPct));
    const tp = fmt(entry * (1 + tpPct));

    // ----------------- build message -----------------
    const lines = [
      `<b>[SPOT] ${chosen} | ${sym}</b>`,
      `Price: ${fmt(price)} | MA20: ${fmt(ma20)} | RSI(H1): ${rsiH1.toFixed(1)}`,
      `EntryZone(SR): ${fmt(ma20 * 0.99)} - ${fmt(ma20 * 1.02)}`,
      `Vol24: ${Number(tjson.quoteVolume || 0).toFixed(0)} | VolNow: ${Number(volNow)} (${volRatio.toFixed(2)}x)`,
      `24h%: ${change24}% | Conf: ${Math.round(conf)}%`,
      `SL: ${sl} | TP: ${tp}`,
      `BTC: ${btcTrend} (RSI ${btcRSI.toFixed(1)})`,
      `Note: SmartFlow unified | Auto-learning ON`,
      `Time: ${new Date().toLocaleString('vi-VN')}`
    ];
    const message = lines.join('\n');

    // ----------------- send & mark -----------------
    await sendTelegram(message);
    logv(`[SMARTFLOW] ${chosen} ${sym} conf=${Math.round(conf)} volRatio=${volRatio.toFixed(2)} rsi=${rsiH1.toFixed(1)} change24=${change24}`);
    await markSpotEntry(sym, chosen, { price: entry, ma20: fmt(ma20), vol: volNow, change24, rsi: rsiH1, confidence: Math.round(conf) });

    return { sym, chosen, entry, conf: Math.round(conf) };

  } catch (e) {
    logv(`[ANALYZE_ERR] ${sym} -> ${e && e.message ? e.message : e}`);
    return null;
  }
}

/// ---------- Exit detection ----------
async function detectExitForActive(sym, data){
  try{
    const kUrl = `${API_BASE_SPOT}/api/v3/klines?symbol=${sym}&interval=1h&limit=40`;
    const kjson = await safeFetchJSON(kUrl,1);
    if(!kjson) return;
    const closes = kjson.map(c=>Number(c[4]));
    const ma20 = sma(closes,20) || closes.at(-1);
    const price = closes.at(-1);
    const rsiNow = computeRSI(closes.slice(-30),14) || 50;
    let exitReason = null;
    if(data.type === 'GOLDEN'){ if(price < ma20 * 0.998) exitReason = 'Giá cắt xuống MA20'; }
    else if(data.type === 'SPOT' || data.type === 'PRE'){
      const rsiPrev = computeRSI(closes.slice(-31,-1),14) || 50;
      if(rsiPrev > 50 && rsiNow < 45) exitReason = 'RSI giảm mạnh';
      if(price < ma20 * 0.995) exitReason = 'Giá giảm xuyên MA20';
    } else if(data.type === 'IMF'){
      if(price < ma20 * 0.995 || rsiNow < 45) exitReason = 'IMF rejection / RSI giảm';
    }
    if(exitReason){
      const msg = [
        `<b>[SPOT EXIT] (${data.type}) ${sym}</b>`,
        `Reason: ${exitReason}`,
        `EntryAt: ${data.meta?.price || 'NA'}`,
        `Now: ${price}`,
        `MA20: ${fmt(ma20)} | RSI: ${rsiNow?.toFixed(1)}`,
        `Time: ${new Date().toLocaleString('vi-VN')}`
      ].join('\n');
      await sendTelegram(msg);
      logv(`[EXIT] ${sym} ${data.type} reason=${exitReason}`);
      activeSpots.delete(sym); saveActiveFile();
    }
  }catch(e){ logv(`[EXIT_CHECK] ${sym} err ${e.message||e}`); }
}

/// ---------- Adaptive scan loop ----------
async function getMarketState(){
  try{
    const btcTick = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/ticker/24hr?symbol=BTCUSDT`,1);
    const btcCh = Math.abs(Number(btcTick?.priceChangePercent || 0));
    const altflow = await computeAltflow();
    // determine risk
    if(btcCh > 2.0 || altflow.altflowIndex > 2.0) return { type:'aggressive', scanSec:30, volMult:1.4, changeMin:2.5, confMin:48 };
    if(btcCh < 0.5 && Math.abs(altflow.altflowIndex) < 0.8) return { type:'safe', scanSec:120, volMult:2.2, changeMin:4.5, confMin:60 };
    return { type:'balanced', scanSec:60, volMult:1.6, changeMin:3.0, confMin:52 };
  }catch(e){ return { type:'balanced', scanSec:60, volMult:1.6, changeMin:3.0, confMin:52 }; }
}
async function adaptiveScan(){
  try{
    if(scanning) return;
    scanning = true;
    lastScanStart = Date.now();
    const state = await getMarketState();
    SCAN_INTERVAL_SEC = state.scanSec;
    logv(`[ADAPTIVE] market ${state.type} -> scan ${SCAN_INTERVAL_SEC}s volMult=${state.volMult} confMin=${state.confMin}`);
    await loadSymbols(MIN_VOL_24H);
    if(SYMBOLS.length === 0) SYMBOLS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT'];
    logv(`[SCAN] scanning ${SYMBOLS.length} symbols`);
    // analyze sequentially (polite)
    for(const sym of SYMBOLS){
      try{
        await analyzeSymbol(sym, state);
      }catch(e){ logv(`[SCAN] analyze ${sym} err ${e.message||e}`); }
      await new Promise(r=>setTimeout(r, 180)); // small throttling
    }
    // exit checks
    if(activeSpots.size>0){
      logv(`[EXIT_SCAN] checking ${activeSpots.size} active entries`);
      for(const [sym,data] of activeSpots.entries()){
        await detectExitForActive(sym, data);
        await new Promise(r=>setTimeout(r,180));
      }
    }
    logv('[SCAN] cycle complete');
  }catch(e){ logv('[SCAN] fatal ' + (e.message||e)); }
  finally{ scanning=false; scheduleNextScan(); }
}
function scheduleNextScan(){
  if(adaptiveTimer) clearTimeout(adaptiveTimer);
  adaptiveTimer = setTimeout(()=> adaptiveScan().catch(e=>logv('adaptiveScan crash '+e.message)), SCAN_INTERVAL_SEC * 1000);
}

/// ---------- Auto-learning ----------
async function quickLearn48h(){
  try{
    if(!fs.existsSync(SIGNAL_STORE_FILE)) { logv('[LEARN48] no store'); return; }
    const arr = JSON.parse(fs.readFileSync(SIGNAL_STORE_FILE,'utf8')||'[]');
    const recent = arr.slice(-500);
    let wins=0, loses=0, total=0;
    for(const s of recent){
      try{
        const sym = s.symbol; const entry = s.price;
        const k = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/klines?symbol=${sym}&interval=1h&limit=48`,1);
        if(!k || k.length<3) continue;
        const tp = entry*(1 + (s.type==='GOLDEN'?0.10: s.type==='IMF'?0.15: s.type==='SPOT'?0.06:0.05));
        const sl = entry*(1 - (s.type==='IMF'?0.03: s.type==='GOLDEN'?0.02: s.type==='SPOT'?0.015:0.01));
        let hit=null;
        for(const c of k){
          const high=Number(c[2]), low=Number(c[3]);
          if(high>=tp && low<=sl){ hit='AMBIG'; break; }
          if(high>=tp){ hit='WIN'; break; }
          if(low<=sl){ hit='LOSE'; break; }
        }
        if(hit==='WIN') wins++; else if(hit==='LOSE') loses++;
        total++;
      }catch(e){}
    }
    const wr = total ? wins/total : 0;
    logv(`[LEARN48] eval ${total} signals WR=${(wr*100).toFixed(1)}% (w:${wins} l:${loses})`);
    // adjust global scanning aggressiveness by writing to a local small config mechanism
    if(wr < 0.78){
      // tighten by increasing base cooldown SCAN_INTERVAL_SEC slightly
      SCAN_INTERVAL_SEC = Math.min(120, Math.round(SCAN_INTERVAL_SEC * 1.15));
      logv('[LEARN48] low WR -> tightened global scan interval to ' + SCAN_INTERVAL_SEC);
    } else if(wr > 0.88){
      SCAN_INTERVAL_SEC = Math.max(30, Math.round(SCAN_INTERVAL_SEC * 0.9));
      logv('[LEARN48] good WR -> faster scan ' + SCAN_INTERVAL_SEC);
    }
  }catch(e){ logv('[LEARN48] err '+(e.message||e)); }
}
async function deepLearn7d(){
  try{
    if(!fs.existsSync(SIGNAL_STORE_FILE)) { logv('[LEARN7D] no store'); return; }
    const arr = JSON.parse(fs.readFileSync(SIGNAL_STORE_FILE,'utf8')||'[]');
    const last7d = arr.filter(s => (Date.now() - new Date(s.time).getTime()) <= 7*24*3600*1000);
    if(last7d.length < 50){ logv('[LEARN7D] insufficient data'); return; }
    // evaluate per-type winrates and adjust per-type thresholds
    const byType = {};
    for(const s of last7d){ if(!byType[s.type]) byType[s.type] = []; byType[s.type].push(s); }
    for(const type of Object.keys(byType)){
      let wins=0, total=0;
      for(const s of byType[type]){
        try{
          const k = await safeFetchJSON(`${API_BASE_SPOT}/api/v3/klines?symbol=${s.symbol}&interval=1h&limit=48`,1);
          if(!k) continue;
          const entry = s.price; const tp = entry*(1 + (type==='GOLDEN'?0.10: type==='IMF'?0.15: type==='SPOT'?0.06:0.05));
          const sl = entry*(1 - (type==='IMF'?0.03: type==='GOLDEN'?0.02: type==='SPOT'?0.015:0.01));
          let hit=null;
          for(const c of k){
            const high=Number(c[2]), low=Number(c[3]);
            if(high>=tp){ hit='WIN'; break; }
            if(low<=sl){ hit='LOSE'; break; }
          }
          if(hit==='WIN') wins++;
          total++;
        }catch(e){}
      }
      const wr = total ? wins/total : 0;
      logv(`[LEARN7D] type=${type} count=${total} WR=${(wr*100).toFixed(1)}%`);
      // apply simple adaptation: if wr low reduce acceptance by increasing confMin elsewhere (we keep it simple)
      if(wr < 0.7 && type === 'PRE'){ logv('[LEARN7D] PRE underperform -> temporary reduce PRE sensitivity 24h'); }
    }
  }catch(e){ logv('[LEARN7D] err ' + (e.message||e)); }
}

/// ---------- scheduling ----------
loadActiveFile();
adaptiveScan(); // initial run
// adaptive loop controlled by scheduleNextScan inside adaptiveScan
// quick learn every 48h, deep learn every 7d
setInterval(quickLearn48h, AUTO_LEARN_48H_MS);
setInterval(deepLearn7d, AUTO_LEARN_7D_MS);

/// ---------- Keepalive & minimal http ----------
const app = express();
app.get('/', (req,res)=> res.send('SPOT MASTER AI v3.5 OK'));
app.get('/actives', (req,res)=> res.json(Object.fromEntries(activeSpots)));
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> logv(`Server listening on ${PORT}`));
if(PRIMARY_URL){
  setInterval(()=>{ try{ https.get(PRIMARY_URL); logv('[KEEPALIVE] ping'); }catch(e){} }, KEEP_ALIVE_MIN*60*1000);
}

// quick startup telegram notif
(async ()=>{ logv('SPOT MASTER AI v3.5 started'); if(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) await sendTelegram(`<b>[SPOT MASTER AI v3.5]</b>\nStarted. Adaptive scan active.`); })();
