// server_final_full_v3.9.mjs
// Spot Master AI - Full integration (PRE / SPOT / GOLDEN / IMF / EARLY + Learning + Cache + Failover)
// Author: Generated for you
// Requirements: node >=16, node-fetch@2 (or native fetch available)

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import * as LEARN from "./learning_engine.js";               // you already have this
import { scanPreBreakout } from "./rotation_prebreakout.js"; // pre-breakout module (if present)

//
// ----------------- CONFIG / ENV -----------------
//
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT || "";
const PRIMARY_URL = process.env.PRIMARY_URL || "";
const PORT = process.env.PORT || 3000;

const BINANCE_API_LIST = (process.env.BINANCE_API_LIST || "https://api1.binance.com,https://api-gcp.binance.com,https://api.binance.com")
  .split(",").map(s => s.trim()).filter(Boolean);
let API_INDEX = 0;
function currentBinanceApi(){ return BINANCE_API_LIST[API_INDEX % BINANCE_API_LIST.length]; }
function rotateApi(){ API_INDEX = (API_INDEX + 1) % BINANCE_API_LIST.length; return currentBinanceApi(); }

const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_SEC || 60) * 1000; // 1m default
const SYMBOL_REFRESH_H = Number(process.env.SYMBOL_REFRESH_H || 6);
const SYMBOL_MIN_VOL = Number(process.env.SYMBOL_MIN_VOL || 2_000_000); // default filter
const SYMBOL_MIN_CHANGE = Number(process.env.SYMBOL_MIN_CHANGE || 3);   // %
const ALERT_COOLDOWN_MIN = Number(process.env.ALERT_COOLDOWN_MIN || 15); // minutes

const DATA_DIR = path.resolve("./data");
const ACTIVE_FILE = path.join(DATA_DIR, "active_spots.json");
const CACHE_DIR = path.join(DATA_DIR, "cache");
const DYNAMIC_CONFIG_FILE = path.join(DATA_DIR, "dynamic_config.json");

//
// ----------------- UTIL / LOGGER / TELEGRAM -----------------
//
function ensureDir(p){ try{ fs.mkdirSync(p, { recursive: true }); } catch(e){} }
ensureDir(DATA_DIR); ensureDir(CACHE_DIR);

function logv(msg){
  const s = `[${new Date().toLocaleString("vi-VN")}] ${msg}`;
  console.log(s);
  try{ fs.appendFileSync(path.join(DATA_DIR,"server_log.txt"), s + "\n"); } catch(e){}
}

async function sendTelegram(text){
  if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID){
    logv("[TELEGRAM] missing token/chat");
    return;
  }
  try{
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true };
    const res = await fetch(url, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(payload) });
    if(!res.ok) logv(`[TELEGRAM] send failed ${res.status}`);
  } catch(e){ logv("[TELEGRAM] error " + (e.message||e)); }
}

//
// ----------------- HTTP SAFE FETCH + FAILOVER + CACHE -----------------
//
async function safeFetchJSON(url, retries=2){
  for(let i=0;i<=retries;i++){
    try{
      const r = await fetch(url, { headers: { "User-Agent": "SpotMasterAI/3.9" }, timeout: 10000 });
      if(!r.ok){
        logv(`[HTTP] ${r.status} ${url}`);
        await new Promise(rp=>setTimeout(rp, 200*(i+1)));
        continue;
      }
      return await r.json();
    } catch(e){
      logv(`[HTTP] fetch error (${i}) ${e.message}`);
      await new Promise(rp=>setTimeout(rp, 200*(i+1)));
    }
  }
  // failover rotate API (for Binance IP block)
  rotateApi();
  logv("[HTTP] rotate API -> " + currentBinanceApi());
  return null;
}

