# 疑難排解 (Troubleshooting)

依類別整理專案開發/執行時常見的問題與解法。找不到答案時，也可以參考 [DEVELOPMENT_LOG.md](./DEVELOPMENT_LOG.md) 了解當時的除錯脈絡。

## 安裝 / 建置

### WSL2 裡完全看不到 ESP-12F 的 USB 序列埠
**症狀**
`pio device list` 沒有任何輸出；`ls /dev/tty*` 也看不到 `ttyUSB*`。

**原因**
WSL2 預設不會把 USB 裝置 passthrough 進 Linux 子系統；USB-UART 轉接器插在 Windows 主機上，WSL2 完全看不到。

**解法**
1. 在 Windows 上另外裝一份 PlatformIO（`pip install platformio`），直接對 `\\wsl.localhost\<distro>\...\firmware` 這個 UNC 路徑跑 `pio run -t upload --upload-port COMx`。
2. 或者乾脆把整個 `firmware/` 複製一份到 Windows 本機，用 Arduino IDE / PlatformIO 燒錄（本專案實際採用的做法）。

**相關**
詳見 [DEVELOPMENT_LOG.md](./DEVELOPMENT_LOG.md) 2026-10-07 條目。

### Windows 裝置管理器顯示 USB 裝置錯誤碼 43（要求裝置描述元失敗）
**症狀**
`Get-CimInstance -ClassName Win32_PnPEntity` 查到一個 `VID_0000&PID_0002` 的裝置，`ConfigManagerErrorCode = 43`；完全找不到 `CH340`/`CP210x`/`FTDI` 這類序列埠晶片。

**原因**
這個錯誤發生在 USB 列舉階段，在驅動程式介入之前就失敗了，幾乎都是實體層問題：USB 線本身壞掉或只有電源線沒有資料線（很多便宜/充電用的線材是這樣）、USB 埠供電不穩、或是透過 Hub 轉接。

**解法**
換一條確定有資料線的 USB 線，直接插主機板上的埠（避免 Hub）。本專案換線後立刻看到 `USB-SERIAL CH340 (COM4)` 正常出現。

## 執行期錯誤

### OLED 完全沒有畫面
**症狀**
燒錄成功、序列埠能看到韌體在跑（例如 `Connecting to WiFi` 這類輸出），但 OLED 螢幕一片空白，連開機畫面都沒有。

**原因**
`U8g2`/`Wire` 預設走 ESP8266 Arduino core 的預設腳位（SDA=GPIO4/D2、SCL=GPIO5/D1），但很多現成的「物聯網開發板」把 OLED 插槽焊在設計者自選的其他 GPIO 上，並沒有照這個預設走。

**解法**
1. 用 `firmware/tools/i2c_scanner/i2c_scanner.ino`（跟主韌體分開的診斷小工具）掃描所有常見腳位組合，找到實際回應的腳位與 I2C 位址。
2. 在 `main.cpp` 的 `setup()` 裡，`u8g2.begin()` **之前**明確呼叫 `Wire.begin(實際SDA腳位, 實際SCL腳位)`。
3. 本專案實測這塊板子的 OLED 插槽是 SDA=GPIO2(D4)、SCL=GPIO14(D5)，I2C 位址 `0x3C`（SSD1306 典型位址）。

**相關**
詳見 [DEVELOPMENT_LOG.md](./DEVELOPMENT_LOG.md) 2026-10-07 條目。

### ESP8266 兩行都一直顯示 N/A，但用別的裝置連 API server 是通的
**症狀**
手機瀏覽器開 `http://<某個IP>:8787/display` 正常，但 ESP8266 OLED 兩行一直是 `N/A`。

**原因**
主機有多張網卡（例如 Windows 同時有 Ethernet 跟另一張走 192.168.2.x 網段的轉接卡），ESP8266 實際連的 WiFi 跟其中一張網卡的網段對不上；`.env` 裡的 `API_BASE_URL` 填的是「看起來主要」的那張網卡 IP（有預設閘道的那張），但 ESP8266 的 WiFi 其實在另一個網段。

**解法**
用 `ipconfig`（Windows）確認 ESP8266 所在 WiFi 實際對應的是哪張網卡的 IP，`API_BASE_URL` 要填那一張，不是直覺上「主要」的那張。Docker Desktop 的連接埠轉發是綁 `0.0.0.0`，所有網卡都會轉發，所以只要 IP 填對就能連到。

### Grok 那一行偶爾短暫跳成 `ok:false`，過一下又恢復
**症狀**
`/display` 回應裡 `grok.ok` 突然變成 `false`，但 `percent`/`resetSeconds` 看起來還停在舊數值；幾分鐘後（下一次背景刷新）又自動恢復正常。

**原因**
Server 讀取 `~/.grok/logs/unified.jsonl` 的那一瞬間，剛好撞上 Grok CLI 正在寫入新的一行 log，讀到不完整/暫時不一致的內容而解析失敗。這是單檔案讀取天生會遇到的競爭情況（race condition）。

**解法**
不用特別處理——這正是設計好的容錯行為：解析失敗時只會把 `ok` 設 `false` 並保留上一次成功的數值，下一次背景刷新（預設 300 秒）幾乎必然會讀到完整內容而自動恢復。如果持續好幾輪刷新都是 `false`，才需要真的去查 log 格式是不是變了。

### Grok 那一行持續顯示 N/A（不是暫時的），`unified.jsonl` 裡明明有資料
**症狀**
`/display` 的 `grok` 一直是 `percent:null, resetSeconds:null, ok:false`，而且等好幾輪背景刷新（超過 5~10 分鐘）都沒有自動恢復，但 `~/.grok/logs/unified.jsonl` 檔案確實存在、檔案大小也還在增加。

