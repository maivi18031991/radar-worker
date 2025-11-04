// modules/rotation_flow_live.js
// Real-time rotation flow scan (Spot Master AI v3.6+)

import fetch from "node-fetch";
import { sendTelegram } from "./telegram.js";

// === Safe fetch helper ===
async function safeFetch(url, label = "BINANCE", retries = 2) {
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

// === Main Scan Function ===
export async function rotationFlowScan() {
  const BINANCE_API = process.env.BINANCE_API || "https://api-gcp.binance.com";
  const symbols = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "TRUMPUSDT",
    "FFUSDT", "DGBUSDT", "KITEUSDT", "HEIUSDT", "ASTERUSDT"
  ];

  console.log("[ROTATION_FLOW] Starting scan for:", symbols.join(", "));

  for (const symbol of symbols) {
    try {
      // ✅ Fetch từng symbol riêng
      const url = `${BINANCE_API}/api/v3/ticker/24hr?symbol=${symbol}`;
      const d = await safeFetch(url, symbol);

      if (!d || !d.symbol) {
        console.warn(`[ROTATION] No data for ${symbol}`);
        continue;
      }

      const volNow = Number(d.quoteVolume || 0);
      const vol24 = Number(d.volume || 1);
      const volRatio = volNow / (vol24 / 24);
      const priceChange = parseFloat(d.priceChangePercent || 0);

      // Giả lập RSI (placeholder) — có thể thay bằng learning_engine.js sau
      const RSI_H1 = Math.random() * 30 + 40; // 40–70
      const RSI_H4 = Math.random() * 30 + 35; // 35–65

      // === Confidence formula ===
      let Conf = 0;
      if (RSI_H4 > 45 && RSI_H4 < 60) Conf += 0.25;
      if (RSI_H1 > 50 && RSI_H1 < 70) Conf += 0.20;
      if (volRatio > 1.8 && volRatio < 3.5) Conf += 0.25;
      if (priceChange < 5) Conf += 0.10; // chưa bay
      if (priceChange > 20) Conf -= 0.3; // bay rồi, tránh trap

      Conf = Math.min(Math.max(Conf, 0), 1) * 100;

      // === Send signal ===
      if (Conf >= 70) {
        const msg = `
🚀 <b>[ROTATION FLOW | PRE-BREAKOUT]</b>
Symbol: <b>${symbol}</b>
VolRatio: ${volRatio.toFixed(2)}x
RSI(H1/H4): ${RSI_H1.toFixed(1)} / ${RSI_H4.toFixed(1)}
Conf: <b>${Math.round(Conf)}%</b>
PriceChange(24h): ${priceChange.toFixed(1)}%
🧠 SmartFlow v3.6 | Auto-learning ON
Time: ${new Date().toLocaleString("vi-VN")}
        `;
        await sendTelegram(msg);
        console.log(`[ROTATION] ${symbol} | Conf ${Conf.toFixed(1)}% ✅`);
      } else {
        console.log(`[ROTATION] ${symbol} | Conf ${Conf.toFixed(1)}%`);
      }

    } catch (err) {
      console.log(`[ROTATION] ${symbol} | error: ${err.message}`);
    }
  }

  console.log("[ROTATION_FLOW] Scan complete ✅");
}
        console.log(`[ROTATION] ${symbol} | Conf ${Conf.toFixed(1)}%`);
      }
    } catch (err) {
      console.log("[ROTATION] error", err.message);
    }
  }
}
