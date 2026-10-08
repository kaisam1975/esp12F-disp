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

void test_parse_ok_false_with_real_values_preserves_them() {
  DisplayState state;
  std::string json = R"({"claude":{"percent":20,"resetSeconds":1800,"ok":false},"grok":{"percent":30,"resetSeconds":100,"ok":true},"updatedAt":"x"})";
  TEST_ASSERT_TRUE(parseDisplayResponse(json, state));
  TEST_ASSERT_EQUAL(20, state.claude.percent);
  TEST_ASSERT_EQUAL(1800, state.claude.resetSeconds);
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
  RUN_TEST(test_parse_ok_false_with_real_values_preserves_them);
  RUN_TEST(test_parse_malformed_json_returns_false);
  RUN_TEST(test_compute_remaining_seconds_normal);
  RUN_TEST(test_compute_remaining_seconds_clamps_to_zero);
  RUN_TEST(test_compute_remaining_seconds_unknown_base);
  RUN_TEST(test_compute_remaining_seconds_handles_millis_rollover);
  RUN_TEST(test_format_countdown_normal);
  RUN_TEST(test_format_countdown_invalid);
  return UNITY_END();
}
