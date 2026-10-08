#pragma once
#include <string>

struct ServiceStatus {
  int percent;        // 0-100, or -1 when unknown
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
