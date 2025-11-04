// server_final_full.mjs
// SPOT MASTER AI — Full unified server (Pre / Spot / Golden / IMF + Early + PreBreakout + Learning + Backtest + API failover)
// Copy & paste this whole file. Requires node-fetch or Node >= 18 (global fetch).
// Author: assembled from user's requirements

import fs from "fs";
import path from "path";
import os from "os";
import fetchNode from "node-fetch"; // if node <18
const fetch = global.fetch || fetchNode;

// -------- CONFIG --------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const PRIMARY_URL = process.env.PRIMARY_URL || "";
// A list of Binance endpoints to rotate if blocked (order matters)
const BINANCE_API_LIST = (process.env.BINANCE_API_LIST || "https://api1.binance.com,https://api.binance.com,https://api-gcp.binance.com").split(",");
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_SEC || 60) * 1000; // default 60s
const SYMBOL_REFRESH_H = Number(process.env.SYMBOL_REFRESH_H || 6);
const SYMBOL_MIN_VOL = Number(process.env.SYMBOL_MIN_VOL || 2_000_000); // default filter
const ALERT_COOLDOWN_MIN = Number(process.env.ALERT_COOLDOWN_MIN || 15); // cooldown per symbol-level
const DATA_DIR = path.resolve("./data");
const ACTIVE_FILE = path.join(DATA_DIR, "active_entries.json");
const LEARN_FILE = path.join(DATA_DIR, "learning.json");
const HYPER_FILE = path.join(DATA_DIR, "hyper_spikes.json");
const KLINES_CACHE_TTL = 60 * 1000 * 5; // 5 minutes cache
const QUICK_LEARN_MODE = true; // can be disabled

// thresholds (tuneable)
const CONF_SEND_MIN = 60;
const HYPER_THRESHOLD = 85;

// create data dir
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e){}

// -------- Utilities & Helpers --------
function logv(msg){ const s = `[${new Date().toLocaleString("vi-VN")}] ${msg}`; console.log(s); try{ fs.appendFileSync(path.join(DATA_DIR, "server_log.txt"), s + os.EOL);}catch{} }
async function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function safeFetchJSON(url, retries=2, timeoutMs=8000){
  for(let i=0;i<=retries;i++){
    try{
      const controller = new AbortController();
      const tid = setTimeout(()=>controller.abort(), timeoutMs);
      const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent":"SpotMasterAI/3.6" }});
      clearTimeout(tid);
      if(!res.ok){ logv(`[HTTP] ${res.status} ${url}`); await sleep(200*(i+1)); continue; }
      const j = await res.json();
      return j;
    }catch(e){
      if(e.name === "AbortError") logv(`[HTTP] timeout ${url}`);
      else logv(`[HTTP] err ${e.message} ${url}`);
      await sleep(200*(i+1));
    }
  }
  return null;
}

// API failover: choose working BINANCE_API
let API_INDEX = 0;
function BINANCE_API(){ return BINANCE_API_LIST[API_INDEX] || BINANCE_API_LIST[0]; }
function rotateApi(){ API_INDEX = (API_INDEX + 1) % BINANCE_API_LIST.length; logv(`[API] rotate -> ${BINANCE_API()}`); }

// -------- Local Candle Cache (reduce rate) --------
const klinesCache = new Map(); // key -> {ts, data}
function cacheKey(sym, interval, limit){ return `${sym}|${interval}|${limit}`; }
function getCached(sym, interval, limit){
  const k = cacheKey(sym, interval, limit);
  const rec = klinesCache.get(k);
  if(!rec) return null;
  if(Date.now() - rec.ts > KLINES_CACHE_TTL) { klinesCache.delete(k); return null; }
  return rec.data;
}
function setCached(sym, interval, limit, data){
  klinesCache.set(cacheKey(sym, interval, limit), { ts: Date.now(), data });
}

