// --- daily_pump_sync.js ---
// Spot Master AI v3.9 PRO FILTER
// Detects real daily pumps (volume-backed + valid RSI structure)

import fetchNode from "node-fetch";
const fetch = global.fetch || fetchNode;

let ACTIVE_BINANCE_API = process.env.BINANCE_API || "https://api-gcp.binance.com";
const MIN_VOL = 1_000_000; // 1M USDT min
const MAX_RESULTS = 20; // top 20
const MIN_PCT = 5; // ignore <5%
const SPREAD_LIMIT = 2.0; // loại coin pump xả, spread >2%
const RSI_LIMIT = 80; // RSI quá cao = xả
const BBWIDTH_MIN = 0.015; // BBWidth quá nhỏ = chưa pump thật

// --- Helper ---
async function safeFetch(endpoint, label = "BINANCE") {
  const mirrors = [
    "https://api-gcp.binance.com",
    "https://api1.binance.com",
    "https://api3.binance.com",
    "https://api2.binance.com"
  ];

  for (const mirror of [ACTIVE_BINANCE_API, ...mirrors]) {
    try {
      const res = await fetch(`${mirror}${endpoint}`);
      if (res.ok) {
        ACTIVE_BINANCE_API = mirror;
        process.env.BINANCE_API = mirror;
        return await res.json();
      }
      console.warn(`[${label}] Mirror ${mirror} failed ${res.status}`);
    } catch (err) {
      console.warn(`[${label}] Mirror ${mirror} err: ${err.message}`);
    }
  }
  throw new Error(`[${label}] All mirrors failed`);
}

// --- Indicator utils ---
function sma(arr, n) {
  if (arr.length < n) return 0;
  const s = arr.slice(-n);
  return s.reduce((a,b)=>a+b,0)/s.length;
}
function stddev(arr, n) {
  const s = arr.slice(-n);
  const m = sma(s,n);
  const v = s.reduce((a,b)=>a+(b-m)**2,0)/s.length;
  return Math.sqrt(v);
}
function bollingerWidth(closeArr, n=14, mult=2){
  const mb=sma(closeArr,n);
  const sd=stddev(closeArr,n);
  return (2*mult*sd)/(mb||1);
}
function rsiFromArray(closes, n=14){
  if (closes.length < n+1) return 50;
  let gains=0,losses=0;
  for(let i=closes.length-n;i<closes.length;i++){
    const diff=closes[i]-closes[i-1];
    if (diff>=0) gains+=diff; else losses+=Math.abs(diff);
  }
  if (losses===0) return 100;
  const rs=gains/losses;
  return 100-(100/(1+rs));
}

// --- Sub fetch 15m candles ---
async function getKlines(symbol, interval="15m", limit=50){
  const url = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  return await safeFetch(url, `KLINES ${symbol}`);
}

// --- Main Scan ---
export async function scanDailyPumpSync(){
  try {
    console.log("[DAILY_PUMP] Using mirror:", ACTIVE_BINANCE_API);
    const data = await safeFetch("/api/v3/ticker/24hr", "DAILY_PUMP");
    if (!Array.isArray(data)) return [];

    const filtered = data
      .filter(d => 
        d.symbol.endsWith("USDT") &&
        Number(d.quoteVolume||0) >= MIN_VOL &&
        Number(d.priceChangePercent||0) >= MIN_PCT
      )
      .sort((a,b)=>Number(b.priceChangePercent)-Number(a.priceChangePercent))
      .slice(0, MAX_RESULTS * 2); // quét rộng hơn, lọc sau

    const results = [];
    for (const d of filtered){
      try {
        const symbol = d.symbol;
        const klines = await getKlines(symbol, "15m", 50);
        const closes = klines.map(k=>Number(k[4]));
        const highs = klines.map(k=>Number(k[2]));
        const lows = klines.map(k=>Number(k[3]));

        const lastClose = closes.at(-1);
        const rsi15 = rsiFromArray(closes,14);
        const bbwidth = bollingerWidth(closes,14,2);
        const high = Math.max(...highs.slice(-4));
        const low = Math.min(...lows.slice(-4));
        const spread = ((high - low) / low) * 100;

        // Bộ lọc pump thật
        const isHealthy =
          rsi15 < RSI_LIMIT &&
          spread < SPREAD_LIMIT &&
          bbwidth > BBWIDTH_MIN;

        let conf = 60;
        if (isHealthy) {
          if (Number(d.priceChangePercent) >= 30) conf = 90;
          else if (Number(d.priceChangePercent) >= 15) conf = 80;
          else if (Number(d.priceChangePercent) >= 8) conf = 70;
        } else {
          conf = Math.max(50, conf - 15);
        }

        results.push({
          symbol,
          priceChangePercent: Number(d.priceChangePercent),
          quoteVolume: Number(d.quoteVolume),
          conf,
          rsi15: Number(rsi15.toFixed(1)),
          bbwidth: Number(bbwidth.toFixed(3)),
          spread: Number(spread.toFixed(2)),
          note: isHealthy ? "Real Pump (Healthy momentum)" : "Possible fake pump / overheat",
        });
      } catch(e){
        console.warn("[DAILY_PUMP] sub error:", e.message);
      }
    }

    // Sort by confidence
    results.sort((a,b)=>b.conf - a.conf);
    console.log(`[DAILY_PUMP] ✅ ${results.length} candidates`);
    return results.slice(0, MAX_RESULTS);
  } catch(e){
    console.error("[DAILY_PUMP ERROR]", e.message);
    return [];
  }
}
