import express from "express";
import fetch from "node-fetch";
const app = express();
const PORT = process.env.PORT || 10000;

// Hàm lấy dữ liệu nhanh từ Binance
app.get("/analyze", async (req, res) => {
  try {
    const { symbol = "BTCUSDT", interval = "1h" } = req.query;
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=50`;

    const response = await fetch(url);
    const data = await response.json();

    if (!Array.isArray(data)) throw new Error("Invalid data");

    const closes = data.map(c => Number(c[4]));
    const avg = closes.reduce((a, b) => a + b, 0) / closes.length;
    const lastPrice = closes.at(-1);
    const ratio = ((lastPrice - avg) / avg * 100).toFixed(2);

    res.json({
      symbol,
      lastPrice,
      ratio: `${ratio}%`,
      candles: data.length,
      time: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto ping để Render không sleep
setInterval(() => {
  fetch(`https://radar-worker-yte4.onrender.com`)
    .then(() => console.log("Ping success ✅"))
    .catch(() => console.log("Ping failed ❌"));
}, 600000); // mỗi 10 phút ping 1 lần

app.listen(PORT, () => console.log(`🚀 Radar Worker running on port ${PORT}`));
