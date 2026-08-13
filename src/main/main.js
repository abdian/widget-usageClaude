'use strict';

const path = require('path');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  screen,
  shell,
  nativeImage,
} = require('electron');

const store = require('./store');
const pkg = require('../../package.json');
const { fetchUsage, UsageError, credentialsPath } = require('./usage');
const {
  foregroundIsFullscreen,
  isAvailable: fullscreenDetectionAvailable,
} = require('./fullscreen');

let barWindow = null;
let settingsWindow = null;
let tray = null;
let pollTimer = null;
let lastGood = null; // the most recent successful reading, kept so offline can still show something
let lastFailure = null;
let backoffUntil = 0; // set when Anthropic throttles us, so polling sits it out
let topmostTimer = null;
let backoffTimer = null;
let steppedAside = false; // true while the bar has dropped below a fullscreen app
let reportedPanelHeight = 0; // the panel's measured height, straight from the renderer

// setBounds fires 'moved' just like a drag does. This tells them apart, so that
// snapping the bar to an anchor is not mistaken for you moving it off one.
let placingWindow = false;

const isWindows = process.platform === 'win32';
const EDGE_MARGIN = 12;

/* ---------------------------------------------------------------- geometry */

const ANCHORS = {
  'top-left': [0, 0],
  'top-center': [0.5, 0],
  'top-right': [1, 0],
  'middle-left': [0, 0.5],
  'middle-center': [0.5, 0.5],
  'middle-right': [1, 0.5],
  'bottom-left': [0, 1],
  'bottom-center': [0.5, 1],
  'bottom-right': [1, 1],
};

// Windows refuses to make a window shorter than this, so asking for less just
// yields dead space. Compact is designed to land on it rather than fight it.
const MIN_WINDOW_HEIGHT = 64;

/* ------------------------------------------------------------- notch mode */

/*
 * The camera housing is one fixed physical part, and the menu bar is grown to
 * clear it — 33pt on a notched Mac against about 25pt without one. That makes the
 * menu bar height both the detector and the ruler: housing width and the bar it
 * forces are locked in proportion, so measuring the height Electron does report
 * yields the width it does not, under any display scaling.
 *
 * Calibrated on a 14" MacBook Pro at default scaling, where a 33pt menu bar sits
 * over a notch that NSScreen puts at 663..848 — 185pt between the two auxiliary
 * areas. The painted black edge sits a point inside that on the left, so 184 is
 * what actually lines up; the reported figure evidently includes the boundary
 * column rather than stopping at it. 184 also divides the leftover screen evenly
 * (1512 - 184 = 1328), so the centring lands on a whole point with no rounding
 * left to argue about.
 */
const NOTCH_MENU_BAR_MIN = 28;
const NOTCH_WIDTH_PER_MENU_BAR_PT = 184 / 33;
/*
 * How far the black shell reaches up *into* the real notch, and how far it shows
 * below it.
 *
 * The overlap is the whole trick. The camera housing's bottom corners curve
 * inward, so a shell starting flush with the menu bar meets a shape narrower than
 * itself: a seam across the join and a square ear sticking out either side of it.
 * Starting above where that curve begins puts the shell's top edge against the
 * housing at full width, fills the two curved corners with the same black, and
 * leaves one silhouette — straight sides running down to a single rounded edge.
 *
 * The overlap sits over the housing, where there is no menu bar content to hide.
 */
const NOTCH_OVERLAP = 12;

/*
 * How far it shows below. This is a shape, not a hairline with a backdrop: too
 * shallow and the corner radius eats the whole height, which turns the shell into
 * a floating pill instead of the housing growing. Fourteen leaves real straight
 * side wall above the corners, so the silhouette still reads as the notch.
 */
const NOTCH_EXTENSION = 14;

function notchGeometry() {
  if (process.platform !== 'darwin') return null;

  // The notch belongs to the laptop's own screen, so an external monitor being
  // the primary display must not drag the hairline onto it.
  const display =
    screen.getAllDisplays().find((d) => d.internal) ||
    screen.getPrimaryDisplay();

  const menuBar = display.workArea.y - display.bounds.y;
  if (menuBar < NOTCH_MENU_BAR_MIN) return null;

  const width = Math.round(menuBar * NOTCH_WIDTH_PER_MENU_BAR_PT);

  return {
    // Floor, not round: the housing is centred on the panel, so on a screen with
    // an odd amount of room beside it the true edge falls on a half point — and
    // macOS resolves that downward. Rounding lands the hairline a point right of
    // the notch it is meant to sit under.
    x: Math.floor(display.bounds.x + (display.bounds.width - width) / 2),
    y: display.bounds.y + menuBar - NOTCH_OVERLAP,
    width,
    height: NOTCH_OVERLAP + NOTCH_EXTENSION,
  };
}

