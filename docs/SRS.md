# 軟體需求規範書 (SRS) — ESP-12F 使用量顯示器 (esp12F-disp)

## 1. 簡介

### 1.1 目的
記錄這個專案要解決的問題、系統範圍與功能需求，作為 API 規格書等其他文件的依據。

### 1.2 專案範圍
用一片 ESP-12F（ESP8266）接 0.96 吋 I2C OLED（SSD1306 128x64），即時顯示：

- Claude Code 的 5 小時額度使用率（%）與距離下次重置的倒數時間
- Grok（透過本機 Grok CLI 的 log）的額度使用率（%）與距離下次重置的倒數時間

資料由一個跑在 Docker 裡的 Node.js API server 負責抓取、計算、快取；ESP8266 每 30 秒向這個 API server 查詢一次，自己在本地做每秒倒數動畫。

**不做的事**：不提供使用者帳號系統、不提供歷史資料查詢/圖表、不支援多顆 ESP8266 裝置的個別化設定（目前假設單一顯示裝置、單一使用者）。

### 1.3 名詞定義
| 詞彙 | 說明 |
|------|------|
| 5 小時額度 | Anthropic 官方對 Claude Code 的 rolling 5 小時用量限制，對應 `rate_limits.five_hour` |
| 額度使用率 | 0-100 的整數百分比，代表目前視窗內已使用的額度比例 |
| 重置倒數 | 距離目前額度視窗結束、使用率歸零的剩餘秒數 |
| Stale（過舊） | 超過 2 分鐘沒有成功從 API server 同步到新資料 |

## 2. 系統總覽

### 2.1 系統情境
```
[ESP-12F + SSD1306 OLED]
        |  每 30 秒 HTTP GET /display
        v
[Docker: usage-api (Node.js + Express)]
        |-- Claude 模組：讀取主機 ~/.claude/.credentials.json 的 OAuth token，
        |     呼叫 Anthropic 官方 rate-limit API，每 60 秒刷新一次
        |-- Grok 模組：讀取主機 ~/.grok/logs/unified.jsonl，
              找最新一筆額度紀錄，每 300 秒刷新一次
```

### 2.2 使用者角色
| 角色 | 說明 |
|------|------|
| 使用者（擁有者） | 設定 `.env`、部署 Docker server、燒錄 ESP8266 韌體、平時只是看畫面 |

## 3. 功能需求

### FR-API-01：提供 Claude 額度查詢
- **描述**：API server 需定期從 Anthropic 官方 rate-limit API 取得目前 5 小時額度使用率與重置時間，並快取供查詢。
- **前置條件**：主機已透過 Claude Code 完成登入，`~/.claude/.credentials.json` 存在且含有效 OAuth token。
- **主要流程**：背景計時器每 `CLAUDE_REFRESH_SECONDS`（預設 60）秒讀取 token → 呼叫 `GET https://api.anthropic.com/api/oauth/usage` → 解析 `five_hour.utilization` 與 `five_hour.resets_at` → 更新快取。
- **例外流程**：token 不存在、API 回應非 200、或回應格式不符時，保留前一次成功的數值，並將 `ok` 標記為 `false`。
- **相關角色**：使用者（擁有者）

### FR-API-02：提供 Grok 額度查詢
- **描述**：API server 需定期讀取本機 Grok CLI 的 log 檔案，取出最新一筆帳單週期用量，並快取供查詢。
- **前置條件**：主機已安裝並至少執行過一次 Grok CLI，`~/.grok/logs/unified.jsonl` 存在且含至少一筆 `fetched credits config` 紀錄。
- **主要流程**：背景計時器每 `GROK_REFRESH_SECONDS`（預設 300）秒讀取 log 檔案 → 掃描找出最後一筆 `fetched credits config` 紀錄 → 解析 `creditUsagePercent` 與 `currentPeriod.end`（或 `billingPeriodEnd`）→ 更新快取。
- **例外流程**：log 檔案不存在、找不到任何符合的紀錄、或該筆紀錄格式不符時，保留前一次成功的數值，並將 `ok` 標記為 `false`。
- **相關角色**：使用者（擁有者）

### FR-API-03：容錯與資料降級
- **描述**：`GET /display` 永遠直接回應記憶體中的快取內容，不等待任何外部呼叫；任一資料來源失敗時，回應該來源「最後一次成功的數值 + `ok:false`」，從未成功過則回應 `percent:null, resetSeconds:null, ok:false`。
- **相關角色**：使用者（擁有者）、ESP-12F 顯示裝置

