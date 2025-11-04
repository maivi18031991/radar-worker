// modules/daily_pump_sync.js
// Detect top daily pump coins (Spot Master AI v3.6+)
// Scans Binance tickers every 4h and returns high momentum coins.

import fetch from "node-fetch";

// === Safe fetch helper ===
async function safeFetch(url, label = "BINANCE 24H", retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (SpotMasterAI/3.6)",
          "Accept": "application/json"
        }
      });
      if (!resp.ok) {
        console.error(`[${label}] Fetch failed (${resp.status})`);
        await new Promise(r => setTimeout(r, 300 * (i + 1)));
        continue;
      }
      return await resp.json();
    } catch (err) {
      console.error(`[${label}] Fetch error:`, err.message);
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw new Error(`${label} fetch failed after ${retries + 1} attempts`);
}

// === Main scan function ===
export async function scanDailyPumpSync() {
  const BINANCE_API = process.env.BINANCE_API || "https://api-gcp.binance.com";
  const url = `${BINANCE_API}/api/v3/ticker/24hr`;

  console.log("[DAILY_PUMP] Fetching:", url);

  let data = [];
  try {
    data = await safeFetch(url, "BINANCE DAILY PUMP");
  } catch (err) {
    console.error("[DAILY_PUMP] Fetch error:", err.message);
    return [];
  }

  if (!Array.isArray(data)) {
    console.warn("[DAILY_PUMP] Invalid data from Binance.");
    return [];
  }

  // Sort theo % tăng giá và khối lượng lớn
  const sorted = data
    .filter(d => Number(d.volume) > 1_000_000) // lọc coin có volume cao
    .sort((a, b) => Number(b.priceChangePercent) - Number(a.priceChangePercent))
    .slice(0, 15); // lấy top 15

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

  console.log(`[DAILY_PUMP] Found ${results.length} top movers`);
  return results;
}
