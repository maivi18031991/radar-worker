// server_full_no_trim_v1.mjs
// SPOT MASTER AI — Full (no-simplify) build
// Integrates: PRE-BREAKOUT, ROTATION FLOW, EARLY PUMP, SPOT tiers (PRE/SPOT/GOLDEN/IMF),
// Learning engine, Backtester hooks, AI Priority Filter, Multi-endpoint failover.
// Author: consolidated for user
// NOTE: paste whole file replacing previous server file.

import fetchNode from "node-fetch";
import fs from "fs";
import path from "path";
const fetch = (global.fetch || fetchNode);

// ========== CONFIG / ENV ==========
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT || "";
const PRIMARY_URL = process.env.PRIMARY_URL || "";
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_SEC || 60) * 1000;
const KEEP_ALIVE_MIN = Number(process.env.KEEP_ALIVE_INTERVAL || 10); // minutes
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// Multi-endpoint failover list (try these in order, rotate on 403/429/5xx)
// --- Auto-rotate API mirror (includes .me global domain to bypass 451) ---
const BINANCE_APIS = [
  process.env.BINANCE_API || "https://api.binance.me",   // ✅ main global mirror (Asia)
  "https://api1.binance.me",
  "https://api2.binance.me",
  "https://api3.binance.me",
  "https://api-gcp.binance.com",                         // fallback (may be blocked in some regions)
  "https://api3.binance.com",
  "https://data-api.binance.me"
];
let apiIndex = 0;
function currentAPI() { return BINANCE_APIS[apiIndex % BINANCE_APIS.length]; }
function rotateAPI() { apiIndex = (apiIndex + 1) % BINANCE_APIS.length; logv(`[API] rotate -> ${currentAPI()}`); }

