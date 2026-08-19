'use strict';

const api = window.claudeUsage;

let settings = {};

/* -------------------------------------------------------------------- tabs */

const tabs = Array.from(document.querySelectorAll('.tab'));
const panels = Array.from(document.querySelectorAll('.panel-tab'));

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    for (const other of tabs) {
      other.setAttribute('aria-selected', String(other === tab));
    }
    for (const panel of panels) {
      panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    }
    document.querySelector('.sheet').scrollTop = 0;
  });
}

/* ---------------------------------------------------------------- controls */

function bindSwitch(id, key) {
  const el = document.getElementById(id);
  el.addEventListener('click', async () => {
    const next = el.getAttribute('aria-checked') !== 'true';
    el.setAttribute('aria-checked', String(next));
    settings = await api.setSettings({ [key]: next });
  });
  return el;
}

/** Same behaviour as a switch, drawn as a checkbox because these are a set. */
function bindCheck(id, key) {
  const el = document.getElementById(id);
  el.addEventListener('click', async () => {
    if (el.getAttribute('aria-disabled') === 'true') return;
    const next = el.getAttribute('aria-checked') !== 'true';
    el.setAttribute('aria-checked', String(next));
    settings = await api.setSettings({ [key]: next });
  });
  return el;
}

const checks = {
  session: bindCheck('mSession', 'showSession'),
  week: bindCheck('mWeek', 'showWeek'),
  scoped: bindCheck('mScoped', 'showScopedWeekly'),
  credit: bindCheck('mCredit', 'showCredit'),
};

const switches = {
  compact: bindSwitch('compact', 'compact'),
  notchMode: bindSwitch('notchMode', 'notchMode'),
  onTop: bindSwitch('onTop', 'alwaysOnTop'),
  aboveFullscreen: bindSwitch('aboveFullscreen', 'stayAboveFullscreen'),
  overTaskbar: bindSwitch('overTaskbar', 'overTaskbar'),
  lock: bindSwitch('lock', 'lockPosition'),
  clickThrough: bindSwitch('clickThrough', 'clickThrough'),
  startup: bindSwitch('startup', 'startAtLogin'),
  refreshTime: bindSwitch('refreshTime', 'showRefreshTime'),
  autoUpdate: bindSwitch('autoUpdate', 'autoUpdate'),
};

/* -------------------------------------------------------- position picker */

const ANCHOR_LABELS = {
  'top-left': 'Top left',
  'top-center': 'Top center',
  'top-right': 'Top right',
  'middle-left': 'Middle left',
  'middle-center': 'Middle center',
  'middle-right': 'Middle right',
  'bottom-left': 'Bottom left',
  'bottom-center': 'Bottom center',
  'bottom-right': 'Bottom right',
};

const spots = Array.from(document.querySelectorAll('.spot'));
const anchorCaption = document.getElementById('anchorCaption');

for (const spot of spots) {
  spot.addEventListener('click', async () => {
    settings = await api.setSettings({ anchor: spot.dataset.anchor });
  });
}

function paintAnchor(anchor) {
  for (const spot of spots) {
    spot.setAttribute('aria-checked', String(spot.dataset.anchor === anchor));
  }
  anchorCaption.textContent = ANCHOR_LABELS[anchor] || 'Wherever you drag it';
}

const intervalEl = document.getElementById('interval');
const opacityEl = document.getElementById('opacity');
const opacityValue = document.getElementById('opacityValue');

intervalEl.addEventListener('change', async () => {
  settings = await api.setSettings({ refreshSeconds: Number(intervalEl.value) });
});

opacityEl.addEventListener('input', () => {
  opacityValue.textContent = `${opacityEl.value}%`;
});

opacityEl.addEventListener('change', async () => {
  settings = await api.setSettings({ opacity: Number(opacityEl.value) / 100 });
});

document.getElementById('closeBtn').addEventListener('click', () => api.closeSettings());

/*
 * The one keyboard way out. This window draws its own titlebar, so there is no
 * system close button behind it — and on a Mac the app has no menu bar either,
 * being a menu bar item itself, so Cmd-W has nothing to close it with. Without
 * this the × in the corner is the only exit there is.
 */
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.closeSettings();
});
document.getElementById('refreshNow').addEventListener('click', () => api.refresh());
document.getElementById('openFolder').addEventListener('click', () => api.openCredentialsFolder());

/* ------------------------------------------------------------------ mirror */

