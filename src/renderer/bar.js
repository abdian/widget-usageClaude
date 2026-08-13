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
const notchBar = document.getElementById('notchBar');
const notchFill = document.getElementById('notchFill');

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
let hasNotch = false; // answered by the main process, which is the only side that can measure one

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

/**
 * The setting on its own is not enough to switch layouts on.
 *
 * Only the main process can tell whether there is a notch, and it is already
 * refusing to place the window under one that does not exist. Reading the flag
 * alone would let the two disagree — the panel hidden and a hairline drawn inside
 * a full-sized window — which is what a settings.json carried over from a Mac, or
 * a Mac with no notch of its own, would otherwise produce.
 */
function notchActive() {
  return hasNotch && Boolean(settings.notchMode);
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

/*
 * The session window is a fixed five hours ending at resets_at, which is the only
 * reason the wait can be drawn as a proportion at all: the API gives the far end
 * of the window, and its length is what turns that into a position within it.
 */
const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;

/** True once the 5-hour allowance is spent and only the clock is still moving. */
function isDepleted() {
  return (latest?.session?.percent ?? 0) >= 100;
}

/** How far through the session window we are now, 0–100. */
function resetProgress(iso) {
  if (!iso) return 0;
  const remaining = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(remaining)) return 0;

  const elapsed = SESSION_WINDOW_MS - remaining;
  return Math.min(100, Math.max(0, (elapsed / SESSION_WINDOW_MS) * 100));
}

/**
 * Notch mode's entire render. Always the 5-hour session, whatever the meter
 * checkboxes say — those pick rows for a bar that has no rows here, and a mode
 * defined as "the session, as a hairline" should not be switchable to empty.
 *
 * At 100% the meter changes what it measures. A full bar that stays full says
 * nothing for the hours it stays that way, so once there is no allowance left to
 * track it switches to the wait for the next one and fills as the reset comes up.
 * The colour is what marks the change of subject — with no label to read, it is
 * the only thing that can.
 */
function paintNotch() {
  const blocked = isBlocked();
  document.body.classList.toggle('is-stale', Boolean(failure) && !blocked);
  document.body.classList.toggle('is-blocked', blocked);

  const depleted = isDepleted();
  document.body.classList.toggle('is-depleted', depleted);

  const percent = latest?.session?.percent ?? 0;
  const filled = depleted ? resetProgress(latest?.session?.resetsAt) : percent;

  notchBar.style.setProperty(
    '--c',
    depleted ? 'var(--depleted)' : `var(--${severity(percent)})`
  );
  notchFill.style.setProperty('--empty', `${100 - filled}%`);
}

function render() {
  if (notchActive()) return paintNotch();

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
  // The hairline's height is fixed by the main process, so measuring it here
  // would only report a number back at whoever already decided it. Forgetting the
  // last measurement is what makes leaving notch mode send a fresh one: the main
  // process drops its copy on every settings change, and a height that merely
  // matched the stale value here would be skipped and never replace it.
  if (notchActive()) {
    lastReportedHeight = 0;
    return;
  }

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
  document.body.classList.toggle('notch', notchActive());
  panel.classList.toggle('compact', Boolean(settings.compact));

  const opacity = String(settings.opacity ?? 0.96);
  panel.style.setProperty('--panel-opacity', opacity);
  notchBar.style.setProperty('--panel-opacity', opacity);
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
  if (notchActive()) {
    // Nothing in notch mode ticks except a depleted meter, which is a clock and
    // has to be redrawn to advance. A usage meter only moves on a poll.
    if (isDepleted()) paintNotch();
    return;
  }

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
  // Both before the first paint, since the layout depends on the pair of them.
  // hasNotch starting false is the safe way round: anything rendering early gets
  // the full bar, never a hairline stranded in a full-sized window.
  const [info, stored] = await Promise.all([api.appInfo(), api.getSettings()]);
  hasNotch = Boolean(info.hasNotch);

  applySettings(stored);

  const state = await api.current();
  if (state?.data) latest = state.data;
  if (state?.error) failure = state.error;
  if (state?.data || state?.error) render();
})();
