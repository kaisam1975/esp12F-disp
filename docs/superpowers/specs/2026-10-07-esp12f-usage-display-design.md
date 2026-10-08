# ESP-12F OLED 使用量顯示器 — 設計文件

日期：2026-10-07

## 1. 目標

用一片 ESP-12F（ESP8266）接 0.96 吋 I2C OLED（SSD1306 128x64），顯示：

- Claude Code 的 5 小時額度使用率（%）與距離下次重置的倒數時間
- Grok（grok.com 網頁版）的額度使用率（%）與距離下次重置的倒數時間

資料由一個跑在 Docker 裡的 API server 負責抓取、計算、快取，ESP8266 每 30 秒向這個 API server 查詢一次，自己在本地做每秒倒數動畫。

成功標準：
- OLED 上能同時看到 Claude 與 Grok 的額度 % 與重置倒數
- WiFi 或 API 連線中斷時，畫面有明確提示（不會卡死或顯示錯誤資料裝作正常）
- Grok 登入 session 過期時，Grok 那一行顯示「N/A」，不影響 Claude 那一行正常顯示
- 所有機密（WiFi 密碼等）不進 git

## 2. 整體架構

```
[ESP-12F + SSD1306 OLED]
        |  每 30 秒 HTTP GET /display
        v
[Docker: usage-api (Node.js + Express + Playwright)]
        |-- Claude 模組：讀取主機 ~/.claude 的 OAuth token，
        |     呼叫 Anthropic 官方 rate-limit API，每 ~60 秒刷新一次，快取於記憶體
        |-- Grok 模組：headless 瀏覽器載入預先存好的登入 storage_state，
              開 grok.com 抓額度文字，每 ~5~10 分鐘刷新一次，快取於記憶體
```

兩個資料來源都是「背景定期刷新 + 記憶體快取」，`/display` 端點永遠直接回快取內容，不會讓 ESP 的請求卡住等外部 API。

## 3. 專案目錄結構

```
esp12F-disp/
├── .env                      # 根目錄唯一一份機密設定，不進 git
├── .env.example               # 範例，進 git
├── .gitignore
├── docker-compose.yml
├── server/                    # Docker API server
│   ├── Dockerfile
│   ├── package.json
│   ├── src/
│   │   ├── index.js           # Express app + /display endpoint
│   │   ├── claude.js          # Claude 額度抓取模組
│   │   └── grok.js            # Grok 額度抓取模組（Playwright）
│   └── scripts/
│       └── grok-login.js      # 在 host 上手動執行的一次性登入腳本
├── firmware/                  # PlatformIO 專案
│   ├── platformio.ini
│   ├── scripts/
│   │   └── gen_secrets.py     # pre-build：讀根目錄 .env 產生 include/secrets.h
│   ├── include/
│   │   └── secrets.h          # 自動產生，不進 git
│   └── src/
│       └── main.cpp
└── docs/superpowers/specs/...
```

## 4. `.env` 內容（根目錄唯一一份，給 docker-compose 與韌體共用）

```
WIFI_SSID=...
WIFI_PASSWORD=...
API_BASE_URL=http://<這台機器的區域網路IP>:8787
PORT=8787
CLAUDE_REFRESH_SECONDS=60
GROK_REFRESH_SECONDS=300
```

- `docker-compose.yml` 直接用 `env_file: .env` 讀取 `PORT`、`CLAUDE_REFRESH_SECONDS`、`GROK_REFRESH_SECONDS`。
- `firmware/scripts/gen_secrets.py` 在 PlatformIO build 前讀同一份 `.env`，產生 `include/secrets.h`（`#define WIFI_SSID "..."` 等）。

## 5. API Server

### 5.1 技術選擇
Node.js + Express + Playwright（用官方 `mcr.microsoft.com/playwright` base image，內建 Chromium 與系統相依套件，省去自己裝瀏覽器依賴的麻煩）。

### 5.2 Claude 額度模組 (`server/src/claude.js`)
- 掛載主機 `~/.claude` 為唯讀 volume（`docker-compose.yml` 中 `~/.claude:/root/.claude:ro`）。
- 讀取其中的 OAuth token（走跟本機已安裝的 `rz1989s/claude-code-statusline` 工具同一條路：讀取 Claude Code 存放的 credentials 檔案）。
- 用該 token 呼叫 Anthropic 官方 rate-limit 端點，取得 `five_hour.resets_at` 與對應使用率。
- 背景計時器每 `CLAUDE_REFRESH_SECONDS` 秒刷新一次，結果存在記憶體變數 `claudeCache = { percent, resetAt, ok, updatedAt }`。
- 呼叫失敗（token 失效、網路問題等）時維持上一次成功的快取值，並把 `ok` 設為 `false` 讓前端知道資料可能過舊；完全沒有過快取資料時回 `percent: null`。

