# ESP-12F OLED Firmware Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the PlatformIO/Arduino firmware for an ESP-12F that polls the `usage-api` server's `GET /display` every 30 seconds and renders Claude/Grok usage % and reset countdowns on a 0.96" I2C SSD1306 OLED, with graceful WiFi/API/stale-data error states.

**Architecture:** Pure, host-testable display-state logic (JSON parsing, countdown math, time formatting) lives in `firmware/lib/usage_state/`, exercised by PlatformIO's native Unity test environment with no hardware required. `firmware/src/main.cpp` wires that logic to real WiFi/HTTP/OLED calls and is verified manually on hardware, per the spec's own testing approach.

**Tech Stack:** PlatformIO, Arduino framework for ESP8266 (board `esp12e`), ArduinoJson, U8g2 (SSD1306 I2C driver), Unity (PlatformIO native test env).

**Spec:** `docs/superpowers/specs/2026-10-07-esp12f-usage-display-design.md`

## Global Constraints

- Board target: PlatformIO `esp12e` (pin-compatible with ESP-12F), `framework = arduino` (spec §6.1).
- Display: 0.96" SSD1306 128×64 over I2C, driven via U8g2 (spec §6.1).
- Poll `GET {API_BASE_URL}/display` every 30 seconds; redraw the OLED every 1 second using a locally computed countdown, not a new network call (spec §6.3).
- `WIFI_SSID`, `WIFI_PASSWORD`, `API_BASE_URL` come from a generated `include/secrets.h`, produced at build time from the repo-root `.env` by `firmware/scripts/gen_secrets.py`; `include/secrets.h` is never committed (spec §4, §6.1).
- `/display` JSON contract consumed: `{"claude":{"percent":int|null,"resetSeconds":int|null,"ok":bool},"grok":{same shape},"updatedAt":string}` (spec §5.5).
- Error states (spec §6.4): WiFi disconnected → full-screen reconnect message, countdown paused. A service with `ok:false` and no prior good value → show "N/A" for that service only. No successful sync for over 2 minutes → show a stale-data indicator without hiding the last good numbers.

## Review Focus

- `percent`/`resetSeconds` arriving as JSON `null` (source has no data) → must parse to an explicit "unknown" sentinel, not a garbage int or a crash. Covered in Task 1.
- A malformed/non-JSON response body (e.g. an HTML error page from a misconfigured `API_BASE_URL`) → parser must fail safely and leave the previous `DisplayState` untouched rather than corrupt it. Covered in Task 1.
- Countdown reaching the server's last-known `resetSeconds` before the next successful sync → remaining-time math must clamp at 0, never go negative. Covered in Task 1.
- `millis()` rollover (~49 days of continuous uptime) → the elapsed-time calculation must still produce a small, correct delta via unsigned wraparound, not a multi-year garbage value. Covered in Task 1.
- No successful HTTP sync for an extended period (server unreachable) → the display must surface a stale indicator instead of silently freezing forever with no visual cue. Covered in Task 3 (manual verification).

---

### Task 1: Pure display-state logic (JSON parsing, countdown math, formatting)

**Files:**
- Create: `firmware/platformio.ini`
- Create: `firmware/scripts/gen_secrets.py`
- Create: `firmware/include/secrets.h.example`
- Create: `firmware/lib/usage_state/usage_state.h`
- Create: `firmware/lib/usage_state/usage_state.cpp`
- Create: `firmware/test/test_usage_state/test_main.cpp`
- Modify: `.gitignore` (repo root — add `firmware/include/secrets.h` if not already present from the server plan)

**Interfaces:**
- Produces (for Task 2/3): `struct ServiceStatus { int percent; long resetSeconds; bool ok; }`, `struct DisplayState { ServiceStatus claude; ServiceStatus grok; }`, `bool parseDisplayResponse(const std::string& jsonBody, DisplayState& outState)`, `long computeRemainingSeconds(long baseResetSeconds, unsigned long baseMillis, unsigned long nowMillis)`, `std::string formatCountdown(long seconds)` — all in `firmware/lib/usage_state/usage_state.h`.

- [ ] **Step 1: Write the failing tests**

Create `firmware/test/test_usage_state/test_main.cpp`:

```cpp
#include <unity.h>
#include <climits>
#include "usage_state.h"

void test_parse_valid_response() {
  DisplayState state;
  std::string json = R"({"claude":{"percent":62,"resetSeconds":8040,"ok":true},"grok":{"percent":30,"resetSeconds":18120,"ok":true},"updatedAt":"2026-10-07T12:00:00Z"})";
  TEST_ASSERT_TRUE(parseDisplayResponse(json, state));
  TEST_ASSERT_EQUAL(62, state.claude.percent);
  TEST_ASSERT_EQUAL(8040, state.claude.resetSeconds);
  TEST_ASSERT_TRUE(state.claude.ok);
  TEST_ASSERT_EQUAL(30, state.grok.percent);
  TEST_ASSERT_EQUAL(18120, state.grok.resetSeconds);
  TEST_ASSERT_TRUE(state.grok.ok);
}

void test_parse_null_fields_become_unknown() {
  DisplayState state;
  std::string json = R"({"claude":{"percent":null,"resetSeconds":null,"ok":false},"grok":{"percent":30,"resetSeconds":100,"ok":true},"updatedAt":"x"})";
  TEST_ASSERT_TRUE(parseDisplayResponse(json, state));
  TEST_ASSERT_EQUAL(-1, state.claude.percent);
  TEST_ASSERT_EQUAL(-1, state.claude.resetSeconds);
  TEST_ASSERT_FALSE(state.claude.ok);
}

void test_parse_malformed_json_returns_false() {
  DisplayState state;
  TEST_ASSERT_FALSE(parseDisplayResponse("not json at all", state));
}

void test_compute_remaining_seconds_normal() {
  TEST_ASSERT_EQUAL(50, computeRemainingSeconds(100, 0, 50000));
}

void test_compute_remaining_seconds_clamps_to_zero() {
  TEST_ASSERT_EQUAL(0, computeRemainingSeconds(10, 0, 20000));
}

void test_compute_remaining_seconds_unknown_base() {
  TEST_ASSERT_EQUAL(-1, computeRemainingSeconds(-1, 0, 5000));
}

void test_compute_remaining_seconds_handles_millis_rollover() {
  unsigned long baseMillis = (unsigned long)(ULONG_MAX) - 500;
  unsigned long nowMillis = 500; // wrapped past overflow, 1000ms after baseMillis
  TEST_ASSERT_EQUAL(99, computeRemainingSeconds(100, baseMillis, nowMillis));
}

void test_format_countdown_normal() {
  TEST_ASSERT_EQUAL_STRING("02:14:00", formatCountdown(8040).c_str());
}

void test_format_countdown_invalid() {
  TEST_ASSERT_EQUAL_STRING("--:--:--", formatCountdown(-1).c_str());
}

int main(int argc, char **argv) {
  UNITY_BEGIN();
  RUN_TEST(test_parse_valid_response);
  RUN_TEST(test_parse_null_fields_become_unknown);
  RUN_TEST(test_parse_malformed_json_returns_false);
  RUN_TEST(test_compute_remaining_seconds_normal);
  RUN_TEST(test_compute_remaining_seconds_clamps_to_zero);
  RUN_TEST(test_compute_remaining_seconds_unknown_base);
  RUN_TEST(test_compute_remaining_seconds_handles_millis_rollover);
  RUN_TEST(test_format_countdown_normal);
  RUN_TEST(test_format_countdown_invalid);
  return UNITY_END();
}
```

- [ ] **Step 2: Scaffold the PlatformIO project so the test can run (and fail)**

Create `firmware/platformio.ini`:

```ini
[env:esp12e]
platform = espressif8266
board = esp12e
framework = arduino
lib_deps =
  bblanchon/ArduinoJson @ ^7.0.0
  olikraus/U8g2 @ ^2.35.0
extra_scripts = pre:scripts/gen_secrets.py
monitor_speed = 115200

[env:native]
platform = native
lib_deps =
  bblanchon/ArduinoJson @ ^7.0.0
test_framework = unity
```

Set up the `native` environment so `pio test -e native` compiles only `firmware/lib/usage_state/` plus `firmware/test/test_usage_state/`, excluding `firmware/src/main.cpp` (which will depend on `ESP8266WiFi.h`/U8g2 and cannot compile natively) — use PlatformIO's standard `test_build_src` / `build_src_filter` mechanism for this exclusion, whichever current PlatformIO syntax applies.

Run: `pio test -e native`
Expected: FAIL (missing `usage_state.h` / undefined reference)