// -------- Indicators --------
function sma(arr,n=20){ if(!arr||!arr.length) return NaN; const s=arr.slice(-n).reduce((a,b)=>a+Number(b),0); return s/Math.min(n,arr.length); }
function stddev(arr,n=20){ const slice=arr.slice(-n); const m=sma(slice,slice.length); const v=slice.reduce((s,x)=>s+(x-m)**2,0)/slice.length; return Math.sqrt(v); }
function bollingerWidth(closeArr, period=14, mult=2){ const mb=sma(closeArr,period); const sd=stddev(closeArr,period); const up=mb+mult*sd; const dn=mb-mult*sd; const width=(up-dn)/(mb||1); return { mb, up, dn, width }; }
function rsiFromArray(closes, period=14){ if(!closes||closes.length<period+1) return NaN; let gains=0, losses=0; for(let i=closes.length-period;i<closes.length;i++){ const d=closes[i]-closes[i-1]; if(d>=0) gains+=d; else losses+=Math.abs(d); } const avgG=gains/period; const avgL=losses/period; if(avgL===0) return 100; const rs=avgG/avgL; return 100-(100/(1+rs)); }

// -------- Telegram sender --------
async function sendTelegram(text){
  if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID){ logv("[TELEGRAM] missing token/chat"); return false; }
  try{
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true };
    const res = await fetch(url, { method: "POST", headers: { 'content-type':'application/json' }, body: JSON.stringify(payload) });
    if(!res.ok){ logv(`[TELEGRAM] fail ${res.status}`); return false; }
    return true;
  }catch(e){ logv("[TELEGRAM] err " + e.message); return false; }
}

// -------- Learning Engine (embedded light) --------
async function loadLearn(){ try{ const txt = await fs.promises.readFile(LEARN_FILE,'utf8'); return JSON.parse(txt||'{}'); }catch{return {signals:{}, stats:{}};}
}
async function saveLearn(data){ await fs.promises.mkdir(path.dirname(LEARN_FILE),{recursive:true}); await fs.promises.writeFile(LEARN_FILE, JSON.stringify(data,null,2),'utf8'); }
async function recordSignalLearn(sig){
  const data = await loadLearn();
  data.signals = data.signals || {};
  data.signals[sig.symbol] = data.signals[sig.symbol] || [];
  data.signals[sig.symbol].push({ id: Date.now()+"-"+Math.random().toString(36).slice(2,6), time: sig.time||new Date().toISOString(), ...sig, checked:false, result:null });
  await saveLearn(data);
}
async function checkOutcomesForPending(){
  const data = await loadLearn();
  const now = Date.now();
  const CHECK_HOURS = Number(process.env.LEARNING_CHECK_HOURS || 24);
  let checked = 0;
  for(const sym of Object.keys(data.signals||{})){
    for(const s of data.signals[sym]){
      if(s.checked) continue;
      if(now - new Date(s.time).getTime() < CHECK_HOURS*3600*1000) continue;
      try{
        const result = await checkOutcome(s);
        s.checked = true; s.result = result;
        data.stats = data.stats || {}; data.stats.overall = data.stats.overall || {total:0,wins:0};
        data.stats.overall.total++;
        if(result === "TP") data.stats.overall.wins++;
        checked++;
      }catch(e){}
    }
  }
  if(checked) await saveLearn(data);
  return checked;
}
async function checkOutcome(signal){
  // download candles and check TP/SL
  const LOOK_HOURS = Number(process.env.LEARNING_LOOK_HOURS || 24);
  const entry = Number(signal.price);
  const TP_PCT = Number(signal.tpPct || 0.06);
  const SL_PCT = Number(signal.slPct || 0.02);
  const api = BINANCE_API();
  const url = `${api}/api/v3/klines?symbol=${signal.symbol}&interval=1h&limit=${LOOK_HOURS+1}`;
  const candles = await safeFetchJSON(url,2);
  if(!Array.isArray(candles) || !candles.length) return "NO";
  let tp=false, sl=false;
  for(const c of candles){
    const high=Number(c[2]), low=Number(c[3]);
    if(high >= entry*(1+TP_PCT)) tp=true;
    if(low <= entry*(1-SL_PCT)) sl=true;
    if(tp||sl) break;
  }
  if(tp && !sl) return "TP";
  if(sl && !tp) return "SL";
  return "NO";
}
// periodic learning cycle
setInterval(async ()=>{
  try{ const n = await checkOutcomesForPending(); if(n>0) logv(`[LEARN] checked ${n} pending signals`); }catch(e){ logv("[LEARN] cycle err "+e.message); }
}, (process.env.LEARN_INTERVAL_HOURS ? Number(process.env.LEARN_INTERVAL_HOURS)*3600*1000 : 6*3600*1000));