### FR-DISP-01：ESP8266 定期輪詢與本地倒數
- **描述**：ESP8266 每 30 秒向 API server 的 `/display` 發送一次請求，取得的 `resetSeconds` 作為基準，之後每秒在本地重新計算剩餘秒數（不需每秒都打 API）。
- **主要流程**：開機連線 WiFi → 迴圈中每 30 秒 poll 一次 → 成功時更新基準值與同步時間 → 每 1 秒重繪畫面。
- **例外流程**：WiFi 斷線時顯示全螢幕提示並暫停倒數；超過 30 秒內沒有任何成功同步時，該服務列顯示 N/A（目前已知限制：開機後第一次同步前的這段時間一律顯示 N/A，見 §6）。
- **相關角色**：ESP-12F 顯示裝置

### FR-DISP-02：OLED 畫面渲染與錯誤狀態
- **描述**：128x64 OLED 上下各半顯示 Claude / Grok 一行，含百分比、長條圖、倒數時間（HH:MM:SS）。
- **主要流程**：每秒依目前快取狀態重繪。
- **例外流程**：
  - WiFi 未連線：全螢幕顯示重連中訊息，暫停倒數
  - 某服務 `ok:false` 且從未有過有效數值：該行顯示 `N/A`
  - 某服務 `ok:false` 但曾有有效數值：沿用該數值繼續倒數（代表資料可能過舊，但不中斷顯示）
  - 距離上次成功同步超過 2 分鐘：畫面角落顯示過舊提示（`!`），不影響數字顯示
- **相關角色**：ESP-12F 顯示裝置

## 4. 非功能需求
| 類別 | 需求 |
|------|------|
| 效能 | `GET /display` 回應時間 < 200ms（直接讀記憶體快取，不觸發外部呼叫） |
| 安全性 | `.env`、Claude OAuth 憑證、Grok log 僅以唯讀方式掛載進容器；不對外網公開 `/display`（僅限區域網路） |
| 可用性 | 任一資料來源失敗不應導致整個 `/display` 端點失敗或讓伺服器程序中止 |
| 相容性 | Server：Node.js 18+；韌體：PlatformIO `espressif8266` 平台、Arduino framework |
| 可維護性 | 核心計算邏輯（額度/倒數解析）需有自動化測試，可離線於 CI 執行，不需真實外部服務 |

## 5. 資料需求概述
本專案沒有資料庫，所有資料都是**記憶體內的易逝快取**（Server 重啟即清空，下次背景刷新會重新填入）。主要資料實體：

- `ClaudeStatus { percent, resetSeconds, ok, updatedAt }`
- `GrokStatus { percent, resetSeconds, ok, updatedAt }`

兩者在記憶體中各以單一物件存在，沒有歷史記錄、沒有多使用者區分。

## 6. 限制與假設
- **限制**：Grok 資料來源依賴 Grok CLI 本機 log 格式（`fetched credits config` 訊息與其 JSON 結構），非官方公開 API，未來 Grok CLI 改版可能需要調整解析邏輯。
- **限制**：Claude 資料來源使用 Anthropic 非公開文件化的 OAuth rate-limit 端點，原理與本機第三方 statusline 工具（`rz1989s/claude-code-statusline`）相同，但非官方保證的穩定介面。
- **限制**：ESP8266 開機後，第一次成功同步前（最多 30 秒）兩個服務都會顯示 `N/A`，目前視為可接受的已知限制，未修復。
- **假設**：Server 與 ESP8266 位於同一區域網路，且 Docker 的連接埠轉發能從該網路實際存取到。

## 7. 驗收標準
- Given API server 正常運作且 Claude/Grok 資料來源皆有效, When 呼叫 `GET /display`, Then 回應包含兩個服務的 `percent`（0-100 整數）、`resetSeconds`（非負整數）、`ok:true`
- Given Claude 的 OAuth token 失效, When 下一次背景刷新執行, Then 快取保留前一次的 `percent`/`resetSeconds`，但 `ok` 變為 `false`，且伺服器程序不中斷
- Given ESP8266 已連上 WiFi 且曾成功同步過資料, When 持續運作超過 2 分鐘未再成功同步, Then 畫面上數字維持最後已知值，並顯示過舊提示
- Given ESP8266 WiFi 斷線, When 偵測到斷線, Then 畫面切換為全螢幕重連提示，倒數暫停
