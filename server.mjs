// server_v4.0_full.mjs
// SPOT MASTER AI v4.0 - Hybrid SmartFlow (orchestrator)
// - Main loop: 1s scan (SELECTIVE alerts on spike/confidence)
// - Requires Node >=16, install node-fetch if needed: npm i node-fetch
//
// Env vars (recommended):
// TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, BINANCE_API (default used if not set),
// PRIMARY_URL (keep-alive), SCAN_INTERVAL_MS (override), ALERT_COOLDOWN_MIN (override)

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import * as LEARN from "./modules/learning_engine.js"; // learning engine (must export evaluateConfidence / recordSignal optionally)
import { scanPreBreakout } from "./modules/rotation_prebreakout.js"; // returns array of signals
import { scanDailyPumpSync } from "./modules/daily_pump_sync.js"; // optional
import { scanEarlyPump } from "./modules/early_pump_detector.js"; // optional - if not present, module should export stub

// === CONFIG ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const BINANCE_API = process.env.BINANCE_API || "https://api1.binance.com";
const PRIMARY_URL = process.env.PRIMARY_URL || "";
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 1000); // 1s default
const ALERT_COOLDOWN_MIN = Number(process.env.ALERT_COOLDOWN_MIN || 15); // minutes per symbol-type
const MIN_CONF_TO_PUSH = Number(process.env.MIN_CONF_TO_PUSH || 60);
const MAX_PUSH_PER_CYCLE = Number(process.env.MAX_PUSH_PER_CYCLE || 6); // safety: max signals per 1s cycle
const DATA_DIR = path.resolve("./data");
const ACTIVE_FILE = path.join(DATA_DIR, "active_signals.json");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e){}

// === UTIL LOGGER ===
function logv(msg){
  const s = `[${new Date().toLocaleString('vi-VN')}] ${msg}`;
  console.log(s);
  try { fs.appendFileSync(path.join(DATA_DIR, "server_log.txt"), s + "\n"); } catch(e){}
}

// === TELEGRAM SENDER ===
async function sendTelegram(text){
  if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID){
    logv("[TELE] missing TELEGRAM_TOKEN / TELEGRAM_CHAT_ID");
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
    const res = await fetch(url, { method: "POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(payload) });
    if(!res.ok){
      logv(`[TELE] send failed ${res.status}`);
      return false;
    }
    return true;
  } catch(e){
    logv("[TELE] send error " + e.message);
    return false;
  }
}

// === ALERT MEMORY / DEDUPE ===
/*
  ALERT_MEMORY key = `${symbol}:${level}` -> timestamp ms of last alert
  We allow re-alert after ALERT_COOLDOWN_MIN minutes OR if confidence increased by >= delta
*/
const ALERT_MEMORY = new Map(); // key -> { ts, lastConf }
const CONF_INCREASE_TO_RE_ALERT = 10; // percent points

function canSendAlert(symbol, level, conf){
  const key = `${symbol}:${level}`;
  const now = Date.now();
  const prev = ALERT_MEMORY.get(key);
  if(!prev){
    ALERT_MEMORY.set(key, { ts: now, lastConf: conf });
    return true;
  }
  const diffMin = (now - prev.ts) / 60000;
  if(conf - (prev.lastConf || 0) >= CONF_INCREASE_TO_RE_ALERT){
    ALERT_MEMORY.set(key, { ts: now, lastConf: conf });
    return true;
  }
  if(diffMin >= ALERT_COOLDOWN_MIN){
    ALERT_MEMORY.set(key, { ts: now, lastConf: conf });
    return true;
  }
  return false;
}

// === ACTIVE SIGNALS file ===
let activeSignals = {};
function loadActive(){
  try{
    if(fs.existsSync(ACTIVE_FILE)){
      activeSignals = JSON.parse(fs.readFileSync(ACTIVE_FILE,'utf8') || "{}");
      logv(`[ACTIVE] loaded ${Object.keys(activeSignals).length} entries`);
    }
  }catch(e){
    logv("[ACTIVE] load err " + e.message);
    activeSignals = {};
  }
}
function saveActive(){
  try{
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify(activeSignals,null,2));
  }catch(e){ logv("[ACTIVE] save err " + e.message); }
}