// -------- Entry zone, SL/TP helpers --------
function computeEntryZoneFromMA(ma20){ if(!ma20) return {entryLow:null, entryHigh:null}; return { entryLow: +(ma20*0.995).toFixed(8), entryHigh: +(ma20*1.02).toFixed(8) }; }
function computeSlTp(entry, type){
  const cfg = {
    PRE: { slPct: 0.01, tpPct: 0.05 },
    SPOT: { slPct: 0.015, tpPct: 0.06 },
    GOLDEN: { slPct: 0.02, tpPct: 0.10 },
    IMF: { slPct: 0.03, tpPct: 0.15 }
  }[type] || { slPct: 0.02, tpPct: 0.08 };
  const sl = +(entry * (1 - cfg.slPct)).toFixed(8);
  const tp = +(entry * (1 + cfg.tpPct)).toFixed(8);
  return { sl, tp, slPct: cfg.slPct, tpPct: cfg.tpPct };
}

// -------- Active entries tracking (RAM + file) --------
const activeMap = new Map();
function loadActive(){
  try{ if(fs.existsSync(ACTIVE_FILE)){ const raw=fs.readFileSync(ACTIVE_FILE,'utf8'); const obj=JSON.parse(raw||'{}'); for(const [k,v] of Object.entries(obj)) activeMap.set(k,v); logv(`[ENTRY_TRACK] loaded ${activeMap.size}`); } }catch(e){ logv('[ENTRY_TRACK] load err '+e.message); }
}
function saveActive(){ try{ const obj = Object.fromEntries(activeMap); fs.writeFileSync(ACTIVE_FILE, JSON.stringify(obj,null,2)); }catch(e){ logv('[ENTRY_TRACK] save err '+e.message); } }
function markEntry(sym, type, meta={}){ activeMap.set(sym, { type, meta, markedAt: Date.now() }); saveActive(); logv(`[MARK] ${sym} as ${type}`); }
function clearEntry(sym){ if(activeMap.has(sym)){ activeMap.delete(sym); saveActive(); logv(`[CLEAR] ${sym}`); } }

// -------- SYMBOL LOADER (by volume + USDT) --------
let SYMBOLS = []; let lastSymbolsTs=0;
async function loadSymbols(minVol=SYMBOL_MIN_VOL){
  try{
    const nowS = Date.now()/1000;
    if(lastSymbolsTs + SYMBOL_REFRESH_H*3600 > nowS && SYMBOLS.length) return SYMBOLS;
    const api = BINANCE_API();
    const url = `${api}/api/v3/ticker/24hr`;
    const data = await safeFetchJSON(url,2);
    if(!Array.isArray(data)) return SYMBOLS;
    const syms = data.filter(s=> s.symbol && s.symbol.endsWith("USDT"))
      .filter(s=> !/UPUSDT|DOWNUSDT|BULLUSDT|BEARUSDT|_/.test(s.symbol))
      .map(s=> ({ symbol: s.symbol, vol: Number(s.quoteVolume||0), change: Number(s.priceChangePercent||0) }))
      .filter(s => s.vol >= minVol)
      .sort((a,b)=>b.vol-a.vol)
      .map(s=>s.symbol);
    SYMBOLS = syms;
    lastSymbolsTs = nowS;
    logv(`[SYMBOLS] loaded ${SYMBOLS.length}`);
    return SYMBOLS;
  }catch(e){
    logv('[SYMBOLS] err '+e.message);
    // try rotating api once when fail
    rotateApi();
    return SYMBOLS;
  }
}

