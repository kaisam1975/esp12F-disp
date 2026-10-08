const fs = require('node:fs/promises');

const DEFAULT_CREDENTIALS_PATH = '/root/.claude/.credentials.json';
const RATE_LIMIT_URL = 'https://api.anthropic.com/api/oauth/usage';

const INITIAL_CACHE = { percent: null, resetAt: null, ok: false, updatedAt: null };
let claudeCache = { ...INITIAL_CACHE };

function extractAccessToken(jsonText) {
  try {
    const data = JSON.parse(jsonText);
    return data?.claudeAiOauth?.accessToken ?? data?.accessToken ?? data?.access_token ?? null;
  } catch {
    return null;
  }
}

function parseResetsAt(value) {
  if (value == null) return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    return Number(value) * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function computeClaudeStatus(fiveHour) {
  if (!fiveHour || fiveHour.utilization == null || fiveHour.resets_at == null) {
    return { percent: null, resetAt: null, ok: false };
  }
  const resetAt = parseResetsAt(fiveHour.resets_at);
  if (resetAt == null) {
    return { percent: null, resetAt: null, ok: false };
  }
  const percent = Math.round(fiveHour.utilization);
  return { percent, resetAt, ok: true };
}

async function fetchFiveHourStatus({ credentialsPath, fetchImpl = fetch }) {
  const raw = await fs.readFile(credentialsPath, 'utf8');
  const token = extractAccessToken(raw);
  if (!token) throw new Error('no access token in credentials file');
  const res = await fetchImpl(RATE_LIMIT_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`rate-limit API returned ${res.status}`);
  const body = await res.json();
  return computeClaudeStatus(body.five_hour);
}

async function refreshClaudeUsage(opts = {}) {
  const credentialsPath = opts.credentialsPath || DEFAULT_CREDENTIALS_PATH;
  const now = opts.now || (() => Date.now());
  try {
    const status = await fetchFiveHourStatus({ credentialsPath, fetchImpl: opts.fetchImpl });
    // A 200 response can still carry unparseable/absent five_hour data (status.ok
    // false without throwing). Treat that the same as a thrown error: keep the
    // last known good percent/resetAt instead of overwriting them with nulls.
    if (!status.ok) {
      claudeCache = { ...claudeCache, ok: false };
    } else {
      claudeCache = { ...status, updatedAt: new Date(now()).toISOString() };
    }
  } catch {
    claudeCache = { ...claudeCache, ok: false };
  }
}

function getClaudeCache(now = Date.now) {
  const resetSeconds =
    claudeCache.resetAt == null ? null : Math.max(0, Math.round((claudeCache.resetAt - now()) / 1000));
  return { percent: claudeCache.percent, resetSeconds, ok: claudeCache.ok, updatedAt: claudeCache.updatedAt };
}

function __resetClaudeCacheForTests() {
  claudeCache = { ...INITIAL_CACHE };
}

module.exports = {
  computeClaudeStatus,
  extractAccessToken,
  refreshClaudeUsage,
  getClaudeCache,
  __resetClaudeCacheForTests,
};