// === FORMAT & PUSH helpers ===
function buildMsg(tag, coin, conf){
  // coin expected to have: symbol, price, Conf/ conf, type, note, priceChangePercent, quoteVolume
  const sym = coin.symbol || coin.symbol?.replace?.('USDT','') || 'NA';
  const price = coin.price || coin.lastPrice || 'NA';
  const change24 = coin.priceChangePercent ?? coin.change24 ?? 0;
  const vol = coin.quoteVolume || coin.vol24 || coin.vol24 ?? 0;
  const time = new Date().toLocaleString('vi-VN');
  const lines = [];
  lines.push(`<b>${tag} ${coin.symbol}</b>`);
  lines.push(`Conf: ${Math.round(conf)}% | Δ24h: ${Number(change24).toFixed(2)}%`);
  lines.push(`Price: ${price} | Vol24h: ${Number(vol).toLocaleString()}`);
  if(coin.note) lines.push(`Note: ${coin.note}`);
  lines.push(`Time: ${time}`);
  return lines.join("\n");
}

async function pushIfAllowed(tag, coin, conf){
  if(conf < MIN_CONF_TO_PUSH) return false;
  const lvl = tag.replace(/\W/g,'') || 'SIG';
  if(!canSendAlert(coin.symbol, lvl, conf)) return false;
  const msg = buildMsg(tag, coin, conf);
  const ok = await sendTelegram(msg);
  if(ok){
    logv(`[PUSH] ${coin.symbol} ${tag} conf=${conf}%`);
    // record to learning engine for later checking
    try {
      if(typeof LEARN.recordSignal === 'function'){
        LEARN.recordSignal({
          symbol: coin.symbol,
          type: coin.type || lvl,
          time: new Date().toISOString(),
          price: coin.price || coin.lastPrice || 0,
          conf,
          extra: coin.note || ''
        });
      }
    } catch(e){ logv('[LEARN] recordSignal err '+ e.message); }
  }
  return ok;
}

// === GRACEFUL BACKOFF HANDLER (simple) ===
let consecutiveFetchErrors = 0;
function registerFetchError(){
  consecutiveFetchErrors++;
  if(consecutiveFetchErrors >= 5){
    logv(`[BACKOFF] ${consecutiveFetchErrors} consecutive fetch errors — advise to increase SCAN_INTERVAL_MS or check BINANCE_API`);
  }
}
function resetFetchErrors(){ consecutiveFetchErrors = 0; }

// === MAIN ORCHESTRATOR ===
loadActive();

let shuttingDown = false;

