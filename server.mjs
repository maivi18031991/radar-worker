// server.mjs
// Spot Smart Radar - Full USDT scan, PRE / SPOT / GOLDEN / IMF, detailed logs, 1m scan
// Copy-paste thay file hiện tại. Requires node >= 16, run: node --experimental-modules server_spot_full.mjs (if needed)

// ---- Imports & config ----
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT || "";
const API_BASE_SPOT = process.env.API_BASE_SPOT || "https://api.binance.com";
const PRIMARY_URL = process.env.PRIMARY_URL || "";
const KEEP_ALIVE_INTERVAL = Number(process.env.KEEP_ALIVE_INTERVAL || 10); // minutes
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_SEC || 60) * 1000; // default 60s
const SYMBOL_REFRESH_H = 6;
const SYMBOL_MIN_VOL = Number(process.env.SYMBOL_MIN_VOL || 10000000); // 10M default
const SYMBOL_MIN_CHANGE = Number(process.env.SYMBOL_MIN_CHANGE || 5); // 3% default
const ACTIVE_FILE = path.resolve("./active_spots.json");
const ACTIVE_FILE = path.resolve("./active_symbols.json");

// ===== Anti-duplicate alert memory =====
const ALERT_MEMORY = new Map(); // key: symbol-level -> timestamp
const ALERT_COOLDOWN_MIN = 15; // phút, đổi tuỳ ý (10 / 15 / 30)

function canSendAlert(symbol, level = "SPOT") {
  const key = `${level}:${symbol}`;
  const now = Date.now();
  const lastTime = ALERT_MEMORY.get(key) || 0;
  const diffMin = (now - lastTime) / 60000;
  if (diffMin >= ALERT_COOLDOWN_MIN) {
    ALERT_MEMORY.set(key, now);
    return true;
  }
  return false;
}

// logger (dạng cũ, chi tiết)
function logv(msg) {
  const s = `[${new Date().toLocaleString("vi-VN")}] ${msg}`;
  console.log(s);
  ...
}
// logger (dạng cũ, chi tiết)
function logv(msg) {
  const s = `[${new Date().toLocaleString('vi-VN')}] ${msg}`;
  console.log(s);
  // optional: append to local log file
  try {
    fs.appendFileSync(path.resolve('./spot_logs.txt'), s + "\n");
  } catch(e){}
}

// ---- Telegram sender (unified bot for Spot) ----
async function sendTelegram(text) {
  if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    logv('[TELEGRAM] missing TOKEN/CHAT_ID');
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if(!res.ok) logv(`[TELEGRAM] send failed ${res.status}`);
  } catch (e) {
    logv('[TELEGRAM] error ' + e.message);
  }
}

// ---- Safe fetch JSON ----
async function safeFetchJSON(url, retries = 2) {
  for(let i=0;i<retries;i++){
    try{
      const r = await fetch(url);
      if(!r.ok) {
        logv(`[HTTP] ${r.status} ${url}`);
        await new Promise(r=>setTimeout(r, 200*(i+1)));
        continue;
      }
      const j = await r.json();
      return j;
    }catch(e){
      logv('[HTTP] fetch error ' + e.message + ' url=' + url);
      await new Promise(r=>setTimeout(r, 200*(i+1)));
    }
  }
  return null;
}

// ---- Indicators helpers ----
function sma(arr, n = 20) {
  if(!arr || arr.length < 1) return null;
  const slice = arr.slice(-n);
  const sum = slice.reduce((s,x)=>s + Number(x), 0);
  return sum / slice.length;
}
function computeRSI(closes, period = 14) {
  if(!closes || closes.length <= period) return null;
  let gains = 0, losses = 0;
  for(let i=1;i<=period;i++){
    const d = closes[i] - closes[i-1];
    if(d>0) gains += d; else losses -= d;
  }
  let avgGain = gains/period;
  let avgLoss = losses/period || 1;
  for(let i=period+1;i<closes.length;i++){
    const d = closes[i] - closes[i-1];
    avgGain = (avgGain*(period-1) + Math.max(0,d))/period;
    avgLoss = (avgLoss*(period-1) + Math.max(0,-d))/period;
  }
  if(avgLoss === 0) return 100;
  const rs = avgGain/avgLoss;
  return 100 - (100/(1+rs));
}
function fmt(n){ return typeof n === 'number' ? Number(n.toFixed(8)) : n; }