// ========== UTIL / LOGGER ==========
function logv(msg) {
  const s = `[${new Date().toLocaleString("vi-VN")}] ${msg}`;
  console.log(s);
  try { fs.appendFileSync(path.join(DATA_DIR,"server_log.txt"), s + "\n"); } catch(e){}
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

// ========== SAFE FETCH with failover ==========
async function safeFetchURL(pathAndQuery, opts={}, retries=3, label="BINANCE") {
  for(let i=0;i<retries;i++){
    const base = currentAPI();
    const url = base + pathAndQuery;
    try {
      const r = await fetch(url, opts);
      if(!r.ok) {
  logv(`[${label}] ${r.status} ${url}`);
  // Auto switch for blocked or throttled endpoints
  if([403,429,451,500,502,503].includes(r.status)) {
    logv(`[API] Detected blocked (${r.status}) → rotating endpoint...`);
    rotateAPI();
  }
        await sleep(300 * (i+1));
        continue;
      }
      const contentType = r.headers.get('content-type') || '';
      if(contentType.includes('application/json')) {
        return await r.json();
      } else {
        return await r.text();
      }
    } catch (e) {
      logv(`[${label}] network error ${e.message} url=${url}`);
      rotateAPI();
      await sleep(300 * (i+1));
    }
  }
  throw new Error(`${label} fetch failed for ${pathAndQuery}`);
}

// ========== TELEGRAM SENDER ==========
async function sendTelegram(text) {
  if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    logv("[TELEGRAM] missing TOKEN/CHAT_ID");
    return false;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  try {
    const r = await fetch(url, { method: "POST", headers: {'content-type':'application/json'}, body: JSON.stringify(payload) });
    if(!r.ok) {
      logv(`[TELEGRAM] send failed ${r.status}`);
      return false;
    }
    return true;
  } catch (e) {
    logv("[TELEGRAM] send error " + e.message);
    return false;
  }
}

// ========== PERSISTENCE: active entries, learning storage ==========
const ACTIVE_FILE = path.join(DATA_DIR,"active_entries.json");
const LEARN_FILE = path.join(DATA_DIR,"learning.json");
const DYNAMIC_CONFIG = path.join(DATA_DIR,"dynamic_config.json");

let activeEntries = new Map();
function loadActiveEntries(){
  try {
    if(fs.existsSync(ACTIVE_FILE)){
      const raw = fs.readFileSync(ACTIVE_FILE,'utf8');
      const obj = JSON.parse(raw||'{}');
      for(const k of Object.keys(obj)) activeEntries.set(k, obj[k]);
      logv(`[ENTRY] loaded ${activeEntries.size} active entries`);
    }
  } catch(e){ logv('[ENTRY] load error '+e.message); }
}
function saveActiveEntries(){
  try{ fs.writeFileSync(ACTIVE_FILE, JSON.stringify(Object.fromEntries(activeEntries), null, 2)); }catch(e){ logv('[ENTRY] save error '+e.message); }
}
async function recordActive(symbol, data){
  activeEntries.set(symbol, data);
  saveActiveEntries();
  logv(`[ENTRY] mark ${symbol}`);
}
async function clearActive(symbol){
  if(activeEntries.has(symbol)){ activeEntries.delete(symbol); saveActiveEntries(); logv(`[ENTRY] clear ${symbol}`); }
}

// ========== LEARNING ENGINE (inlined from learning_engine.js) ==========
const LEARN = (function(){
  const DATA_FILE = LEARN_FILE;
  const CONFIG_FILE = DYNAMIC_CONFIG;
  const CHECK_HOURS = Number(process.env.LEARNING_CHECK_HOURS || 24);
  const MIN_SIGNALS_TO_TUNE = Number(process.env.MIN_SIGNALS_TO_TUNE || 20);
  const AUTO_SAVE_INTERVAL_H = Number(process.env.AUTO_SAVE_INTERVAL_H || 6);

  async function loadData(){
    try { const t = await fs.promises.readFile(DATA_FILE,'utf8'); return JSON.parse(t); } catch(e){ return { signals: {}, stats: {} }; }
  }
  async function saveData(d){ try{ await fs.promises.mkdir(path.dirname(DATA_FILE), { recursive:true }); await fs.promises.writeFile(DATA_FILE, JSON.stringify(d,null,2),'utf8'); }catch(e){ logv('[LEARN] save error '+e.message); } }

  async function recordSignal(item){
    const data = await loadData();
    data.signals[item.symbol] = data.signals[item.symbol] || [];
    data.signals[item.symbol].push({ id: Date.now() + "-" + Math.random().toString(36).slice(2,7), ...item, checked:false, result:null });
    await saveData(data);
  }

  async function checkOutcome(s){
    // check candles after s.time up to LOOK_HOURS
    try {
      const LOOK_HOURS = Number(process.env.LEARNING_LOOK_HOURS || 24);
      const TP_PCT = Number(s.tpPct || 0.06);
      const SL_PCT = Number(s.slPct || 0.02);
      const apiBasePath = `/api/v3/klines?symbol=${s.symbol}&interval=1h&limit=${LOOK_HOURS+1}`;
      const candles = await safeFetchURL(apiBasePath, {}, 2, "LEARN-KLINES");
      if(!Array.isArray(candles) || candles.length===0) return "NO";
      const entry = Number(s.price);
      let tp=false, sl=false;
      for(const c of candles){
        const high = Number(c[2]), low = Number(c[3]);
        if(high >= entry*(1+TP_PCT)) tp = true;
        if(low <= entry*(1-SL_PCT)) sl = true;
        if(tp||sl) break;
      }
      if(tp && !sl) return "TP";
      if(sl && !tp) return "SL";
      return "NO";
    } catch(e) {
      logv("[LEARN] checkOutcome err "+e.message);
      return "NO";
    }
  }

  async function checkOutcomesForPending(){
    const data = await loadData();
    const now = Date.now();
    const toCheck = [];
    for(const sym of Object.keys(data.signals||{})){
      for(const s of data.signals[sym]){
        if(!s.checked && (now - new Date(s.time).getTime() >= Number(process.env.LEARNING_CHECK_HOURS || 24)*3600*1000)){
          toCheck.push(s);
        }
      }
    }
    let checked = 0;
    for(const s of toCheck){
      try {
        const res = await checkOutcome(s);
        s.checked = true; s.result = res;
        updateStats(data, s);
        checked++;
      } catch(e){ logv('[LEARN] checkOutcomes error '+e.message); }
    }
    if(checked) await saveData(data);
    return checked;
  }

  function updateStats(data, s){
    data.stats = data.stats || { overall:{total:0,wins:0}, byType:{}, bySymbol:{} };
    const st = data.stats;
    st.overall.total++;
    if(s.result === "TP") st.overall.wins++;
    const t = s.type || 'UNKNOWN';
    st.byType[t] = st.byType[t] || { total:0, wins:0 };
    st.byType[t].total++;
    if(s.result === "TP") st.byType[t].wins++;
    st.bySymbol[s.symbol] = st.bySymbol[s.symbol] || { total:0, wins:0 };
    st.bySymbol[s.symbol].total++;
    if(s.result === "TP") st.bySymbol[s.symbol].wins++;
  }

  async function computeAdjustments(){
    const data = await loadData();
    const byType = data.stats?.byType || {};
    const result = { adjust:false, reasons:[], changes:{} };
    for(const [type, rec] of Object.entries(byType)){
      if(rec.total < MIN_SIGNALS_TO_TUNE) continue;
      const wr = rec.wins / rec.total;
      if(wr < 0.45){
        result.adjust = true; result.reasons.push(`${type} WR ${Math.round(wr*100)}% → tighten`);
        result.changes[type] = { rsiMinDelta: +3, volMinPctDelta: +10 };
      } else if (wr > 0.75){
        result.adjust = true; result.reasons.push(`${type} WR ${Math.round(wr*100)}% → relax`);
        result.changes[type] = { rsiMinDelta: -2, volMinPctDelta: -5 };
      }
    }
    if(result.adjust) await applyAdjustments(result.changes);
    return result;
  }

  async function applyAdjustments(changes){
    try {
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')); } catch(e){}
      for(const [k,v] of Object.entries(changes)){ cfg[k] = { ...(cfg[k]||{}), ...v }; }
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg,null,2));
      logv("[LEARN] dynamic config updated");
      return cfg;
    } catch(e){ logv("[LEARN] applyAdjustments err "+e.message); }
  }

  // periodic check
  setInterval(async ()=>{
    try {
      const checked = await checkOutcomesForPending();
      if(checked>0){
        const adj = await computeAdjustments();
        logv(`[LEARN] quick check done ${checked} | adjust=${adj.adjust}`);
      }
    } catch(e){ logv("[LEARN] periodic err "+e.message); }
  }, Number(process.env.LEARN_PERIOD_MIN || 60)*60*1000);

  return { recordSignal, checkOutcomesForPending, computeAdjustments, loadData: loadData, quickLearn48h: async ()=>{ logv("[LEARN] quickLearn called"); } };
})();