function paintSettings(next) {
  settings = next || {};

  switches.compact.setAttribute('aria-checked', String(Boolean(settings.compact)));
  switches.notchMode.setAttribute('aria-checked', String(Boolean(settings.notchMode)));
  switches.onTop.setAttribute('aria-checked', String(Boolean(settings.alwaysOnTop)));
  switches.aboveFullscreen.setAttribute(
    'aria-checked',
    String(Boolean(settings.stayAboveFullscreen))
  );

  checks.session.setAttribute('aria-checked', String(settings.showSession !== false));
  checks.week.setAttribute('aria-checked', String(settings.showWeek !== false));
  checks.scoped.setAttribute('aria-checked', String(Boolean(settings.showScopedWeekly)));
  checks.credit.setAttribute('aria-checked', String(Boolean(settings.showCredit)));
  switches.lock.setAttribute('aria-checked', String(Boolean(settings.lockPosition)));
  switches.clickThrough.setAttribute('aria-checked', String(Boolean(settings.clickThrough)));
  switches.startup.setAttribute('aria-checked', String(Boolean(settings.startAtLogin)));
  switches.overTaskbar.setAttribute('aria-checked', String(Boolean(settings.overTaskbar)));
  switches.refreshTime.setAttribute('aria-checked', String(settings.showRefreshTime !== false));
  switches.autoUpdate.setAttribute('aria-checked', String(settings.autoUpdate !== false));

  paintAnchor(settings.anchor || 'bottom-right');
  // 300 matches the store's default; 60 is not one of the options, so falling
  // back to it would leave the select showing nothing at all.
  intervalEl.value = String(settings.refreshSeconds ?? 300);

  const opacityPercent = Math.round((settings.opacity ?? 0.96) * 100);
  opacityEl.value = String(opacityPercent);
  opacityValue.textContent = `${opacityPercent}%`;
}

/* ----------------------------------------------------------------- updates */

const updateCard = document.getElementById('update');
const updateStateEl = document.getElementById('updateState');
const updateBadge = document.getElementById('updateBadge');
const updateTrack = document.getElementById('updateTrack');
const updateFill = document.getElementById('updateFill');
const updateGo = document.getElementById('updateGo');
const updateNote = document.getElementById('updateNote');
const updateNotes = document.getElementById('updateNotes');

let update = { status: 'idle' };

/*
 * What the card says, and what its button offers, for each state. Kept as one
 * table because the two have to agree: a headline announcing a download with a
 * button offering to check again is how a person ends up not trusting either.
 *
 * A null action means there is nothing useful to press — the button stays put and
 * greys out rather than vanishing, so the card does not change height while it
 * works.
 */
const UPDATE_COPY = {
  idle: () => ['Not checked yet', 'Check for updates'],
  checking: () => ['Looking for a newer version…', null],
  none: () => ['This is the newest version', 'Check again'],
  available: (u) => [`Version ${u.version} is available`, 'Download it'],
  downloading: (u) => [`Downloading version ${u.version}…`, null],
  ready: (u) => [`Version ${u.version} is ready`, 'Restart and install'],
  installing: () => ['Restarting to finish the update…', null],
  unpublished: (u) => [u.message || 'No release has been published yet', 'Check again'],
  manual: (u) => [`Version ${u.version} is available`, 'Get it from GitHub'],
  error: (u) => [u.message || 'The check did not finish', 'Try again'],
  unavailable: (u) => [u.message || 'This build cannot update itself', null],
};

function paintUpdate(next) {
  update = next || {};
  const status = UPDATE_COPY[update.status] ? update.status : 'idle';
  const [headline, action] = UPDATE_COPY[status](update);

  updateCard.dataset.state = status;
  updateStateEl.textContent = headline;

  // The badge carries the one number worth watching, and nothing when there is
  // no number: a percentage mid-download, the version otherwise.
  if (status === 'downloading') {
    updateBadge.hidden = false;
    updateBadge.textContent = `${update.percent || 0}%`;
  } else if ((status === 'available' || status === 'ready' || status === 'manual') && update.version) {
    updateBadge.hidden = false;
    updateBadge.textContent = 'new';
  } else {
    updateBadge.hidden = true;
  }

  updateTrack.hidden = status !== 'downloading';
  updateFill.style.setProperty('--empty', `${100 - (update.percent || 0)}%`);

  updateGo.hidden = !action && status === 'unavailable';
  updateGo.disabled = !action;
  if (action) updateGo.textContent = action;

  /*
   * One state, and only one, has news the headline cannot hold: there is a newer
   * version *and* a reason this copy cannot install it. Everywhere else the
   * message is already the headline, and printing it twice is how a card stops
   * being read at all.
   */
  const note = status === 'manual' ? update.message : null;
  updateNote.hidden = !note;
  updateNote.textContent = note || '';

  updateNotes.hidden = !update.releaseUrl || status === 'none';
}

updateGo.addEventListener('click', async () => {
  // Nothing to fetch here — this build cannot install what it would fetch, so the
  // button does the only useful thing and opens the page.
  if (update.status === 'manual') {
    api.openReleaseNotes();
    return;
  }
  if (update.status === 'available') {
    paintUpdate(await api.downloadUpdate());
    return;
  }
  if (update.status === 'ready') {
    api.installUpdate();
    return;
  }
  paintUpdate(await api.checkUpdate());
});

updateNotes.addEventListener('click', () => api.openReleaseNotes());

api.onUpdate(paintUpdate);

/* ----------------------------------------------------------------- readout */

const readoutRows = document.getElementById('readoutRows');
const readoutState = document.getElementById('readoutState');
const planEl = document.getElementById('plan');

