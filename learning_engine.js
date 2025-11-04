// --- learning_engine.js ---
// SmartFlow AI Learning Engine v3.9 ADVANCED
// + Local Candle Cache System (anti-API-fail + faster learning)

import fs from "fs";
import path from "path";
import fetch from "node-fetch";

// === File Paths ===
const DATA_FILE = path.resolve("./data/learning.json");
const CONFIG_FILE = path.resolve("./data/dynamic_config.json");
const CACHE_FILE = path.resolve("./data/cache_klines.json");

// === Learning Parameters ===
const CHECK_HOURS = Number(process.env.LEARNING_CHECK_HOURS || 24);
const MIN_SIGNALS_TO_TUNE = Number(process.env.MIN_SIGNALS_TO_TUNE || 20);
const AUTO_SAVE_INTERVAL_H = 6; // mỗi 6h chạy 1 vòng học
const BINANCE_API = process.env.BINANCE_API || "https://api-gcp.binance.com";

// === Local Cache ===
let cache = {};
function loadCache() {
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch { cache = {}; }
}
function saveCache() {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}
function getCachedKlines(symbol, interval = "1h") {
  const key = `${symbol}_${interval}`;
  const entry = cache[key];
  if (!entry) return null;
  const age = (Date.now() - entry.ts) / 1000;
  if (age > 600) return null; // hết hạn sau 10p
  return entry.data;
}
async function setCachedKlines(symbol, interval, data) {
  cache[`${symbol}_${interval}`] = { ts: Date.now(), data };
  saveCache();
}

// === File helpers ===
async function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return { signals: {}, stats: {} }; }
}
async function saveData(d) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), "utf8");
}

// === Record Signal ===
export async function recordSignal(item) {
  const d = await loadData();
  d.signals[item.symbol] = d.signals[item.symbol] || [];
  d.signals[item.symbol].push({
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    ...item,
    checked: false,
    result: null,
  });
  await saveData(d);
}

// === Fetch Helper (with Cache) ===
async function fetchKlines(symbol, interval = "1h", limit = 50) {
  const cached = getCachedKlines(symbol, interval);
  if (cached) {
    console.log(`[CACHE] Using ${symbol} ${interval} (${cached.length} candles cached)`);
    return cached;
  }
  const r = await fetch(`${BINANCE_API}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  const data = await r.json();
  if (Array.isArray(data)) await setCachedKlines(symbol, interval, data);
  return data;
}

// === Check Outcome (TP / SL / Neutral) ===
async function checkOutcome(signal) {
  const candles = await fetchKlines(signal.symbol, "1h", 50);
  if (!Array.isArray(candles) || !candles.length) return "NO";

  const entry = Number(signal.price);
  const TP = entry * (1 + Number(signal.tpPct || 0.06));
  const SL = entry * (1 - Number(signal.slPct || 0.02));

  for (const c of candles) {
    const high = Number(c[2]), low = Number(c[3]);
    if (high >= TP) return "TP";
    if (low <= SL) return "SL";
  }
  return "NO";
}

// === Learning Cycle ===
export async function checkOutcomesForPending() {
  loadCache();
  const d = await loadData();
  const now = Date.now();
  let checked = 0;
  for (const sym of Object.keys(d.signals)) {
    for (const s of d.signals[sym]) {
      if (!s.checked && now - new Date(s.id.split("-")[0]).getTime() >= CHECK_HOURS * 3600 * 1000) {
        s.result = await checkOutcome(s);
        s.checked = true;
        updateStats(d, s);
        checked++;
      }
    }
  }
  if (checked) await saveData(d);
  return checked;
}

// === Stats ===
function updateStats(data, s) {
  data.stats = data.stats || { overall: { total: 0, wins: 0 }, byType: {}, bySymbol: {} };
  const st = data.stats;

  st.overall.total++;
  if (s.result === "TP") st.overall.wins++;

  const t = s.type || "GENERIC";
  st.byType[t] = st.byType[t] || { total: 0, wins: 0 };
  st.byType[t].total++;
  if (s.result === "TP") st.byType[t].wins++;

  st.bySymbol[s.symbol] = st.bySymbol[s.symbol] || { total: 0, wins: 0 };
  st.bySymbol[s.symbol].total++;
  if (s.result === "TP") st.bySymbol[s.symbol].wins++;
}

// === Compute Adjustments ===
export async function computeAdjustments() {
  const d = await loadData();
  const byType = d.stats?.byType || {};
  const result = { adjust: false, changes: {} };

  for (const [type, rec] of Object.entries(byType)) {
    if (rec.total < MIN_SIGNALS_TO_TUNE) continue;
    const wr = rec.wins / rec.total;

    if (wr < 0.45) {
      result.adjust = true;
      result.changes[type] = { rsiMinDelta: +3, volMinPctDelta: +10 };
      console.log(`[LEARN] ${type} WR ${Math.round(wr * 100)}% → tighten`);
    } else if (wr > 0.75) {
      result.adjust = true;
      result.changes[type] = { rsiMinDelta: -2, volMinPctDelta: -5 };
      console.log(`[LEARN] ${type} WR ${Math.round(wr * 100)}% → relax`);
    }
  }

  if (result.adjust) await applyAdjustments(result.changes);
  return result;
}

async function applyAdjustments(changes) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch {}
  for (const [key, val] of Object.entries(changes)) {
    cfg[key] = { ...(cfg[key] || {}), ...val };
  }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  console.log("[LEARN] dynamic config updated:", cfg);
  return cfg;
}

// === Auto Cycle ===
setInterval(async () => {
  try {
    const res = await checkOutcomesForPending();
    if (res > 0) {
      const adj = await computeAdjustments();
      console.log("[LEARN] cycle complete:", adj);
    }
  } catch (e) {
    console.error("[LEARN] auto-cycle error:", e.message);
  }
}, AUTO_SAVE_INTERVAL_H * 3600 * 1000);

export default {
  recordSignal,
  checkOutcomesForPending,
  computeAdjustments,
};