// ========== INDICATORS / HELPERS ==========
function sma(arr, n=20){ if(!arr || arr.length===0) return NaN; const slice = arr.slice(-n); return slice.reduce((s,v)=>s+Number(v),0)/slice.length; }
function stddev(arr, n=20){ const slice = arr.slice(-n); const m = sma(slice, slice.length); const v = slice.reduce((s,x)=>s + (x-m)**2,0)/slice.length; return Math.sqrt(v); }
function bollingerWidth(closeArr, period=14, mult=2){ const mb = sma(closeArr, period); const sd = stddev(closeArr, period); const up = mb + mult*sd; const dn = mb - mult*sd; const width = (up - dn) / (mb || 1); return { mb, up, dn, width }; }
function rsiFromArray(closes, period=14){ if(!closes || closes.length < period+1) return NaN; let gains=0, losses=0; for(let i=closes.length-period;i<closes.length;i++){ const d = closes[i] - closes[i-1]; if(d>0) gains+=d; else losses+=Math.abs(d); } const avgGain = gains/period; const avgLoss = losses/period; if(avgLoss === 0) return 100; const rs = avgGain/avgLoss; return 100 - (100/(1+rs)); }
function fmt(n, d=8){ return (typeof n === 'number') ? Number(n.toFixed(d)) : n; }