// -------- PREBREAKOUT / EARLY detector (rotation-style) --------
async function scanPreBreakoutCore({maxTick=120, minVol24=SYMBOL_MIN_VOL} = {}){
  const api = BINANCE_API();
  const tickers = await safeFetchJSON(`${api}/api/v3/ticker/24hr`,2);
  if(!Array.isArray(tickers)) return [];
  const pool = tickers.filter(t => t.symbol.endsWith("USDT") && Number(t.quoteVolume||0) >= minVol24 && !/UPUSDT|DOWNUSDT|BULLUSDT|BEARUSDT|_/.test(t.symbol))
    .sort((a,b)=> Number(b.quoteVolume||0) - Number(a.quoteVolume||0)).slice(0, maxTick);

  const results = [];
  // fetch BTC rsi quick
  let BTC_RSI = 50;
  try{
    const btckl = await getKlinesCached("BTCUSDT","1h",100);
    BTC_RSI = rsiFromArray(btckl.map(c=>c[4]),14);
  }catch(e){}

  for(const t of pool){
    const sym = t.symbol;
    try{
      const k4 = await getKlinesCached(sym,"4h",100);
      const k1 = await getKlinesCached(sym,"1h",100);
      if(!k4.length || !k1.length) continue;
      const closes4 = k4.map(c=>Number(c[4]));
      const closes1 = k1.map(c=>Number(c[4]));
      const vols1 = k1.map(c=>Number(c[5]));
      const RSI_H4 = Math.round(rsiFromArray(closes4,14) || 0);
      const RSI_H1 = Math.round(rsiFromArray(closes1,14) || 0);
      const bb = bollingerWidth(closes4,14,2); const BBWidth_H4 = Number((bb.width||0).toFixed(4));
      const MA20 = sma(closes4,20) || closes4.at(-1);
      const price = closes1.at(-1);
      const VolNow = vols1.at(-1) || 0;
      const avg24h_base = Number(t.volume||1)/24;
      const VolNowRatio = avg24h_base ? VolNow/avg24h_base : 1;

      // compute Conf
      const conf = computeConfForPre({RSI_H4,RSI_H1,VolNowRatio,BBWidth_H4,BTC_RSI});

      // compressed check
      const compressed = (BBWidth_H4 < 0.08) && (Math.abs(price-MA20)/(MA20||1) < 0.03);

      // determine type (IMF > GOLDEN > SPOT > PRE)
      let type = null;
      const change24 = Number(t.priceChangePercent||0);
      if(VolNowRatio > 3 && price > MA20*0.995 && RSI_H1 >= 55 && change24>=5) type='IMF';
      else if(price > MA20*1.03 && change24 >=6) type='GOLDEN';
      else if(price > MA20 && VolNow > (sma(vols1,20)||1)*1.6 && RSI_H1 >=50 && RSI_H1<=70) type='SPOT';
      else if(compressed && VolNow > (sma(vols1,20)||1)*1.2 && RSI_H1>=45 && RSI_H1<=60) type='PRE';

      if(type && conf >= CONF_SEND_MIN){
        results.push({ symbol: sym, price, type, conf, RSI_H4, RSI_H1, VolNow, VolNowRatio, BBWidth_H4, MA20, change24, compressed, time: new Date().toISOString() });
      }
      // save hyper spikes minimal
      if(conf >= HYPER_THRESHOLD && compressed) { try{ let hyper = JSON.parse(fs.readFileSync(HYPER_FILE,'utf8')||'[]'); hyper.push({symbol:sym,conf,ts:Date.now()}); hyper = hyper.slice(-500); fs.writeFileSync(HYPER_FILE, JSON.stringify(hyper,null,2)); }catch(e){} }
      await sleep(40); // small delay
    }catch(e){ /*skip*/ }
  }
  // sort by conf desc
  results.sort((a,b)=>b.conf-a.conf);
  return results;
}

function computeConfForPre({RSI_H4,RSI_H1,VolNowRatio,BBWidth_H4,BTC_RSI}){
  let Conf=0;
  if(RSI_H4>45 && RSI_H4<60) Conf+=0.25;
  if(RSI_H1>50 && RSI_H1<70) Conf+=0.20;
  if(VolNowRatio>1.8 && VolNowRatio<3.5) Conf+=0.20;
  if(BBWidth_H4 < 0.06) Conf+=0.15;
  if(BTC_RSI>35 && BTC_RSI<65) Conf+=0.15;
  if(RSI_H1>75 || VolNowRatio>4.5) Conf-=0.15;
  Conf=Math.min(Math.max(Conf,0),1)*100;
  return Math.round(Conf);
}

