// server.mjs
// Combined server final (based on server v4 + v5 + prebreakout module)
// NOTE: paste whole file over your existing server.mjs

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import https from "https";
import express from "express";

// main modules from repo (must exist)
import * as learningEngine from "./learning_engine.js";
import { rotationFlowScan } from "./rotation_flow_live.js";
import { scanRotationFlow } from "./modules/rotation_prebreakout.js";
import * as smartLayer from "./smart_layer.js"; // optional utilities

// ---- CONFIG (env overrides) ----
const SCAN_INTERVAL_SEC = Number(process.env.SCAN_INTERVAL_SEC || 60); // base 60s
const AUTO_LEARN_48H_MS = Number(process.env.AUTO_LEARN_48H_MS || 48 * 3600 * 1000);
const AUTO_LEARN_7D_MS = Number(process.env.AUTO_LEARN_7D_MS || 7 * 24 * 3600 * 1000);
const ROTATION_SCAN_MS = Number(process.env.ROTATION_SCAN_MS || 6 * 3600 * 1000); // 6h default
const QUICK_LEARN_START_DELAY_MS = Number(process.env.QUICK_LEARN_START_DELAY_MS || 5000);

const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.BOT_CHAT_ID || "";
const PRIMARY_URL = process.env.PRIMARY_URL || ""; // keepalive target

// small logger helpers
function logv(...args) { console.log(new Date().toLocaleString(), ...args); }
function logError(...args) { console.error(new Date().toLocaleString(), ...args); }

// ---- sendTelegram: safe wrapper ----
async function sendTelegram(text, html = false) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    logv("[TELEGRAM] token or chat id missing - skip send");
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const payload = {
      chat_id: TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: html ? "HTML" : undefined,
      disable_web_page_preview: true,
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeout: 10000
    });
    const j = await res.json();
    if (!j.ok) logv("[TELEGRAM] send fail:", j);
    else logv("[TELEGRAM] sent ok");
    return j;
  } catch (e) {
    logError("[TELEGRAM] error", e?.message || e);
  }
}

// ---- Keep minimal http server for Render / healthchecks ----
const app = express();
app.get("/", (req, res) => res.send("SPOT MASTER AI running"));
app.get("/actives", (req, res) => res.json({ ok: true, when: new Date().toISOString() }));
app.listen(PORT, () => logv(`Server listening on ${PORT}`));

// ping PRIMARY_URL if configured (keepalive)
if (PRIMARY_URL) {
  setInterval(() => {
    try { https.get(PRIMARY_URL); } catch(e) { logError("Primary ping error", e?.message); }
  }, 5 * 60 * 1000).unref();
}

// ---- Scheduling & integration ----

// 1) Quick "fast" learn - run manually after startup and also scheduled by learning engine itself
try {
  setTimeout(async () => {
    try {
      if (typeof learningEngine.quickLearn48h === "function") {
        await learningEngine.quickLearn48h();
        logv("[FAST-LEARN] QuickLearn48h manually started.");
      } else {
        logv("[FAST-LEARN] quickLearn48h() not found in learningEngine");
      }
    } catch (err) {
      logError("[FAST-LEARN] Error in quickLearn48h:", err?.message || err);
    }
  }, QUICK_LEARN_START_DELAY_MS);
} catch (e) {
  logError("[FAST-LEARN] schedule error", e?.message || e);
}

// 2) Auto-learn intervals (48h and 7d) - rely on learningEngine exports
if (typeof learningEngine.quickLearn48h === "function") {
  setInterval(async () => {
    try {
      await learningEngine.quickLearn48h();
      logv("[AUTO] quickLearn48h scheduled run complete");
    } catch (e) { logError("[AUTO] quickLearn48h error", e?.message || e); }
  }, AUTO_LEARN_48H_MS);
} else {
  logv("[AUTO] quickLearn48h not present - skipping scheduled 48h");
}