// ========== PRE-BREAKOUT (rotation_prebreakout inlined) ==========
const PRE_CONFIG = {
  MIN_VOL24H: Number(process.env.MIN_VOL24H || 5_000_000),
  MAX_TICKERS: Number(process.env.MAX_TICKERS || 120),
  CONF_THRESHOLD_SEND: Number(process.env.PRE_CONF_SEND || 70),
  HYPER_SPIKE_THRESHOLD: Number(process.env.HYPER_SPIKE_THRESHOLD || 85),
  KLINES_LIMIT: Number(process.env.KLINES_LIMIT || 200)
};
const HYPER_FILE = path.join(DATA_DIR, "hyper_spikes.json");
async function ensureDataDir(){ try{ await fs.promises.mkdir(DATA_DIR, { recursive:true }); }catch(e){} }
async function readHyperSpikes(){ try{ const t = await fs.promises.readFile(HYPER_FILE,'utf8'); return JSON.parse(t||'[]'); }catch(e){ return []; } }
async function writeHyperSpikes(arr){ await ensureDataDir(); await fs.promises.writeFile(HYPER_FILE, JSON.stringify(arr,null,2),'utf8'); }

async function get24hTickerAll(){
  const path = `/api/v3/ticker/24hr`;
  return await safeFetchURL(path, {}, 2, "24H-TICKER");
}
async function getKlines(symbol, interval="1h", limit=PRE_CONFIG.KLINES_LIMIT){
  const path = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  return await safeFetchURL(path, {}, 2, "KLINES");
}

function isCompressedDetect({ price, mb, up, dn, bbWidth, MA20 }){
  if(bbWidth > 0.08) return false;
  const nearMA20 = Math.abs(price - MA20) / (MA20 || 1) < 0.03;
  const nearMiddle = Math.abs(price - mb) / (mb || 1) < 0.06;
  const notNearUpper = price < (mb + (up - mb) * 0.7);
  return (nearMA20 || nearMiddle) && notNearUpper;
}

