# 📊 Spot SmartFlow Radar Bot

> Binance Spot Radar AI – Phiên bản tối ưu SmartFlow 2025  
> Tự động quét toàn bộ cặp USDT mỗi 1 phút, phát hiện dòng tiền mạnh, lọc nhiễu, học thông minh qua dữ liệu thị trường thực tế.

---

## 🚀 Chức năng chính
- Tự động quét **toàn bộ cặp USDT** mỗi 60s.
- Phân loại tín hiệu: **PRE**, **SPOT**, **GOLDEN**, **IMF**.
- Tự học hành vi giá (Auto-learning ON).
- Đối chiếu dữ liệu từ **Future OI, Funding, Volume**, xác định dòng tiền thật.
- Tự động **Exit signal** khi RSI/MA20 bị phá hoặc volume đảo chiều.
- Tự ping Render để giữ bot online liên tục.

---

## ⚙️ Cấu hình môi trường (.env)
```bash
TELEGRAM_TOKEN=xxxx
TELEGRAM_CHAT_ID=xxxx
API_BASE_SPOT=https://api.binance.com
PRIMARY_URL=https://radar-worker-xxxx.onrender.com
SCAN_INTERVAL_SEC=60
KEEP_ALIVE_INTERVAL=10
SYMBOL_MIN_VOL=10000000
SYMBOL_MIN_CHANGE=5
---

## ⚙️ SmartFlow 3-tier (PRE → SPOT → GOLDEN / IMF) – Tóm tắt chiến lược

### MARKET CONTEXT
- BTC Trend: xác định xu hướng tổng thể (UP / DOWN / NEUTRAL)
- BTC RSI: dùng để xác nhận vùng dòng tiền mạnh / yếu

### SMART FILTER
- Lọc chỉ cặp USDT thật (loại trừ token ảo / thanh khoản thấp)
- Yêu cầu min volume (vol24h > 10M mặc định)

### ENTRY TIERS
- **PRE:** volx ≥ 1.2, RSI 45–60, giá quanh MA20 → cảnh báo vùng test  
- **SPOT:** volx ≥ 1.5, giá > MA20, RSI 50–70 → xác nhận entry nhẹ  
- **GOLDEN:** giá > MA20 × 1.03, volx ≥ 1.8, change24 ≥ 6% → entry swing  
- **IMF:** volx ≥ 3.0, giá > MA20 × 0.995, RSI 55–70, change24 5–40% → early wave / dòng tiền mạnh

### EXIT RULES
- RSI collapse  
- MA20 cross (giá cắt xuống MA20)  
- Funding flip hoặc Volume giảm mạnh → gửi tín hiệu EXIT

### AUTO-LEARNING
- Lưu dữ liệu (symbol, RSI, volRatio, change24, confidence, result)
- Điều chỉnh ngưỡng tự động để duy trì winrate tối ưu