// Candle cache: cache klines per-symbol/interval for short time
const CANDLE_CACHE_MS = Number(process.env.CANDLE_CACHE_MS || 30*1000); // 30s
const candleCache = new Map(); // key -> {ts, data}
function cacheKey(symbol, interval, limit){ return `${symbol}|${interval}|${limit}`; }
async function getKlinesCached(symbol, interval='1h', limit=60){
  const key = cacheKey(symbol, interval, limit);
  const now = Date.now();
  const cached = candleCache.get(key);
  if(cached && (now - cached.ts) < CANDLE_CACHE_MS) return cached.data;
  const url = `${currentBinanceApi()}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const j = await safeFetchJSON(url, 2);
  if(j) candleCache.set(key, { ts: Date.now(), data: j });
  return j || [];
}

//
// ----------------- SYMBOLS LOADER -----------------
let SYMBOLS = [];
let lastSymbolsTs = 0;
async function loadSymbols({minVol=SYMBOL_MIN_VOL, minChange=SYMBOL_MIN_CHANGE} = {}){
  const now = Date.now()/1000;
  if(lastSymbolsTs + SYMBOL_REFRESH_H*3600 > now && SYMBOLS.length) return SYMBOLS;
  const url = `${currentBinanceApi()}/api/v3/ticker/24hr`;
  const data = await safeFetchJSON(url, 2);
  if(!Array.isArray(data)) return SYMBOLS;
  const syms = data
    .filter(s => s.symbol && s.symbol.endsWith("USDT"))
    .filter(s => !/UPUSDT|DOWNUSDT|BULLUSDT|BEARUSDT|_/.test(s.symbol))
    .map(s => ({ symbol: s.symbol, vol: Number(s.quoteVolume||0), change: Number(s.priceChangePercent||0) }))
    .filter(s => s.vol >= minVol && Math.abs(s.change) >= minChange)
    .sort((a,b)=> b.vol - a.vol)
    .map(s => s.symbol);
  SYMBOLS = syms;
  lastSymbolsTs = now;
  logv(`[SYMBOLS] loaded ${SYMBOLS.length} USDT pairs (vol>=${minVol}, change>=${minChange}%)`);
  return SYMBOLS;
}

//
// ----------------- ACTIVE ENTRIES TRACKING -----------------
const activeSpots = new Map();
function loadActiveFile(){
  try{
    if(fs.existsSync(ACTIVE_FILE)){
      const raw = fs.readFileSync(ACTIVE_FILE,'utf8');
      const obj = JSON.parse(raw || '{}');
      for(const [k,v] of Object.entries(obj)) activeSpots.set(k,v);
      logv(`[ENTRY_TRACK] loaded ${activeSpots.size} active entries`);
    }
  }catch(e){ logv('[ENTRY_TRACK] load error '+e.message); }
}
function saveActiveFile(){
  try{ const obj = Object.fromEntries(activeSpots); fs.writeFileSync(ACTIVE_FILE, JSON.stringify(obj, null, 2)); } catch(e){ logv('[ENTRY_TRACK] save error '+e.message); }
}
function markSpotEntry(symbol, type, meta={}){
  activeSpots.set(symbol, { type, markedAt: Date.now(), meta });
  saveActiveFile();
  logv(`[MARK ENTRY] ${symbol} type=${type} price=${meta.price} ma20=${meta.ma20} vol=${meta.vol}`);
}
function clearSpotEntry(symbol){
  if(activeSpots.has(symbol)){ activeSpots.delete(symbol); saveActiveFile(); logv(`[CLEAR ENTRY] ${symbol}`); }
}

//
// ----------------- INDICATORS -----------------
function sma(arr, n=20){
  if(!arr || arr.length < 1) return null;
  const slice = arr.slice(-n);
  const sum = slice.reduce((s,x)=> s + Number(x), 0);
  return sum / slice.length;
}
function computeRSI(closes, period=14){
  if(!closes || closes.length <= period) return 50;
  let gains = 0, losses = 0;
  for(let i=1;i<closes.length;i++){
    const d = closes[i] - closes[i-1];
    if(d>0) gains += d; else losses += Math.abs(d);
  }
  const avgGain = gains / (closes.length-1);
  const avgLoss = losses / (closes.length-1) || 1;
  if(avgLoss === 0) return 100;
  const rs = avgGain/avgLoss;
  return 100 - (100/(1+rs));
}
function bollingerWidth(closeArr, period=14, mult=2){
  const mb = sma(closeArr, period);
  const sd = Math.sqrt(closeArr.slice(-period).reduce((s,x)=> s + Math.pow(x - mb, 2), 0) / period);
  const up = mb + mult*sd;
  const dn = mb - mult*sd;
  const width = (up - dn) / (mb || 1);
  return { mb, up, dn, width };
}
function fmt(n){ return typeof n === 'number' ? Number(n.toFixed(8)) : n; }

//
// ----------------- ENTRY ZONES & SL/TP -----------------
function computeEntryZoneFromMA(ma20){
  if(!ma20) return { entryLow:null, entryHigh:null };
  return { entryLow: fmt(ma20 * 0.995), entryHigh: fmt(ma20 * 1.02) }; // conservative
}
function computeSLTP(entry, type){
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

//
// ----------------- ALERT DEDUPE -----------------
const ALERT_MEMORY = new Map(); // key -> ts
function canSendAlert(symbol, level="SPOT"){
  const key = `${level}:${symbol}`;
  const now = Date.now();
  const last = ALERT_MEMORY.get(key) || 0;
  const diffMin = (now - last) / 60000;
  if(diffMin >= ALERT_COOLDOWN_MIN){
    ALERT_MEMORY.set(key, now);
    return true;
  }
  return false;
}

//
// ----------------- ANALYZE ONE SYMBOL -----------------
async function analyzeSymbol(sym){
  try{
    const kjson = await getKlinesCached(sym, '1h', 60);
    const tjson = await safeFetchJSON(`${currentBinanceApi()}/api/v3/ticker/24hr?symbol=${sym}`, 1);
    if(!kjson || !tjson) return null;

    const closes = kjson.map(c => Number(c[4]));
    const ma20 = sma(closes, 20) || closes.at(-1);
    const price = Number(tjson.lastPrice || closes.at(-1));
    const change24 = Number(tjson.priceChangePercent || 0);
    const vol = Number(tjson.quoteVolume || 0);
    const rsi = computeRSI(closes.slice(-30)) || 50;

    // extra volume array for local vol average on 1h candles:
    const vols = kjson.map(c => Number(c[5] || 0));
    const volAvg = sma(vols, Math.min(vols.length, 20)) || 1;
    const volNow = vols.at(-1) || 0;

    // heuristics (from discussions)
    const entryZone = computeEntryZoneFromMA(ma20);
    const nearEntry = price >= entryZone.entryLow && price <= entryZone.entryHigh;
    const isGolden = price > ma20 * 1.03 && change24 >= 6 && volNow > volAvg * 1.5;
    const isSpotConfirm = (price > ma20 && volNow > Math.max(1, volAvg * 1.6) && rsi >= 50 && rsi <= 68);
    const isPre = nearEntry && volNow > Math.max(1, volAvg * 1.2) && rsi >= 45 && rsi <= 58;
    const isIMF = volNow > volAvg * 3 && price > ma20 * 0.995 && rsi >= 55 && rsi <= 75;

    // priority IMF > GOLDEN > SPOT > PRE
    let chosen = null;
    if(isIMF) chosen = 'IMF';
    else if(isGolden) chosen = 'GOLDEN';
    else if(isSpotConfirm) chosen = 'SPOT';
    else if(isPre) chosen = 'PRE';

    if(!chosen) return null;

    // prepare message and action
    const entry = price;
    const { sl, tp } = computeSLTP(entry, chosen);
    const conf = estimateConfidence({ sym, chosen, rsi, volNow, volAvg, change24, price, ma20 });

    // dedupe per symbol-level
    if(!canSendAlert(sym, chosen)) {
      logv(`[DUPLICATE] skip ${sym} ${chosen}`);
      return null;
    }

    const msg = buildEntryMsg({
      symbol: sym, type: chosen, entry, entryLow: entryZone.entryLow, entryHigh: entryZone.entryHigh, sl, tp, ma20, vol: volNow, change24, rsi, conf
    });

    // send
    await sendTelegram(msg);
    logv(`[ALERT] ${chosen} ${sym} price=${entry} conf=${conf}%`);
    // mark active entry for exit tracking
    markSpotEntry(sym, chosen, { price: entry, ma20: fmt(ma20), vol: volNow, change24, rsi, conf });

    // record to learning engine
    try{
      await LEARN.recordSignal({
        symbol: sym,
        type: chosen,
        time: new Date().toISOString(),
        price: entry,
        rsi,
        vol: volNow,
        tpPct: (tp/entry -1),
        slPct: (1 - sl/entry),
        extra: { change24, conf }
      });
    }catch(e){ logv('[LEARN] record fail '+(e.message||e)); }

    return { sym, chosen, entry, conf };
  }catch(e){
    logv(`[ANALYZE] ${sym} error ${e.message}`);
    return null;
  }
}

function estimateConfidence({ sym, chosen, rsi, volNow, volAvg, change24, price, ma20 }){
  // basic confidence estimator; learning engine can override via dynamic_config
  let conf = 0;
  if(chosen === 'IMF') conf += 0.30;
  if(chosen === 'GOLDEN') conf += 0.25;
  if(chosen === 'SPOT') conf += 0.18;
  if(chosen === 'PRE') conf += 0.10;

  // RSI bands
  if(rsi >=50 && rsi <= 70) conf += 0.2;
  if(rsi >=55 && rsi <= 65) conf += 0.1;

  // vol ratio effect
  const volRatio = volAvg ? volNow / volAvg : 1;
  if(volRatio >= 1.5 && volRatio < 3) conf += 0.12;
  if(volRatio >= 3) conf += 0.18;

  // 24h change
  if(change24 >= 6) conf += 0.12;
  if(change24 >= 15) conf -= 0.10; // avoid already-flying coins

  // proximity to MA20: near MA20 better for PRE
  if(Math.abs(price - ma20) / (ma20 || 1) < 0.02) conf += 0.05;

  conf = Math.round(Math.min(Math.max(conf, 0), 0.99) * 100);
  // allow dynamic adjustment from config
  let dynamic = {};
  try{ dynamic = JSON.parse(fs.readFileSync(DYNAMIC_CONFIG_FILE,'utf8')||'{}'); } catch(e){}
  if(dynamic && dynamic.adjustConfPct) conf = Math.round(conf * (1 + (dynamic.adjustConfPct/100)));
  return Math.min(conf, 99);
}

function buildEntryMsg({symbol, type, entry, entryLow, entryHigh, sl, tp, ma20, vol, change24, rsi, conf}) {
  const lines = [];
  lines.push(`<b>[SPOT] ${type} | ${symbol}</b>`);
  if(entryLow && entryHigh) lines.push(`Vùng entry: ${entryLow} - ${entryHigh}`);
  else lines.push(`Giá hiện: ${entry}`);
  lines.push(`MA20: ${fmt(ma20)} | RSI: ${rsi?.toFixed(1) || 'NA'}`);
  lines.push(`Vol(1h): ${Number(vol).toFixed(0)} | 24h: ${change24}%`);
  lines.push(`SL: ${sl} | TP: ${tp} | Conf: ${conf}%`);
  lines.push(`Time: ${new Date().toLocaleString('vi-VN')}`);
  return lines.join('\n');
}

//
// ----------------- EXIT CHECK -----------------
async function detectExitForActive(sym, data){
  try{
    const kjson = await getKlinesCached(sym, '1h', 40);
    if(!kjson || !kjson.length) return;
    const closes = kjson.map(c => Number(c[4]));
    const ma20 = sma(closes, 20) || closes.at(-1);
    const price = closes.at(-1);
    const rsiNow = computeRSI(closes.slice(-30)) || 50;
    let exitReason = null;

    if(data.type === 'GOLDEN'){
      if(price < ma20 * 0.998) exitReason = 'Giá cắt xuống MA20';
    } else if(data.type === 'SPOT' || data.type === 'PRE'){
      const rsiPrev = computeRSI(closes.slice(-31,-1)) || 50;
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
      logv(`[EXIT] ${sym} type=${data.type} reason=${exitReason} now=${price}`);
      clearSpotEntry(sym);
    }
  }catch(e){
    logv(`[EXIT_CHECK] ${sym} err ${e.message}`);
  }
}

//
// ----------------- MAIN SCAN LOOP -----------------
let scanning = false;
async function scanOnce(){
  if(scanning) return;
  scanning = true;
  try{
    // 1) try pre-breakout module first (early signals)
    let preList = [];
    try{
      if(typeof scanPreBreakout === 'function'){
        const res = await scanPreBreakout();
        if(Array.isArray(res)) preList = res;
      }
    }catch(e){ logv('[PREBREAKOUT] module error '+(e.message||e)); }

    if(preList && preList.length){
      logv(`[SCAN] prebreakout found ${preList.length}`);
      for(const coin of preList){
        try{
          const sym = coin.symbol;
          const conf = coin.Conf || coin.conf || estimateConfidence({ sym, chosen: coin.type||'PRE', rsi: coin.RSI_H1 || 50, volNow: coin.VolNow || 0, volAvg: 1, change24: coin.change24 || 0, price: coin.price || 0, ma20: coin.MA20 || 0 });
          const tag = coin.type === 'IMF' ? '[FLOW]' : coin.type === 'GOLDEN' ? '[GOLDEN]' : '[PRE]';
          // dedupe guard
          if(canSendAlert(sym, coin.type)) {
            await sendTelegram(`<b>${tag} ${sym}</b>\nConf: ${conf}%\nNote: Pre-breakout signal`);
            markSpotEntry(sym, coin.type, { price: coin.price, ma20: coin.MA20, vol: coin.VolNow, conf });
            await LEARN.recordSignal({ symbol: sym, type: coin.type, time: new Date().toISOString(), price: coin.price, rsi: coin.RSI_H1 });
          }
        }catch(e){ logv('[SCAN] pre push fail '+(e.message||e)); }
      }
    }

    // 2) load target symbols and analyze (spot rules) - full USDT scan (filtered)
    await loadSymbols();
    if(SYMBOLS.length === 0){
      SYMBOLS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT'];
    }

    logv(`[SCAN] start scanning ${SYMBOLS.length} symbols`);
    for(const sym of SYMBOLS){
      try{
        await analyzeSymbol(sym);
      }catch(e){ logv(`[SCAN] analyze ${sym} error ${e.message}`); }
      await new Promise(r=>setTimeout(r, 200)); // small delay
    }

    // 3) check exits
    if(activeSpots.size > 0){
      logv(`[EXIT_SCAN] checking ${activeSpots.size} actives`);
      for(const [sym, data] of activeSpots.entries()){
        await detectExitForActive(sym, data);
        await new Promise(r=>setTimeout(r, 200));
      }
    }

    logv('[SCAN] cycle complete');
  }catch(e){
    logv('[SCAN] fatal error ' + (e.message||e));
  }finally{
    scanning = false;
  }
}

//
// ----------------- AUTO-LEARNING SCHEDULER -----------------
setInterval(async ()=>{
  try{
    const n = await LEARN.checkOutcomesForPending();
    if(n>0) logv(`[LEARN] checked ${n} signals`);
    const adjust = await LEARN.computeAdjustments();
    if(adjust && adjust.adjust) logv('[LEARN] adjustments suggested: ' + JSON.stringify(adjust));
  }catch(e){ logv('[LEARN] scheduler err '+(e.message||e)); }
}, Number(process.env.LEARNING_POLL_MINUTES || 30) * 60 * 1000);

//
// ----------------- STARTUP / SCHEDULER -----------------
loadActiveFile();
(async ()=>{ logv("[SPOT MASTER AI v3.9] starting"); if(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) await sendTelegram(`<b>[SPOT MASTER AI v3.9]</b>\nStarted. Adaptive scan active.`); })();

scanOnce().catch(e=>logv('[MAIN] immediate err '+(e.message||e)));
setInterval(scanOnce, SCAN_INTERVAL_MS);

//
// ----------------- Minimal HTTP health server (optional) -----------------
import express from "express";
const app = express();
app.get('/', (req,res)=> res.send('Spot Master AI OK'));
app.get('/status', (req,res)=> res.json({ started: true, ts: new Date(), activeEntries: Array.from(activeSpots.keys()).slice(0,20) }));
app.listen(PORT, ()=> logv(`HTTP health listening on ${PORT}`));

//
// ----------------- export for tests -----------------
export default { scanOnce, analyzeSymbol, getKlinesCached, computeSLTP, computeEntryZoneFromMA };
