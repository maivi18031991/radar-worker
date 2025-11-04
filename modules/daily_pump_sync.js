// --- modules/daily_pump_sync.js ---
// Detect top daily pump coins (works with Spot Master AI v3.6+)
// Auto-detect Binance API mirror for max stability.
// Author: ViXuan System Build

import fetch from "node-fetch";

// ===================== AUTO PICK BINANCE API =====================
async function autoPickBinanceAPI() {
  const mirrors = [
    "https://api-gcp.binance.com",
    "https://api1.binance.com",
    "https://api3.binance.com",
    "https://api4.binance.com",
    "https://data-api.binance.vision" // ✅ always works
  ];

  for (const url of mirrors) {
    try {
      const res = await fetch(`${url}/api/v3/ticker/24hr`);
      if (res.ok) {
        console.log(`[DAILY_PUMP] ✅ Selected Binance mirror: ${url}`);
        return url;
      } else {
        console.log(`[DAILY_PUMP] ⚠️ Mirror ${url} failed (${res.status})`);
      }
    } catch (e) {
      console.log(`[DAILY_PUMP] ❌ Mirror ${url} error: ${e.message}`);
    }
  }

  console.log("[DAILY_PUMP] ⚠️ All mirrors failed → fallback to data-api");
  return "https://data-api.binance.vision";
}

// --- Auto-detect mirror once at module load ---
const BINANCE_API = await autoPickBinanceAPI();

// ===================== MAIN SCAN FUNCTION =====================
export async function scanDailyPumpSync() {
  console.log(`[DAILY_PUMP] Fetching data from: ${BINANCE_API}/api/v3/ticker/24hr`);
  try {
    const res = await fetch(`${BINANCE_API}/api/v3/ticker/24hr`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!Array.isArray(data)) {
      console.warn("[DAILY_PUMP] Invalid data from Binance.");
      return [];
    }

    // Lọc top volume + % tăng giá cao nhất
    const sorted = data
      .filter(d => Number(d.volume) > 1_000_000 && d.symbol.endsWith("USDT"))
      .sort((a, b) => Number(b.priceChangePercent) - Number(a.priceChangePercent))
      .slice(0, 20); // lấy top 20 coin

    // Chuẩn hóa dữ liệu
    const results = sorted.map(d => ({
      symbol: d.symbol,
      priceChangePercent: Number(d.priceChangePercent),
      quoteVolume: Number(d.quoteVolume),
      conf:
        Number(d.priceChangePercent) >= 30
          ? 90
          : Number(d.priceChangePercent) >= 15
          ? 80
          : Number(d.priceChangePercent) >= 8
          ? 70
          : 60,
      note: "Daily top pump ranking",
    }));

    console.log(`[DAILY_PUMP] ✅ Found ${results.length} active pump signals`);
    return results;
  } catch (err) {
    console.error("[DAILY_PUMP] ❌ Fetch error:", err.message);
    return [];
  }
}
