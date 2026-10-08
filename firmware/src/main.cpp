#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <U8g2lib.h>
#include <Wire.h>
#include "secrets.h"
#include "usage_state.h"

U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0);

DisplayState currentState = {
    ServiceStatus{-1, -1, false},
    ServiceStatus{-1, -1, false},
};
unsigned long lastSyncMillis = 0;
unsigned long lastPollMillis = 0;
unsigned long lastRenderMillis = 0;

const unsigned long STALE_THRESHOLD_MS = 120000;

void connectWiFi() {
  Serial.print("Connecting to WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println(" connected");
}

bool fetchDisplayState(DisplayState& outState) {
  WiFiClient client;
  HTTPClient http;
  String url = String(API_BASE_URL) + "/display";
  http.begin(client, url);
  int httpCode = http.GET();
  bool success = false;
  if (httpCode == 200) {
    success = parseDisplayResponse(http.getString().c_str(), outState);
  }
  http.end();
  return success;
}

void drawServiceRow(int yTop, const char* label, const ServiceStatus& status,
                     unsigned long lastSyncMillis, unsigned long nowMillis) {
  u8g2.drawStr(0, yTop + 8, label);
  if (!status.ok && status.percent == -1) {
    u8g2.drawStr(50, yTop + 8, "N/A");
    return;
  }

  char percentBuf[8];
  snprintf(percentBuf, sizeof(percentBuf), "%d%%", status.percent);
  u8g2.drawStr(50, yTop + 8, percentBuf);

  int barWidth = (status.percent * 60) / 100;
  if (barWidth < 0) barWidth = 0;
  if (barWidth > 60) barWidth = 60;
  u8g2.drawFrame(0, yTop + 10, 60, 6);
  u8g2.drawBox(0, yTop + 10, barWidth, 6);

  long remaining = computeRemainingSeconds(status.resetSeconds, lastSyncMillis, nowMillis);
  std::string countdown = formatCountdown(remaining);
  u8g2.drawStr(65, yTop + 20, countdown.c_str());
}

void renderDisplay(const DisplayState& state, unsigned long lastSyncMillis, unsigned long nowMillis, bool wifiConnected) {
  u8g2.clearBuffer();

  if (!wifiConnected) {
    // u8g2_font_6x10_tf has no CJK glyphs and drawStr() doesn't decode UTF-8,
    // so this must stay plain ASCII or it renders as garbage.
    u8g2.drawStr(0, 24, "WiFi disconnected");
    u8g2.drawStr(0, 40, "reconnecting...");
    u8g2.sendBuffer();
    return;
  }

  drawServiceRow(0, "Claude", state.claude, lastSyncMillis, nowMillis);
  drawServiceRow(26, "Grok", state.grok, lastSyncMillis, nowMillis);

  if (nowMillis - lastSyncMillis > STALE_THRESHOLD_MS) {
    u8g2.drawStr(118, 8, "!");
  }

  u8g2.sendBuffer();
}

void setup() {
  Serial.begin(115200);
  // This board's OLED socket is hard-wired to SDA=GPIO2, SCL=GPIO14
  // (found via I2C scan; the ESP8266 Arduino default of GPIO4/GPIO5 is wrong
  // for this board). Wire.begin() must be called with these pins BEFORE
  // u8g2.begin(), which otherwise just uses whatever Wire was last set to.
  Wire.begin(2, 14);
  u8g2.begin();
  u8g2.setFont(u8g2_font_6x10_tf);
  u8g2.clearBuffer();
  u8g2.drawStr(20, 32, "Booting...");
  u8g2.sendBuffer();
  connectWiFi();
}

void loop() {
  unsigned long now = millis();

  if (now - lastPollMillis >= 30000) {
    lastPollMillis = now;
    if (fetchDisplayState(currentState)) {
      lastSyncMillis = now;
    }
  }

  if (now - lastRenderMillis >= 1000) {
    lastRenderMillis = now;
    renderDisplay(currentState, lastSyncMillis, now, WiFi.status() == WL_CONNECTED);
  }
}
