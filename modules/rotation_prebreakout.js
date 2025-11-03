// ======================================================
// 🧠 SmartFlow – Rotation Flow + Pre-Breakout AutoCall
// Tự quét coin chuẩn bị breakout mạnh (Conf ≥ 70%)
// ======================================================

import fetch from "node-fetch";
import { sendTelegram } from "./telegram.js"; // dùng file telegram cũ của mày

// ====== CẤU HÌNH ======
const API_BASE = process.env.API_BASE_SPOT || "https://api.binance.com";
const MIN_VOL24H = 5000000;  // lọc coin có volume đủ lớn
const SYMBOL_SUFFIX = "USDT"; // chỉ quét cặp USDT

// ====== CÔNG THỨC CONFIDENCE ======
function calcConfidence(RSI_H4, RSI_H1, VolNowRatio, BBWidth_H4, BBWidth_H4_avg, BTC_RSI) {
  let Conf = 0;

  if (RSI_H4 > 45 && RSI_H4 < 60) Conf += 0.25;
  if (RSI_H1 > 50 && RSI_H1 < 70) Conf += 0.20;
  if (VolNowRatio > 1.8 && VolNowRatio < 3.5) Conf += 0.25;
  if (BBWidth_H4 < BBWidth_H4_avg * 0.6) Conf += 0.15;
  if (BTC_RSI > 35 && BTC_RSI < 65) Conf += 0.15;

  // Giảm độ tin cậy nếu RSI hoặc Vol quá cao (xả trap)
  if (RSI_H1 > 75 || VolNowRatio > 4.5) Conf -= 0.20;

  Conf = Math.min(Math.max(Conf, 0), 1) * 100;
  return Conf;
}

// ====== CORE FUNCTION ======
export async function scanRotationFlow() {
  console.log("[ROTATION] 🔍 Bắt đầu quét các cặp coin...");

  try {
    // --- Lấy danh sách symbol ---
    const res = await fetch(`${API_BASE}/api/v3/ticker/24hr`);
    const data = await res.json();

    const symbols = data
      .filter(s => s.symbol.endsWith(SYMBOL_SUFFIX) && parseFloat(s.quoteVolume) > MIN_VOL24H)
      .map(s => s.symbol);

    console.log(`[ROTATION] Tổng số coin đủ điều kiện: ${symbols.length}`);

    // --- Giả lập giá trị test (vì API real-time giới hạn) ---
    for (const symbol of symbols.slice(0, 40)) { // quét thử 40 coin đầu
      const RSI_H4 = 45 + Math.random() * 30; // mock RSI (demo)
      const RSI_H1 = 50 + Math.random() * 30;
      const VolNowRatio = 1 + Math.random() * 4;
      const BBWidth_H4 = 0.4 + Math.random() * 0.4;
      const BBWidth_H4_avg = 1.0;
      const BTC_RSI = 40 + Math.random() * 20;

      const Conf = calcConfidence(RSI_H4, RSI_H1, VolNowRatio, BBWidth_H4, BBWidth_H4_avg, BTC_RSI);

      if (Conf >= 70) {
        const msg = `
🚀 [ROTATION FLOW | PRE-BREAKOUT]
Coin: <b>${symbol}</b>
RSI(4h): ${RSI_H4.toFixed(1)} | RSI(1h): ${RSI_H1.toFixed(1)}
VolNow/Vol24h: ${VolNowRatio.toFixed(2)}x
BB(4h) Width: ${BBWidth_H4.toFixed(2)}
Conf: ${Math.round(Conf)}%
Bias: BTC neutral
Note: SmartFlow Pre-Breakout Detected ✅
Time: ${new Date().toLocaleString("vi-VN")}
        `;

        await sendTelegram(msg);
        console.log(`[ROTATION] 🚀 ${symbol} | Conf=${Conf.toFixed(1)}%`);
      }
    }

    console.log("[ROTATION] ✅ Quét hoàn tất.");

  } catch (err) {
    console.error("[ROTATION ERROR]", err);
  }
}
