# Usage API Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Docker-hosted `usage-api` server that exposes `GET /display`, serving cached Claude Code 5-hour usage % + reset countdown (from Anthropic's official OAuth rate-limit API) and Grok web usage % + reset countdown (scraped via a reused Playwright login session).

**Architecture:** Two independent background-refreshed cache modules (`claude.js`, `grok.js`), each with a pure computation/parsing function and an orchestration function that never throws past itself. An Express app (`index.js`) serves the current cache contents instantly on every request, decoupled from the refresh timers.

**Tech Stack:** Node.js (built-in `node:test`, `node:assert/strict`, global `fetch`), Express, Playwright, Docker (official Playwright base image), docker-compose.

**Spec:** `docs/superpowers/specs/2026-10-07-esp12f-usage-display-design.md`

## Global Constraints

- `GET /display` always responds immediately from the in-memory cache; it never waits on a live external call (spec §3, §5.5).
- Claude refresh interval defaults to 60s, Grok to 300s, both overridable via `CLAUDE_REFRESH_SECONDS` / `GROK_REFRESH_SECONDS` env vars (spec §4, §5.2, §5.3).
- A source with no trustworthy data reports `percent: null, ok: false` rather than a guessed value (spec §5.5).
- Claude OAuth credentials are read from `~/.claude/.credentials.json` on the host, mounted read-only into the container at `/root/.claude/.credentials.json`; the token lives at JSON path `.claudeAiOauth.accessToken` (fallback `.accessToken` / `.access_token`) (confirmed by reading the installed `rz1989s/claude-code-statusline` tool's source on this machine).
- The Claude rate-limit call is `GET https://api.anthropic.com/api/oauth/usage` with headers `Authorization: Bearer <token>`, `Content-Type: application/json`, `anthropic-beta: oauth-2025-04-20`, `Accept: application/json`; the response's `.five_hour.utilization` (0–100) and `.five_hour.resets_at` (ISO-8601 string or digit-only epoch-seconds string) are the fields used.
- Nothing secret (`.env`, `grok-storage-state.json`) is committed to git (spec §4, §5.4).

## Review Focus

- Claude credentials file missing or unreadable (first run before the host has ever authenticated) → `refreshClaudeUsage` must not throw; cache settles to `ok:false`. Covered in Task 1.
- Anthropic API returns 401 (expired OAuth token) → degrade gracefully, keeping the last known good `percent`/`resetSeconds` while flipping `ok:false`. Covered in Task 1.
- `grok-storage-state.json` missing (operator never ran the login script) → `refreshGrokUsage` must not crash server startup; cache settles to `ok:false`. Covered in Task 2.
- `GET /display` must return instantly even while a refresh is in flight — the endpoint and the timers must not share a blocking path. Covered in Task 3.
- Grok page text that doesn't match the expected quota format (e.g. a signed-out/interstitial page) must be rejected cleanly instead of producing a fabricated percentage. Covered in Task 2.

---

### Task 1: Claude usage module

**Files:**
- Create: `server/package.json`
- Create: `server/src/claude.js`
- Create: `server/test/claude.test.js`
- Create: `.env.example`
- Create: `.gitignore`

**Interfaces:**
- Produces (for Task 3): `getClaudeCache(): { percent: number|null, resetSeconds: number|null, ok: boolean, updatedAt: string|null }`, `refreshClaudeUsage(opts?: { credentialsPath?: string, fetchImpl?: typeof fetch, now?: () => number }): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `server/test/claude.test.js`:

```js
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

test('computeClaudeStatus returns percent and resetSeconds for valid data', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const resetsAt = new Date(now + 2 * 3600 * 1000).toISOString();
  const result = computeClaudeStatus({ utilization: 61.7, resets_at: resetsAt }, now);
  assert.deepStrictEqual(result, { percent: 62, resetSeconds: 7200, ok: true });
});

test('computeClaudeStatus clamps resetSeconds to 0 when resets_at is in the past', () => {
  const now = Date.UTC(2026, 0, 1, 1, 0, 0);
  const resetsAt = new Date(now - 1000).toISOString();
  const result = computeClaudeStatus({ utilization: 10, resets_at: resetsAt }, now);
  assert.strictEqual(result.resetSeconds, 0);
  assert.strictEqual(result.ok, true);
});

