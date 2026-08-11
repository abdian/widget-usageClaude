'use strict';

const api = window.claudeUsage;

const panel = document.getElementById('panel');
const statusEl = document.getElementById('status');
const metersEl = document.getElementById('meters');
const noticeEl = document.getElementById('notice');
const noticeTitle = document.getElementById('noticeTitle');
const noticeDetail = document.getElementById('noticeDetail');
const stripEl = document.getElementById('strip');
const stripState = document.getElementById('stripState');
const stripRetry = document.getElementById('stripRetry');
const stripPlan = document.getElementById('stripPlan');

const rows = {
  session: metersEl.querySelector('[data-meter="session"]'),
  week: metersEl.querySelector('[data-meter="week"]'),
  scoped: metersEl.querySelector('[data-meter="scoped"]'),
  credit: metersEl.querySelector('[data-meter="credit"]'),
};

let settings = {};
let latest = null; // last successful reading, kept so the countdowns keep running while offline
let failure = null;
let loading = false;

/* ---------------------------------------------------------------- helpers */

/** "5d 21h" · "2h 57m" · "43m" — the coarsest useful unit pair, never more. */
function untilReset(iso) {
  if (!iso) return '--';

  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return '--';
  if (ms <= 0) return 'due';

  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return '<1m';
}

function clockTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Within the hour, how long ago is the useful fact; past that, the clock time is.
 * "3 min ago" answers "are these numbers fresh?" without any mental arithmetic.
 */
function sinceLabel(timestamp) {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 min ago';
  if (minutes < 60) return `${minutes} min ago`;
  return clockTime(timestamp);
}

function severity(percent) {
  if (percent >= 85) return 'alarm';
  if (percent >= 60) return 'warn';
  return 'calm';
}

function isBlocked() {
  return failure?.kind === 'no-credentials' || failure?.kind === 'expired';
}

/* ------------------------------------------------------------------ render */

function paintRow(row, meter, label) {
  if (!row) return;

  if (!meter) {
    row.hidden = true;
    return;
  }

  row.hidden = false;
  if (label) {
    row.dataset.long = label.toUpperCase();
    row.dataset.short = label.slice(0, 5).toUpperCase();
  }
  row.querySelector('.label').textContent = settings.compact ? row.dataset.short : row.dataset.long;

  const level = severity(meter.percent);
  row.classList.remove('sev-calm', 'sev-warn', 'sev-alarm');
  row.classList.add(`sev-${level}`);
  row.style.setProperty('--c', `var(--${level})`);

  row.querySelector('.fill').style.setProperty('--empty', `${100 - meter.percent}%`);
  row.querySelector('.pct').textContent = `${meter.percent}%`;
  row.querySelector('.time').textContent = untilReset(meter.resetsAt);
}

/** Pairs each row element with the meter it should draw, or null to stay hidden. */
function meterPairs() {
  return [
    [rows.session, settings.showSession === false ? null : latest?.session],
    [rows.week, settings.showWeek === false ? null : latest?.week],
    [rows.scoped, settings.showScopedWeekly ? latest?.scoped : null],
    [rows.credit, settings.showCredit ? latest?.credit : null],
  ];
}

function paintCountdowns() {
  if (!latest) return;
  const pairs = meterPairs();
  for (const [row, meter] of pairs) {
    if (row && meter && !row.hidden) {
      row.querySelector('.time').textContent = untilReset(meter.resetsAt);
    }
  }
}

function throttleSecondsLeft() {
  if (failure?.kind !== 'rate-limited' || !failure.retryAt) return 0;
  return Math.max(0, Math.ceil((failure.retryAt - Date.now()) / 1000));
}

function clockish(seconds) {
  const mins = Math.floor(seconds / 60);
  return mins > 0 ? `${mins}m ${seconds % 60}s` : `${seconds}s`;
}

/** The strip is the bar's permanent answer to "are these numbers current?". */
function paintStrip() {
  stripPlan.textContent = latest?.plan ? latest.plan.toUpperCase() : '';

  // Offering Retry during a throttle only earns another refusal, so it is
  // replaced by the wait itself.
  const waiting = throttleSecondsLeft();
  stripRetry.hidden = !failure || waiting > 0;

  if (loading) {
    stripState.textContent = 'Checking…';
    return;
  }

  if (waiting > 0) {
    stripState.textContent = `Checking too often · retrying in ${clockish(waiting)}`;
    return;
  }

  if (failure) {
    const stamp = latest ? ` · last ${sinceLabel(latest.fetchedAt)}` : '';
    const headline =
      { offline: 'No connection', 'rate-limited': 'Checking too often' }[failure.kind] ||
      failure.message;
    stripState.textContent = `${headline}${stamp}`;
    return;
  }

  stripState.textContent = latest ? `Updated ${sinceLabel(latest.fetchedAt)}` : 'Not loaded yet';
}

