'use strict';

/**
 * Reads the Claude Code OAuth credentials that already live on this machine and
 * asks Anthropic for the same usage numbers the `/usage` command shows.
 *
 * The token is deliberately re-read on every poll instead of being cached:
 * Claude Code refreshes it in the background, and re-reading means this widget
 * never needs its own login and never goes stale after a refresh.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const REQUEST_TIMEOUT_MS = 15000;

class UsageError extends Error {
  constructor(kind, message) {
    super(message);
    // 'no-credentials' | 'expired' | 'offline' | 'rate-limited' | 'server' | 'unknown'
    this.kind = kind;
  }
}

function credentialsPath() {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

function readKeychain() {
  // macOS keeps the credentials in the login keychain rather than on disk.
  return new Promise((resolve, reject) => {
    execFile(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 10000 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.trim());
      }
    );
  });
}

async function readCredentials() {
  let raw = null;

  try {
    raw = fs.readFileSync(credentialsPath(), 'utf8');
  } catch {
    if (process.platform === 'darwin') {
      try {
        raw = await readKeychain();
      } catch {
        raw = null;
      }
    }
  }

  if (!raw) {
    throw new UsageError(
      'no-credentials',
      'Claude Code credentials not found on this computer.'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError('no-credentials', 'Claude Code credentials could not be read.');
  }

  const oauth = parsed.claudeAiOauth || {};
  if (!oauth.accessToken) {
    throw new UsageError('no-credentials', 'No Claude Code access token found.');
  }

  return {
    token: oauth.accessToken,
    plan: oauth.subscriptionType || null,
    expiresAt: oauth.expiresAt || null,
  };
}

function pickMeter(block) {
  if (!block || typeof block.utilization !== 'number') return null;
  return {
    percent: Math.min(100, Math.max(0, Math.round(block.utilization))),
    resetsAt: block.resets_at || null,
  };
}

/**
 * The `limits` array carries per-model weekly caps (e.g. Opus), which for Max
 * plans is often the limit you actually hit first.
 */
function pickScoped(limits) {
  if (!Array.isArray(limits)) return null;
  const scoped = limits.find((l) => l && l.kind === 'weekly_scoped');
  if (!scoped || typeof scoped.percent !== 'number') return null;
  const label = scoped.scope?.model?.display_name || 'Model';
  return {
    percent: Math.min(100, Math.max(0, Math.round(scoped.percent))),
    resetsAt: scoped.resets_at || null,
    label,
  };
}

/**
 * Pay-as-you-go credit, which only some accounts have switched on. Returns null
 * when the account has no credit configured, so the row can stay hidden rather
 * than showing a meaningless zero.
 */
function pickCredit(data) {
  const extra = data.extra_usage;
  if (extra?.is_enabled && typeof extra.utilization === 'number') {
    return {
      percent: Math.min(100, Math.max(0, Math.round(extra.utilization))),
      resetsAt: null,
      label: 'Credit',
      used: extra.used_credits ?? null,
      limit: extra.monthly_limit ?? null,
      currency: extra.currency || null,
    };
  }

  const spend = data.spend;
  if (spend?.enabled && typeof spend.percent === 'number') {
    const exponent = spend.used?.exponent ?? 2;
    return {
      percent: Math.min(100, Math.max(0, Math.round(spend.percent))),
      resetsAt: null,
      label: 'Credit',
      used: spend.used ? spend.used.amount_minor / 10 ** exponent : null,
      limit: spend.limit ?? null,
      currency: spend.used?.currency || null,
    };
  }

  return null;
}

async function fetchUsage() {
  const { token, plan, expiresAt } = await readCredentials();

  if (expiresAt && Date.now() > expiresAt) {
    throw new UsageError(
      'expired',
      'Your Claude Code session expired. Run `claude` once to sign back in.'
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } catch {
    throw new UsageError('offline', 'Could not reach Anthropic.');
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new UsageError(
      'expired',
      'Your Claude Code session expired. Run `claude` once to sign back in.'
    );
  }

  // Polling every 30s across restarts is enough to get throttled, and hammering
  // through it only makes it last longer. Honour the server's own wait if given.
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    const error = new UsageError('rate-limited', 'Anthropic is limiting requests.');
    error.retryAfterMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 15 * 60 * 1000)
        : 2 * 60 * 1000;
    throw error;
  }

  if (!response.ok) {
    throw new UsageError('server', `Anthropic returned ${response.status}.`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new UsageError('server', 'Anthropic returned an unreadable response.');
  }

  const session = pickMeter(data.five_hour);
  const week = pickMeter(data.seven_day);

  if (!session && !week) {
    throw new UsageError('server', 'No usage limits were reported for this account.');
  }

  return {
    plan,
    session,
    week,
    scoped: pickScoped(data.limits),
    credit: pickCredit(data),
    fetchedAt: Date.now(),
  };
}

module.exports = { fetchUsage, UsageError, credentialsPath };