// -------- Cached getKlines wrapper --------
async function getKlinesCached(symbol, interval="1h", limit=100){
  const cached = getCached(symbol, interval, limit);
  if(cached) return cached;
  const api = BINANCE_API();
  const url = `${api}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const j = await safeFetchJSON(url,2);
  if(!j) { rotateApi(); return []; }
  setCached(symbol, interval, limit, j);
  return j;
}

// -------- Analyze single symbol for spot-tier (call) --------
async function analyzeSymbolForCall(sym){
  try{
    const kjson = await getKlinesCached(sym,'1h',60);
    const tjsonRaw = await safeFetchJSON(`${BINANCE_API()}/api/v3/ticker/24hr?symbol=${sym}`,2);
    if(!kjson.length || !tjsonRaw) return null;
    const closes = kjson.map(k=>Number(k[4]));
    const vols = kjson.map(k=>Number(k[5]));
    const ma20 = sma(closes,20) || closes.at(-1);
    const price = Number(tjsonRaw.lastPrice || closes.at(-1));
    const change24 = Number(tjsonRaw.priceChangePercent||0);
    const vol24 = Number(tjsonRaw.quoteVolume||0);
    const rsi = Math.round(rsiFromArray(closes,14) || 50);

    const entryZone = computeEntryZoneFromMA(ma20);
    const nearEntry = price >= entryZone.entryLow && price <= entryZone.entryHigh;
    const volAvg = Math.max(1,sma(vols,20));
    const volNow = vols.at(-1) || 0;

    const isIMF = volNow > volAvg*3 && price > ma20*0.995 && rsi>=55 && change24>=5;
    const isGolden = price > ma20*1.03 && change24 >= 6;
    const isSpotConfirm = price > ma20 && volNow > volAvg*1.8 && rsi>=50 && rsi<=70;
    const isPre = nearEntry && volNow > volAvg*1.2 && rsi>=45 && rsi<=60;

    let chosen=null;
    if(isIMF) chosen='IMF';
    else if(isGolden) chosen='GOLDEN';
    else if(isSpotConfirm) chosen='SPOT';
    else if(isPre) chosen='PRE';
    if(!chosen) return null;

    const entry = price;
    const { sl, tp, slPct, tpPct } = computeSlTp(entry, chosen);
    const conf = computeConfForPre({RSI_H4: rsi, RSI_H1: rsi, VolNowRatio: volNow/Math.max(1,volAvg), BBWidth_H4:0.05, BTC_RSI:50}); // quick conf
    const msgObj = { symbol: sym, type: chosen, entry, sl, tp, slPct, tpPct, ma20, volNow, vol24, change24, rsi, conf, time: new Date().toISOString() };

    // send alert if allowed by cooldown
    if(canSendAlert(sym, chosen) && conf >= CONF_SEND_MIN){
      const text = buildEntryMsg(msgObj);
      await sendTelegram(text);
      logv(`[ALERT-SENT] ${sym} ${chosen} conf=${conf}%`);
      // record in learning
      await recordSignalLearn({ symbol: sym, type: chosen, price: entry, tpPct, slPct, conf, time: msgObj.time });
      markEntry(sym, chosen, { price: entry, ma20, volNow, rsi, conf });
    }
    return msgObj;
  }catch(e){
    logv(`[ANALYZE] ${sym} err ${e.message}`);
    return null;
  }
}

// -------- Alert dedupe / cooldown memory --------
const ALERT_MEMORY = new Map(); // key -> ts
function canSendAlert(symbol, level="SPOT"){
  const key = `${level}:${symbol}`;
  const now=Date.now();
  const last = ALERT_MEMORY.get(key) || 0;
  const diffMin = (now-last)/60000;
  if(diffMin >= ALERT_COOLDOWN_MIN){ ALERT_MEMORY.set(key,now); return true; }
  return false;
}

// -------- Build entry message text --------
function buildEntryMsg({symbol,type,entry,entryLow,entryHigh,sl,tp,ma20,volNow,change24,rsi,conf,time}) {
  const lines = [];
  lines.push(`<b>[SPOT] ${type} • ${symbol}</b>`);
  if(entryLow && entryHigh) lines.push(`Vùng entry: ${entryLow} - ${entryHigh}`);
  else lines.push(`Giá hiện: ${entry}`);
  lines.push(`MA20: ${+(ma20||0).toFixed(6)} | RSI: ${rsi}`);
  lines.push(`Vol(1h): ${Math.round(volNow)} | 24h%: ${change24}%`);
  lines.push(`SL: ${sl} | TP: ${tp}`);
  lines.push(`Conf: ${conf}%`);
  lines.push(`Time: ${new Date(time).toLocaleString('vi-VN')}`);
  return lines.join("\n");
}

// -------- Exit detection for actives --------
async function detectExitForActive(sym, data){
  try{
    const k = await getKlinesCached(sym,'1h',40);
    if(!k.length) return;
    const closes = k.map(c=>Number(c[4]));
    const price = closes.at(-1);
    const ma20 = sma(closes,20);
    const rsiNow = Math.round(rsiFromArray(closes,14)||50);
    let exitReason = null;
    if(data.type === 'GOLDEN'){
      if(price < ma20 * 0.998) exitReason = 'Giá cắt xuống MA20';
    } else if(data.type === 'SPOT' || data.type === 'PRE'){
      if(rsiNow < 45) exitReason = 'RSI giảm mạnh';
      if(price < ma20 * 0.995) exitReason = 'Giá xuyên MA20';
    } else if(data.type === 'IMF'){
      if(price < ma20 * 0.995 || rsiNow < 45) exitReason = 'IMF rejection';
    }

    if(exitReason){
      const msg = `<b>[SPOT EXIT] (${data.type}) ${sym}</b>\nReason: ${exitReason}\nEntryAt: ${data.meta?.price || 'NA'}\nNow: ${price}\nMA20: ${+(ma20||0).toFixed(6)} | RSI: ${rsiNow}`;
      await sendTelegram(msg);
      logv(`[EXIT] ${sym} ${exitReason}`);
      clearEntry(sym);
    }
  }catch(e){ logv('[EXIT] '+e.message); }
}

// -------- Scan loop (main) --------
let scanning=false;
async function scanOnce(){
  if(scanning) return;
  scanning=true;
  try{
    // refresh symbol list if empty
    await loadSymbols();
    if(!SYMBOLS.length) SYMBOLS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT'];

    logv(`[SCAN] start ${SYMBOLS.length} symbols`);
    // run prebreakout core first (early detection)
    const pre = await scanPreBreakoutCore({maxTick: 120, minVol24: SYMBOL_MIN_VOL});
    if(pre && pre.length){
      logv(`[PREBREAKOUT] candidates ${pre.length} top=${pre[0].symbol} conf=${pre[0].conf}%`);
      for(const p of pre.slice(0,15)){ // push top candidates
        if(p.conf >= CONF_SEND_MIN && canSendAlert(p.symbol, p.type)){
          const entry = p.price;
          const { sl, tp } = computeSlTp(entry, p.type);
          const txt = `<b>[PREBREAKOUT] ${p.type} • ${p.symbol}</b>\nConf: ${p.conf}%\nPrice: ${entry}\nSL: ${sl} | TP: ${tp}\nTime: ${new Date().toLocaleString('vi-VN')}`;
          await sendTelegram(txt);
          await recordSignalLearn({ symbol: p.symbol, type: p.type, price: entry, tpPct: (tp-entry)/entry, slPct:(entry-sl)/entry, conf:p.conf, time: p.time });
          markEntry(p.symbol, p.type, { price: entry, conf: p.conf, meta:p });
        }
      }
    }

    // then analyze each symbol — but only top N to reduce rate (we already have pre list)
    for(const sym of SYMBOLS.slice(0, 120)){
      try{
        await analyzeSymbolForCall(sym);
      }catch(e){ logv(`[SCAN] analyze ${sym} err ${e.message}`); }
      await sleep(120); // small pacing to respect rate-limits
    }

    // then check exits
    if(activeMap.size){
      logv(`[EXIT_SCAN] checking ${activeMap.size} active entries`);
      for(const [sym, data] of activeMap.entries()){
        await detectExitForActive(sym, data);
        await sleep(120);
      }
    }

    logv('[SCAN] cycle complete');
  }catch(e){ logv('[SCAN] fatal '+e.message); }
  finally{ scanning=false; }
}

// -------- Helpers: computeConf (used elsewhere) --------
function computeConfGeneric(vals){
  // wrapper to reuse computeConfForPre
  return computeConfForPre(vals);
}

// -------- Startup / Scheduler --------
loadActive(); // load previously active entries

// quick startup notice
(async ()=>{
  logv("[SPOT MASTER AI — Unified] Starting...");
  if(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) await sendTelegram(`<b>[SPOT MASTER AI]</b>\nServer started. Unified scan active.`);
})();

// start immediate + schedule
scanOnce().catch(e=>logv('[MAIN] immediate err '+e.message));
setInterval(scanOnce, SCAN_INTERVAL_MS);

// keepalive ping to PRIMARY_URL if provided
if(PRIMARY_URL){
  setInterval(()=>{ try{ fetch(PRIMARY_URL); logv('[KeepAlive] ping'); }catch(e){} }, (Number(process.env.KEEP_ALIVE_INTERVAL||10))*60*1000);
}

// expose minimal health server if running on node with http
import http from "http";
const PORT = Number(process.env.PORT || 3000);
http.createServer((req,res)=> res.end('OK - Spot Master AI')).listen(PORT, ()=> logv(`HTTP health on ${PORT}`));
// ===== AUTO-ADJUST (paste vào cuối server_final_full.mjs) =====
const DYN_CFG_FILE = path.join(DATA_DIR, 'dynamic_config.json');
const AUTO_ADJUST_INTERVAL_MIN = Number(process.env.AUTO_ADJUST_INTERVAL_MIN || 60); // check every 60min
async function loadDynamicCfg(){ try{ return JSON.parse(fs.readFileSync(DYN_CFG_FILE,'utf8')||'{}'); }catch{return {}; } }
async function saveDynamicCfg(obj){ try{ fs.writeFileSync(DYN_CFG_FILE, JSON.stringify(obj,null,2)); logv('[DYNCFG] saved'); }catch(e){ logv('[DYNCFG] save err '+e.message); } }

async function computeAndApplyAdjustments(){
  try{
    const learn = await loadLearn();
    const stats = learn.stats || {};
    const byType = stats.byType || {};
    const cfg = await loadDynamicCfg();
    let changed = false;

    // example simple policy per type
    for(const [type, rec] of Object.entries(byType)){
      const total = rec.total || 0, wins = rec.wins || 0;
      if(total < 20) continue; // not enough sample
      const wr = wins/total;
      cfg[type] = cfg[type] || {};
      // tighten if wr very low
      if(wr < 0.45){
        cfg[type].confAdd = Math.min(40, (cfg[type].confAdd||0) + 5); // require higher conf to send
        cfg[type].volMult = Math.min(3, (cfg[type].volMult||1) + 0.1);
        changed = true;
        logv(`[AUTO-ADJUST] tighten ${type} wr=${Math.round(wr*100)}%`);
      } else if(wr > 0.75){
        cfg[type].confAdd = Math.max(-20, (cfg[type].confAdd||0) - 3); // relax
        cfg[type].volMult = Math.max(0.6, (cfg[type].volMult||1) - 0.05);
        changed = true;
        logv(`[AUTO-ADJUST] relax ${type} wr=${Math.round(wr*100)}%`);
      }
    }

    if(changed) await saveDynamicCfg(cfg);
    return { changed, cfg };
  }catch(e){ logv('[AUTO-ADJUST] err '+e.message); return {changed:false}; }
}

// periodically run and apply dynamic config (server's analysis functions must read dynamic_config.json to use multipliers)
setInterval(async ()=>{
  try{
    const res = await computeAndApplyAdjustments();
    if(res.changed) logv('[AUTO-ADJUST] applied changes');
  }catch(e){ logv('[AUTO-ADJUST] cycle err '+e.message); }
}, AUTO_ADJUST_INTERVAL_MIN * 60 * 1000);

// note: to make adjustments effective, when loading SYMBOLS or computing conf you should check dynamic_config.json (example usage is in comments)
