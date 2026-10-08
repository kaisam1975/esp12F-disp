const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, startBackgroundRefreshers } = require('../src/index');

test('GET /display returns combined cache data from both modules', async () => {
  const app = createApp({
    getClaudeCache: () => ({ percent: 62, resetSeconds: 8040, ok: true, updatedAt: 'x' }),
    getGrokCache: () => ({ percent: 30, resetSeconds: 18120, ok: true, updatedAt: 'y' }),
  });
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://localhost:${port}/display`);
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(body.claude, { percent: 62, resetSeconds: 8040, ok: true, updatedAt: 'x' });
  assert.deepStrictEqual(body.grok, { percent: 30, resetSeconds: 18120, ok: true, updatedAt: 'y' });
  server.close();
});

test('GET /display responds immediately without waiting on a slow refresh', async () => {
  let resolveSlow;
  const slowPromise = new Promise((resolve) => { resolveSlow = resolve; });
  const app = createApp({
    getClaudeCache: () => ({ percent: 10, resetSeconds: 10, ok: true, updatedAt: 'z' }),
    getGrokCache: () => ({ percent: 10, resetSeconds: 10, ok: true, updatedAt: 'z' }),
  });
  const server = app.listen(0);
  const port = server.address().port;
  const { claudeTimer, grokTimer } = startBackgroundRefreshers({
    claudeRefreshSeconds: 9999,
    grokRefreshSeconds: 9999,
    refreshClaudeUsage: () => slowPromise,
    refreshGrokUsage: () => Promise.resolve(),
  });
  const start = Date.now();
  const res = await fetch(`http://localhost:${port}/display`);
  const elapsed = Date.now() - start;
  assert.strictEqual(res.status, 200);
  assert.ok(elapsed < 200, `expected a fast response, got ${elapsed}ms`);
  resolveSlow();
  clearInterval(claudeTimer);
  clearInterval(grokTimer);
  server.close();
});
