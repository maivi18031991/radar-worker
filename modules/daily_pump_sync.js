// modules/daily_pump_sync.js
// Detect top daily pump coins (works with Spot Master AI v3.5+)
// Runs every 4h to scan Binance tickers and return high momentum coins.

import fetch from "node-fetch";

// === Main scan function ===
export async function scanDailyPumpSync() {
  const url = "https://api-gcp.binance.com/api/v3/ticker/24hr";
  console.log("[DAILY_PUMP] Fetching:", url);

  const res = await fetch(url);
  const data = await res.json();

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

  return results;
}
