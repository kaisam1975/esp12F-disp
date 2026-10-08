# Changelog

本文件記錄本專案所有值得注意的變更。

格式基於 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)。

## [Unreleased]

### Added
- 新增 Docker API server（`server/`）：背景定期刷新並快取 Claude Code 5 小時額度（讀 Anthropic 官方 rate-limit API）與 Grok 額度（讀本機 Grok CLI 的 log），提供 `GET /display` 單一端點，資料來源異常時優雅降級為保留舊值 + `ok:false`，不會讓端點失敗
- 新增 ESP-12F PlatformIO 韌體（`firmware/`）：WiFi 連線、每 30 秒輪詢 `/display`、SSD1306 OLED 顯示兩項額度百分比、長條圖與重置倒數；WiFi 斷線與資料過舊都有對應畫面提示
- 新增 `firmware/scripts/gen_secrets.py`：建置前自動從根目錄 `.env` 產生 `include/secrets.h`，WiFi 密碼等機密不進版本控制
- 新增 `firmware/tools/i2c_scanner`：獨立的 I2C 接線診斷小工具
- 新增專案文件：SRS、API 規格書、README、STYLE_GUIDE、TROUBLESHOOTING、DEVELOPMENT_LOG
