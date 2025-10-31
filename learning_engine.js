// learning_engine.js
// ES module - requires package.json "type":"module"
import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch'; // project already has node-fetch in deps

const DATA_FILE = path.resolve('./data/learning.json');
const CHECK_HOURS = Number(process.env.LEARNING_CHECK_HOURS || 24); // sau bao nhiêu giờ check outcome
const MIN_SIGNALS_TO_TUNE = Number(process.env.MIN_SIGNALS_TO_TUNE || 20);

async function loadData(){
  try{
    const txt = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(txt);
  }catch(e){
    return { signals: {}, stats: {} };
  }
}
async function saveData(data){
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2),'utf8');
}

/**
 * recordSignal - lưu 1 tín hiệu ngay khi gửi alert
 * item: { symbol, type, time, price, rsi, vol, funding, extra }
 */
export async function recordSignal(item){
  const data = await loadData();
  data.signals[item.symbol] = data.signals[item.symbol] || [];
  data.signals[item.symbol].push({
    id: Date.now() + '-' + Math.random().toString(36).slice(2,7),
    ...item,
    checked: false,
    result: null // TP | SL | NO
  });
  await saveData(data);
}

/**
 * checkOutcomesForPending - check tất cả signals chưa checked mà đủ thời gian
 * returns number of checked
 * NOTE: uses spot/future API to fetch price history — adapt to your API
 */
export async function checkOutcomesForPending(){
  const data = await loadData();
  const now = Date.now();
  const toCheck = [];
  for(const sym of Object.keys(data.signals)){
    for(const s of data.signals[sym]){
      if(!s.checked && (now - new Date(s.time).getTime()) >= CHECK_HOURS * 3600*1000){
        toCheck.push(s);
      }
    }
  }
  let checkedCount = 0;
  for(const s of toCheck){
    try{
      const res = await checkOutcome(s);
      s.checked = true;
      s.result = res; // 'TP' | 'SL' | 'NO'
      updateStats(data, s);
      checkedCount++;
    }catch(e){
      console.error('checkOutcome error', e);
    }
  }
  if(checkedCount) await saveData(data);
  return checkedCount;
}

/**
 * checkOutcome - đơn giản: lấy giá trong window sau signal (ví dụ max/min trong 24h)
 * Trả về 'TP' nếu price đạt TP% above entry, 'SL' nếu giảm đến SL% below entry, else 'NO'
 * Mày có thể thay bằng gọi exchange OHLC.
 */
async function checkOutcome(signal){
  // config từ signal hoặc mặc định
  const LOOK_HOURS = Number(process.env.LEARNING_LOOK_HOURS || 24);
  const TP_PCT = Number(signal.tpPct || process.env.DEFAULT_TP_PCT || 0.06); // 6% mặc định
  const SL_PCT = Number(signal.slPct || process.env.DEFAULT_SL_PCT || 0.02); // 2% mặc định

  // giả sử có API_BASE_SPOT để lấy candles: /candles?symbol=XXX&limit=100
  // chỉnh điều này theo API thực của mày
  const apiBase = process.env.API_BASE_SPOT || process.env.API_BASE_FUTURE || '';
  if(!apiBase){
    // fallback: không check được -> mark NO
    return 'NO';
  }

  const symbol = signal.symbol;
  // call exchange candle endpoint - this is placeholder path, chỉnh cho đúng
  const url = `${apiBase}/candles?symbol=${symbol}&interval=1h&limit=${LOOK_HOURS+1}`;
  const r = await fetch(url);
  if(!r.ok) return 'NO';
  const candles = await r.json(); // assume array of {open,high,low,close}
  if(!Array.isArray(candles) || candles.length===0) return 'NO';

  const entry = Number(signal.price);
  let reachedTP=false, reachedSL=false;
  for(const c of candles){
    const high = Number(c.high);
    const low = Number(c.low);
    if(high >= entry * (1 + TP_PCT)) reachedTP = true;
    if(low <= entry * (1 - SL_PCT)) reachedSL = true;
    if(reachedTP && reachedSL) break;
  }
  if(reachedTP && !reachedSL) return 'TP';
  if(reachedSL && !reachedTP) return 'SL';
  if(reachedTP && reachedSL) {
    // nếu cả 2 xảy ra, xem first occurence (đơn giản: TP ưu tiên)
    return 'TP';
  }
  return 'NO';
}

/**
 * updateStats - cập nhật thống kê tổng, per-type, per-symbol
 */
function updateStats(data, s){
  data.stats = data.stats || { overall: {total:0, wins:0}, byType:{}, bySymbol:{} };
  const st = data.stats;
  st.overall.total++;
  if(s.result === 'TP') st.overall.wins++;

  const t = s.type || 'UNKNOWN';
  st.byType[t] = st.byType[t] || {total:0, wins:0};
  st.byType[t].total++;
  if(s.result === 'TP') st.byType[t].wins++;

  st.bySymbol[s.symbol] = st.bySymbol[s.symbol] || {total:0, wins:0};
  st.bySymbol[s.symbol].total++;
  if(s.result === 'TP') st.bySymbol[s.symbol].wins++;
}

/**
 * computeAdjustments - simple heuristic: nếu winrate type < threshold thì tighten filters
 * trả về object { adjust: true, changes: { rsiMin:+2, volMin:+10, ... } }
 */
export async function computeAdjustments(){
  const data = await loadData();
  const stats = data.stats || {};
  const byType = stats.byType || {};
  const result = { adjust: false, reasons: [], changes: {} };

  for(const [type, rec] of Object.entries(byType)){
    if(rec.total < MIN_SIGNALS_TO_TUNE) continue;
    const wr = rec.wins / rec.total;
    if(wr < 0.45){
      // tighten: require higher volume or higher rsi for this type
      result.adjust = true;
      result.reasons.push(`${type} winrate ${Math.round(wr*100)}% -> tighten`);
      result.changes[type] = { rsiMinDelta: +3, volMinPctDelta: +10 };
    }else if(wr > 0.75){
      result.adjust = true;
      result.reasons.push(`${type} winrate ${Math.round(wr*100)}% -> relax`);
      result.changes[type] = { rsiMinDelta: -2, volMinPctDelta: -5 };
    }
  }
  return result;
}

/**
 * export helper to get stats
 */
export async function getStats(){
  const data = await loadData();
  return data.stats || {};
}