/** Null unless the setting is on *and* there is a notch to sit under. */
function notchBounds(settings) {
  return settings.notchMode ? notchGeometry() : null;
}

/**
 * The strip is shown whenever it has something to say: either you asked to see
 * the refresh time, or a refresh failed and the reason belongs somewhere.
 */
function stripVisible() {
  return store.get('showRefreshTime') !== false || Boolean(lastFailure);
}

/**
 * Counts only rows that will actually be drawn: a meter the account does not
 * report stays hidden however the setting is left, so sizing matches reality.
 */
function rowsFor(settings) {
  let rows = 0;
  if (settings.showSession !== false) rows += 1;
  if (settings.showWeek !== false) rows += 1;
  if (settings.showScopedWeekly && lastGood?.scoped) rows += 1;
  if (settings.showCredit && lastGood?.credit) rows += 1;
  return Math.max(1, rows);
}

/*
 * Two heights, because they are two different things. The window cannot go below
 * MIN_WINDOW_HEIGHT, but the visible panel can: it is centred inside a transparent
 * window, so switching off a row really does make the box smaller even when the
 * window underneath it stays put. The renderer measures the panel and reports back,
 * which keeps this honest without duplicating the CSS here.
 */
function sizeFor(settings, showStrip) {
  // A fixed hairline: no rows to count, and none of the floors below apply.
  const notch = notchBounds(settings);
  if (notch) {
    return {
      width: notch.width,
      panelHeight: notch.height,
      height: notch.height,
    };
  }

  const rows = rowsFor(settings);
  const compact = Boolean(settings.compact);

  // Keep these in step with bar.css: .row height + .meters gap, per mode.
  const meters = compact
    ? rows * 13 + (rows - 1) * 2
    : rows * 18 + (rows - 1) * 4;
  const chrome = compact ? 14 : 20; // panel padding + borders
  const strip = showStrip ? (compact ? 15 : 22) : 0;

  const panelHeight = reportedPanelHeight || meters + chrome + strip;

  return {
    width: compact ? 236 : 420,
    panelHeight,
    height: Math.max(MIN_WINDOW_HEIGHT, panelHeight),
  };
}

function anchoredPosition(anchor, width, height) {
  const [fx, fy] = ANCHORS[anchor] || ANCHORS['bottom-right'];
  const display = screen.getPrimaryDisplay();

  // workArea stops at the taskbar; bounds is the whole screen, so anchoring to
  // it is what lets the bar sit over the taskbar rather than resting on it.
  const area = store.get('overTaskbar') ? display.bounds : display.workArea;

  return {
    x: Math.round(
      area.x + EDGE_MARGIN + (area.width - width - EDGE_MARGIN * 2) * fx,
    ),
    y: Math.round(
      area.y + EDGE_MARGIN + (area.height - height - EDGE_MARGIN * 2) * fy,
    ),
  };
}

/**
 * Keeps a freely-placed widget on-screen if a monitor was unplugged since.
 *
 * Two things this must not do. Clamping to the work area would shove a bar you
 * deliberately parked on the taskbar back above it — and since every settings
 * change re-clamps, locking the position was enough to make it jump. And clamping
 * the window rather than the panel would nudge it again, because the window is
 * taller than the box you can see; the transparent margin is allowed off-screen.
 */
function clampToDisplay(pos, width, height, panelHeight = height) {
  const nearest = screen.getDisplayMatching({
    x: pos.x,
    y: pos.y,
    width,
    height,
  });
  const area = store.get('overTaskbar') ? nearest.bounds : nearest.workArea;
  const spare = Math.round((height - panelHeight) / 2);

  return {
    x: Math.min(Math.max(pos.x, area.x), area.x + area.width - width),
    y: Math.min(
      Math.max(pos.y, area.y - spare),
      area.y + area.height - height + spare,
    ),
  };
}