- [ ] **Step 3: Implement `firmware/lib/usage_state/usage_state.h`**

```cpp
#pragma once
#include <string>

struct ServiceStatus {
  int percent;       // 0-100, or -1 when unknown
  long resetSeconds;  // seconds remaining, or -1 when unknown
  bool ok;
};

struct DisplayState {
  ServiceStatus claude;
  ServiceStatus grok;
};

bool parseDisplayResponse(const std::string& jsonBody, DisplayState& outState);
long computeRemainingSeconds(long baseResetSeconds, unsigned long baseMillis, unsigned long nowMillis);
std::string formatCountdown(long seconds);
```

- [ ] **Step 4: Implement `firmware/lib/usage_state/usage_state.cpp`**

Use `ArduinoJson`'s `deserializeJson` into a `JsonDocument`. `parseDisplayResponse`: return `false` if deserialization errors or either top-level `"claude"`/`"grok"` key is missing/not an object. For each of the two keys, read a `ServiceStatus`: if `ok` is `false` or either `percent`/`resetSeconds` is JSON `null`/missing, set `{ -1, -1, false }`; otherwise set `{ percent, resetSeconds, true }` from the parsed ints. Return `true` on success.

`computeRemainingSeconds`: if `baseResetSeconds < 0`, return `-1` immediately. Otherwise `unsigned long elapsedMs = nowMillis - baseMillis;` (unsigned subtraction — correct across `millis()` overflow by construction), `long elapsedSeconds = (long)(elapsedMs / 1000);`, `long remaining = baseResetSeconds - elapsedSeconds;`, return `remaining < 0 ? 0 : remaining`.

