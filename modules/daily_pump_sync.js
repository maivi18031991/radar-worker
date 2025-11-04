// ===============================
// 🔥 DAILY PUMP SYNC v2.1
// Bắt coin đang bay trong ngày (sắp lọt top tăng Binance)
// ===============================

import fetch from "node-fetch";
import { pushSignal } from "../server_utils.js"; // giữ nguyên nếu mày đã có

export async function scanDailyPumpSync() {
  const url = "https://api.binance.com/api/v3/ticker/24hr";
  const res = await fetch(url);
  const data = await res.json();

  let hits = [];

  for (const t of data) {
    if (!t.symbol.endsWith("USDT")) continue;

    const vol = parseFloat(t.quoteVolume);
    const change24 = parseFloat(t.priceChangePercent) / 100;
    const lastPrice = parseFloat(t.lastPrice);
    const openPrice = parseFloat(t.openPrice);
    const change6h = (lastPrice - openPrice) / openPrice;
    const high = parseFloat(t.highPrice);
    const low = parseFloat(t.lowPrice);
    const rangeRatio = (high - low) / low;
    const volRatio = vol / 1_000_000; // quy đổi tương đối theo thanh khoản
    const conf =
      (Math.min(volRatio * 25, 50) + Math.min(change24 * 200, 50)) *
      (1 - Math.min(rangeRatio, 0.25));

    // Bộ lọc pump thật sự
    if (vol >= 1_000_000 && volRatio >= 1.6 && change6h >= 0.02 && rangeRatio < 0.18) {
      // ⚡ Log coin gần lọt top tăng (chuẩn bị lọt top Binance)
      console.log(
        `[TOP MONITOR] ${t.symbol} volRatio=${volRatio.toFixed(2)} change6h=${(
          change6h * 100
        ).toFixed(1)}% range=${(rangeRatio * 100).toFixed(1)}%`
      );

      // 🚀 Push tín hiệu sang Telegram
      await pushSignal("[TOP MONITOR]", {
        symbol: t.symbol,
        volRatio,
        change6h,
        rangeRatio,
        conf: Math.round(conf),
      }, conf);

      // ✅ Ghi nhận tín hiệu daily pump
      hits.push({
        symbol: t.symbol,
        type: "DAILY_PUMP",
        conf: Math.round(conf),
        payload: { vol, change24, change6h, rangeRatio, volRatio },
      });
    }
  }

  console.log(`[DAILY PUMP] Done scanning. Hits=${hits.length}`);
  return hits;
}
import fetch from "node-fetch";

export async function pushSignal(tag, payload, conf) {
  try {
    const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
    const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;

    let msg = `${tag}\n`;
    if (payload.symbol) msg += `Symbol: <b>${payload.symbol}</b>\n`;
    if (payload.conf) msg += `Conf: ${Math.round(payload.conf)}%\n`;
    if (payload.price) msg += `Price: ${payload.price}\n`;
    msg += `Time: ${new Date().toLocaleString("vi-VN")}`;

    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: "HTML"
      })
    });
  } catch (err) {
    console.error("[pushSignal ERROR]", err.message);
  }
}