### 5.3 Grok 額度模組 (`server/src/grok.js`)
- 讀取唯讀掛載的 `grok-storage-state.json`（Playwright storage state：cookies + localStorage）。
- 背景計時器每 `GROK_REFRESH_SECONDS` 秒：啟動一個 headless Chromium context（帶入 storage state）→開 grok.com →用 DOM selector 抓額度文字與重置時間 →關閉 context。
- 解析失敗（selector 找不到、session 過期跳回登入頁等）時，`grokCache.ok = false`，`percent` 維持上次成功值或 `null`。
- selector 集中寫在檔案最上方幾個常數，方便之後 grok.com 改版時快速修改。

### 5.4 一次性登入腳本 (`server/scripts/grok-login.js`)
- 在 **host 機器**（不是容器裡）用 `node server/scripts/grok-login.js` 執行，開一個「有畫面」的瀏覽器視窗。
- 使用者手動完成 Google/Apple SSO 登入。
- 登入成功後腳本呼叫 `context.storageState({ path: 'grok-storage-state.json' })` 存檔。
- 這個檔案不進 git，容器啟動時唯讀掛載進去。
- session 過期時重跑這個腳本即可更新。

### 5.5 `GET /display` 端點
直接回傳記憶體快取，不觸發任何外部呼叫：

```json
{
  "claude": { "percent": 62, "resetSeconds": 8040, "ok": true },
  "grok":   { "percent": 30, "resetSeconds": 18120, "ok": true },
  "updatedAt": "2026-10-07T12:34:56Z"
}
```

- `percent: null` 或 `ok: false` 代表該來源目前沒有可信資料，ESP 端顯示「N/A」。
- `resetSeconds` 是「現在到重置」還剩多少秒，由 server 算好，ESP 不需要處理時區轉換。

## 6. ESP-12F 韌體

### 6.1 專案與函式庫
- PlatformIO，board `esp12e`（腳位相容 ESP-12F），framework = arduino
- 函式庫：`ArduinoJson`（解析 `/display` 回應）、`U8g2`（I2C SSD1306 128x64 驅動）

### 6.2 `setup()`
1. 初始化 I2C + U8g2，顯示開機畫面
2. 連 WiFi（用 `secrets.h` 的 `WIFI_SSID` / `WIFI_PASSWORD`），失敗時畫面顯示「WiFi 連線中...」並持續重試

### 6.3 `loop()`
- **每 30 秒**：對 `API_BASE_URL/display` 發 HTTP GET，用 ArduinoJson 解析回應：
  - 成功：更新本地變數 `claudePercent/claudeResetSeconds/claudeOk`、`grokPercent/grokResetSeconds/grokOk`，並記錄這次同步的 `millis()` 當基準點
  - 失敗/逾時：維持上次資料，但設一個 `dataStaleSince` 計時，超過一定時間（例如 2 分鐘沒同步成功）在畫面上顯示過舊提示
- **每 1 秒**：
  - 本地倒數秒數 = 上次同步拿到的 `resetSeconds` − (現在 `millis()` − 同步時的 `millis()`) / 1000，算出來顯示用，不會因為算太久而報錯（下限鎖在 0）
  - 重繪 OLED

### 6.4 畫面佈局（128x64）
兩個區塊，各佔半個畫面高度，每區塊：服務名稱 + 百分比 + 簡易長條圖 + 倒數時間（HH:MM:SS）。異常狀態：
- WiFi 斷線：全畫面顯示「WiFi 斷線重連中」，倒數暫停
- 該服務 `ok:false` 且無歷史快取：該區塊顯示「N/A」
- 距離上次成功同步超過 2 分鐘：該區塊角落顯示過舊提示（例如一個小驚嘆號圖示或閃爍文字）

## 7. 已知風險與限制

- **Grok 擷取是非官方網頁爬取**：grok.com 頁面結構沒有公開文件，之後改版可能讓 selector 失效，需要手動更新 `server/src/grok.js` 裡的 selector 常數。
- **Grok session 會過期**：SSO 登入的 session 到期後需要人工重跑 `grok-login.js`，無法完全自動化。
- **Claude rate-limit API 屬於 Anthropic 內部端點**：目前跟本機已安裝的第三方 statusline 工具走同一條路，但這不是公開 documented API，未來 Claude Code 更新後端點或 token 存放位置改變時可能需要調整。

## 8. 測試方式

- API server：本地跑 `docker compose up`，用 `curl localhost:8787/display` 檢查三種情境（Claude 正常/失敗、Grok 正常/失敗）回傳格式是否符合預期。
- 韌體：先用 Arduino 序列埠 log 確認 WiFi 連線與 HTTP 回應解析正確，再接上實體 OLED 驗證畫面佈局與倒數動畫；模擬斷網（拔 WiFi）與 API 回傳 `ok:false` 兩種情境確認畫面提示正確。
