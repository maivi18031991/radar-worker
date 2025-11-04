// --- SPOT MASTER AI v3.9 (Full Integration Stable) ---
// Modules: PreBreakout + Daily Pump + Learning + Telegram + KeepAlive
// Author: ViXuan System Build

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import * as LEARN from "./modules/learning_engine.js";
import { scanPreBreakout } from "./modules/rotation_prebreakout.js";
import { scanDailyPumpSync } from "./modules/daily_pump_sync.js";
import { scanEarlyPump } from "./modules/early_pump_detector.js"; // optional nếu có

// === ENV CONFIG ===
process.env.BINANCE_API = process.env.BINANCE_API || "https://api-gcp.binance.com";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const PRIMARY_URL = process.env.PRIMARY_URL || "";
const KEEP_ALIVE_INTERVAL = Number(process.env.KEEP_ALIVE_INTERVAL || 10);
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_SEC || 60) * 1000;

// === LOGGER ===
function logv(msg) {
  const s = `[${new Date().toLocaleString("vi-VN")}] ${msg}`;
  console.log(s);
  try {
    fs.appendFileSync(path.resolve("./server_log.txt"), s + "\n");
  } catch {}
}

// === TELEGRAM ===
async function sendTelegram(text) {
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

// === UNIFIED PUSH SIGNAL ===
async function pushSignal(tag, data, conf = 70) {
  try {
    if (!data || !data.symbol) return;
    const sym = data.symbol.replace("USDT", "");
    const vol = (data.quoteVolume || 0).toLocaleString();
    const chg = data.priceChangePercent || data.change24h || 0;
    const note = data.note || "Auto Signal";

    const msg = `
<b>${tag}</b> ${sym}USDT
Δ24h: <b>${chg.toFixed(2)}%</b> | Conf: ${conf}%
Vol: ${vol}
Note: ${note}
⏱ ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Ho_Chi_Minh" })}
    `;

    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
      await sendTelegram(msg);
    }
    logv(`[PUSH] ${sym} ${chg.toFixed(2)}% sent`);
  } catch (err) {
    logv("[pushSignal ERROR] " + err.message);
  }
}

// === MAIN LOOP (PREBREAKOUT) ===
async function mainLoop() {
  logv("[MAIN] Cycle started...");
  try {
    const preList = await scanPreBreakout();
    if (preList && preList.length > 0) {
      for (const coin of preList) {
        const conf = LEARN?.evaluateConfidence
          ? LEARN.evaluateConfidence(coin)
          : coin.Conf || 75;
        const tag = "[PRE]";
        await pushSignal(tag, coin, conf);
      }
      logv(`[MAIN] ${preList.length} prebreakout coins processed`);
    } else {
      logv("[MAIN] No breakout candidates found");
    }
  } catch (err) {
    logv("[MAIN ERROR] " + err.message);
  }
  logv("[MAIN] Cycle complete ✅");
}

// === DAILY PUMP LOOP ===
async function runDailyPumpLoop() {
  try {
    const hits = await scanDailyPumpSync();
    for (const h of hits) {
      const tag = h.conf >= 80 ? "[TOP PUMP 🔥]" : "[DAILY PUMP]";
      await pushSignal(tag, h, h.conf);
    }
  } catch (e) {
    logv("[DAILY PUMP ERROR] " + e.message);
  }
}

// === EARLY PUMP LOOP (optional) ===
async function runEarlyPumpLoop() {
  if (typeof scanEarlyPump !== "function") return;
  try {
    const hits = await scanEarlyPump();
    for (const h of hits) {
      const tag = h.conf >= 80 ? "[EARLY PUMP ⚡]" : "[PRE-EARLY]";
      await pushSignal(tag, h, h.conf);
    }
  } catch (e) {
    logv("[EARLY PUMP ERROR] " + e.message);
  }
}

// === STARTUP ===
(async () => {
  logv("[SPOT MASTER AI v3.9] Starting server 🚀");
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID)
    await sendTelegram("<b>[SPOT MASTER AI v3.9]</b>\nServer Started ✅");
})();

// === INTERVALS ===
mainLoop();
setInterval(mainLoop, SCAN_INTERVAL_MS);
setInterval(runDailyPumpLoop, 4 * 3600 * 1000);
setInterval(runEarlyPumpLoop, 2 * 3600 * 1000);

// === KEEPALIVE ===
if (PRIMARY_URL) {
  setInterval(() => {
    fetch(PRIMARY_URL).catch(() => {});
    logv("[KEEPALIVE] Ping sent to PRIMARY_URL");
  }, KEEP_ALIVE_INTERVAL * 60 * 1000);
}
