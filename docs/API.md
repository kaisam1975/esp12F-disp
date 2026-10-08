# API 規格書 — ESP-12F 使用量顯示器 (esp12F-disp)

## 1. 基本資訊
- Base URL：`http://<這台機器的區域網路IP>:8787`（由 `.env` 的 `PORT` 決定連接埠；目前只在內部區域網路使用，未做對外網域名或 HTTPS）
- 認證方式：無。這支 API 只設計給同一區域網路內的 ESP8266 裝置讀取，不做任何認證或授權機制，**不應對外公開**。
- 回應格式：JSON，無額外 envelope 包裝
- 版本策略：目前只有單一版本，無版本化機制

## 2. 通用錯誤格式
本 API 目前只有一支端點，且該端點設計上不會回傳 HTTP 層級的錯誤——資料來源層級的失敗一律反映在回應 body 的 `ok` 欄位，而不是 HTTP 狀態碼。

| HTTP 狀態碼 | 說明 |
|------------|------|
| 200 | 永遠回這個狀態碼；資料是否可信請看 body 裡每個服務的 `ok` 欄位 |

## 3. 端點列表

### `GET` `/display` — 取得目前 Claude 與 Grok 的額度快取
- **對應需求**：FR-API-03、FR-DISP-01
- **認證**：不需要
- **Request Path/Query 參數**：無

- **Request Body**：無

- **成功回應** `200 OK`：
```json
{
  "claude": {
    "percent": 37,
    "resetSeconds": 2602,
    "ok": true,
    "updatedAt": "2026-10-07T17:26:35.745Z"
  },
  "grok": {
    "percent": 1,
    "resetSeconds": 546989,
    "ok": true,
    "updatedAt": "2026-10-07T17:37:01.843Z"
  },
  "updatedAt": "2026-10-07T17:37:03.715Z"
}
```

- **資料來源異常時的回應範例**（Claude token 失效，但保留上次已知數值）：
```json
{
  "claude": { "percent": 20, "resetSeconds": 1740, "ok": false, "updatedAt": "2026-10-01T00:00:00.000Z" },
  "grok": { "percent": null, "resetSeconds": null, "ok": false, "updatedAt": null },
  "updatedAt": "2026-10-01T00:05:00.000Z"
}
```

- **可能錯誤**：本端點不會回傳非 200 狀態碼。呼叫端（韌體）應該用 `ok` 欄位判斷資料是否可信，而不是檢查 HTTP 狀態。

## 4. 資料模型 (Schemas)

### `ServiceStatus`
| 欄位 | 型別 | 說明 |
|------|------|------|
| `percent` | `number \| null` | 0-100 的整數使用率；該服務從未成功同步過資料時為 `null` |
| `resetSeconds` | `number \| null` | 距離重置還剩多少秒（已依查詢當下時間動態計算、並下限鎖在 0）；從未成功同步過時為 `null` |
| `ok` | `boolean` | 這次查詢時，這個數值是否來自「最近一次成功」的資料來源；`false` 代表資料來源目前異常，但 `percent`/`resetSeconds` 仍可能是舊的、仍可參考的數值 |
| `updatedAt` | `string \| null` | 最近一次成功刷新的 ISO 8601 時間戳；從未成功過時為 `null` |

### `DisplayResponse`
| 欄位 | 型別 | 說明 |
|------|------|------|
| `claude` | `ServiceStatus` | Claude Code 5 小時額度狀態 |
| `grok` | `ServiceStatus` | Grok 額度狀態 |
| `updatedAt` | `string` | 這次 `/display` 回應產生的時間戳（永遠是現在，與個別服務的 `updatedAt` 不同） |