// ---- Auto-load USDT symbols (filtered) ----
let SYMBOLS = [];
let lastSymbolsTs = 0;
async function loadSymbols({minVol=SYMBOL_MIN_VOL, minChange=SYMBOL_MIN_CHANGE} = {}) {
  try{
    const now = Date.now()/1000;
    if(lastSymbolsTs + SYMBOL_REFRESH_H*3600 > now && SYMBOLS.length) {
      return SYMBOLS;
    }
    const url = `${API_BASE_SPOT}/api/v3/ticker/24hr`;
    const data = await safeFetchJSON(url, 2);
    if(!Array.isArray(data)) return SYMBOLS;
    const syms = data
      .filter(s=> s.symbol && s.symbol.endsWith('USDT'))
      .filter(s=> !/UPUSDT|DOWNUSDT|BULLUSDT|BEARUSDT|_/.test(s.symbol)) // exclude weird
      .map(s=> ({ symbol: s.symbol, vol: Number(s.quoteVolume||0), change: Number(s.priceChangePercent||0) }))
      .filter(s => s.vol >= minVol && s.change >= minChange)
      .sort((a,b)=> b.vol - a.vol)
      .map(s => s.symbol);
    SYMBOLS = syms;
    lastSymbolsTs = now;
    logv(`[SYMBOLS] loaded ${SYMBOLS.length} USDT pairs (vol>=${minVol}, change>=${minChange}%)`);
    return SYMBOLS;
  }catch(e){
    logv('[SYMBOLS] load error ' + e.message);
    return SYMBOLS;
  }
}

// ---- Active entries tracking (RAM + JSON) ----
const activeSpots = new Map();
function loadActiveFile() {
  try{
    if(fs.existsSync(ACTIVE_FILE)) {
      const raw = fs.readFileSync(ACTIVE_FILE,'utf8');
      const obj = JSON.parse(raw || '{}');
      for(const [k,v] of Object.entries(obj)) activeSpots.set(k,v);
      logv(`[ENTRY_TRACK] loaded ${activeSpots.size} active entries from file`);
    }
  }catch(e){
    logv('[ENTRY_TRACK] load file error ' + e.message);
  }
}
function saveActiveFile() {
  try{
    const obj = Object.fromEntries(activeSpots);
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify(obj, null, 2));
  }catch(e){ logv('[ENTRY_TRACK] save error ' + e.message); }
}
async function markSpotEntry(symbol, type, meta={}) {
  activeSpots.set(symbol, { type, markedAt: Date.now(), meta });
  saveActiveFile();
  // old detailed log style:
  logv(`[MARK ENTRY] symbol=${symbol} type=${type} price=${meta.price} ma20=${meta.ma20} vol=${meta.vol} rsi=${meta.rsi} change24=${meta.change24}`);
}
function clearSpotEntry(symbol) {
  if(activeSpots.has(symbol)) {
    activeSpots.delete(symbol);
    saveActiveFile();
    logv(`[CLEAR ENTRY] symbol=${symbol}`);
  }
}