async function scanRotationFlowCore(){
  try{
    const all = await get24hTickerAll();
    const usdt = all.filter(t=> t.symbol && t.symbol.endsWith("USDT"))
      .map(t=> ({ symbol: t.symbol, vol24: Number(t.quoteVolume || t.volume || 0), baseVol: Number(t.volume || 0), priceChangePercent: Number(t.priceChangePercent || 0) }))
      .filter(t=> t.vol24 >= PRE_CONFIG.MIN_VOL24H)
      .sort((a,b)=> b.vol24 - a.vol24)
      .slice(0, PRE_CONFIG.MAX_TICKERS);

    if(!usdt.length) { logv("[PRE] no tickers pass volume"); return []; }

    const results = [];
    const hyper = await readHyperSpikes();

    // BTC RSI for bias
    let BTC_RSI = 50;
    try{
      const btc4 = await getKlines("BTCUSDT","4h",100);
      BTC_RSI = rsiFromArray(btc4.map(k=>Number(k[4])), 14) || BTC_RSI;
    } catch(e){}

    for(const t of usdt){
      try{
        const kl4 = await getKlines(t.symbol, "4h", 100).catch(()=>[]);
        const kl1 = await getKlines(t.symbol, "1h", 100).catch(()=>[]);
        if(!kl4.length || !kl1.length) continue;

        const closes4 = kl4.map(k=>Number(k[4]));
        const closes1 = kl1.map(k=>Number(k[4]));
        const vols1 = kl1.map(k=>Number(k[5]));

        const RSI_H4 = Number((rsiFromArray(closes4,14)||0).toFixed(1));
        const RSI_H1 = Number((rsiFromArray(closes1,14)||0).toFixed(1));
        const bb = bollingerWidth(closes4,14,2);
        const BBWidth_H4 = Number((bb.width||0).toFixed(4));
        const MA20 = Number((sma(closes4,20)||0).toFixed(6));
        const VolNow = Number(vols1[vols1.length-1]||0);
        const avg24base = Math.max(1, (t.baseVol||1)/24);
        const VolNowRatio = Number((VolNow / avg24base).toFixed(2));
        const price = closes1[closes1.length-1];

        // conf formula (as doc)
        let Conf=0;
        if(RSI_H4>45 && RSI_H4<60) Conf += 0.25;
        if(RSI_H1>50 && RSI_H1<70) Conf += 0.20;
        if(VolNowRatio>1.8 && VolNowRatio<3.5) Conf += 0.20;
        if(BBWidth_H4 < 0.6 * 1.0) Conf += 0.15;
        if(BTC_RSI >35 && BTC_RSI<65) Conf += 0.15;
        if(RSI_H1>75 || VolNowRatio>4.5) Conf -= 0.15;
        Conf = Math.min(Math.max(Conf,0),1)*100;
        Conf = Math.round(Conf);

        const compressed = isCompressedDetect({ price, mb: bb.mb, up: bb.up, dn: bb.dn, bbWidth: BBWidth_H4, MA20 });

        const res = {
          symbol: t.symbol,
          price, RSI_H4, RSI_H1, BBWidth_H4, VolNowRatio,
          MA20, Conf, compressed, priceChangePercent: t.priceChangePercent
        };

        if(Conf >= PRE_CONFIG.CONF_THRESHOLD_SEND && compressed) {
          // send alert (server will handle push)
          logv(`[PRE] candidate ${t.symbol} Conf=${Conf}`);
        }
        if(Conf >= PRE_CONFIG.HYPER_SPIKE_THRESHOLD && compressed){
          hyper.push({...res, ts: Date.now()});
        }
        results.push(res);
      } catch(e){
        logv(`[PRE] error ${t.symbol} ${e.message}`);
      }
    }

    if(hyper.length) await writeHyperSpikes(hyper.slice(-500));
    results.sort((a,b)=> b.Conf - a.Conf);
    logv(`[PRE] scanned ${results.length} symbols, top: ${results[0]?.symbol || 'none'} ${results[0]?.Conf || 0}%`);
    return results;
  } catch(e){
    logv('[PRE] main error '+e.message);
    return [];
  }
}
async function scanPreBreakout(){
  const data = await scanRotationFlowCore();
  if(!Array.isArray(data)) return [];
  // keep any with Conf >= 60
  const valid = data.filter(x => x.symbol && x.Conf >= 60);
  logv(`[PRE] returning ${valid.length} valid signals`);
  return valid;
}

// ========== EARLY PUMP DETECTOR (inlined simplified) ==========
async function scanEarlyPump(){
  try{
    // Scans 24h tickers, picks those with high volatility but not yet exploded (early)
    const all = await get24hTickerAll();
    const candidates = all.filter(t=> t.symbol && t.symbol.endsWith("USDT"))
      .map(t=> ({ symbol: t.symbol, change: Number(t.priceChangePercent||0), vol: Number(t.quoteVolume||0) }))
      .filter(t=> t.vol > (Number(process.env.EARLY_MIN_VOL || 1_000_000)))
      .sort((a,b)=> b.change - a.change)
      .slice(0, 200);

    const results = [];
    for(const c of candidates){
      try{
        // quick fetch 1h klines
        const kl1 = await getKlines(c.symbol, "1h", 24);
        const closes1 = kl1.map(k=>Number(k[4]));
        const rsi1 = rsiFromArray(closes1,14) || 50;
        // early criteria: moderate daily increase but RSI not too high, vol spike ratio moderate
        if(c.change >= 5 && c.change <= 40 && rsi1 >= 45 && rsi1 <= 70){
          const volNow = Number(kl1.at(-1)?.[5] || 0);
          const avgVol1h = (kl1.reduce((s,k)=>s+Number(k[5]),0)/kl1.length) || 1;
          const volRatio = volNow / Math.max(1, avgVol1h);
          const conf = Math.min(95, Math.round(30 + Math.min(60, c.change) + Math.min(40, volRatio*10)));
          results.push({ symbol: c.symbol, change24: c.change, vol: c.vol, rsi1: rsi1, volRatio, conf, note: "EARLY_PUMP" });
        }
      } catch(e){ /* ignore per symbol */ }
    }
    results.sort((a,b)=> b.conf - a.conf);
    logv(`[EARLY] found ${results.length} early pumps`);
    return results;
  } catch(e){
    logv("[EARLY] err " + e.message);
    return [];
  }
}