async function orchestratorCycle(){
  if(shuttingDown) return;
  const start = Date.now();
  logv(`[CYCLE] start`);

  try {
    // 1) PreBreakout (rotation / compressed / early flow) - returns array of signals
    let preList = [];
    try {
      preList = Array.isArray(await scanPreBreakout()) ? await scanPreBreakout() : [];
      resetFetchErrors();
    } catch(e){
      logv('[CYCLE] scanPreBreakout error ' + e.message);
      registerFetchError();
      preList = [];
    }

    // 2) Early pump detector (fast vol pops) - optional
    let earlyList = [];
    try {
      if(typeof scanEarlyPump === 'function'){
        earlyList = Array.isArray(await scanEarlyPump()) ? await scanEarlyPump() : [];
      }
      resetFetchErrors();
    } catch(e){
      logv('[CYCLE] scanEarlyPump error ' + e.message);
      registerFetchError();
      earlyList = [];
    }

    // 3) Daily pump sync (optional, lower priority)
    let dailyList = [];
    try {
      if(typeof scanDailyPumpSync === 'function'){
        dailyList = Array.isArray(await scanDailyPumpSync()) ? await scanDailyPumpSync() : [];
      }
    } catch(e){
      logv('[CYCLE] scanDailyPumpSync error ' + e.message);
    }

    // Merge & sort by confidence (highest first) to avoid spamming many low-conf in 1s cycle
    const combined = [];
    for(const x of preList) combined.push({ ...x, source: 'PRE' });
    for(const x of earlyList) combined.push({ ...x, source: 'EARLY' });
    for(const x of dailyList) combined.push({ ...x, source: 'DAILY' });

    // normalize conf field name variants
    combined.forEach(c => {
      c.conf = c.conf ?? c.Conf ?? c.Confidence ?? 0;
      // ensure symbol includes USDT
      if(c.symbol && !c.symbol.endsWith('USDT')) {
        if(/^.+USDT$/i.test(c.symbol)) c.symbol = c.symbol;
        else c.symbol = String(c.symbol).toUpperCase().endsWith('USDT') ? c.symbol : `${String(c.symbol).toUpperCase()}USDT`;
      }
    });

    combined.sort((a,b) => (b.conf || 0) - (a.conf || 0));

    // push top N per cycle (safety)
    let pushedCount = 0;
    for(const coin of combined){
      if(pushedCount >= MAX_PUSH_PER_CYCLE) break;
      const conf = coin.conf || 0;

      // map source -> tag
      let tag = coin.type ? `[${coin.type}]` : (coin.source === 'EARLY' ? '[EARLY ⚡]' : coin.source === 'DAILY' ? '[DAILY PUMP]' : '[PRE]');
      // if coin flagged as IMF or GOLDEN adjust tag
      if(coin.type === 'IMF') tag = '[IMF ⚡]';
      if(coin.type === 'GOLDEN') tag = '[GOLDEN 🔥]';
      if(coin.type === 'SPOT') tag = '[SPOT 🔔]';

      // selective filters: only push if conf >= MIN_CONF_TO_PUSH and dedupe allows
      if(conf >= MIN_CONF_TO_PUSH && canSendAlert(coin.symbol, tag, conf)){
        const ok = await pushIfAllowed(tag, coin, conf);
        if(ok) pushedCount++;
      }
    }

    // 4) Save active signals snapshot to disk for traceability
    try {
      saveActive();
    } catch(e){ logv('[CYCLE] saveActive err '+ e.message); }

    // done
    resetFetchErrors();
    const tookMs = Date.now() - start;
    logv(`[CYCLE] complete - pushed ${pushedCount}, combinedCandidates=${combined.length}, took=${tookMs}ms`);
  } catch(e){
    logv('[CYCLE] fatal err ' + (e && e.message) );
    registerFetchError();
  }
}

// Start immediate and schedule
(async ()=>{
  logv("[SERVER] SPOT MASTER AI v4.0 starting. SCAN_INTERVAL_MS=" + SCAN_INTERVAL_MS);
  if(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    await sendTelegram(`<b>[SPOT MASTER AI v4.0]</b>\nServer started. Scan every ${SCAN_INTERVAL_MS} ms. Selective alerts ON.`);
  }
  // immediate
  orchestratorCycle().catch(e=>logv('[MAIN] immediate err '+ e.message));
  // schedule
  setInterval(orchestratorCycle, SCAN_INTERVAL_MS);

  // keep-alive ping to PRIMARY_URL if provided (reduce Render sleep)
  if(PRIMARY_URL){
    setInterval(()=>{
      try { fetch(PRIMARY_URL); logv('[KEEPALIVE] ping primary'); } catch(e){}
    }, (Number(process.env.KEEP_ALIVE_INTERVAL_MIN || 10) ) * 60 * 1000);
  }
})();

// graceful exit
process.on('SIGINT', async ()=> {
  logv('[SERVER] SIGINT received - shutting down');
  shuttingDown = true;
  try { await sendTelegram('[SPOT MASTER AI v4.0] Shutting down'); } catch(e){}
  process.exit(0);
});