**原因**
`server/src/grok.js` 的解析邏輯是照目前這個版本的 Grok CLI log 格式寫死的：固定尋找訊息文字包含 `"fetched credits config"`，並預期能在裡面讀到 `ctx.config.creditUsagePercent` 與 `ctx.config.currentPeriod.end`（或退而求其次的 `billingPeriodEnd`）這幾個確切欄位。Grok CLI 之後改版，只要這段訊息文字或欄位名稱變了，`parseLatestCreditsConfig` 就會永遠找不到可用的資料，不是暫時性的，不會自己恢復。

**解法**
1. 先直接看真實 log 最新一筆長什麼樣子，確認到底是訊息文字變了還是欄位名稱變了：
   ```bash
   grep "fetched credits config" ~/.grok/logs/unified.jsonl | tail -1 | python3 -m json.tool
   ```
   如果 `grep` 完全找不到這段文字，代表 Grok CLI 把訊息文字本身也改了，要改抓別的關鍵字。
2. 對照 `server/src/grok.js` 裡的 `MATCH_TEXT` 常數，以及 `computeGrokStatus` 讀取的 `creditUsagePercent` / `currentPeriod.end` / `billingPeriodEnd` 這幾個欄位名稱，依實際抓到的新格式更新。
3. 先把這次抓到的真實內容做成 `server/test/grok.test.js` 的新測試案例（參考既有測試的寫法），看著它因為格式不符而失敗（RED），再去改 `grok.js` 讓測試通過（GREEN），不要憑感覺改完就直接部署。

**相關**
這個限制在 [SRS.md 第 6 節「限制與假設」](./SRS.md) 已經先寫明：Grok 資料來源依賴的是非官方公開的本機 log 格式，之後改版本來就有可能需要調整解析邏輯。

### Claude 那一行卡在舊資料不會更新（不是 ok:false 的暫時性問題）
**症狀**
`/display` 的 `claude.updatedAt` 停在很久以前的時間點（例如卡了 2 天），`percent`/`resetSeconds` 完全不變；跟上面那個 Grok 的暫時性 race condition 不一樣，不管等多久、重新整理多少次都不會自己好。容器本身是正常運行中的（`docker compose ps` 顯示 `Up`），log 也沒有任何錯誤訊息。

**原因**
`docker-compose.yml` 把 `~/.claude/.credentials.json` 以**單一檔案**方式 bind mount 進 container。Claude Code CLI 刷新 token 時是「寫暫存檔、再 rename 覆蓋原檔」的原子寫入方式，host 端的檔案會換成一個全新的 inode；但單一檔案的 bind mount 綁定的是 **mount 當下那個 inode**，host 端 rename 覆蓋之後，container 裡看到的還是舊的、已經被 unlink 的孤兒 inode，永遠不會再更新。用 `docker compose exec usage-api stat /root/.claude/.credentials.json` 搭配 host 端 `stat ~/.claude/.credentials.json` 比對，會看到兩邊 `Device`/`Inode` 不一樣，容器端還會顯示 `Links: 0`（代表那個 inode 已經在 host 端被刪除，只是 container 還抱著不放）。

**解法**
把 bind mount 的來源改成**父目錄**，而不是個別檔案：
```yaml
volumes:
  - ${HOME}/.claude:/root/.claude:ro
  - ${HOME}/.grok/logs:/root/.grok/logs:ro
```
目錄的 bind mount 是每次都即時依檔名查找，不會綁死某個 inode，host 端無論怎麼 rename 覆蓋都看得到最新內容。改完用 `docker compose up -d --force-recreate` 重建 container 套用新設定。

**相關**
詳見 [DEVELOPMENT_LOG.md](./DEVELOPMENT_LOG.md) 2026-10-10 條目。

## 部署 / Docker

### `docker compose up` 後，掛載的檔案變成一個空目錄
**症狀**
`grok-storage-state.json`（舊版用 Playwright 時的設計）或任何 bind mount 的來源檔案，如果在第一次 `docker compose up` 之前還不存在，之後去看會發現它變成了一個 `root` 擁有的**目錄**，不是檔案。

**原因**
Docker（至少在這台機器的 Docker Desktop + WSL2 環境上）對短語法 `volumes:` 掛載，如果來源路徑不存在，會直接建立一個空目錄頂替，而不是報錯。**已實測確認**：即使改用長語法 `type: bind` 搭配 `bind.create_host_path: false`，這台機器上依然會建立目錄，這個選項並沒有真的生效。

**解法**
確保所有要 bind mount 的來源檔案在第一次 `docker compose up` 之前就已經存在（例如 `~/.claude/.credentials.json`、`~/.grok/logs/unified.jsonl` 這類本來就會存在的真實檔案，通常不會踩到這個問題；只有「程式自己要產生的狀態檔」才需要特別注意要先建立好空的 placeholder）。

### WSL2 執行 `docker compose up` 用的 Bash 工具偶爾回報「auto mode classifier」錯誤
**症狀**
執行一般的 `ls`、`find` 等指令時，Bash 工具回報「server-side auto mode classifier gave no verdict」而失敗。

**原因**
這是 Claude Code 這個 agent 工具本身的暫時性後端分類服務異常，跟專案程式碼無關。

**解法**
稍等後重試；如果持續失敗，先做其他不需要 Bash 的工作（讀檔、寫檔），之後再回來重試。