function targetBounds(settings) {
  // The notch is the position, so anchor, saved position and clamping all sit
  // this one out — there is exactly one place this bar can go.
  const notch = notchBounds(settings);
  if (notch) return notch;

  const { width, height, panelHeight } = sizeFor(settings, stripVisible());

  if (settings.anchor && settings.anchor !== 'free') {
    // Anchor the visible panel, not the window, then lift the window by the
    // transparent margin above the panel so the box lands where it was asked to.
    const spare = Math.round((height - panelHeight) / 2);
    const spot = anchoredPosition(settings.anchor, width, panelHeight);
    return { x: spot.x, y: spot.y - spare, width, height };
  }

  const stored =
    settings.position || anchoredPosition('bottom-right', width, panelHeight);
  return {
    ...clampToDisplay(stored, width, height, panelHeight),
    width,
    height,
  };
}

function placeWindow() {
  if (!barWindow || barWindow.isDestroyed()) return;
  placingWindow = true;
  barWindow.setBounds(targetBounds(store.all()));
  placingWindow = false;
}

/**
 * The taskbar is a topmost window too, and among topmost windows the one raised
 * last sits in front, so an unattended bar slides behind it. Re-asserting fixes
 * that — but done blindly it also wins against a fullscreen video player, which
 * claims the front the same way.
 *
 * So the loop asks which window is actually in front: against the taskbar it holds
 * its place, and for a genuine fullscreen app it drops out of always-on-top until
 * that ends. `stayAboveFullscreen` turns the courtesy off.
 */
function syncTopmostGuard() {
  if (topmostTimer) {
    clearInterval(topmostTimer);
    topmostTimer = null;
  }

  const settings = store.all();
  if (!settings.alwaysOnTop) return;

  // Only the over-the-taskbar case needs re-asserting; resting above the taskbar
  // involves no contest at all.
  if (!settings.overTaskbar && !settings.stayAboveFullscreen) return;

  topmostTimer = setInterval(() => {
    if (!barWindow || barWindow.isDestroyed() || !barWindow.isVisible()) return;

    // Hold position against the taskbar, but stand down for a fullscreen app —
    // that is the whole reason this checks instead of just raising itself.
    const yieldToFullscreen =
      !settings.stayAboveFullscreen && foregroundIsFullscreen();

    if (yieldToFullscreen) {
      if (!steppedAside) {
        barWindow.setAlwaysOnTop(false);
        steppedAside = true;
      }
      return;
    }

    if (steppedAside) {
      barWindow.setAlwaysOnTop(true, 'screen-saver');
      steppedAside = false;
    }

    barWindow.moveTop();
  }, 1200);
}

/** The strip can appear or vanish with a failure, so the bar has to resize with it. */
function syncBarSize() {
  if (!barWindow || barWindow.isDestroyed()) return;
  const wanted = sizeFor(store.all(), stripVisible());
  if (barWindow.getSize()[1] !== wanted.height) placeWindow();
}

/* ------------------------------------------------------------------ windows */

/**
 * Neither window has anywhere to go. Both load a local file, and the one outbound
 * link in Settings is routed through the main process so it can be checked first.
 * Saying that explicitly means a stray href — or a window.open from a page that
 * holds a live usage reading — can never turn a renderer into a browser.
 */
function sealNavigation(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
}

