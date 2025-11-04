// --- SPOT MASTER AI v3.7 (Final Stable Build) ---
// Modules: PreBreakout + Smart Learning + Adaptive Flow + Daily Pump + Telegram Sync + Auto Learning Monitor
// Author: ViXuan System Build | Optimized 2025

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import * as LEARN from "./learning_engine.js";
import { scanPreBreakout } from "./modules/rotation_prebreakout.js";
import { scanDailyPumpSync } from "./modules/daily_pump_sync.js";

// --- CONFIG ---
process.env.BINANCE_API = process.env.BINANCE_API || "https://api-gcp.binance.com";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const PRIMARY_URL = process.env.PRIMARY_URL || "";
const KEEP_ALIVE_INTERVAL = Number(process.env.KEEP_ALIVE_INTERVAL || 10); // minutes
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_SEC || 60) * 1000; // default 1m
const LEARNING_MONITOR_INTERVAL = 60 * 60 * 1000; // 1h monitor learning progress

// --- Logger ---
function logv(msg) {
  const s = `[${new Date().toLocaleString("vi-VN")}] ${msg}`;
  console.log(s);
  try {
    fs.appendFileSync(path.resolve("./server_log.txt"), s + "\n");
  } catch {}
}

// --- Telegram Sender ---
export async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    logv("[TELEGRAM] missing TOKEN/CHAT_ID");
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) logv(`[TELEGRAM] send failed ${res.status}`);
  } catch (e) {
    logv("[TELEGRAM] error " + e.message);
  }
}

// --- Unified Push Signal ---
async function pushSignal(tag, data, conf = 70) {
  try {
    if (!data || !data.symbol) return;

    const sym = data.symbol.replace("USDT", "");
    const vol = (data.quoteVolume || 0).toLocaleString();
    const chg = data.priceChangePercent || data.change24h || 0;
    const note = data.note || "Auto signal";

    const msg = `
<b>${tag}</b> ${sym}USDT
Δ24h: <b>${chg.toFixed(2)}%</b> | Conf: ${conf}%
Vol: ${vol}
Note: ${note}
Time: ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Ho_Chi_Minh" })}
`;

    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) await sendTelegram(msg);
    logv(`[PUSH] ${sym} Conf=${conf}% Δ=${chg.toFixed(2)}%`);
  } catch (err) {
    console.error("[pushSignal ERROR]", err.message);
  }
}

// --- MAIN SCAN LOOP (PreBreakout + Learning) ---
async function mainLoop() {
  logv("[MAIN] cycle started");
  try {
    const preList = await scanPreBreakout();
    if (preList?.length) {
      for (const coin of preList) {
        const conf = LEARN?.evaluateConfidence
          ? LEARN.evaluateConfidence(coin)
          : coin.Conf || 75;
        const tag =
          coin.type === "IMF"
            ? "[FLOW]"
            : coin.type === "GOLDEN"
            ? "[GOLDEN]"
            : "[PRE]";
        await pushSignal(tag, coin, conf);
      }
      logv(`[MAIN] ✅ ${preList.length} coins processed`);
    } else {
      logv("[MAIN] no breakout candidates found");
    }
  } catch (err) {
    logv("[MAIN ERROR] " + err.message);
  }
  logv("[MAIN] cycle complete");
}

// --- DAILY PUMP SYNC LOOP ---
async function runDailyPumpSyncLoop() {
  try {
    const hits = await scanDailyPumpSync();
    for (const h of hits) {
      const tag = h.conf >= 80 ? "[TOP PUMP 🔥]" : "[DAILY PUMP]";
      await pushSignal(tag, h.payload || h, h.conf);
    }
  } catch (e) {
    console.error("[DAILY PUMP SYNC ERROR]", e.message);
  }
}

// --- LEARNING MONITOR LOOP ---
async function runLearningMonitor() {
  try {
    const data = await LEARN.loadData();
    const total = Object.values(data.signals || {}).reduce((a, b) => a + b.length, 0);
    const stats = data.stats?.overall || { total: 0, wins: 0 };
    const wr = stats.total ? ((stats.wins / stats.total) * 100).toFixed(1) : "0.0";
    const msg = `[LEARN_MONITOR] signals=${total}, winrate=${wr}%`;
    logv(msg);

    // gửi Telegram 2 tiếng/lần (để giám sát server)
    const hour = new Date().getHours();
    if (hour % 2 === 0) {
      await sendTelegram(`🧠 <b>Smart Learning Monitor</b>\nSignals: ${total}\nWR: ${wr}%\n⏰ ${new Date().toLocaleString("vi-VN")}`);
    }
  } catch (err) {
    logv("[LEARN_MONITOR ERROR] " + err.message);
  }
}

// --- STARTUP ---
(async () => {
  logv("[SPOT MASTER AI v3.7] Server starting...");
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID)
    await sendTelegram("<b>[SPOT MASTER AI v3.7]</b>\nServer Started ✅");

  // Chạy ngay khi khởi động
  await mainLoop().catch((e) => logv("[MAIN] immediate err " + e.message));
  await runDailyPumpSyncLoop().catch((e) => logv("[DAILY] immediate err " + e.message));
  await runLearningMonitor().catch((e) => logv("[LEARN] monitor err " + e.message));
})();

// --- AUTO INTERVALS ---
setInterval(mainLoop, SCAN_INTERVAL_MS);
setInterval(runDailyPumpSyncLoop, 4 * 3600 * 1000); // 4h/lần
setInterval(runLearningMonitor, LEARNING_MONITOR_INTERVAL); // 1h/lần

// --- KEEP-ALIVE ---
if (PRIMARY_URL) {
  setInterval(() => {
    try {
      fetch(PRIMARY_URL);
      logv("[KEEPALIVE] ping sent to PRIMARY_URL");
    } catch (e) {}
  }, KEEP_ALIVE_INTERVAL * 60 * 1000);
}