// ========== ROTATION FLOW (simpler wrapper calling scanRotationFlowCore) ==========
async function rotationFlowScan(){
  // reuse scanRotationFlowCore as rotation flow detection
  const res = await scanRotationFlowCore();
  // Optionally push top X to telegram as rotation flow signals
  // but server main will decide
  return res;
}

// ========== AI PRIORITY FILTER ==========
async function aiPriorityFilter(preList, earlyList){
  try{
    const map = new Map();
    for(const p of preList){
      const s = map.get(p.symbol) || { symbol: p.symbol, score:0, sources: new Set() };
      s.score += p.Conf || 60; s.sources.add('PRE'); map.set(p.symbol, s);
    }
    for(const e of earlyList){
      const s = map.get(e.symbol) || { symbol: e.symbol, score:0, sources: new Set() };
      s.score += e.conf || 60; s.sources.add('EARLY'); map.set(e.symbol, s);
    }
    const arr = Array.from(map.values()).map(x=>{
      const synergy = (x.sources.size>1) ? 1.15 : 1.0;
      return { symbol: x.symbol, finalConf: Math.round(Math.min(x.score * synergy, 200)), sources: Array.from(x.sources) };
    }).sort((a,b)=> b.finalConf - a.finalConf);
    return arr;
  } catch(e){ logv('[AI] err '+e.message); return []; }
}

// ========== PUSH SIGNAL builder ==========
async function pushSignal(tag, data, conf=70){
  try {
    if(!data || !data.symbol) return;
    const sym = data.symbol;
    const chg = data.priceChangePercent || data.change24 || data.change24h || 0;
    const vol = Number(data.quoteVolume || data.vol || 0);
    const rsi = data.RSI_H1 || data.rsi1 || data.RSI_H4 || 0;
    const msg = [
      `<b>${tag}</b> ${sym}`,
      `Conf: ${conf}%`,
      `24h: ${chg}% | Vol: ${Math.round(vol)}`,
      `RSI: ${rsi}`,
      `Note: ${data.note || data.type || ''}`,
      `Time: ${new Date().toLocaleString('vi-VN')}`
    ].join('\n');
    await sendTelegram(msg);
    logv(`[PUSH] ${tag} ${sym} conf=${conf}`);
  } catch(e) { logv('[PUSH] err '+e.message); }
}

// ========== EXIT TRACKER: check TP/SL for active entries ==========
async function checkActiveExits(){
  try{
    if(activeEntries.size === 0) return;
    logv(`[EXIT] checking ${activeEntries.size} active entries`);
    for(const [sym, data] of Array.from(activeEntries.entries())){
      try{
        // fetch recent candles 1h (limit 24)
        const path = `/api/v3/klines?symbol=${sym}&interval=1h&limit=24`;
        const kl = await safeFetchURL(path, {}, 2, "EXIT-KLINES");
        if(!Array.isArray(kl) || !kl.length) continue;
        const lastClose = Number(kl.at(-1)[4]);
        const sl = Number(data.sl), tp = Number(data.tp), entry = Number(data.entry);
        let exitReason = null;
        if(lastClose <= sl) exitReason = 'SL hit';
        if(lastClose >= tp) exitReason = 'TP hit';
        // additional: MA20 cross check
        const closes = kl.map(k=>Number(k[4]));
        const ma20 = sma(closes, 20);
        if(data.side === 'LONG' && lastClose < ma20 * 0.995) exitReason = exitReason || 'MA20 breach';
        if(exitReason){
          const msg = [
            `<b>[EXIT] ${sym}</b>`,
            `Reason: ${exitReason}`,
            `Entry: ${entry} | Now: ${lastClose}`,
            `SL: ${sl} | TP: ${tp}`,
            `Type: ${data.type || 'SPOT'}`,
            `Time: ${new Date().toLocaleString('vi-VN')}`
          ].join('\n');
          await sendTelegram(msg);
          logv(`[EXIT] ${sym} reason=${exitReason}`);
          await clearActive(sym);
        }
      } catch(e){ logv(`[EXIT] ${sym} err ${e.message}`); }
    }
  } catch(e){ logv('[EXIT] fatal '+e.message); }
}

