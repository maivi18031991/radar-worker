// backtester.js
// Simple analyzer for data/hyper_spikes.json
// Run: node backtester.js

import fs from "fs/promises";
import path from "path";

const HYPER = path.join(process.cwd(), "data", "hyper_spikes.json");

async function load() {
  try {
    const txt = await fs.readFile(HYPER, "utf8");
    return JSON.parse(txt || "[]");
  } catch (e) {
    console.error("No hyper_spikes.json found.");
    return [];
  }
}

function summarize(arr) {
  if (!arr.length) { console.log("No data"); return; }
  const bySymbol = arr.reduce((acc, r) => {
    if (!acc[r.symbol]) acc[r.symbol] = [];
    acc[r.symbol].push(r);
    return acc;
  }, {});
  const summary = Object.entries(bySymbol).map(([sym, list]) => {
    const avgConf = list.reduce((s,x)=>s+x.Conf,0)/list.length;
    return { symbol: sym, count: list.length, avgConf: Math.round(avgConf) };
  }).sort((a,b)=>b.count - a.count);
  console.table(summary.slice(0,50));
}

(async ()=>{
  const data = await load();
  console.log("entries:", data.length);
  summarize(data);
})();
