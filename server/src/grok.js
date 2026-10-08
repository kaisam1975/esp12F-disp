const fs = require('node:fs/promises');

const DEFAULT_LOG_PATH = '/root/.grok/logs/unified.jsonl';
const MATCH_TEXT = 'fetched credits config';

const INITIAL_CACHE = { percent: null, resetAt: null, ok: false, updatedAt: null };
let grokCache = { ...INITIAL_CACHE };

// Mirrors the reference Python script: scan every line, keep overwriting
// `latest` on each match, so the final value is the LAST matching line in
// the file. Lines that match but fail to parse are skipped, not fatal.
function parseLatestCreditsConfig(logText) {
  let latest = null;
  for (const line of logText.split('\n')) {
    if (!line.includes(MATCH_TEXT)) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    let ctx = parsed.ctx;
    if (typeof ctx === 'string') {
      try {
        ctx = JSON.parse(ctx);
      } catch {
        continue;
      }
    }
    if (ctx && ctx.config) {
      latest = ctx;
    }
  }
  return latest;
}

function computeGrokStatus(latest) {
  const cfg = latest && latest.config;
  if (!cfg || cfg.creditUsagePercent == null) {
    return { percent: null, resetAt: null, ok: false };
  }
  const endIso = (cfg.currentPeriod && cfg.currentPeriod.end) || cfg.billingPeriodEnd;
  if (!endIso) {
    return { percent: null, resetAt: null, ok: false };
  }
  const resetAt = Date.parse(endIso);
  if (Number.isNaN(resetAt)) {
    return { percent: null, resetAt: null, ok: false };
  }
  return { percent: Math.round(cfg.creditUsagePercent), resetAt, ok: true };
}

async function refreshGrokUsage(opts = {}) {
  const logPath = opts.logPath || DEFAULT_LOG_PATH;
  const now = opts.now || Date.now;
  try {
    const text = await fs.readFile(logPath, 'utf8');
    const latest = parseLatestCreditsConfig(text);
    const status = computeGrokStatus(latest);
    if (!status.ok) throw new Error('no usable credits config found in log');
    grokCache = { ...status, updatedAt: new Date(now()).toISOString() };
  } catch {
    grokCache = { ...grokCache, ok: false };
  }
}

function getGrokCache(now = Date.now) {
  const resetSeconds = grokCache.resetAt == null ? null : Math.max(0, Math.round((grokCache.resetAt - now()) / 1000));
  return { percent: grokCache.percent, resetSeconds, ok: grokCache.ok, updatedAt: grokCache.updatedAt };
}

function __resetGrokCacheForTests() {
  grokCache = { ...INITIAL_CACHE };
}

module.exports = {
  parseLatestCreditsConfig,
  computeGrokStatus,
  refreshGrokUsage,
  getGrokCache,
  __resetGrokCacheForTests,
};
