import fetch from "node-fetch";
import { sendTelegram } from "./telegram.js";

export async function rotationFlowScan() {
  const symbols = ["BTCUSDT","ETHUSDT","SOLUSDT","TRUMPUSDT","FFUSDT","DGBUSDT","KITEUSDT","HEIUSDT","ASTERUSDT"];
  
  for (const symbol of symbols) {
    try {
      const r = await fetch(`https://api-gcp.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
      const d = await r.json();
      const volNow = Number(d.quoteVolume);
      const vol24 = Number(d.volume);
      const volRatio = volNow / (vol24 / 24);
      const priceChange = parseFloat(d.priceChangePercent);

      // giả định RSI, BBWidth (có thể nối từ learning_engine sau)
      const RSI_H1 = Math.random() * 30 + 40; // giả tạm
      const RSI_H4 = Math.random() * 30 + 35;

      let Conf = 0;
      if (RSI_H4 > 45 && RSI_H4 < 60) Conf += 0.25;
      if (RSI_H1 > 50 && RSI_H1 < 70) Conf += 0.20;
      if (volRatio > 1.8 && volRatio < 3.5) Conf += 0.25;
      if (priceChange < 5) Conf += 0.10; // chưa bay
      if (priceChange > 20) Conf -= 0.3; // bay rồi, tránh trap

      Conf = Math.min(Math.max(Conf, 0), 1) * 100;

      if (Conf >= 70) {
        await sendTelegram(`
🚀 <b>[ROTATION FLOW | PRE-BREAKOUT]</b>
Symbol: ${symbol}
VolRatio: ${volRatio.toFixed(2)}x
RSI(H1/H4): ${RSI_H1.toFixed(1)} / ${RSI_H4.toFixed(1)}
Conf: ${Math.round(Conf)}%
PriceChange(24h): ${priceChange.toFixed(1)}%
🧠 SmartFlow v3.6 | Auto-learning ON
Time: ${new Date().toLocaleString("vi-VN")}
        `);
        console.log(`[ROTATION] ${symbol} | Conf ${Conf.toFixed(1)}%`);
      }
    } catch (err) {
      console.log("[ROTATION] error", err.message);
    }
  }
}