function showNotice(title, detail) {
  noticeTitle.textContent = title;
  noticeDetail.textContent = detail;
  noticeEl.hidden = false;
  metersEl.hidden = true;
  document.getElementById('retry').hidden = throttleSecondsLeft() > 0;
}

function render() {
  const blocked = isBlocked();

  panel.classList.toggle('is-offline', Boolean(failure) && !blocked);
  panel.classList.toggle('is-blocked', blocked);

  // A stale reading still answers "how much have I got left", so keep showing it
  // and let the amber dot and strip say the numbers stopped updating. Sign-in
  // problems are the exception: those need you to act, so they take over the bar.
  if (latest && !blocked) {
    noticeEl.hidden = true;
    metersEl.hidden = false;

    // Turning the refresh time off hides the strip while all is well, but a
    // failure still needs somewhere to say so.
    stripEl.hidden = settings.showRefreshTime === false && !failure;

    for (const [row, meter] of meterPairs()) {
      paintRow(row, meter, meter?.label || null);
    }
    paintStrip();

    statusEl.title = failure
      ? `${failure.message} Showing the reading from ${sinceLabel(latest.fetchedAt)}.`
      : `Updated ${sinceLabel(latest.fetchedAt)}`;
    return;
  }

  stripEl.hidden = true;
  statusEl.title = failure ? failure.message : 'Loading…';

  if (!failure) {
    showNotice('Loading usage…', 'Reading your Claude Code session');
    return;
  }

  const copy = {
    'no-credentials': ['Sign in to Claude Code', 'Run claude in a terminal, then retry'],
    expired: ['Sign-in expired', 'Run claude once to sign back in, then retry'],
    offline: ['No connection', "Can't reach Anthropic right now"],
    // Compact hides the detail line, so the wait has to live in the title.
    'rate-limited': [
      throttleSecondsLeft() > 0
        ? `Retrying in ${clockish(throttleSecondsLeft())}`
        : 'Checking too often',
      'Anthropic is limiting requests',
    ],
    server: ['Anthropic unavailable', failure.message],
  }[failure.kind] || ['Something went wrong', failure.message];

  showNotice(copy[0], copy[1]);
}

/**
 * The window has a floor the panel does not, so the main process needs the panel's
 * real height to place the visible box where the anchor asked for it.
 */
let lastReportedHeight = 0;

function reportHeight() {
  requestAnimationFrame(() => {
    const height = Math.round(panel.getBoundingClientRect().height);
    if (!height || height === lastReportedHeight) return;
    lastReportedHeight = height;
    api.reportPanelHeight(height);
  });
}

/* ---------------------------------------------------------------- settings */

function applySettings(next) {
  settings = next || {};
  panel.classList.toggle('compact', Boolean(settings.compact));
  panel.style.setProperty('--panel-opacity', String(settings.opacity ?? 0.96));
  panel.title = settings.compact ? 'Right-click for options' : '';
  render();
  reportHeight();
}

/* ------------------------------------------------------------------ wiring */

document.getElementById('refreshBtn').addEventListener('click', () => api.refresh());
document.getElementById('retry').addEventListener('click', () => api.refresh());
document.getElementById('settingsBtn').addEventListener('click', () => api.openSettings());
document.getElementById('hideBtn').addEventListener('click', () => api.hideBar());
stripRetry.addEventListener('click', () => api.refresh());

// Every control on the bar is also reachable here, which is what lets compact
// mode drop the buttons entirely.
window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  api.contextMenu();
});

api.onLoading(() => {
  loading = true;
  panel.classList.add('is-loading');
  paintStrip();
});

api.onData((data) => {
  loading = false;
  panel.classList.remove('is-loading');
  latest = data;
  failure = null;
  render();
  reportHeight();
});

api.onError((error) => {
  loading = false;
  panel.classList.remove('is-loading');
  failure = error;
  if (!latest && error.lastGood) latest = error.lastGood;
  render();
  reportHeight();
});

api.onSettings(applySettings);

// Countdowns move every second; "3 min ago" and the throttle wait keep up too.
setInterval(() => {
  paintCountdowns();
  if (!stripEl.hidden) paintStrip();
  if (!noticeEl.hidden) {
    document.getElementById('retry').hidden = throttleSecondsLeft() > 0;
    if (throttleSecondsLeft() > 0) {
      noticeTitle.textContent = `Retrying in ${clockish(throttleSecondsLeft())}`;
    }
  }
}, 1000);

(async () => {
  applySettings(await api.getSettings());

  const state = await api.current();
  if (state?.data) latest = state.data;
  if (state?.error) failure = state.error;
  if (state?.data || state?.error) render();
})();