`formatCountdown`: if `seconds < 0`, return `"--:--:--"`. Otherwise compute hours/minutes/seconds and format zero-padded as `"HH:MM:SS"` (e.g. via `snprintf` into a fixed buffer, then construct the `std::string`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pio test -e native`
Expected: PASS (9 tests)

- [ ] **Step 6: Implement `firmware/scripts/gen_secrets.py`**

A PlatformIO `pre:` extra script (`Import("env")`) that reads `../.env` (relative to `firmware/`), parses simple `KEY=VALUE` lines (skip blank lines and lines starting with `#`), and writes `firmware/include/secrets.h`:

```cpp
#pragma once
#define WIFI_SSID "<value of WIFI_SSID>"
#define WIFI_PASSWORD "<value of WIFI_PASSWORD>"
#define API_BASE_URL "<value of API_BASE_URL>"
```

Create `firmware/include/secrets.h.example` as a checked-in template with placeholder values, for contributors who haven't run the generator yet.

- [ ] **Step 7: Manual verification of the secrets generator**

With a real `.env` at the repo root (copied from `.env.example`), run `pio run -e esp12e` (or just invoke the script directly: `python3 firmware/scripts/gen_secrets.py`) and confirm `firmware/include/secrets.h` is generated with the three `#define` lines matching the `.env` values.

- [ ] **Step 8: Ensure `.gitignore` covers the generated secrets file**

Confirm the repo-root `.gitignore` contains `firmware/include/secrets.h` (it was added by the server plan's Task 1 — if that plan hasn't run yet, create/append it here).

- [ ] **Step 9: Commit**

```bash
git add firmware/platformio.ini firmware/lib/usage_state/usage_state.h firmware/lib/usage_state/usage_state.cpp firmware/test/test_usage_state/test_main.cpp firmware/scripts/gen_secrets.py firmware/include/secrets.h.example .gitignore
git commit -m "feat: add host-testable display-state logic for ESP firmware"
```

---

### Task 2: WiFi connectivity and HTTP polling

**Files:**
- Create: `firmware/src/main.cpp`

**Interfaces:**
- Consumes: `DisplayState`, `ServiceStatus`, `parseDisplayResponse` from Task 1 (`firmware/lib/usage_state/usage_state.h`); `WIFI_SSID`, `WIFI_PASSWORD`, `API_BASE_URL` from generated `include/secrets.h`.

- [ ] **Step 1: Implement WiFi connection in `setup()`**

Include `ESP8266WiFi.h`. Call `WiFi.begin(WIFI_SSID, WIFI_PASSWORD)`, then loop `while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }` before proceeding, logging progress over `Serial` (begin `Serial.begin(115200)` first).

- [ ] **Step 2: Implement `bool fetchDisplayState(DisplayState& outState)`**

Include `ESP8266HTTPClient.h`. Build the URL as `String(API_BASE_URL) + "/display"`. Use `HTTPClient` to `GET`; if the HTTP status is 200, call `parseDisplayResponse(http.getString().c_str(), outState)` and return its result; otherwise return `false`. Always call `http.end()`.

- [ ] **Step 3: Poll every 30 seconds from `loop()`**

Track `unsigned long lastPollMillis = 0;` and a module-level `DisplayState currentState` (default-initialized with all `ServiceStatus{-1,-1,false}`) and `unsigned long lastSyncMillis = 0;`. In `loop()`, if `millis() - lastPollMillis >= 30000` (unsigned subtraction, overflow-safe as in Task 1), set `lastPollMillis = millis()` and call `fetchDisplayState`; on success, overwrite `currentState` and set `lastSyncMillis = millis()`; on failure, leave `currentState`/`lastSyncMillis` untouched. After every poll attempt (success or failure), `Serial.print` the resulting `currentState.claude.percent`, `currentState.claude.resetSeconds`, `currentState.grok.percent`, `currentState.grok.resetSeconds` for manual verification.

- [ ] **Step 4: Manual verification**

Flash to a real ESP-12F (or at minimum `pio run -e esp12e` to confirm it compiles). Open the serial monitor and confirm WiFi connects, then every 30 seconds a line is printed whose percents/resetSeconds match what `curl $API_BASE_URL/display` returns at the same moment.

- [ ] **Step 5: Commit**

```bash
git add firmware/src/main.cpp
git commit -m "feat: add WiFi connection and /display polling to ESP firmware"
```

---

### Task 3: OLED rendering and error/stale states

**Files:**
- Modify: `firmware/src/main.cpp`

**Interfaces:**
- Consumes: `currentState`, `lastSyncMillis` from Task 2; `computeRemainingSeconds`, `formatCountdown` from Task 1.

- [ ] **Step 1: Initialize U8g2 and draw a boot splash**

Add U8g2 (`U8G2_SSD1306_128X64_NONAME_F_HW_I2C` or the appropriate constructor for the wired I2C pins) initialization in `setup()`, right after `Serial.begin`, and draw a simple "Booting..." splash before the WiFi-connect loop begins.

- [ ] **Step 2: Implement `void renderDisplay(const DisplayState& state, unsigned long lastSyncMillis, unsigned long nowMillis, bool wifiConnected)`**

- If `!wifiConnected`: clear the screen, draw a centered "WiFi 斷線重連中" message, `return` (no countdown math).
- Otherwise, for each of `claude`/`grok` in turn, draw one half of the screen: the label, then:
  - if `!status.ok && status.percent == -1`: draw `"N/A"` for that row;
  - else: draw `status.percent` with a `%` sign, a proportional bar via `u8g2.drawBox` (width scaled by `percent`), and `formatCountdown(computeRemainingSeconds(status.resetSeconds, lastSyncMillis, nowMillis)).c_str()`.
- If `nowMillis - lastSyncMillis > 120000` (unsigned subtraction), draw a small stale-data indicator (e.g. a `"!"` glyph in a corner) without altering the numbers being shown.

- [ ] **Step 3: Call `renderDisplay` once per second from `loop()`**

Track `unsigned long lastRenderMillis = 0;`. If `millis() - lastRenderMillis >= 1000`, set `lastRenderMillis = millis()`, call `u8g2.clearBuffer()`, `renderDisplay(currentState, lastSyncMillis, millis(), WiFi.status() == WL_CONNECTED)`, then `u8g2.sendBuffer()`.

- [ ] **Step 4: Manual verification**

On real hardware: confirm the two-row layout updates every second with a smoothly decreasing countdown. Disconnect WiFi (power off the router or move out of range) and confirm the "WiFi 斷線重連中" screen appears. Stop the `usage-api` server and confirm that after 2 minutes the stale-data indicator appears while the last good numbers stay frozen rather than disappearing. Temporarily rename `grok-storage-state.json` so the Grok refresh always fails, restart the API server, and confirm the Grok row shows `"N/A"` while the Claude row keeps updating normally.

- [ ] **Step 5: Commit**

```bash
git add firmware/src/main.cpp
git commit -m "feat: render OLED usage display with WiFi/stale/N-A error states"
```