if (typeof learningEngine.deepLearn7d === "function") {
  setInterval(async () => {
    try {
      await learningEngine.deepLearn7d();
      logv("[AUTO] deepLearn7d scheduled run complete");
    } catch (e) { logError("[AUTO] deepLearn7d error", e?.message || e); }
  }, AUTO_LEARN_7D_MS);
} else {
  logv("[AUTO] deepLearn7d not present - skipping scheduled 7d");
}

// 3) Integration: Auto-learning loop (checks outcomes -> compute adjustments -> apply)
if (typeof learningEngine.checkOutcomesForPending === "function" && typeof learningEngine.computeAdjustments === "function" && typeof learningEngine.applyAdjustments === "function") {
  setInterval(async () => {
    try {
      const checked = await learningEngine.checkOutcomesForPending();
      if (checked > 0) {
        const adj = await learningEngine.computeAdjustments();
        if (adj) {
          logv(`[LEARNING] ${checked} signals processed, adjustments computed`);
        } else {
          logv(`[LEARNING] ${checked} signals processed, no adjustments required`);
        }
      } else {
        logv(`[LEARNING] no new signals checked`);
      }
    } catch (err) {
      logError("[LEARNING LOOP ERROR]", err?.message || err);
    }
  }, 6 * 3600 * 1000); // every 6 hours
} else {
  logv("[LEARNING LOOP] learning engine missing some functions - skipping auto-learning loop");
}

// 4) Rotation Flow / Pre-breakout scanner (new module) - scans whole exchange every ROTATION_SCAN_MS
if (typeof scanRotationFlow === "function") {
  setInterval(async () => {
    try {
      logv("[ROTATION] Running scanRotationFlow()");
      await scanRotationFlow({ sendTelegram }); // pass helper to module if it accepts
      logv("[ROTATION] scanRotationFlow complete");
    } catch (err) {
      logError("[ROTATION] scanRotationFlow error", err?.message || err);
    }
  }, ROTATION_SCAN_MS);

  // run an initial one at startup (non-blocking)
  (async () => {
    try {
      await scanRotationFlow({ sendTelegram });
      logv("[ROTATION] initial scanRotationFlow done");
    } catch (e) { logError("[ROTATION] initial error", e?.message || e); }
  })();
} else {
  logv("[ROTATION] scanRotationFlow() not found - skipping rotation pre-breakout");
}

// 5) rotation_flow_live (if exists) - parallel scanner (e.g. live rotation flow)
if (typeof rotationFlowScan === "function") {
  setInterval(async () => {
    try {
      logv("[ROT-LIVE] Running rotationFlowScan()");
      await rotationFlowScan({ sendTelegram });
      logv("[ROT-LIVE] rotationFlowScan complete");
    } catch (err) {
      logError("[ROT-LIVE] rotationFlowScan error", err?.message || err);
    }
  }, ROTATION_SCAN_MS);
} else {
  logv("[ROT-LIVE] rotationFlowScan not found - skipping rotation_flow_live");
}

// 6) Adaptive scanning / main engine (if you have adaptiveScan or main scan function inside learningEngine)
if (typeof learningEngine.adaptiveScan === "function") {
  (async () => {
    try {
      await learningEngine.adaptiveScan();
      logv("[ADAPTIVE] initial adaptiveScan() done");
    } catch (e) { logError("[ADAPTIVE] initial adaptiveScan error", e?.message || e); }
  })();
} else {
  logv("[ADAPTIVE] adaptiveScan() not present in learningEngine - skip initial adaptive run");
}

// ---- Quick startup Telegram notification ----
(async () => {
  try {
    logv("SPOT MASTER AI starting up...");
    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
      await sendTelegram(`<b>[SPOT MASTER AI]</b>\nStarted. Adaptive scan active.`, true);
    }
  } catch (e) {
    logError("startup notify error", e?.message || e);
  }
})();

// export for testing if needed
export default {
  sendTelegram,
};
