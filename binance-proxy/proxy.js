import express from "express";
import fetch from "node-fetch";
const app = express();

app.get("/ticker", async (req, res) => {
  try {
    const r = await fetch("https://api.binance.me/api/v3/ticker/24hr", {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(8080, () => console.log("✅ Proxy Binance running on port 8080"));
