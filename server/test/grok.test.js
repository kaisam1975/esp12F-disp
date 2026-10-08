const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  parseLatestCreditsConfig,
  computeGrokStatus,
  refreshGrokUsage,
  getGrokCache,
  __resetGrokCacheForTests,
} = require('../src/grok');

function logLine(ctx, ts) {
  return JSON.stringify({ ts, src: 'test', msg: 'fetched credits config', ctx });
}

test('parseLatestCreditsConfig picks the LAST matching line in the file', () => {
  const older = logLine({ config: { creditUsagePercent: 10, currentPeriod: { end: '2026-01-01T00:00:00Z' } } });
  const newer = logLine({ config: { creditUsagePercent: 55, currentPeriod: { end: '2026-02-01T00:00:00Z' } } });
  const unrelated = JSON.stringify({ ts: 'x', msg: 'something else' });
  const text = [older, unrelated, newer].join('\n');
  const result = parseLatestCreditsConfig(text);
  assert.strictEqual(result.config.creditUsagePercent, 55);
});

test('parseLatestCreditsConfig parses a ctx that is itself a JSON string', () => {
  const inner = { config: { creditUsagePercent: 42, currentPeriod: { end: '2026-03-01T00:00:00Z' } } };
  const line = JSON.stringify({ ts: 'x', msg: 'fetched credits config', ctx: JSON.stringify(inner) });
  const result = parseLatestCreditsConfig(line);
  assert.strictEqual(result.config.creditUsagePercent, 42);
});

test('parseLatestCreditsConfig skips malformed JSON lines and still finds the last valid match', () => {
  const valid = logLine({ config: { creditUsagePercent: 20, currentPeriod: { end: '2026-01-01T00:00:00Z' } } });
  const brokenMatchingLine = '{not valid json but fetched credits config in it';
  const text = [valid, brokenMatchingLine].join('\n');
  const result = parseLatestCreditsConfig(text);
  assert.strictEqual(result.config.creditUsagePercent, 20);
});

test('parseLatestCreditsConfig returns null when no line matches', () => {
  const text = JSON.stringify({ ts: 'x', msg: 'something unrelated' });
  assert.strictEqual(parseLatestCreditsConfig(text), null);
});

test('computeGrokStatus returns percent and an absolute resetAt for valid data', () => {
  const latest = { config: { creditUsagePercent: 61.7, currentPeriod: { end: '2026-01-01T02:00:00.000Z' } } };
  const result = computeGrokStatus(latest);
  assert.deepStrictEqual(result, { percent: 62, resetAt: Date.parse('2026-01-01T02:00:00.000Z'), ok: true });
});

test('computeGrokStatus falls back to billingPeriodEnd when currentPeriod.end is missing', () => {
  const latest = { config: { creditUsagePercent: 30, billingPeriodEnd: '2026-01-01T03:00:00.000Z' } };
  const result = computeGrokStatus(latest);
  assert.strictEqual(result.resetAt, Date.parse('2026-01-01T03:00:00.000Z'));
  assert.strictEqual(result.ok, true);
});

test('computeGrokStatus returns ok:false when creditUsagePercent is missing', () => {
  const latest = { config: { currentPeriod: { end: '2026-01-01T00:00:00Z' } } };
  assert.deepStrictEqual(computeGrokStatus(latest), { percent: null, resetAt: null, ok: false });
});

test('computeGrokStatus returns ok:false when given null (no matching log line found)', () => {
  assert.deepStrictEqual(computeGrokStatus(null), { percent: null, resetAt: null, ok: false });
});

test('refreshGrokUsage populates cache from a real log file on success', async () => {
  __resetGrokCacheForTests();
  const logPath = path.join(os.tmpdir(), `grok-log-${Date.now()}.jsonl`);
  const refreshNow = Date.UTC(2026, 0, 1, 0, 0, 0);
  const resetIso = new Date(refreshNow + 3600 * 1000).toISOString();
  await fs.writeFile(logPath, logLine({ config: { creditUsagePercent: 40, currentPeriod: { end: resetIso } } }) + '\n');
  await refreshGrokUsage({ logPath, now: () => refreshNow });
  assert.deepStrictEqual(getGrokCache(() => refreshNow), {
    percent: 40,
    resetSeconds: 3600,
    ok: true,
    updatedAt: new Date(refreshNow).toISOString(),
  });
  await fs.unlink(logPath);
});

test('refreshGrokUsage resetSeconds keeps counting down rather than snapshotting', async () => {
  __resetGrokCacheForTests();
  const logPath = path.join(os.tmpdir(), `grok-log-${Date.now()}-b.jsonl`);
  const refreshNow = Date.UTC(2026, 0, 1, 0, 0, 0);
  const resetIso = new Date(refreshNow + 600 * 1000).toISOString(); // 600s out
  await fs.writeFile(logPath, logLine({ config: { creditUsagePercent: 20, currentPeriod: { end: resetIso } } }) + '\n');
  await refreshGrokUsage({ logPath, now: () => refreshNow });
  const cacheLater = getGrokCache(() => refreshNow + 120000); // 2 minutes later
  assert.strictEqual(cacheLater.resetSeconds, 480); // 600 - 120
  await fs.unlink(logPath);
});

test('refreshGrokUsage sets ok:false without throwing when the log file is missing', async () => {
  __resetGrokCacheForTests();
  await assert.doesNotReject(refreshGrokUsage({ logPath: '/nonexistent/unified.jsonl' }));
  assert.strictEqual(getGrokCache().ok, false);
});

test('refreshGrokUsage keeps previous good values but flips ok:false when a later refresh finds no matching line', async () => {
  __resetGrokCacheForTests();
  const logPath = path.join(os.tmpdir(), `grok-log-${Date.now()}-c.jsonl`);
  const refreshNow = Date.UTC(2026, 0, 1, 0, 0, 0);
  const resetIso = new Date(refreshNow + 1800 * 1000).toISOString();
  await fs.writeFile(logPath, logLine({ config: { creditUsagePercent: 20, currentPeriod: { end: resetIso } } }) + '\n');
  await refreshGrokUsage({ logPath, now: () => refreshNow });

  await fs.writeFile(logPath, 'nothing relevant here\n');
  await refreshGrokUsage({ logPath, now: () => refreshNow + 60000 });

  const cache = getGrokCache(() => refreshNow + 60000);
  assert.strictEqual(cache.ok, false);
  assert.strictEqual(cache.percent, 20);
  assert.strictEqual(cache.resetSeconds, 1740); // 1800 - 60s elapsed, not frozen
  await fs.unlink(logPath);
});