function createBar() {
  const settings = store.all();
  const bounds = targetBounds(settings);

  barWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false, // the panel draws its own edge so the transparent margin stays clean

    /*
     * macOS, and the only way notch mode can reach the menu bar strip. AppKit
     * quietly rewrites any frame that crosses into it — raising the window level
     * is not enough — and this is the one switch that turns that off. It can only
     * be set at construction, so it is set always; nothing is placed off-screen by
     * it, because clampToDisplay already owns where a free-placed bar may sit.
     */
    enableLargerThanScreen: true,

    /*
     * macOS rounds a frameless window's corners itself, and that clip outranks any
     * radius CSS asks for. It rounds all four, so notch mode got a stadium: the top
     * arcs curved back in below the housing's bottom edge and pinched the sides at
     * exactly the join meant to be invisible. Off, the radius is decided in one
     * place — bar.css — which is also where .panel has always drawn its own.
     */
    roundedCorners: false,
    show: false,
    alwaysOnTop: settings.alwaysOnTop,
    movable: !settings.lockPosition, // correct from birth, so there is no movable moment
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // Electron's default, stated because the token this app can reach makes it worth stating
    },
  });

  sealNavigation(barWindow);

  /*
   * Every runtime setting is applied through this one function rather than being
   * repeated here. Startup used to set only some of them, so a locked position was
   * honoured when you toggled it and quietly forgotten on the next launch — the bar
   * came back draggable however the switch was left.
   */
  applyWindowSettings();

  barWindow.loadFile(path.join(__dirname, '..', 'renderer', 'bar.html'));
  barWindow.once('ready-to-show', () => barWindow.show());

  // The whole bar is a drag handle, and on Windows right-clicking a drag region
  // raises the system menu instead of delivering a contextmenu event to the page.
  // Intercepting WM_INITMENU is what lets the bar answer with its own menu — which
  // compact mode depends on entirely, having no buttons of its own.
  if (isWindows) {
    const WM_INITMENU = 0x0116;
    barWindow.hookWindowMessage(WM_INITMENU, () => {
      barWindow.setEnabled(false); // dismisses the system menu Windows just opened
      barWindow.setEnabled(true);
      Menu.buildFromTemplate(menuTemplate()).popup({ window: barWindow });
    });
  }

  // Dragging the bar is a deliberate choice of place, so it releases the anchor
  // rather than fighting you by snapping back.
  barWindow.on('moved', () => {
    if (!barWindow || placingWindow || store.get('lockPosition')) return;

    const [x, y] = barWindow.getPosition();
    const settings = store.all();

    // Windows reports a move for a plain click on a drag region, so an anchored
    // bar would come unstuck the moment you pressed one of its buttons. Only a
    // real displacement counts as choosing a new place.
    if (settings.anchor && settings.anchor !== 'free') {
      const { width, height } = sizeFor(settings, stripVisible());
      const at = anchoredPosition(settings.anchor, width, height);
      if (Math.abs(at.x - x) <= 2 && Math.abs(at.y - y) <= 2) return;
    }

    store.set({ position: { x, y }, anchor: 'free' });
    broadcastSettings();
    updateTray();
  });

  barWindow.on('closed', () => {
    barWindow = null;
  });
}

function applyWindowSettings() {
  if (!barWindow || barWindow.isDestroyed()) return;
  const settings = store.all();

  const notch = notchBounds(settings);

  /*
   * Notch mode overrides both of these, because it cannot work without them.
   * AppKit refuses to place a window at 'floating' level inside the menu bar
   * strip — it silently clamps the frame back below it, which lands the shell
   * flush against the housing and brings back the seam the overlap exists to
   * remove. Only a window above the status level is left unconstrained, and a
   * window that is not on top has no business being at that level.
   */
  barWindow.setAlwaysOnTop(
    notch ? true : settings.alwaysOnTop,
    notch || settings.stayAboveFullscreen ? 'screen-saver' : 'floating',
  );
  barWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: Boolean(settings.stayAboveFullscreen),
  });
  // Nothing to drag in notch mode: the bar has one home and dragging it off
  // would only strand it somewhere the setting no longer describes.
  barWindow.setMovable(!settings.lockPosition && !notchBounds(settings));
  barWindow.setIgnoreMouseEvents(settings.clickThrough, { forward: true });
  placeWindow();
  syncTopmostGuard();
}

