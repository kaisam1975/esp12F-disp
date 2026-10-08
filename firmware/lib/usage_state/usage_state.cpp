#include "usage_state.h"
#include <ArduinoJson.h>
#include <cstdio>

namespace {

ServiceStatus readServiceStatus(JsonVariantConst serviceJson) {
  if (serviceJson.isNull() || !serviceJson.is<JsonObjectConst>()) {
    return ServiceStatus{-1, -1, false};
  }
  JsonVariantConst okVar = serviceJson["ok"];
  JsonVariantConst percentVar = serviceJson["percent"];
  JsonVariantConst resetVar = serviceJson["resetSeconds"];

  bool ok = !okVar.isNull() && okVar.is<bool>() && okVar.as<bool>();
  if (percentVar.isNull() || resetVar.isNull()) {
    // No usable numbers at all -> nothing to show, regardless of ok.
    return ServiceStatus{-1, -1, false};
  }
  // ok:false with real numbers means "stale but still the last known good value" -
  // keep them so the caller can still render them (see spec's N/A rule: only
  // show N/A when there is truly no prior good value).
  return ServiceStatus{percentVar.as<int>(), resetVar.as<long>(), ok};
}

}  // namespace

bool parseDisplayResponse(const std::string& jsonBody, DisplayState& outState) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, jsonBody);
  if (err) {
    return false;
  }
  if (!doc["claude"].is<JsonObjectConst>() || !doc["grok"].is<JsonObjectConst>()) {
    return false;
  }
  outState.claude = readServiceStatus(doc["claude"]);
  outState.grok = readServiceStatus(doc["grok"]);
  return true;
}

long computeRemainingSeconds(long baseResetSeconds, unsigned long baseMillis, unsigned long nowMillis) {
  if (baseResetSeconds < 0) {
    return -1;
  }
  unsigned long elapsedMs = nowMillis - baseMillis;  // unsigned subtraction: correct across millis() overflow
  long elapsedSeconds = (long)(elapsedMs / 1000);
  long remaining = baseResetSeconds - elapsedSeconds;
  return remaining < 0 ? 0 : remaining;
}

std::string formatCountdown(long seconds) {
  if (seconds < 0) {
    return "--:--:--";
  }
  long hours = seconds / 3600;
  long minutes = (seconds % 3600) / 60;
  long secs = seconds % 60;
  char buf[16];
  snprintf(buf, sizeof(buf), "%02ld:%02ld:%02ld", hours, minutes, secs);
  return std::string(buf);
}