test('computeClaudeStatus returns ok:false when utilization is missing', () => {
  const result = computeClaudeStatus({ utilization: null, resets_at: '2026-01-01T00:00:00Z' }, Date.now());
  assert.deepStrictEqual(result, { percent: null, resetSeconds: null, ok: false });
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
  assert.deepStrictEqual(getClaudeCache(), {
    percent: 40,
    resetSeconds: 3600,
    ok: true,
    updatedAt: new Date(now).toISOString(),
  });
  await fs.unlink(tmpFile);
});

test('refreshClaudeUsage sets ok:false without throwing when credentials file is missing', async () => {
  __resetClaudeCacheForTests();
  await assert.doesNotReject(refreshClaudeUsage({ credentialsPath: '/nonexistent/path.json' }));
  assert.strictEqual(getClaudeCache().ok, false);
});

test('refreshClaudeUsage keeps previous good values but flips ok:false on 401', async () => {
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
  const cache = getClaudeCache();
  assert.strictEqual(cache.ok, false);
  assert.strictEqual(cache.percent, 20);
  assert.strictEqual(cache.resetSeconds, 1800);
  await fs.unlink(tmpFile);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test server/test/claude.test.js`
Expected: FAIL with "Cannot find module '../src/claude'"

- [ ] **Step 3: Scaffold `server/package.json`**

```json
{
  "name": "usage-api",
  "version": "1.0.0",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test test/"
  },
  "dependencies": {
    "express": "^4.19.0"
  }
}
```

Run `npm install` inside `server/`.

- [ ] **Step 4: Implement `server/src/claude.js`**

Exports `computeClaudeStatus(fiveHour, nowMs)`, `extractAccessToken(jsonText)`, `refreshClaudeUsage(opts)`, `getClaudeCache()`, `__resetClaudeCacheForTests()`.

- `extractAccessToken`: `JSON.parse` the text, return `data?.claudeAiOauth?.accessToken ?? data?.accessToken ?? data?.access_token ?? null`; return `null` on parse failure.
- `computeClaudeStatus(fiveHour, nowMs)`: if `fiveHour` is falsy or `utilization`/`resets_at` is `null`/`undefined`, return `{ percent: null, resetSeconds: null, ok: false }`. Otherwise parse `resets_at` (pure-digit string/number → epoch seconds × 1000; else `Date.parse`) into `resetMs`; if unparseable return the same `ok:false` shape. Else return `{ percent: Math.round(utilization), resetSeconds: Math.max(0, Math.round((resetMs - nowMs) / 1000)), ok: true }`.
- Module-level `let claudeCache = { percent: null, resetSeconds: null, ok: false, updatedAt: null }`. `getClaudeCache()` returns a shallow clone. `__resetClaudeCacheForTests()` resets it to the initial shape (test-only helper).
- `refreshClaudeUsage({ credentialsPath = '/root/.claude/.credentials.json', fetchImpl = fetch, now = () => Date.now() } = {})`: read the credentials file (`fs.readFile`, utf8), extract the token, call `fetchImpl('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: \`Bearer ${token}\`, 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' } })`; if the response's `ok` is falsy, throw; otherwise parse the JSON body and call `computeClaudeStatus(body.five_hour, now())`. On success, set `claudeCache = { ...status, updatedAt: new Date(now()).toISOString() }`. On any thrown error (missing file, no token, non-ok response, parse failure), catch it and set `claudeCache = { ...claudeCache, ok: false }` — leaving `percent`/`resetSeconds`/`updatedAt` untouched.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test server/test/claude.test.js`
Expected: PASS (8 tests)

- [ ] **Step 6: Create `.env.example` and `.gitignore` at the repo root**

`.env.example`:
```
WIFI_SSID=your-wifi-ssid
WIFI_PASSWORD=your-wifi-password
API_BASE_URL=http://192.168.1.100:8787
PORT=8787
CLAUDE_REFRESH_SECONDS=60
GROK_REFRESH_SECONDS=300
```

`.gitignore`:
```
.env
node_modules/
grok-storage-state.json
firmware/include/secrets.h
```

- [ ] **Step 7: Commit**

```bash
git add server/package.json server/src/claude.js server/test/claude.test.js .env.example .gitignore server/package-lock.json
git commit -m "feat: add Claude usage cache module with OAuth rate-limit lookup"
```

---

### Task 2: Grok usage module

**Files:**
- Create: `server/src/grok.js`
- Create: `server/test/grok.test.js`
- Create: `server/scripts/grok-login.js`