// ========== BACKTESTER hook (placeholder) ==========
async function backtestSignal(signal){
  // optional: call local backtester.js if present
  try{
    const btPath = path.join(process.cwd(), 'backtester.js');
    if(fs.existsSync(btPath)){
      // naive require
      const mod = require(btPath);
      if(typeof mod.backtest === 'function') {
        return await mod.backtest(signal);
      }
    }
  } catch(e){ logv('[BACKTEST] err '+e.message); }
  return null;
}

// ========== MAIN LOOP ==========
loadActiveEntries();

async function mainCycle(){
  logv('[MAIN] cycle start');

  try{
    // 1) Pre-breakout scan
    const preList = await scanPreBreakout();
    if(preList && preList.length){
      for(const p of preList){
        const conf = (p.Conf || p.conf || 75);
        await pushSignal('[PRE-BREAKOUT]', p, conf);
        await LEARN.recordSignal({ symbol: p.symbol, type: 'PRE', time: new Date().toISOString(), price: p.price, tpPct: 0.06, slPct: 0.02 });
      }
    }

    // 2) rotation flow (spot)
    const rot = await rotationFlowScan(); // rot is array
    // optionally push tops (we push top few)
    if(rot && rot.length){
      for(let i=0;i<Math.min(3, rot.length); i++){
        const r = rot[i];
        await pushSignal('[ROTATION]', r, r.Conf || r.Conf);
        // record to learning
        await LEARN.recordSignal({ symbol: r.symbol, type: 'ROTATION', time: new Date().toISOString(), price: r.price, tpPct: 0.06, slPct: 0.02 });
      }
    }

    // 3) early pump scan
    const early = await scanEarlyPump();
    if(early && early.length){
      for(const e of early.slice(0,5)){
        await pushSignal('[EARLY]', e, e.conf || 70);
        await LEARN.recordSignal({ symbol: e.symbol, type: 'EARLY', time: new Date().toISOString(), price: e.price || 0, tpPct: 0.06, slPct: 0.02 });
      }
    }

    // 4) AI Priority filter - combine lists
    try {
      const merged = await aiPriorityFilter(preList || [], early || []);
      if(merged && merged.length){
        for(const m of merged.slice(0,3)){
          if(m.finalConf >= 120){
            await sendTelegram(`<b>[AI PRIORITY]</b> ${m.symbol}\nAI Conf: ${m.finalConf}%\nSources: ${m.sources.join(', ')}\nTime: ${new Date().toLocaleString('vi-VN')}`);
            logv(`[AI] push ${m.symbol} conf=${m.finalConf}`);
          }
        }
      }
    } catch(e){ logv('[AI] err '+e.message); }

    // 5) check active exits
    await checkActiveExits();

    // 6) Learning check outcomes periodically done in LEARN interval

  } catch(e){
    logv('[MAIN] fatal error ' + e.message);
  }

  logv('[MAIN] cycle complete');
}

// startup immediate + schedule
(async ()=>{
  logv('[SERVER] Spot Master AI full server starting');
  if(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) await sendTelegram('<b>[Spot Master AI]</b>\nServer started (full).');
  // initial run
  try{ await mainCycle(); } catch(e){ logv('[MAIN] initial err '+e.message); }
  setInterval(()=>{ mainCycle().catch(e=>logv('[MAIN] loop err '+e.message)); }, SCAN_INTERVAL_MS);
  // keep-alive ping
  if(PRIMARY_URL){
    setInterval(()=>{ fetch(PRIMARY_URL).catch(()=>{}); logv('[KEEPALIVE] ping'); }, KEEP_ALIVE_MIN*60*1000);
  }
})();