function openSettings() {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 460,
    height: 730,
    frame: false,
    backgroundColor: '#191412',
    resizable: false,
    show: false,
    title: 'Claude Usage settings',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  sealNavigation(settingsWindow);

  settingsWindow.loadFile(
    path.join(__dirname, '..', 'renderer', 'settings.html'),
  );
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

/* -------------------------------------------------------------------- menus */

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

function update(patch) {
  store.set(patch);
  applyWindowSettings();
  broadcastSettings();
  updateTray();
}

function menuTemplate() {
  const settings = store.all();

  return [
    { label: 'Refresh now', click: () => refresh(true) },
    { type: 'separator' },
    {
      label: 'Compact size',
      type: 'checkbox',
      checked: Boolean(settings.compact),
      click: (item) => update({ compact: item.checked }),
    },
    // Offered only where there is a notch to sit under. This is also the way back
    // out: a three-pixel hairline is a poor right-click target, so the escape
    // hatch has to live somewhere that is not the bar itself.
    ...(notchGeometry()
      ? [
          {
            label: 'Notch mode',
            type: 'checkbox',
            checked: Boolean(settings.notchMode),
            click: (item) => update({ notchMode: item.checked }),
          },
        ]
      : []),
    {
      label: 'Position',
      submenu: [
        ...Object.entries(ANCHOR_LABELS).map(([value, label]) => ({
          label,
          type: 'radio',
          checked: settings.anchor === value,
          click: () => update({ anchor: value }),
        })),
        { type: 'separator' },
        {
          label: 'Anywhere I drag it',
          type: 'radio',
          checked: settings.anchor === 'free',
          click: () => update({ anchor: 'free' }),
        },
        { type: 'separator' },
        {
          label: 'Allow over the taskbar',
          type: 'checkbox',
          checked: Boolean(settings.overTaskbar),
          click: (item) => update({ overTaskbar: item.checked }),
        },
      ],
    },
    {
      label: 'Lock position',
      type: 'checkbox',
      checked: Boolean(settings.lockPosition),
      click: (item) => update({ lockPosition: item.checked }),
    },
    { type: 'separator' },
    { label: 'Settings…', click: openSettings },
    {
      label: 'Hide widget',
      click: () => {
        if (barWindow) barWindow.hide();
        updateTray();
      },
    },
    { label: 'Quit', click: () => app.quit() },
  ];
}

/* --------------------------------------------------------------------- tray */

function trayIcon() {
  const image = nativeImage.createFromPath(
    path.join(__dirname, '..', '..', 'build', 'icon.png'),
  );
  if (image.isEmpty()) return nativeImage.createEmpty();
  return image.resize({ width: 16, height: 16 });
}

function updateTray() {
  if (!tray) return;

  const template = [...menuTemplate()];
  template.splice(1, 0, {
    label: 'Show widget',
    type: 'checkbox',
    checked: Boolean(barWindow && barWindow.isVisible()),
    click: () => {
      if (!barWindow) return createBar();
      if (barWindow.isVisible()) barWindow.hide();
      else barWindow.show();
      updateTray();
    },
  });

  tray.setContextMenu(Menu.buildFromTemplate(template));

  /*
   * macOS puts text next to the menu bar clock, which is the native place for a
   * reading like this — and the closest thing to "in the notch", since the notch
   * itself is dead space that the menu bar flows around.
   */
  if (process.platform === 'darwin') {
    if (lastGood) {
      const session = lastGood.session?.percent ?? 0;
      const week = lastGood.week?.percent ?? 0;
      tray.setTitle(`${session}% · ${week}%`);
    } else {
      tray.setTitle(lastFailure ? '—' : '');
    }
  }

  if (lastFailure && !lastGood) {
    tray.setToolTip(`Claude Usage — ${lastFailure.message}`);
  } else if (lastGood) {
    const session = lastGood.session?.percent ?? 0;
    const week = lastGood.week?.percent ?? 0;
    const suffix = lastFailure ? ' (not updating)' : '';
    tray.setToolTip(
      `Claude Usage — session ${session}%, week ${week}%${suffix}`,
    );
  } else {
    tray.setToolTip('Claude Usage');
  }
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Claude Usage');
  tray.on('click', () => {
    if (!barWindow) return createBar();
    barWindow.show();
    updateTray();
  });
  updateTray();
}

/* ------------------------------------------------------------------ polling */

function send(channel, payload) {
  for (const win of [barWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function broadcastSettings() {
  send('settings:changed', store.all());
}

async function refresh(manual = false) {
  // Retrying inside a throttle just earns another 429 and pushes the wait out
  // further, so the request is refused here and the bar shows a countdown instead.
  if (Date.now() < backoffUntil) return;

  send('usage:loading', { manual });

  try {
    const data = await fetchUsage();
    lastGood = data;
    lastFailure = null;
    backoffUntil = 0;
    if (backoffTimer) {
      clearTimeout(backoffTimer);
      backoffTimer = null;
    }
    send('usage:data', data);
  } catch (error) {
    const kind = error instanceof UsageError ? error.kind : 'unknown';

    if (kind === 'rate-limited') {
      const wait = error.retryAfterMs || 120000;
      backoffUntil = Date.now() + wait;

      // Come back exactly when the wait is over rather than idling until the
      // next tick, so the bar recovers on its own.
      if (backoffTimer) clearTimeout(backoffTimer);
      backoffTimer = setTimeout(() => {
        backoffTimer = null;
        refresh(false);
      }, wait + 500);
    }

    lastFailure = {
      kind,
      message: error.message || 'Something went wrong.',
      lastGood,
      failedAt: Date.now(),
      retryAt: kind === 'rate-limited' ? backoffUntil : null,
    };
    send('usage:error', lastFailure);
  }

  syncBarSize();
  updateTray();
}

function schedulePolling() {
  if (pollTimer) clearInterval(pollTimer);
  const seconds = Math.max(120, Number(store.get('refreshSeconds')) || 300);
  pollTimer = setInterval(() => {
    if (Date.now() < backoffUntil) return; // sitting out a throttle
    refresh(false);
  }, seconds * 1000);
}

/* --------------------------------------------------------------------- IPC */

function registerIpc() {
  ipcMain.handle('settings:get', () => store.all());

  ipcMain.handle('settings:set', (_event, patch) => {
    const next = store.set(patch);

    // The old measurement describes the old layout; drop it so the fallback
    // applies until the renderer reports the new one.
    reportedPanelHeight = 0;

    // Read the stored value back rather than the patch: the store is what decides
    // whether a setting was acceptable, so it is what the registry should follow.
    if (patch && 'startAtLogin' in patch) {
      app.setLoginItemSettings({
        openAtLogin: Boolean(next.startAtLogin),
        openAsHidden: true,
      });
    }
    if (patch && 'refreshSeconds' in patch) {
      schedulePolling();
    }

    applyWindowSettings();
    broadcastSettings();
    updateTray();
    return next;
  });

  ipcMain.handle('usage:refresh', () => refresh(true));

  // A window that opens after a poll has already run needs both halves of the
  // picture, otherwise it sits on "Loading…" until the next tick.
  ipcMain.handle('usage:current', () => ({
    data: lastGood,
    error: lastFailure,
  }));

  ipcMain.handle('app:info', () => ({
    name: 'Claude Usage',
    version: app.getVersion(),
    author:
      typeof pkg.author === 'string' ? pkg.author : pkg.author?.name || '',
    homepage: pkg.homepage || '',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    credentialsPath: credentialsPath(),
    platform: process.platform,

    // Settings hides the notch toggle unless this machine actually has one,
    // rather than offering a switch that would place the bar nowhere.
    hasNotch: Boolean(notchGeometry()),

    // Surfaced in About: if this is ever false on Windows, the bar cannot tell a
    // fullscreen app from the taskbar and will not step aside for video.
    fullscreenDetection: fullscreenDetectionAvailable(),
  }));

  ipcMain.on('window:open-settings', openSettings);
  ipcMain.on(
    'window:close-settings',
    () => settingsWindow && settingsWindow.close(),
  );
  ipcMain.on('window:hide-bar', () => {
    if (barWindow) barWindow.hide();
    updateTray();
  });
  // The renderer measures itself, so this is a report rather than an instruction:
  // bound it to what a panel could plausibly be before it becomes a window size.
  ipcMain.on('window:panel-height', (_event, value) => {
    // The hairline's height is decided here, not measured there; letting a
    // report through would only fight the fixed bounds notch mode just set.
    if (notchBounds(store.all())) return;

    const height = Math.round(Number(value) || 0);
    if (height < 8 || height > 600 || height === reportedPanelHeight) return;
    reportedPanelHeight = height;
    placeWindow();
  });

  ipcMain.on('window:context-menu', () => {
    Menu.buildFromTemplate(menuTemplate()).popup({ window: barWindow });
  });
  ipcMain.on('shell:open-credentials-folder', () =>
    shell.showItemInFolder(credentialsPath()),
  );
  ipcMain.on('shell:open-external', (_event, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url))
      shell.openExternal(url);
  });
}

/* --------------------------------------------------------------- lifecycle */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (barWindow) barWindow.show();
    else createBar();
  });

  app.whenReady().then(() => {
    if (isWindows) app.setAppUserModelId('dev.esanj.claude-usage-widget');

    registerIpc();

    // Reconcile the login item on every start. It was only ever written when the
    // setting was toggled, so a reinstall or a moved executable would leave the
    // registry pointing at a path that no longer runs.
    app.setLoginItemSettings({
      openAtLogin: Boolean(store.get('startAtLogin')),
      openAsHidden: true,
    });

    createBar();
    createTray();
    schedulePolling();
    syncTopmostGuard();

    // An anchored bar should follow the screen it is anchored to, not drift off
    // it when a monitor is added, removed, or rescaled.
    for (const event of [
      'display-metrics-changed',
      'display-added',
      'display-removed',
    ]) {
      screen.on(event, () => placeWindow());
    }

    // Wait for the renderer before the first poll so it sees the result live
    // rather than having to ask for it after the fact.
    barWindow.webContents.once('did-finish-load', () => refresh(true));

    app.on('activate', () => {
      if (!barWindow) createBar();
      else barWindow.show();
    });
  });

  // The widget lives in the tray, so closing its windows should not quit the app.
  // Subscribing at all is what suppresses Electron's default quit.
  app.on('window-all-closed', () => {});
}