**Interfaces:**
- Consumes: none from Task 1 (independent module, same cache shape convention)
- Produces (for Task 3): `getGrokCache(): { percent: number|null, resetSeconds: number|null, ok: boolean, updatedAt: string|null }`, `refreshGrokUsage(opts?: { storageStatePath?: string, scrapeImpl?: (path: string) => Promise<string> }): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `server/test/grok.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  parseGrokUsage,
  refreshGrokUsage,
  getGrokCache,
  __resetGrokCacheForTests,
} = require('../src/grok');

test('parseGrokUsage extracts percent and reset duration from matching text', () => {
  const result = parseGrokUsage('Usage: 30% used. Resets in 4h 52m');
  assert.deepStrictEqual(result, { percent: 30, resetSeconds: 4 * 3600 + 52 * 60, ok: true });
});

test('parseGrokUsage returns ok:false when text has no recognizable quota info', () => {
  const result = parseGrokUsage('Please sign in to continue');
  assert.deepStrictEqual(result, { percent: null, resetSeconds: null, ok: false });
});

test('parseGrokUsage clamps percent to the 0-100 range', () => {
  const result = parseGrokUsage('Usage: 150% used. Resets in 0h 5m');
  assert.strictEqual(result.percent, 100);
});

test('refreshGrokUsage updates cache using an injected scrapeImpl', async () => {
  __resetGrokCacheForTests();
  const storageStatePath = path.join(os.tmpdir(), `storage-${Date.now()}.json`);
  await fs.writeFile(storageStatePath, '{}');
  const scrapeImpl = async () => 'Usage: 55% used. Resets in 1h 10m';
  await refreshGrokUsage({ storageStatePath, scrapeImpl });
  const cache = getGrokCache();
  assert.strictEqual(cache.percent, 55);
  assert.strictEqual(cache.resetSeconds, 70 * 60);
  assert.strictEqual(cache.ok, true);
  await fs.unlink(storageStatePath);
});