// ---- Compute Entry zone & SL/TP ----
function computeEntryZoneFromMA(ma20) {
  if(!ma20) return { entryLow:null, entryHigh:null };
  return { entryLow: fmt(ma20 * 0.995), entryHigh: fmt(ma20 * 1.02) };
}
function computeSLTP(entry, type) {
  // Use conservative defaults; can be tuned later/learning
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

// ---- Build Telegram message (dạng cũ chi tiết) ----
function buildEntryMsg({symbol, type, entry, entryLow, entryHigh, sl, tp, ma20, vol, change24, rsi, extra=''}){
  const lines = [];
  lines.push(`<b>[SPOT] ${type} | ${symbol}</b>`);
  if(entryLow && entryHigh) lines.push(`Vùng entry: ${entryLow} - ${entryHigh}`);
  else lines.push(`Giá hiện: ${entry}`);
  lines.push(`MA20: ${fmt(ma20)} | RSI: ${rsi?.toFixed(1) || 'NA'}`);
  lines.push(`Vol(24h): ${Number(vol).toFixed(0)} | 24h: ${change24}%`);
  lines.push(`SL: ${sl} (${( (1-sl/entry)*100 ).toFixed(2)}%) | TP: ${tp} (${( (tp/entry-1)*100 ).toFixed(2)}%)`);
  if(extra) lines.push(`Note: ${extra}`);
  lines.push(`Time: ${new Date().toLocaleString('vi-VN')}`);
  return lines.join('\n');
}

// ---- Analyze one symbol for entry ----
async function analyzeSymbol(sym) {
  try{
    const kUrl = `${API_BASE_SPOT}/api/v3/klines?symbol=${sym}&interval=1h&limit=60`;
    const tUrl = `${API_BASE_SPOT}/api/v3/ticker/24hr?symbol=${sym}`;
    const [kjson, tjson] = await Promise.all([safeFetchJSON(kUrl), safeFetchJSON(tUrl)]);
    if(!kjson || !tjson) return null;

    const closes = kjson.map(c => Number(c[4]));
    const ma20 = sma(closes, 20) || closes.at(-1);
    const price = Number(tjson.lastPrice || closes.at(-1));
    const change24 = Number(tjson.priceChangePercent || 0);
    const vol = Number(tjson.quoteVolume || 0);
    const rsi = computeRSI(closes.slice(-30)) || 50;

    // Rules (as discussed)
    // PRE: price within [ma20*0.995, ma20*1.02], moderate positive change, vol spike + taker bias (approximated)
    // SPOT (confirm): vol higher, rsi moderate, price > ma20
    // GOLDEN: strong breakout: price > ma20*1.03 and change24 >= 6 (as before)
    // IMF: special independent flow detection: huge vol spike + taker dominance (approx)
    const entryZone = computeEntryZoneFromMA(ma20);
    const nearEntry = price >= entryZone.entryLow && price <= entryZone.entryHigh;
    const isGolden = price > ma20 * 1.03 && change24 >= 6;
    const isSpotConfirm = (price > ma20 && vol > Math.max(1, sma(kjson.map(c=>c[5]), 20) * 1.8) && rsi >= 50 && rsi <= 60);
    const isPre = nearEntry && vol > Math.max(1, sma(kjson.map(c=>c[5]), 20) * 1.2) && rsi >= 45 && rsi <= 55;
    // IMF: identify if last hour vol >> average and price slightly above ma20
    const vols = kjson.map(c=> Number(c[5]));
    const volAvg = sma(vols, Math.min(vols.length, 20)) || 1;
    const volNow = vols.at(-1) || 0;
    const isIMF = volNow > Math.max(1, volAvg * 3) && price > ma20 * 0.995;

    // priority: IMF > GOLDEN > SPOT > PRE
    let chosen = null;
    if(isIMF) chosen = 'IMF';
    else if(isGolden) chosen = 'GOLDEN';
    else if(isSpotConfirm) chosen = 'SPOT';
    else if(isPre) chosen = 'PRE';

    if(!chosen) return null;

    const entry = price;
    const { sl, tp } = computeSLTP(entry, chosen);
    const msg = buildEntryMsg({symbol: sym, type: chosen, entry, entryLow: entryZone.entryLow, entryHigh: entryZone.entryHigh, sl, tp, ma20, vol, change24, rsi});
    // send (detailed)
    await sendTelegram(msg);
    // detailed old-style log
    logv(`[ALERT] Type=${chosen} Symbol=${sym} Price=${entry} MA20=${fmt(ma20)} RSI=${rsi?.toFixed(1)} Vol=${vol} 24h%=${change24} SL=${sl} TP=${tp}`);
    // mark active entry
    await markSpotEntry(sym, chosen, { price: entry, ma20: fmt(ma20), vol, change24, rsi });
    return { sym, chosen, entry };
  }catch(e){
    logv(`[ANALYZE] ${sym} error ${e.message}`);
    return null;
  }
}

// ---- Exit detection (track only active entries) ----
async function detectExitForActive(sym, data) {
  try{
    const kUrl = `${API_BASE_SPOT}/api/v3/klines?symbol=${sym}&interval=1h&limit=40`;
    const kjson = await safeFetchJSON(kUrl);
    if(!kjson) return;
    const closes = kjson.map(c=>Number(c[4]));
    const ma20 = sma(closes, 20) || closes.at(-1);
    const price = closes.at(-1);
    const rsiNow = computeRSI(closes.slice(-30)) || 50;
    let exitReason = null;
    if(data.type === 'GOLDEN') {
      if(price < ma20 * 0.998) exitReason = 'Giá cắt xuống MA20';
    } else if(data.type === 'SPOT' || data.type === 'PRE') {
      // PRE: rsi collapse; SPOT: rsi collapse or price drop under ma20
      const rsiPrev = computeRSI(closes.slice(-31,-1)) || 50;
      if(rsiPrev > 50 && rsiNow < 45) exitReason = 'RSI giảm mạnh';
      if(price < ma20 * 0.995) exitReason = 'Giá giảm xuyên MA20';
    } else if(data.type === 'IMF') {
      // IMF: aggressive, exit on any strong rejection
      if(price < ma20 * 0.995 || rsiNow < 45) exitReason = 'IMF rejection / RSI giảm';
    }

    if(exitReason) {
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

// ---- Main scan loop ----
let scanning = false;
async function scanOnce() {
  if(scanning) return;
  scanning = true;
  try{
    await loadSymbols(); // refresh if needed
    if(SYMBOLS.length === 0) {
      // fallback: a short list (if initial load failed)
      SYMBOLS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT'];
    }
    logv(`[SCAN] start scanning ${SYMBOLS.length} symbols`);
    // analyze each symbol for new entry (call all that match)
    for(const sym of SYMBOLS){
      try{
        await analyzeSymbol(sym);
      }catch(e){
        logv(`[SCAN] analyze ${sym} error ${e.message}`);
      }
      // small delay to avoid being rate-limited
      await new Promise(r=>setTimeout(r, 250));
    }
    // then check exits for active entries
    if(activeSpots.size>0) {
      logv(`[EXIT_SCAN] checking ${activeSpots.size} actives`);
      for(const [sym, data] of activeSpots.entries()){
        await detectExitForActive(sym, data);
        await new Promise(r=>setTimeout(r, 250));
      }
    }
    logv('[SCAN] cycle complete');
  }catch(e){
    logv('[SCAN] fatal error ' + e.message);
  }finally{
    scanning = false;
  }
}

// ---- Init load active file ----
loadActiveFile();

// ---- Scheduler ----
setInterval(scanOnce, SCAN_INTERVAL_MS);
await scanOnce(); // run immediate at start

// ---- Keep-alive ping to PRIMARY_URL to keep Render awake ----
if(PRIMARY_URL) {
  setInterval(()=>{
    try {
      https.get(PRIMARY_URL);
      logv('[KEEPALIVE] ping sent to PRIMARY_URL');
    }catch(e){}
  }, KEEP_ALIVE_INTERVAL * 60 * 1000);
}

// ---- Expose minimal express for healthcheck if needed (optional) ----
import express from "express";
const app = express();
app.get('/', (req,res)=> res.send('Spot Smart Radar OK'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> logv(`Server listening on port ${PORT}`));
