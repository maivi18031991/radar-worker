// =======================================================
// SMARTFLOW MASTER v3.8 FINAL (Merged v4 + v5)
// Spot Master AI – Auto-learning + Multi-tier (PRE, SPOT, GOLDEN, IMF, HYPER)
// Node >=16
// =======================================================

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import https from "https";
import express from "express";
import * as learningEngine from "./learning_engine.js";

// ========== CONFIG ==========
const API_BASE = "https://api.binance.com";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const PRIMARY_URL = process.env.PRIMARY_URL || "";
const KEEP_ALIVE_MIN = Number(process.env.KEEP_ALIVE_INTERVAL || 10);
const MIN_VOL = Number(process.env.SYMBOL_MIN_VOL || 2_000_000);
const SCAN_INTERVAL_SEC = 3600;
const LOG_FILE = path.resolve("./spot_logs.txt");
const ACTIVE_FILE = path.resolve("./active_symbols.json");

// ========== HELPERS ==========
function logv(msg){
  const s = `[${new Date().toLocaleString("vi-VN")}] ${msg}`;
  console.log(s);
  try{ fs.appendFileSync(LOG_FILE, s + "\n"); }catch{}
}
async function sendTelegram(text){
  if(!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode:"HTML", disable_web_page_preview:true })
  }).catch(()=>{});
}
async function safeFetchJSON(url, retries=2){
  for(let i=0;i<retries;i++){
    try{
      const r = await fetch(url,{timeout:15000});
      if(r.ok) return await r.json();
    }catch{}
    await new Promise(r=>setTimeout(r,200*(i+1)));
  }
  return null;
}
function sma(arr,n=20){ const s=arr.slice(-n); return s.reduce((a,b)=>a+Number(b),0)/s.length; }
function computeRSI(c,period=14){
  if(c.length<period) return 50;
  let g=0,l=0;
  for(let i=1;i<=period;i++){const d=c[i]-c[i-1]; if(d>0)g+=d;else l-=d;}
  let ag=g/period,al=l/period||1;
  for(let i=period+1;i<c.length;i++){const d=c[i]-c[i-1]; ag=(ag*(period-1)+Math.max(0,d))/period; al=(al*(period-1)+Math.max(0,-d))/period;}
  if(al===0)return 100; const rs=ag/al; return 100-(100/(1+rs));
}
function fmt(n,d=8){return typeof n==="number"?Number(n.toFixed(d)):n;}

// ========== SYMBOLS ==========
let SYMBOLS=[];
async function loadSymbols(){
  const data=await safeFetchJSON(`${API_BASE}/api/v3/ticker/24hr`);
  if(!Array.isArray(data))return SYMBOLS;
  SYMBOLS=data
    .filter(s=>s.symbol.endsWith("USDT") && !/UP|DOWN|BULL|BEAR|_/.test(s.symbol))
    .filter(s=>Number(s.quoteVolume)>=MIN_VOL)
    .sort((a,b)=>b.quoteVolume-a.quoteVolume)
    .map(s=>s.symbol);
  logv(`[SYMBOLS] loaded ${SYMBOLS.length} symbols`);
  return SYMBOLS;
}

// ========== ACTIVE STORAGE ==========
const activeMap=new Map();
if(fs.existsSync(ACTIVE_FILE)){
  const raw=fs.readFileSync(ACTIVE_FILE,"utf8");
  const obj=JSON.parse(raw||"{}");
  for(const k of Object.keys(obj)) activeMap.set(k,obj[k]);
}
function saveActive(){fs.writeFileSync(ACTIVE_FILE,JSON.stringify(Object.fromEntries(activeMap),null,2));}

// ========== BTC CONTEXT ==========
let BTC_CTX={trend:"NEUTRAL",rsi:50};
async function updateBTC(){
  try{
    const k=await safeFetchJSON(`${API_BASE}/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=50`);
    const c=k.map(r=>Number(r[4]));
    const ma=sma(c,20),rsi=computeRSI(c.slice(-30));
    const last=c.at(-1);
    BTC_CTX.trend=last>ma*1.01&&rsi>55?"UP":last<ma*0.99&&rsi<45?"DOWN":"NEUTRAL";
    BTC_CTX.rsi=rsi;
  }catch{}
}

