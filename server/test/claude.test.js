const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  computeClaudeStatus,
  extractAccessToken,
  refreshClaudeUsage,
  getClaudeCache,
  __resetClaudeCacheForTests,
} = require('../src/claude');

test('computeClaudeStatus returns percent and an absolute resetAt for valid data', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const resetsAt = new Date(now + 2 * 3600 * 1000).toISOString();
  const result = computeClaudeStatus({ utilization: 61.7, resets_at: resetsAt });
  assert.deepStrictEqual(result, { percent: 62, resetAt: now + 2 * 3600 * 1000, ok: true });
});

test('computeClaudeStatus returns ok:false when utilization is missing', () => {
  const result = computeClaudeStatus({ utilization: null, resets_at: '2026-01-01T00:00:00Z' });
  assert.deepStrictEqual(result, { percent: null, resetAt: null, ok: false });
});

test('getClaudeCache clamps resetSeconds to 0 once resetAt is in the past, instead of freezing at a stale snapshot', async () => {
  __resetClaudeCacheForTests();
  const tmpFile = path.join(os.tmpdir(), `creds-${Date.now()}-clamp.json`);
  await fs.writeFile(tmpFile, JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }));
  const refreshNow = Date.UTC(2026, 0, 1, 1, 0, 0);
  const resetsAt = new Date(refreshNow + 1000).toISOString(); // resets 1s after refresh
  const okFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ five_hour: { utilization: 10, resets_at: resetsAt } }),
  });
  await refreshClaudeUsage({ credentialsPath: tmpFile, fetchImpl: okFetch, now: () => refreshNow });
  const cache = getClaudeCache(() => refreshNow + 5000); // 5s later, well past the 1s reset
  assert.strictEqual(cache.resetSeconds, 0);
  await fs.unlink(tmpFile);
});

test('extractAccessToken reads nested claudeAiOauth.accessToken', () => {
  assert.strictEqual(extractAccessToken('{"claudeAiOauth":{"accessToken":"abc123"}}'), 'abc123');
});

test('extractAccessToken returns null for malformed JSON', () => {
  assert.strictEqual(extractAccessToken('not json'), null);
});

test('refreshClaudeUsage populates cache on success', async () => {
  __resetClaudeCacheForTests();
  const tmpFile = path.join(os.tmpdir(), `creds-${Date.now()}.json`);
  await fs.writeFile(tmpFile, JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }));
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const resetsAt = new Date(now + 3600 * 1000).toISOString();
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ five_hour: { utilization: 40, resets_at: resetsAt } }),
  });
  await refreshClaudeUsage({ credentialsPath: tmpFile, fetchImpl: fakeFetch, now: () => now });
  assert.deepStrictEqual(getClaudeCache(() => now), {
    percent: 40,
    resetSeconds: 3600,
    ok: true,
    updatedAt: new Date(now).toISOString(),
  });
  await fs.unlink(tmpFile);
});

test('refreshClaudeUsage keeps previous good values when the API responds 200 but with unparseable five_hour data', async () => {
  __resetClaudeCacheForTests();
  const tmpFile = path.join(os.tmpdir(), `creds-${Date.now()}-weird.json`);
  await fs.writeFile(tmpFile, JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }));
  const refreshNow = Date.UTC(2026, 0, 1, 0, 0, 0);
  const resetsAt = new Date(refreshNow + 1800 * 1000).toISOString();
  const okFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ five_hour: { utilization: 20, resets_at: resetsAt } }),
  });
  await refreshClaudeUsage({ credentialsPath: tmpFile, fetchImpl: okFetch, now: () => refreshNow });

  // A 200 response whose five_hour field is null/unparseable must NOT wipe the cache.
  const weirdFetch = async () => ({ ok: true, status: 200, json: async () => ({ five_hour: null }) });
  await refreshClaudeUsage({ credentialsPath: tmpFile, fetchImpl: weirdFetch, now: () => refreshNow + 60000 });

  const cache = getClaudeCache(() => refreshNow + 60000);
  assert.strictEqual(cache.ok, false);
  assert.strictEqual(cache.percent, 20);
  assert.strictEqual(cache.resetSeconds, 1740); // 1800 - 60s elapsed, not wiped to null
  await fs.unlink(tmpFile);
});

test('refreshClaudeUsage sets ok:false without throwing when credentials file is missing', async () => {
  __resetClaudeCacheForTests();
  await assert.doesNotReject(refreshClaudeUsage({ credentialsPath: '/nonexistent/path.json' }));
  assert.strictEqual(getClaudeCache().ok, false);
});

test('refreshClaudeUsage keeps previous good values but flips ok:false on 401, and resetSeconds keeps counting down rather than freezing', async () => {
  __resetClaudeCacheForTests();
  const tmpFile = path.join(os.tmpdir(), `creds-${Date.now()}-b.json`);
  await fs.writeFile(tmpFile, JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }));
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const resetsAt = new Date(now + 1800 * 1000).toISOString();
  const okFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ five_hour: { utilization: 20, resets_at: resetsAt } }),
  });
  await refreshClaudeUsage({ credentialsPath: tmpFile, fetchImpl: okFetch, now: () => now });
  const failFetch = async () => ({ ok: false, status: 401 });
  await refreshClaudeUsage({ credentialsPath: tmpFile, fetchImpl: failFetch, now: () => now + 60000 });
  const cache = getClaudeCache(() => now + 60000);
  assert.strictEqual(cache.ok, false);
  assert.strictEqual(cache.percent, 20);
  assert.strictEqual(cache.resetSeconds, 1740); // 1800 - 60s elapsed, not frozen at 1800
  await fs.unlink(tmpFile);
});