test('refreshGrokUsage sets ok:false without throwing when storage state file is missing', async () => {
  __resetGrokCacheForTests();
  await assert.doesNotReject(
    refreshGrokUsage({ storageStatePath: '/nonexistent/storage.json', scrapeImpl: async () => '' })
  );
  assert.strictEqual(getGrokCache().ok, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test server/test/grok.test.js`
Expected: FAIL with "Cannot find module '../src/grok'"

- [ ] **Step 3: Implement `server/src/grok.js`**

Exports `parseGrokUsage(pageText)`, `scrapeGrokPage(storageStatePath)`, `refreshGrokUsage(opts)`, `getGrokCache()`, `__resetGrokCacheForTests()`.

- `parseGrokUsage(pageText)`: if not a string, return `{ percent: null, resetSeconds: null, ok: false }`. Match `/(\d{1,3})%/` for percent and `/Resets?\s+in\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i` for the reset duration. If either match fails, return the `ok:false` shape. Otherwise clamp percent to `[0, 100]`, compute `resetSeconds = hours * 3600 + minutes * 60` (missing groups default to 0), return `{ percent, resetSeconds, ok: true }`.
- `scrapeGrokPage(storageStatePath)`: use `playwright`'s `chromium.launch({ headless: true })`, open a context with `storageState: storageStatePath`, navigate to `https://grok.com`, wait for the page to settle, return `page.textContent('body')` (or a narrower selector — see Step 6 below), then close the context/browser. Add `playwright` as a dependency (`npm install playwright` inside `server/`).
- Module-level `let grokCache = { percent: null, resetSeconds: null, ok: false, updatedAt: null }`, with `getGrokCache()`/`__resetGrokCacheForTests()` mirroring Task 1's pattern.
- `refreshGrokUsage({ storageStatePath = '/app/grok-storage-state.json', scrapeImpl = scrapeGrokPage } = {})`: `await fs.access(storageStatePath)` (throws if missing), `const pageText = await scrapeImpl(storageStatePath)`, `const status = parseGrokUsage(pageText)`, if `!status.ok` throw. On success set `grokCache = { ...status, updatedAt: new Date().toISOString() }`. Catch any thrown error and set `grokCache = { ...grokCache, ok: false }`, leaving other fields untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test server/test/grok.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Implement the one-time login script `server/scripts/grok-login.js`**

A standalone Node script (run manually on the host, never in the container): launches `chromium.launch({ headless: false })`, opens `https://grok.com`, waits for the operator to press Enter in the terminal (via `node:readline/promises`) after completing the SSO login by hand, then calls `context.storageState({ path: process.argv[2] || 'grok-storage-state.json' })` and closes the browser.

- [ ] **Step 6: Manual calibration against the real grok.com page**

Run `node server/scripts/grok-login.js ../grok-storage-state.json` from `server/`, log in by hand. Then write and run a small throwaway script that calls `scrapeGrokPage('../grok-storage-state.json')` and prints the returned text. Compare the real text against the `parseGrokUsage` regexes from Step 3: if grok.com's actual wording/layout doesn't match (e.g. it shows "messages remaining" instead of a `%`, or a different reset-time phrasing), update `parseGrokUsage`'s regexes — and the Step 1 test fixtures/assertions — to match what the real page actually shows, then re-run Step 4's tests until they pass against the corrected regex.

- [ ] **Step 7: Commit**

```bash
git add server/src/grok.js server/test/grok.test.js server/scripts/grok-login.js server/package.json server/package-lock.json
git commit -m "feat: add Grok usage cache module with Playwright scraping"
```

---

### Task 3: Express app, background refreshers, and Docker packaging

**Files:**
- Create: `server/src/index.js`
- Create: `server/test/index.test.js`
- Create: `server/Dockerfile`
- Create: `docker-compose.yml` (repo root)

**Interfaces:**
- Consumes: `getClaudeCache`/`refreshClaudeUsage` from Task 1 (`server/src/claude.js`), `getGrokCache`/`refreshGrokUsage` from Task 2 (`server/src/grok.js`)

- [ ] **Step 1: Write the failing tests**

Create `server/test/index.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test server/test/index.test.js`
Expected: FAIL with "Cannot find module '../src/index'"

- [ ] **Step 3: Implement `server/src/index.js`**

```js
const express = require('express');

function createApp({ getClaudeCache, getGrokCache }) {
  const app = express();
  app.get('/display', (req, res) => {
    res.json({
      claude: getClaudeCache(),
      grok: getGrokCache(),
      updatedAt: new Date().toISOString(),
    });
  });
  return app;
}

function startBackgroundRefreshers({
  claudeRefreshSeconds,
  grokRefreshSeconds,
  refreshClaudeUsage,
  refreshGrokUsage,
}) {
  refreshClaudeUsage();
  refreshGrokUsage();
  const claudeTimer = setInterval(refreshClaudeUsage, claudeRefreshSeconds * 1000);
  const grokTimer = setInterval(refreshGrokUsage, grokRefreshSeconds * 1000);
  return { claudeTimer, grokTimer };
}

module.exports = { createApp, startBackgroundRefreshers };

if (require.main === module) {
  const claude = require('./claude');
  const grok = require('./grok');
  const PORT = process.env.PORT || 8787;
  const app = createApp({ getClaudeCache: claude.getClaudeCache, getGrokCache: grok.getGrokCache });
  startBackgroundRefreshers({
    claudeRefreshSeconds: Number(process.env.CLAUDE_REFRESH_SECONDS) || 60,
    grokRefreshSeconds: Number(process.env.GROK_REFRESH_SECONDS) || 300,
    refreshClaudeUsage: claude.refreshClaudeUsage,
    refreshGrokUsage: grok.refreshGrokUsage,
  });
  app.listen(PORT, () => console.log(`usage-api listening on ${PORT}`));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test server/test/index.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Write `server/Dockerfile`**

```dockerfile
FROM mcr.microsoft.com/playwright:v1.49.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
EXPOSE 8787
CMD ["node", "src/index.js"]
```

After `npm install` in Task 2 added `playwright`, run `npx playwright --version` inside `server/` and confirm it matches the Dockerfile's base image tag (`v1.49.0`); if your installed version differs, update the tag in this Dockerfile to match.

- [ ] **Step 6: Write `docker-compose.yml` at the repo root**

```yaml
services:
  usage-api:
    build: ./server
    env_file: .env
    ports:
      - "${PORT}:${PORT}"
    volumes:
      - ${HOME}/.claude/.credentials.json:/root/.claude/.credentials.json:ro
      - ./grok-storage-state.json:/app/grok-storage-state.json:ro
    restart: unless-stopped
```

- [ ] **Step 7: Manual verification**

Copy `.env.example` to `.env` and fill in real values. Run `docker compose up --build`. In another terminal, run `curl localhost:$PORT/display` and confirm the JSON shape matches §5.5 of the spec, with real (or at least non-crashing `ok:false`) Claude and Grok data.

- [ ] **Step 8: Commit**

```bash
git add server/src/index.js server/test/index.test.js server/Dockerfile docker-compose.yml
git commit -m "feat: add Express /display endpoint with background refreshers and Docker packaging"
```