// ========== DETERMINE TIER ==========
function determineTier({price,ma20,volNow,volAvg,rsi,change24}){
  const vR=volNow/(volAvg||1);
  let tier=null,conf=0;
  if(price>=ma20*0.995 && price<=ma20*1.02 && vR>=1.2&&rsi>=40&&rsi<=55){tier="PRE";conf=60;}
  if(vR>=3&&price>ma20*0.995&&rsi>=55&&rsi<=70){tier="IMF";conf=Math.max(conf,85);}
  if(price>ma20*1.03&&change24>=6&&rsi>=60){tier="GOLDEN";conf=Math.max(conf,85);}
  if(price>ma20&&vR>=1.5&&rsi>=50&&rsi<=65){tier="SPOT";conf=Math.max(conf,75);}
  if((rsi>=60&&vR>=2.5&&change24>=8)||(tier==="GOLDEN"&&vR>=2.5)){tier="HYPER";conf=Math.max(conf,95);}
  return {tier,conf,vR};
}

// ========== ANALYZE SYMBOL ==========
async function analyzeSymbol(sym){
  try{
    const k1=await safeFetchJSON(`${API_BASE}/api/v3/klines?symbol=${sym}&interval=1h&limit=60`);
    const t24=await safeFetchJSON(`${API_BASE}/api/v3/ticker/24hr?symbol=${sym}`);
    if(!k1||!t24)return;
    const c1=k1.map(r=>Number(r[4])),v1=k1.map(r=>Number(r[5]));
    const ma20=sma(c1,20)||c1.at(-1),price=Number(t24.lastPrice),change24=Number(t24.priceChangePercent),rsi=computeRSI(c1.slice(-30)),volNow=v1.at(-1),volAvg=sma(v1,20);
    const d=determineTier({price,ma20,volNow,volAvg,rsi,change24});
    if(!d.tier)return;
    const sltp={PRE:[0.01,0.05],SPOT:[0.015,0.06],GOLDEN:[0.02,0.1],IMF:[0.03,0.15],HYPER:[0.025,0.12]}[d.tier];
    const [slPct,tpPct]=sltp;
    const sl=fmt(price*(1-slPct)),tp=fmt(price*(1+tpPct));
    const msg=`🚀 <b>[${d.tier}] ${sym}</b>
Price: ${fmt(price)} | MA20: ${fmt(ma20)} | RSI: ${rsi.toFixed(1)}
VolRatio: ${d.vR.toFixed(2)} | 24h%: ${change24} | Conf: ${d.conf}%
BTC: ${BTC_CTX.trend} (${BTC_CTX.rsi.toFixed(1)})
SL: ${sl} | TP: ${tp}
Time: ${new Date().toLocaleString("vi-VN")}`;
    await sendTelegram(msg);
    logv(`[ALERT] ${sym} ${d.tier} conf=${d.conf}`);
    activeMap.set(sym,{type:d.tier,meta:{price,ma20,rsi,conf:d.conf}});
    saveActive();
  }catch(e){logv(`[ERR] ${sym} ${e.message}`);}
}

// ========== EXIT CHECK ==========
async function checkExit(){
  for(const [sym,d] of activeMap.entries()){
    const k=await safeFetchJSON(`${API_BASE}/api/v3/klines?symbol=${sym}&interval=1h&limit=20`);
    if(!k)continue;
    const c=k.map(r=>Number(r[4])),price=c.at(-1),ma=sma(c,20),rsi=computeRSI(c.slice(-30));
    let reason=null;
    if(d.type==="GOLDEN"&&price<ma*0.998)reason="Price cut MA20";
    if((d.type==="SPOT"||d.type==="PRE")&&rsi<45)reason="RSI collapse";
    if(d.type==="IMF"&&price<ma*0.995)reason="IMF rejection";
    if(d.type==="HYPER"&&rsi<50)reason="Hyper weaken";
    if(reason){
      await sendTelegram(`<b>[EXIT]</b> ${sym} (${d.type})\nReason: ${reason}`);
      activeMap.delete(sym);saveActive();
    }
  }
}

// ========== MAIN LOOP ==========
async function rotation(){
  await updateBTC();
  await loadSymbols();
  for(const s of SYMBOLS.slice(0,200)){
    await analyzeSymbol(s);
    await new Promise(r=>setTimeout(r,300));
  }
  await checkExit();
  logv("[CYCLE] done.");
}
rotation();
setInterval(rotation, SCAN_INTERVAL_SEC*1000);

// ========== LEARNING ==========
setInterval(async()=>{
  try{await learningEngine.quickLearn48h();logv("[LEARN] quickLearn48h done");}catch{}
},48*3600*1000);

// ========== KEEPALIVE ==========
if(PRIMARY_URL){setInterval(()=>{https.get(PRIMARY_URL).on("error",()=>{});},KEEP_ALIVE_MIN*60*1000);}
const app=express();
app.get("/",(req,res)=>res.send("SmartFlow v3.8 Final Running"));
app.listen(process.env.PORT||3000,()=>logv("[SERVER] OK"));
