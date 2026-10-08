# 程式碼規範 — esp12F-disp

專案橫跨三種語言：JavaScript（server）、C++（firmware）、Python（firmware 的建置小腳本）。以下規範依實際程式碼歸納，不是通用範本硬套。

## 1. 語言與版本
- **Server**：Node.js 18+（使用內建 `node:test`、`node:assert/strict`、全域 `fetch`，不依賴外部測試框架）
- **Firmware**：C++（Arduino framework for ESP8266），PlatformIO 管理建置
- **建置腳本**：Python 3（`firmware/scripts/gen_secrets.py`，PlatformIO `extra_scripts` 用）

## 2. 命名慣例

### JavaScript (`server/`)
| 對象 | 慣例 | 範例 |
|------|------|------|
| 函式 / 變數 | camelCase | `computeClaudeStatus`、`refreshGrokUsage` |
| 常數（模組層級、不變） | UPPER_SNAKE_CASE | `DEFAULT_CREDENTIALS_PATH`、`RATE_LIMIT_URL` |
| 測試專用匯出 | 前綴 `__` | `__resetClaudeCacheForTests` |
| 檔案 | 與模組同名、camelCase/小寫 | `claude.js`、`grok.js`、`index.js` |

### C++ (`firmware/`)
| 對象 | 慣例 | 範例 |
|------|------|------|
| 函式 / 變數 | camelCase | `computeRemainingSeconds`、`lastSyncMillis` |
| struct / 型別 | PascalCase | `ServiceStatus`、`DisplayState` |
| 常數 | UPPER_SNAKE_CASE 或 camelCase 視情境 | `STALE_THRESHOLD_MS` |
| 檔案 | 小寫+底線 | `usage_state.h` / `usage_state.cpp` |

## 3. 格式化與 Linting 工具
目前專案**沒有**設定自動 formatter / linter（ESLint、clang-format 等皆未導入）。沿用既有檔案的風格手動對齊即可：
- JS：2 空格縮排、單引號字串、句尾加分號
- C++：2 空格縮排、開頭大括號不換行（K&R 風格）

若之後要導入工具，建議：
- JS：ESLint + Prettier
- C++：clang-format（`google` 或 `chromium` base style 皆可）

## 4. 專案結構慣例
- `server/src/`：每個資料來源一個檔案（`claude.js`、`grok.js`），各自管理自己的記憶體快取與 `get*Cache()` / `refresh*Usage()` 一對函式；`index.js` 只負責組裝 Express app 與背景計時器，不包含資料抓取邏輯。
- `server/test/`：測試檔案與 `src/` 同名對應（`claude.test.js` 對應 `claude.js`）。
- `firmware/lib/usage_state/`：所有「不需要硬體就能測試」的純邏輯放這裡（JSON 解析、倒數計算、字串格式化），用 PlatformIO `native` 環境跑測試。
- `firmware/src/main.cpp`：只放需要硬體的部分（WiFi、HTTP、OLED 繪製），呼叫 `usage_state` 的函式，但本身不被自動測試覆蓋，改動後要實機驗證。
- `firmware/tools/`：一次性或診斷用的獨立小工具（例如 `i2c_scanner`），跟主韌體分開，不會被一般建置流程編譯進最終產出。

## 5. 註解與文件字串規範
- 預設不寫註解；只在「為什麼」不明顯時才寫一行註解（例如解釋一個隱藏限制、繞過某個已知問題的原因）。
- 不寫重複程式碼本身意思的註解（例如不要寫 `// 設定 WiFi SSID` 在 `WiFi.begin(WIFI_SSID, ...)` 上面）。
- 範例（這種值得寫）：
  ```cpp
  unsigned long elapsedMs = nowMillis - baseMillis;  // 無號減法：millis() 溢位時仍能算出正確的小增量
  ```

## 6. Commit 訊息規範
目前這個專案**還沒有使用 git 版本控制**（刻意決定，避免小型個人專案的額外負擔）。如果之後要導入 git，建議採用 [Conventional Commits](https://www.conventionalcommits.org/)（`feat:`、`fix:`、`docs:`、`test:` 等前綴），例如：
```
feat: add Grok usage module reading local CLI log
```

## 7. 分支策略
不適用（尚未使用版本控制）。

## 8. 錯誤處理原則
- **Server**：每個資料來源模組（`claude.js`、`grok.js`）的 `refresh*Usage()` 函式永遠 try/catch 包住整個刷新流程；任何失敗（檔案不存在、解析失敗、API 回應非 200）都只會把快取的 `ok` 設為 `false`，絕不讓例外往外拋出中斷伺服器或背景計時器。`GET /display` 端點本身不做任何可能失敗的操作，只讀取已經算好的快取。
- **Firmware**：`parseDisplayResponse` 回傳 `bool` 表示整體解析是否成功；解析失敗時完全不修改傳入的 `DisplayState&`，呼叫端（`main.cpp`）維持上一次的畫面狀態，不會因為一次失敗的 HTTP 回應而讓畫面顯示錯誤或崩潰。
