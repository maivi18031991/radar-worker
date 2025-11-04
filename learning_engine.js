// === SmartFlow AI Learning Engine v3.7 ===
// Full auto-learning + adaptive tuning + confidence optimizer
// Author: ViXuan System | Updated by GPT-5

import fs from "fs";
import path from "path";
import fetch from "node-fetch";

// ===== CONFIG =====
const DATA_FILE = path.resolve("./data/learning.json");
const CONFIG_FILE = path.resolve("./data/dynamic_config.json");
const CHECK_HOURS = Number(process.env.LEARNING_CHECK_HOURS || 24);
const MIN_SIGNALS_TO_TUNE = Number(process.env.MIN_SIGNALS_TO_TUNE || 20);
const AUTO_SAVE_INTERVAL_H = 6; // mỗi 6h lưu tiến trình học
const AUTO_DEBIAS_MODE = true;
const TRAIN_FAST_MODE = true;
const TRAIN_FAST_INTERVAL = 15 * 60 * 1000; // 15 phút khi test

const DEBIAS_THRESHOLD_RSI = 70;
const DEBIAS_VOL_RATIO = 2.8;
const DEBIAS_CONF_REDUCE = 0.15;

// === Utilities ===
function logv(msg) {
  console.log(`[LEARN] ${new Date().toLocaleString("vi-VN")}: ${msg}`);
}

// === FS Load / Save ===
async function loadData() {
  try {
    const txt = await fs.promises.readFile(DATA_FILE, "utf8");
    return JSON.parse(txt);
  } catch {
    return { signals: {}, stats: {} };
  }
}
async function saveData(data) {
  await fs.promises.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.promises.writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

// === Record new signal ===
export async function recordSignal(item) {
  const data = await loadData();
  data.signals[item.symbol] = data.signals[item.symbol] || [];

  // giữ tối đa 200 bản ghi / coin
  if (data.signals[item.symbol].length >= 200) data.signals[item.symbol].shift();

  data.signals[item.symbol].push({
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 6),
    time: new Date().toISOString(),
    checked: false,
    result: null,
    ...item, // symbol, price, RSI_H1, RSI_H4, VolNow, Vol24h, Conf, type, tpPct, slPct
  });

  await saveData(data);
  logv(`[recordSignal] ${item.symbol} | Conf ${item.Conf || "-"} | RSI_H1=${item.RSI_H1 || "-"} saved`);
}

// === Outcome Check ===
export async function checkOutcomesForPending() {
  const data = await loadData();
  const now = Date.now();
  const toCheck = [];

  for (const sym of Object.keys(data.signals)) {
    for (const s of data.signals[sym]) {
      if (!s.checked && now - new Date(s.time).getTime() >= CHECK_HOURS * 3600 * 1000) {
        toCheck.push(s);
      }
    }
  }

  let checked = 0;
  for (const s of toCheck) {
    try {
      const res = await checkOutcome(s);
      s.checked = true;
      s.result = res;
      updateStats(data, s);
      checked++;
    } catch (e) {
      logv(`[checkOutcomes] ${s.symbol} error: ${e.message}`);
    }
  }

  if (checked) await saveData(data);
  logv(`[checkOutcomes] ${checked} signals checked`);
  return checked;
}

// === Kiểm tra kết quả 1 tín hiệu ===
async function checkOutcome(signal) {
  const LOOK_HOURS = Number(process.env.LEARNING_LOOK_HOURS || 24);
  const TP_PCT = Number(signal.tpPct || 0.06);
  const SL_PCT = Number(signal.slPct || 0.02);

  const apiBase = process.env.API_BASE_SPOT || process.env.API_BASE_FUTURE || "https://api-gcp.binance.com";
  const url = `${apiBase}/api/v3/klines?symbol=${signal.symbol}&interval=1h&limit=${LOOK_HOURS + 1}`;

  const r = await fetch(url);
  if (!r.ok) return "NO";
  const candles = await r.json();
  if (!Array.isArray(candles) || !candles.length) return "NO";

  const entry = Number(signal.price);
  let tp = false, sl = false;

  for (const c of candles) {
    const high = Number(c[2]);
    const low = Number(c[3]);
    if (high >= entry * (1 + TP_PCT)) tp = true;
    if (low <= entry * (1 - SL_PCT)) sl = true;
    if (tp || sl) break;
  }

  if (tp && !sl) return "TP";
  if (sl && !tp) return "SL";
  return "NO";
}

