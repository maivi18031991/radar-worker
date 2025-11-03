// learning_engine.js — SmartFlow AI Learning Engine v3.5
// Auto-tuning engine: đọc, ghi, học & tinh chỉnh ngưỡng RSI / Vol / Confidence cho từng loại tín hiệu
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
if (TRAIN_FAST_MODE) {
  console.log("[FAST-LEARN] Quick learning mode active (15m interval)");
  setInterval(async () => {
    try {
      const { quickLearn48h } = await import("./learning_engine.js");
      await quickLearn48h();
      console.log("[FAST-LEARN] Cycle complete");
    } catch (err) {
      console.error("[FAST-LEARN] Error:", err.message);
    }
  }, TRAIN_FAST_INTERVAL);
}
const DATA_FILE = path.resolve("./data/learning.json");
const CONFIG_FILE = path.resolve("./data/dynamic_config.json");
const CHECK_HOURS = Number(process.env.LEARNING_CHECK_HOURS || 24);
const MIN_SIGNALS_TO_TUNE = Number(process.env.MIN_SIGNALS_TO_TUNE || 20);
const AUTO_SAVE_INTERVAL_H = 6; // mỗi 6h lưu tiến trình học

// === Load / Save ===
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

// === Ghi nhận tín hiệu ===
export async function recordSignal(item) {
  const data = await loadData();
  data.signals[item.symbol] = data.signals[item.symbol] || [];
  data.signals[item.symbol].push({
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    ...item,
    checked: false,
    result: null,
  });
  await saveData(data);
}

// === Check kết quả sau chu kỳ học ===
export async function checkOutcomesForPending() {
  const data = await loadData();
  const now = Date.now();
  const toCheck = [];

  for (const sym of Object.keys(data.signals)) {
    for (const s of data.signals[sym]) {
      if (!s.checked && now - new Date(s.time).getTime() >= CHECK_HOURS * 3600 * 1000)
        toCheck.push(s);
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
      console.error("[LEARN] checkOutcome error", e);
    }
  }

  if (checked) await saveData(data);
  return checked;
}

// === Kiểm tra kết quả 1 tín hiệu ===
async function checkOutcome(signal) {
  const LOOK_HOURS = Number(process.env.LEARNING_LOOK_HOURS || 24);
  const TP_PCT = Number(signal.tpPct || 0.06);
  const SL_PCT = Number(signal.slPct || 0.02);

  const apiBase = process.env.API_BASE_SPOT || process.env.API_BASE_FUTURE || "";
  if (!apiBase) return "NO";

  const url = `${apiBase}/api/v3/klines?symbol=${signal.symbol}&interval=1h&limit=${LOOK_HOURS + 1}`;
  const r = await fetch(url);
  if (!r.ok) return "NO";
  const candles = await r.json();
  if (!Array.isArray(candles) || !candles.length) return "NO";

  const entry = Number(signal.price);
  let tp = false,
    sl = false;

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

// === Cập nhật thống kê học ===
function updateStats(data, s) {
  data.stats = data.stats || { overall: { total: 0, wins: 0 }, byType: {}, bySymbol: {} };
  const st = data.stats;

  st.overall.total++;
  if (s.result === "TP") st.overall.wins++;

  const t = s.type || "UNKNOWN";
  st.byType[t] = st.byType[t] || { total: 0, wins: 0 };
  st.byType[t].total++;
  if (s.result === "TP") st.byType[t].wins++;

  st.bySymbol[s.symbol] = st.bySymbol[s.symbol] || { total: 0, wins: 0 };
  st.bySymbol[s.symbol].total++;
  if (s.result === "TP") st.bySymbol[s.symbol].wins++;
}

// === Phân tích & Điều chỉnh thông số ===
export async function computeAdjustments() {
  const data = await loadData();
  const byType = data.stats?.byType || {};
  const result = { adjust: false, reasons: [], changes: {} };

  for (const [type, rec] of Object.entries(byType)) {
    if (rec.total < MIN_SIGNALS_TO_TUNE) continue;
    const wr = rec.wins / rec.total;

    if (wr < 0.45) {
      result.adjust = true;
      result.reasons.push(`${type} WR ${Math.round(wr * 100)}% → tighten`);
      result.changes[type] = { rsiMinDelta: +3, volMinPctDelta: +10 };
    } else if (wr > 0.75) {
      result.adjust = true;
      result.reasons.push(`${type} WR ${Math.round(wr * 100)}% → relax`);
      result.changes[type] = { rsiMinDelta: -2, volMinPctDelta: -5 };
    }
  }

  if (result.adjust) await applyAdjustments(result.changes);
  return result;
}

// === Ghi thay đổi vào dynamic_config.json ===
async function applyAdjustments(changes) {
  try {
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
    console.log("[LEARN] dynamic config updated:", cfg);
    return cfg;
  } catch (e) {
    console.error("[LEARN] applyAdjustments error", e);
  }
}

// === Tự động chạy chu kỳ học định kỳ ===
setInterval(async () => {
  try {
    const res = await checkOutcomesForPending();
    if (res > 0) {
      const adj = await computeAdjustments();
      console.log("[LEARN] cycle complete:", adj);
    }
  } catch (e) {
    console.error("[LEARN] cycle error", e);
  }
}, AUTO_SAVE_INTERVAL_H * 3600 * 1000);

export default {
  loadData,
  saveData,
  recordSignal,
  checkOutcomesForPending,
  computeAdjustments,
};