function untilReset(iso) {
  if (!iso) return 'No reset scheduled';
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return 'No reset scheduled';
  if (ms <= 0) return 'Resetting now';

  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `Resets in ${days}d ${hours % 24}h`;
  if (hours > 0) return `Resets in ${hours}h ${minutes % 60}m`;
  return `Resets in ${minutes}m`;
}

function severity(percent) {
  if (percent >= 85) return 'alarm';
  if (percent >= 60) return 'warn';
  return 'calm';
}

function failureLabel(error) {
  return (
    {
      offline: 'No connection',
      'rate-limited': 'Checking too often',
      'no-credentials': 'Not signed in',
      expired: 'Sign-in expired',
    }[error.kind] || error.message
  );
}

function rowMarkup(name, meter) {
  const row = document.createElement('div');
  row.className = 'readout-row';
  row.style.setProperty('--c', `var(--${severity(meter.percent)})`);

  const head = document.createElement('div');
  head.className = 'readout-row-head';

  const label = document.createElement('span');
  label.className = 'readout-row-name';
  label.textContent = name;

  const value = document.createElement('span');
  value.className = 'readout-row-value';
  value.textContent = `${meter.percent}%`;

  head.append(label, value);

  const track = document.createElement('div');
  track.className = 'readout-meter';
  const fill = document.createElement('span');
  fill.style.setProperty('--empty', `${100 - meter.percent}%`);
  track.append(fill);

  const reset = document.createElement('div');
  reset.className = 'readout-row-reset';
  reset.textContent = untilReset(meter.resetsAt);

  row.append(head, track, reset);
  return row;
}

function paintReadout(data) {
  readoutRows.replaceChildren();
  if (!data) return;

  planEl.textContent = data.plan ? `Claude ${data.plan}` : 'Claude';

  if (data.session) readoutRows.append(rowMarkup('5-hour session', data.session));
  if (data.week) readoutRows.append(rowMarkup('Weekly, all models', data.week));
  if (data.scoped) readoutRows.append(rowMarkup(`Weekly, ${data.scoped.label}`, data.scoped));
  if (data.credit) readoutRows.append(rowMarkup('Extra usage credit', data.credit));

  // A meter the account does not report cannot be switched on, so say why
  // instead of leaving a checkbox that does nothing.
  const scopedNote = document.getElementById('scopedNote');
  const creditNote = document.getElementById('creditNote');

  if (data.scoped) {
    checks.scoped.removeAttribute('aria-disabled');
    scopedNote.textContent = `The separate weekly cap on ${data.scoped.label}`;
  } else {
    checks.scoped.setAttribute('aria-disabled', 'true');
    scopedNote.textContent = 'Your account does not report a per-model cap';
  }

  if (data.credit) {
    checks.credit.removeAttribute('aria-disabled');
    const amount =
      data.credit.used != null && data.credit.currency
        ? `${data.credit.used} ${data.credit.currency} used`
        : 'Pay-as-you-go credit';
    creditNote.textContent = amount;
  } else {
    checks.credit.setAttribute('aria-disabled', 'true');
    creditNote.textContent = 'Credits are not switched on for your account';
  }

  readoutState.textContent = 'Up to date';
}

api.onData(paintReadout);
api.onLoading(() => {
  readoutState.textContent = 'Checking…';
});
api.onError((error) => {
  readoutState.textContent = failureLabel(error);
});
api.onSettings(paintSettings);

/* -------------------------------------------------------------------- init */

(async () => {
  paintSettings(await api.getSettings());
  paintUpdate(await api.updateState());

  const info = await api.appInfo();
  document.getElementById('credPath').textContent = info.credentialsPath;
  document.getElementById('aboutName').textContent = info.name;
  document.getElementById('aboutVersion').textContent = `Version ${info.version}`;
  document.getElementById('aboutAuthor').textContent = info.author
    ? `Built by ${info.author}`
    : '';
  const detection =
    info.platform === 'win32'
      ? ` · fullscreen detection ${info.fullscreenDetection ? 'on' : 'unavailable'}`
      : '';
  document.getElementById('aboutRuntime').textContent =
    `Electron ${info.electron} · Chromium ${info.chrome} · MIT${detection}`;

  const repoLink = document.getElementById('repoLink');
  if (info.homepage) {
    repoLink.addEventListener('click', () => api.openExternal(info.homepage));
  } else {
    repoLink.hidden = true;
  }

  // The page is written for Windows, where most of this runs. The few labels that
  // name a piece of the desktop have to name the right one.
  if (info.platform === 'darwin') {
    document.getElementById('loginLabel').textContent = 'Start when the Mac starts';
    document.getElementById('overEdgeLabel').textContent = 'Allow over the Dock';
    document.getElementById('overEdgeHelp').textContent =
      'Edge positions sit over the Dock and menu bar instead of beside them';
  }

  // Offering the switch on a machine with no notch would place the bar nowhere.
  if (info.hasNotch) document.getElementById('notchField').hidden = false;

  const state = await api.current();
  if (state?.data) paintReadout(state.data);
  if (state?.error) readoutState.textContent = failureLabel(state.error);
})();