// === Update statistics ===
function updateStats(data, s) {
  data.stats = data.stats || { overall: { total: 0, wins: 0 }, byType: {}, bySymbol: {} };
  const st = data.stats;

  st.overall.total++;
  if (s.result === "TP") st.overall.wins++;

  const t = s.type || "GENERIC";
  st.byType[t] = st.byType[t] || { total: 0, wins: 0, avgConf: 0 };
  st.byType[t].total++;
  if (s.result === "TP") st.byType[t].wins++;

  // cập nhật trung bình Conf
  const prev = st.byType[t].avgConf || 0;
  st.byType[t].avgConf = (prev * (st.byType[t].total - 1) + (s.Conf || 0)) / st.byType[t].total;
}

// === Adaptive Adjustments ===
export async function computeAdjustments() {
  const data = await loadData();
  const byType = data.stats?.byType || {};
  const result = { adjust: false, reasons: [], changes: {} };

  for (const [type, rec] of Object.entries(byType)) {
    if (rec.total < MIN_SIGNALS_TO_TUNE) continue;
    const wr = rec.wins / rec.total;
    const avgConf = rec.avgConf || 0.7;

    if (wr < 0.45) {
      result.adjust = true;
      result.reasons.push(`${type} WR ${Math.round(wr * 100)}% → tighten`);
      result.changes[type] = { rsiMinDelta: +3, volMinPctDelta: +10, confScale: avgConf * 0.85 };
    } else if (wr >= 0.75) {
      result.adjust = true;
      result.reasons.push(`${type} WR ${Math.round(wr * 100)}% → relax`);
      result.changes[type] = { rsiMinDelta: -2, volMinPctDelta: -5, confScale: avgConf * 1.1 };
    }
  }

  if (result.adjust) await applyAdjustments(result.changes);
  logv(`[adjust] ${result.reasons.join(" | ") || "no adjustment"}`);
  return result;
}

// === Write updated config ===
async function applyAdjustments(changes) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    cfg = {};
  }

  for (const [key, val] of Object.entries(changes)) {
    cfg[key] = { ...(cfg[key] || {}), ...val };
  }

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  logv("[applyAdjustments] dynamic config updated");
  return cfg;
}

// === Debias Helper ===
function applyAutoDebias(Conf, RSI_H1, VolNow, Vol24h) {
  if (!AUTO_DEBIAS_MODE) return Conf;
  try {
    const volRatio = VolNow / (Vol24h || 1);
    if (RSI_H1 > DEBIAS_THRESHOLD_RSI && volRatio > DEBIAS_VOL_RATIO) {
      const newConf = Math.max(0, Conf - DEBIAS_CONF_REDUCE);
      logv(`[AUTO-DEBIAS] ↓Conf ${Conf.toFixed(2)} → ${newConf.toFixed(2)} | RSI=${RSI_H1} | volRatio=${volRatio.toFixed(2)}`);
      return newConf;
    }
  } catch {}
  return Conf;
}

// === Quick Learn (manual trigger or auto every 48h) ===
export async function quickLearn48h() {
  const data = await loadData();
  const total = Object.values(data.signals).flat().length;
  if (total === 0) return logv("[QuickLearn] no signals yet");

  logv(`[QuickLearn] running on ${total} samples...`);
  const adj = await computeAdjustments();
  logv(`[QuickLearn] complete | adjust=${adj.adjust ? "YES" : "NO"}`);
}

// === Auto cycle every few hours ===
setInterval(async () => {
  try {
    const res = await checkOutcomesForPending();
    if (res > 0) {
      const adj = await computeAdjustments();
      logv("[AutoLearn] cycle complete ✅ " + JSON.stringify(adj.reasons));
    }
  } catch (e) {
    logv("[AutoLearn] error " + e.message);
  }
}, AUTO_SAVE_INTERVAL_H * 3600 * 1000);

// === Optional Fast Training Mode ===
if (TRAIN_FAST_MODE) {
  logv("[FAST-LEARN] active");
  setInterval(quickLearn48h, TRAIN_FAST_INTERVAL);
}

export default {
  recordSignal,
  checkOutcomesForPending,
  computeAdjustments,
  quickLearn48h,
};
