// server_final.mjs
// Consolidated server: adaptive scan + quickLearn + deepLearn + rotation pre-breakout integration
// Paste into repo root as server_final.mjs
// Node >=16 recommended. Install: npm i node-fetch express

import fetchNode from "node-fetch";
import fs from "fs/promises";
import path from "path";
import https from "https";
import express from "express";

const fetch = (global.fetch || fetchNode);

// Try to import existing learning engine and rotation module; if not found, provide safe fallback:
let learningEngine;
try {
  learningEngine = await import("./learning_engine.js");
} catch (e) {
  console.log("[SERVER] learning_engine.js not found, using fallback stub.");
  learningEngine = {
    async quickLearn48h() { console.log("[LEARNING_STUB] quickLearn48h"); return 0; },
    async deepLearn7d() { console.log("[LEARNING_STUB] deepLearn7d"); return 0; },
    async computeAdjustments() { return {}; }
  };
}

let rotationModule;
try {
  rotationModule = await import("./modules/rotation_prebreakout.js");
} catch (e) {
  console.log("[SERVER] rotation_prebreakout.js not found, using internal simple wrapper.");
  // fallback wrapper that returns empty results
  rotationModule = {
    async scanRotationFlow() { console.log("[ROTATION_STUB] no module, returning []"); return []; }
  };
}

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const AUTO_LEARN_48H_MS = (process.env.AUTO_LEARN_48H_MS ? Number(process.env.AUTO_LEARN_48H_MS) : 48 * 3600 * 1000);
const AUTO_LEARN_7D_MS = (process.env.AUTO_LEARN_7D_MS ? Number(process.env.AUTO_LEARN_7D_MS) : 7 * 24 * 3600 * 1000);
const ROTATION_INTERVAL_MS = (process.env.ROTATION_INTERVAL_MS ? Number(process.env.ROTATION_INTERVAL_MS) : 6 * 3600 * 1000);
const DATA_DIR = path.join(process.cwd(), "data");
const HYPER_FILE = path.join(DATA_DIR, "hyper_spikes.json");

// ---------- util ----------
async function ensureDataDir(){ try{ await fs.mkdir(DATA_DIR, {recursive:true}); }catch(e){} }
async function saveJSON(file, obj){ await ensureDataDir(); await fs.writeFile(file, JSON.stringify(obj, null, 2), "utf8"); }
async function readJSON(file, def=[]){ try{ const txt = await fs.readFile(file,"utf8"); return JSON.parse(txt||"null") || def; } catch(e){ return def; } }

// safe send Telegram (supports HTML formatting)
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[TELE] skip sendTelegram (token/chat missing)");
    return false;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true };
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || "tg error");
    return true;
  } catch (e) {
    console.error("[TELE] send error:", e.message || e);
    return false;
  }
}

// expose global sendTelegram so modules can call it
global.sendTelegram = sendTelegram;

// ---------- High-level scheduled tasks ----------

// Quick learn (manual + auto)
async function doQuickLearn48h() {
  try {
    console.log("[QUICKLEARN] start");
    const r = await learningEngine.quickLearn48h?.();
    console.log("[QUICKLEARN] done", r);
    return r;
  } catch (e) { console.error("[QUICKLEARN] error", e?.message || e); return null; }
}

// Deep learn 7d
async function doDeepLearn7d() {
  try {
    console.log("[DEEPLEARN] start");
    const r = await learningEngine.deepLearn7d?.();
    console.log("[DEEPLEARN] done", r);
    return r;
  } catch (e) { console.error("[DEEPLEARN] err", e?.message || e); return null; }
}

// Rotation scanner (pre-breakout)
async function doRotationScan() {
  try {
    console.log("[ROTATION] start scanRotationFlow");
    const out = await rotationModule.scanRotationFlow();
    // rotationModule may auto-send telegrams; we also can post a summary
    if (Array.isArray(out) && out.length) {
      const top = out.slice(0,5).map(r => `${r.symbol} ${r.Conf}%`).join(" | ");
      console.log(`[ROTATION] top -> ${top}`);
    } else {
      console.log("[ROTATION] no results");
    }
    return out;
  } catch(e) {
    console.error("[ROTATION] err", e?.message || e);
    return [];
  }
}

// Adaptive learning loop integration (periodic auto-learning)
async function autoLearningLoop() {
  try {
    // run deep learning every AUTO_LEARN_7D_MS, quick learn every AUTO_LEARN_48H_MS
    // but here we call quick + deep when scheduled externally by setInterval below.
    console.log("[AUTO_LEARN] heartbeat");
  } catch(e) {
    console.error("[AUTO_LEARN] err", e?.message || e);
  }
}

// ---------- Express API (keepalive + debug) ----------
const app = express();
app.use(express.json());

app.get("/", (req,res) => res.send("SPOT MASTER AI - server_final active"));
app.get("/health", (req,res) => res.json({ ok:true, ts: Date.now() }));
app.get("/rotation", async (req,res) => {
  const out = await doRotationScan();
  res.json({ results: out });
});
app.get("/learn/quick", async (req,res) => {
  const out = await doQuickLearn48h();
  res.json({ ok:true, result: out });
});
app.get("/learn/deep", async (req,res) => {
  const out = await doDeepLearn7d();
  res.json({ ok:true, result: out });
});
app.get("/hyper_spikes", async (req,res) => {
  const arr = await readJSON(HYPER_FILE, []);
  res.json(arr);
});

app.listen(PORT, ()=>console.log(`[SERVER] listening ${PORT}`));

// ---------- Startup actions ----------
// quick startup notification
(async ()=>{
  console.log("[SERVER] startup");
  await sendTelegram?.("<b>[SPOT MASTER AI]</b>\nStarted. Adaptive scan active.");
})();

// initial runs and scheduling
// manual quick start after boot (small delay to let imports settle)
setTimeout(() => {
  doQuickLearn48h().catch(()=>{});
}, 5000);

// schedule periodic tasks
setInterval(() => { doQuickLearn48h().catch(()=>{}); }, AUTO_LEARN_48H_MS); // default 48h
setInterval(() => { doDeepLearn7d().catch(()=>{}); }, AUTO_LEARN_7D_MS);     // default 7d
setInterval(() => { doRotationScan().catch(()=>{}); }, ROTATION_INTERVAL_MS); // default 6h

// keepalive ping for PRIMARY_URL if set (Render-style)
if (process.env.PRIMARY_URL) {
  setInterval(async ()=>{
    try { await fetch(process.env.PRIMARY_URL); } catch(e){}
  }, 5 * 60 * 1000);
}

export default { doQuickLearn48h, doDeepLearn7d, doRotationScan };
