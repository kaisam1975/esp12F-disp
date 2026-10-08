# 開發日誌 (Development Log)

依時間倒序記錄開發過程中的重要決策、踩過的坑、以及當下的思考脈絡。

---

## 2026-10-08

### 這次做了什麼
- 確認韌體在 `API_BASE_URL` 改成 ESP8266 實際所在網段（192.168.2.20）後，Claude / Grok 兩行都正常顯示
- 建立專案文件（SRS、API 規格書、README、STYLE_GUIDE、本檔案、TROUBLESHOOTING、CHANGELOG）

### 為什麼這樣做 / 決策與取捨
- 文件是在專案已經完成並實機驗證過之後才補上，所以 TROUBLESHOOTING / DEVELOPMENT_LOG 不是空骨架，而是直接把 10-07 那天真實踩過的坑寫進去——比留白骨架更有價值。
- `.env.example`、`Dockerfile`、`docker-compose.yml` 已經是實測可用的版本，文件產生時刻意不用通用範本覆蓋，只在 README 引用。

### 遇到的問題
無新問題，是前一天問題排除後的收尾確認。

### 下一步
- Grok CLI 之後有新的使用紀錄時，確認額度會自動反映新的帳單週期（目前邏輯已支援，但還沒在「新週期剛開始」的時間點實機驗證過）
- 考慮要不要把專案納入 git 版本控制（目前刻意沒有用）

---

## 2026-10-07

### 這次做了什麼
- 從零設計並實作整個專案：Docker API server（`server/`，Node.js + Express）與 ESP-12F 韌體（`firmware/`，PlatformIO + Arduino）
- Server 端：Claude 模組讀本機 `~/.claude/.credentials.json` 的 OAuth token 打 Anthropic 官方 rate-limit API；Grok 模組一開始用 Playwright 爬 grok.com 網頁版，後來使用者提供本機 Grok CLI 的 log 格式後，整個換成讀 `~/.grok/logs/unified.jsonl`
- 韌體端：WiFi 連線、每 30 秒輪詢 `/display`、U8g2 畫面渲染，純邏輯（JSON 解析、倒數計算、時間格式化）抽到 `firmware/lib/usage_state/`，用 PlatformIO native 環境跑 Unity 測試
- 跑了一次 fresh-context code review（`opus` model），找到並修復 6 個 Important/Critical 問題：
  1. `resetSeconds` 原本是刷新當下算好直接存快取（快照），改成存絕對時間 `resetAt`，查詢時才動態算剩餘秒數——否則倒數會在每次刷新時跳回去，刷新失敗時甚至永遠卡住不會歸零
  2. 韌體把 `ok:false` 但有舊值的資料一律當成 N/A，蓋掉了 server 特意保留的舊值——修正 `usage_state.cpp` 讓舊值能被保留
  3. WiFi 斷線訊息原本用中文，但字型/繪圖函式不支援 UTF-8，改成英文
  4. Grok regex（當時還是爬網頁版本）太鬆，會把無關文字誤判成有效額度——加嚴格判斷條件
  5. docker-compose 短語法掛載，主機來源檔案不存在時 Docker 會自動建目錄——嘗試用 `create_host_path: false` 但實測在這台機器的 Docker Desktop/WSL2 上無效，改用文件說明代替
  6. `gen_secrets.py` 沒處理 `.env` 值的引號/跳脫字元
- 實機燒錄、除錯過程踩了好幾個硬體/環境的坑（detail 見下方「遇到的問題」與 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)）
- 最後把 Grok 模組整個從 Playwright 網頁爬蟲換成讀本機 Grok CLI log，移除 Playwright 依賴、Dockerfile 改回普通 `node:22-slim`

### 為什麼這樣做 / 決策與取捨
- **先用 git worktree/ledger 流程被使用者否決**：原本照 `executing-plans` skill 的標準流程要用 git commit 記錄每個任務，使用者明確說「不要用 git 太浪費」，所以整個開發過程沒有版本控制，純粹用檔案系統現狀 + 這份開發日誌記錄脈絡。
- **Grok 資料來源從 Playwright 爬網頁改成讀本機 log**：一開始設計時沒有更好的選項，只能用 headless browser 登入 grok.com 網頁版再爬畫面文字，脆弱且需要 SSO 登入、需要人工維護登入 session。後來使用者提供一個讀取 Grok CLI 本機 log（`~/.grok/logs/unified.jsonl`，尋找 `fetched credits config` 訊息）的 Python 腳本，直接拿掉了 Playwright 整條線，既穩定又不用處理登入問題。這是「更好的資料來源出現就整個換掉」的典型例子，不是硬要修補原本的爬蟲。
- **沒有自動化測試硬體相關的程式碼**：`firmware/src/main.cpp` 裡 WiFi/HTTP/OLED 繪製的部分無法脫離硬體自動測試，刻意只把「純邏輯」抽到 `usage_state.cpp` 做自動化測試，硬體相關部分改用實機人工驗證（序列埠輸出、實際斷網/斷線測試）。

### 遇到的問題
- WSL2 完全沒有 USB passthrough，看不到 ESP-12F 的序列埠——詳見 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#wsl2-裡完全看不到-esp-12f-的-usb-序列埠)
- Windows 裝置管理器一度顯示 USB 錯誤碼 43，換一條 USB 線後解決——詳見 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#windows-裝置管理器顯示-usb-裝置錯誤碼-43要求裝置描述元失敗)
- 燒錄成功後 OLED 完全沒畫面，用自己寫的 I2C 掃描小工具（`firmware/tools/i2c_scanner`）找出實際接線是 SDA=GPIO2、SCL=GPIO14，跟 ESP8266 預設的 GPIO4/GPIO5 不同——詳見 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#oled-完全沒有畫面)
- 修好接線後兩行都顯示 N/A，原因是主機有多張網卡、`API_BASE_URL` 填錯網段——詳見 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#esp8266-兩行都一直顯示-na但用別的裝置連-api-server-是通的)
- Grok 換成讀 log 之後，有一次 `/display` 短暫回 `ok:false`，查出是讀檔時間點剛好撞上 Grok CLI 正在寫入——確認是設計內的正常容錯行為，不是 bug，詳見 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#grok-那一行偶爾短暫跳成-okfalse過一下又恢復)

### 下一步
- 等有畫面的環境可以人工驗證「WiFi 真的斷線時」畫面是否正確顯示重連提示（目前只驗證過正常運作與軟體邏輯）
- 開機後前 30 秒必定顯示 N/A 的小問題，目前視為 Minor、暫緩不修

---
