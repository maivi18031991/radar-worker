import express from "express";
import fetch from "node-fetch";

const app = express();
const port = process.env.PORT || 3000;

// API proxy cho Binance
app.get("/analyze", async (req, res) => {
  const symbol = req.query.symbol || "BTCUSDT";
  const tf = req.query.interval || "1h";
  const base = "https://api.binance.com";

  try {
    const kline = await fetch(`${base}/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=100`);
    const data = await kline.json();
    const closes = data.map(c => Number(c[4]));
    const lastPrice = closes.at(-1);
    const avg = closes.slice(-20).reduce((a,b)=>a+b,0)/20;
    const ratio = (lastPrice - avg) / avg * 100;
    res.json({ symbol, lastPrice, ratio, dataPoints: data.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => console.log(`Radar worker running on ${port}`));
