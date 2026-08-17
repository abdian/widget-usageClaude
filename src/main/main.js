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
const updater = require('./updater');
const { fetchUsage, UsageError, credentialsPath } = require('./usage');
const {
  claimSingleInstance,
  disableSystemMenu,
  foregroundIsFullscreen,
  handleOf,
  isCoveredAt,
  raiseToTop,
  taskbarHandle,
  pinAbove,
  unpin,
  isAvailable: win32Available,
} = require('./win32');

const APP_ID = 'dev.esanj.claude-usage-widget';

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
let fullscreenVotes = 0; // see stepAsideDecision: consecutive readings, not one reading
let barHandle = 0; // the bar's HWND, read once it exists
let pinnedTo = 0; // the taskbar the bar is currently owned by — see syncTaskbarPin
let reportedPanelHeight = 0; // the panel's measured height, straight from the renderer
let openMenu = null; // the context menu while it is on screen — see showContextMenu
let lastMenu = null; // the previous one, kept a while longer — see showContextMenu
let menuPending = false; // a menu has been asked for and is due on the next turn
let menuOpenedAt = 0; // when it went up — see menuIsUp

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

/*
 * Windows refuses to make a window shorter than this, so asking for less just
 * yields dead space. Compact is designed to land on it rather than fight it.
 *
 * Nowhere else has that floor, and the margin is not free everywhere: a macOS
 * window takes clicks across its whole frame, transparent or not, so a floor
 * there would leave an invisible band above and below the bar that swallows
 * whatever you were trying to click. Matching the panel exactly costs nothing.
 */
const MIN_WINDOW_HEIGHT = isWindows ? 64 : 0;

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
 * Should the bar be standing down right now?
 *
 * Deliberately slow to change its mind. A single reading flips around whenever a
 * window is mid-resize or a player is entering fullscreen, and acting on each one
 * dropped the bar behind the taskbar and pulled it back a moment later — the
 * blinking this whole guard exists to prevent. Two readings have to agree.
 */
function stepAsideDecision(settings) {
  if (settings.stayAboveFullscreen) {
    fullscreenVotes = 0;
    return false;
  }

  fullscreenVotes = Math.max(-2, Math.min(2, fullscreenVotes + (foregroundIsFullscreen() ? 1 : -1)));

  if (!steppedAside && fullscreenVotes >= 2) return true;
  if (steppedAside && fullscreenVotes <= -2) return false;
  return steppedAside;
}

/** The visible panel in screen coordinates: the window minus its transparent margin. */
function panelRect() {
  const bounds = barWindow.getBounds();
  const { panelHeight } = sizeFor(store.all(), stripVisible());
  const spare = Math.max(0, Math.round((bounds.height - panelHeight) / 2));

  return {
    x: bounds.x,
    y: bounds.y + spare,
    width: bounds.width,
    height: Math.min(bounds.height, panelHeight),
  };
}

/*
 * A menu stands the topmost guard down, so a menu that never reports closing
 * stands it down for the rest of the session — and a bar that has sunk behind the
 * taskbar then stays there until a click happens to raise it. That is a much worse
 * failure than the one the stand-down exists to avoid, and it is invisible: nothing
 * looks wrong except that the guard has quietly stopped working.
 *
 * So the stand-down has an expiry. Nobody sits reading this menu for a quarter of a
 * minute, and if somebody does, the cost is the bar drawing over the last of it.
 */
const MENU_MAX_MS = 15000;

function menuIsUp() {
  if (!openMenu) return false;
  if (Date.now() - menuOpenedAt < MENU_MAX_MS) return true;

  openMenu = null;
  return false;
}

/**
 * The taskbar is a topmost window too, and among topmost windows the one raised
 * last sits in front — so Windows quietly drops the bar behind it whenever the
 * taskbar is raised, which is often. Something has to put it back.
 *
 * The old loop simply raised the bar every tick. That fixed the z-order and caused
 * the flicker: the bar was being lifted and repainted constantly, almost always
 * for nothing. Now it looks first — is anything actually drawn on top of us? — and
 * only then acts, without stealing focus. A quiet desktop means no movement at all.
 *
 * The other half is knowing when *not* to win: a genuine fullscreen app gets the
 * front, and the bar drops out of always-on-top until that ends.
 */
function syncTopmostGuard() {
  if (topmostTimer) {
    clearInterval(topmostTimer);
    topmostTimer = null;
  }

  fullscreenVotes = 0;

  const settings = store.all();
  if (!settings.alwaysOnTop) return;

  // Without the coverage check, asking is not possible and every tick is a blind
  // raise — so keep that rare, and only where it was actually needed.
  const canCheck = win32Available();
  if (!canCheck && !settings.overTaskbar && !settings.stayAboveFullscreen) return;

  topmostTimer = setInterval(() => {
    if (!barWindow || barWindow.isDestroyed() || !barWindow.isVisible()) return;

    /*
     * Stand down while our own menu is up.
     *
     * Not because the check would mistake the menu for a covering — isCoveredAt
     * ignores this app's own windows now — but because of what the answer costs.
     * Raising to the top of the topmost band beats the popup as well, and the bar
     * ends up drawn over the bottom of the menu you are reading. Measured against
     * the alternative, a fifth of a second behind the taskbar as the menu appears
     * is much the smaller fault; what actually needed fixing was the second and a
     * half *after* it closes, and settleTopmost has that.
     */
    if (menuIsUp()) return;

    const current = store.all();

    if (stepAsideDecision(current)) {
      if (!steppedAside) {
        barWindow.setAlwaysOnTop(false);
        steppedAside = true;
      }
      return;
    }

    if (steppedAside) {
      barWindow.setAlwaysOnTop(true, current.stayAboveFullscreen ? 'screen-saver' : 'floating');
      steppedAside = false;
    }

    // Cheap, and the only thing standing between an Explorer restart and a bar
    // that is no longer pinned to anything.
    syncTaskbarPin();

    assertTopmost(canCheck);

    /*
     * 150ms, and the number is the whole fix for the blinking.
     *
     * The bar does lose its place — the shell re-raises the taskbar often, and
     * nothing can stop it. What was measurable is how long it stayed lost: at a
     * 400ms tick the bar was still behind the taskbar 150ms after being buried
     * and only back some time before 650ms. That is not a subliminal correction,
     * it is the widget visibly vanishing and reappearing, which is exactly the
     * flicker being reported.
     *
     * Cutting the period is affordable because the tick almost never *does*
     * anything: it is three WindowFromPoint calls, and it acts only on the rare
     * one that finds a covering. A blind raise could not run at this rate — that
     * is what the coverage check bought — so it stays at the old sedate one.
     */
  }, canCheck ? 150 : 1200);
}

/**
 * Keeps the bar owned by whichever taskbar is currently on screen.
 *
 * Ownership is what makes being covered by the taskbar impossible rather than
 * merely brief, so the only job left is noticing when the window it is tied to has
 * been replaced. Explorer restarting builds a new Shell_TrayWnd, and an ownership
 * pointing at the old one means nothing — so the handle is read fresh and compared
 * rather than being set once at startup and trusted.
 *
 * Only while the bar is meant to be on top. Dropped otherwise, because a bar that
 * has been asked not to float should not be quietly pinned above anything.
 */
function syncTaskbarPin() {
  if (!barHandle || !win32Available()) return;

  if (!store.get('alwaysOnTop')) {
    if (pinnedTo) {
      unpin(barHandle);
      pinnedTo = 0;
    }
    return;
  }

  const taskbar = taskbarHandle();
  if (!taskbar || taskbar === pinnedTo) return;

  pinnedTo = pinAbove(barHandle, taskbar) ? taskbar : 0;
}

/**
 * Takes the bar's place back, if it has actually lost it.
 *
 * Split out of the guard's tick because the tick is not the only thing that needs
 * it — see settleTopmost.
 */
function assertTopmost(canCheck = win32Available()) {
  if (!barWindow || barWindow.isDestroyed() || !barWindow.isVisible()) return;

  /*
   * Never reorder windows around a menu.
   *
   * Raising the bar is a SetWindowPos on the window the menu belongs to, and one
   * of those landing in the moment a popup is being created cancels it — the menu
   * appears and vanishes again, or never arrives at all. menuPending covers the
   * gap the openMenu check alone leaves: the click has been seen and the popup is
   * one turn away, which is exactly the window a settle timer can land in.
   */
  if (menuPending || menuIsUp()) return;

  // Standing aside for a fullscreen app is a decision, not a lost place. The tick
  // has already made it by the time it calls here; anything else must not undo it.
  if (!store.get('alwaysOnTop') || steppedAside) return;

  if (!canCheck) {
    barWindow.moveTop();
    return;
  }

  // A click-through bar is invisible to hit testing by definition, so it cannot
  // ask whether it is covered; hold its place unconditionally instead. Raising
  // without activating is at least quiet about it.
  if (store.get('clickThrough')) {
    if (!raiseToTop(barHandle)) barWindow.moveTop();
    return;
  }

  /*
   * Three points down the middle rather than one, because the usual way to lose
   * this is the taskbar covering the bottom edge while the centre stays clear.
   *
   * Kept a quarter of the way in from each end rather than hard against the
   * edges. The panel's height is measured by the renderer, and for a moment
   * after a settings change it is an estimate instead; a probe sitting on the
   * edge of an estimate can land in the transparent margin, see the desktop
   * through it, and report a covering that was never there — which would put
   * the bar back to raising itself on every single tick.
   */
  const rect = panelRect();
  const middle = rect.x + Math.round(rect.width / 2);
  const inset = Math.max(3, Math.round(rect.height / 4));
  const probes = [
    { x: middle, y: rect.y + inset },
    { x: middle, y: rect.y + Math.round(rect.height / 2) },
    { x: middle, y: rect.y + rect.height - inset },
  ];

  // The same fallback the click-through path has always had. Without it, a raise
  // that fails leaves the bar covered until something else happens to fix it.
  if (isCoveredAt(barHandle, probes) && !raiseToTop(barHandle)) barWindow.moveTop();
}

/*
 * Closing a menu is the moment the bar reliably loses its place.
 *
 * Dismissing one hands activation back, and the shell takes that as its cue to
 * re-raise the taskbar — which lands on top of a bar parked over it. The guard is
 * standing down at exactly that moment, so nobody is watching, and the bar then
 * sits behind the taskbar until the next tick comes round. Timed at over a second:
 * you right-click, dismiss, and the widget is simply gone for a beat before coming
 * back. That beat is the whole complaint.
 *
 * A known disturbance deserves better than being waited out, so the same check runs
 * a few times in quick succession afterwards, spacing out as the z-order settles.
 * It is the check and not a blind raise, so a bar that never lost its place still
 * does not move — and the shell gets more than one go at raising the taskbar, which
 * is why this is a handful of attempts rather than one.
 */
const SETTLE_MS = 900; // how long to keep watching after a disturbance

/*
 * One frame at 60Hz, because the unit that matters here is frames, not milliseconds.
 *
 * Clicking the bar from another application is the case that survived every other
 * fix: taking the foreground makes the shell re-raise the taskbar, the bar is
 * behind it for as long as nobody looks, and at a 60ms step that is four frames of
 * the widget simply not being there. Checking every frame means it is back in one
 * or two, which is the difference between a flicker and a repaint you never see.
 *
 * Affordable for the same reason the tick is: this is three WindowFromPoint calls,
 * it only runs for SETTLE_MS after an actual disturbance, and it acts on the rare
 * check that finds a covering.
 */
const SETTLE_STEP = 16;

let settleTimer = null;
let settleUntil = 0;

function settleTopmost() {
  // Without the coverage check every one of these is a blind, activating raise,
  // and a burst of those is a flicker rather than a fix. One will do.
  if (!win32Available()) {
    setTimeout(() => assertTopmost(), 120);
    return;
  }

  /*
   * Coalesced rather than scheduled per call, because the callers overlap: losing
   * focus, regaining it and closing a menu are three announcements of one event,
   * and each used to lay down its own set of timers. Extending a window of
   * attention instead means the same disturbance costs one burst however many
   * times it is reported.
   */
  settleUntil = Date.now() + SETTLE_MS;
  if (settleTimer) return;

  settleTimer = setInterval(() => {
    assertTopmost();
    if (Date.now() < settleUntil) return;
    clearInterval(settleTimer);
    settleTimer = null;
  }, SETTLE_STEP);
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

    /*
     * The bar never takes the foreground, and that is what stops it flickering.
     *
     * Clicking it used to activate it. Handing the foreground to a window sitting
     * over the taskbar is the shell's cue to re-raise the taskbar, which lands on
     * top of the bar — so every click from another application buried the widget
     * and the guard then had to dig it out. Measured over six clicks: without this,
     * the bar spends 30-47ms behind the taskbar each time, which is two or three
     * frames of it simply not being there. With it, none of that happens, because
     * the burial never starts.
     *
     * Nothing is given up. A status widget has no text to type into and no keyboard
     * anything; its menu opens, its items respond and it still drags, all verified.
     * What it gains beyond the flicker is not stealing focus from whatever you were
     * typing in when you glance at it.
     */
    focusable: false,

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
  barHandle = handleOf(barWindow);

  /*
   * Every runtime setting is applied through this one function rather than being
   * repeated here. Startup used to set only some of them, so a locked position was
   * honoured when you toggled it and quietly forgotten on the next launch — the bar
   * came back draggable however the switch was left.
   */
  applyWindowSettings();

  barWindow.loadFile(path.join(__dirname, '..', 'renderer', 'bar.html'));
  barWindow.once('ready-to-show', () => barWindow.show());

  /*
   * The whole bar is a drag handle, and Windows treats a drag region as a title
   * bar: right-clicking one opens the window's system menu rather than delivering
   * a contextmenu event to the page. Compact mode has no buttons at all, so that
   * right-click is the only way into the menu — it has to be the bar's own.
   *
   * Two halves, and the second one is the crash.
   *
   * Emptying the system menu is what stops Windows opening anything itself. The
   * previous approach let it open and then dismissed it by disabling and
   * re-enabling the window; with nothing in the menu there is nothing to dismiss.
   *
   * And the handler now does nothing at all beyond noting the click. A window
   * message is delivered to us by the kernel, and what escapes that callback is
   * not a JavaScript error: Windows tears the whole process down with
   * STATUS_FATAL_USER_CALLBACK_EXCEPTION, no message and no stack. Reaching back
   * into the window from inside the message that was announcing its own menu did
   * exactly that, every single time — the crash on right-click. So the menu is
   * built and shown on the next turn of the loop, once the message has been
   * answered and the native code that sent it has unwound.
   */
  if (isWindows) {
    disableSystemMenu(barHandle);

    /*
     * WM_INITMENU and nothing else, which took measuring to settle.
     *
     * The earlier right-click messages look like better triggers — they arrive
     * sooner and read more honestly than "a menu is being initialised" — but
     * WM_NCRBUTTONDOWN and WM_NCRBUTTONUP never reach this hook at all, and
     * WM_CONTEXTMENU is actively worse: answering it opens our menu before
     * Windows has finished starting its own, and the empty one it then puts up
     * cancels ours on the way past. Over a hundred logged right-clicks, that was
     * the only message that ever lost one.
     *
     * WM_INITMENU comes late enough to be safe. By the time it arrives Windows is
     * already in menu mode, so the popup deferred to the next turn lands after
     * that has unwound rather than in the middle of it.
     */
    const WM_INITMENU = 0x0116;

    barWindow.hookWindowMessage(WM_INITMENU, () => {
      try {
        requestContextMenu();
      } catch {
        // Nothing may leave this callback. There is no caller to catch it.
      }
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
    //
    // A freely-placed bar needs the same test against where it already is. It was
    // only ever exempt because it had no anchor to come unstuck from — but every
    // click on it still wrote the file, re-broadcast the settings, repainted the
    // renderer and rebuilt the tray menu, to record a position it already held.
    let at = settings.position;
    if (settings.anchor && settings.anchor !== 'free') {
      const { width, height } = sizeFor(settings, stripVisible());
      at = anchoredPosition(settings.anchor, width, height);
    }

    if (at && Math.abs(at.x - x) <= 2 && Math.abs(at.y - y) <= 2) return;

    store.set({ position: { x, y }, anchor: 'free' });
    broadcastSettings();
    updateTray();
  });

  /*
   * Handing activation over is the other moment the taskbar gets re-raised on top
   * of us, and taking it back is the moment a click has just reordered things.
   * Both were being left to the next tick to notice, which is up to four tenths of
   * a second of the bar visibly gone. They are announced, so there is no reason to
   * wait for them to be discovered.
   *
   * settleTopmost and not a raise: a bar that never lost its place still does not
   * move, so this costs a hit test on a click and nothing on a quiet desktop.
   */
  barWindow.on('blur', settleTopmost);
  barWindow.on('focus', settleTopmost);

  /*
   * The bar is owned by the taskbar, and destroying a window destroys what it
   * owns — so an Explorer restart can take the widget with it. Nothing else closes
   * this window: hiding it from the tray or the menu hides it, and quitting tears
   * the app down without needing a replacement. So a close that arrives while the
   * app is still running is that, and the answer is to build it again.
   */
  barWindow.on('closed', () => {
    const unexpected = !app.isQuiting;

    barWindow = null;
    barHandle = 0;
    pinnedTo = 0;
    openMenu = null;

    if (unexpected) setTimeout(() => barWindow || createBar(), 400);
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

  // Whatever the bar had stepped aside for, the line above just overruled it.
  steppedAside = false;

  barWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: Boolean(settings.stayAboveFullscreen),
  });
  // Nothing to drag in notch mode: the bar has one home and dragging it off
  // would only strand it somewhere the setting no longer describes.
  barWindow.setMovable(!settings.lockPosition && !notchBounds(settings));
  barWindow.setIgnoreMouseEvents(settings.clickThrough, { forward: true });
  placeWindow();
  syncTaskbarPin();
  syncTopmostGuard();
}

/*
 * A widget that lives in the menu bar has no Dock icon (LSUIElement), and macOS
 * will not hand the foreground to an app that has none. Without asking, Settings
 * opens behind whatever you were using — visible, unfocused, apparently ignoring
 * the keyboard.
 */
function focusApp() {
  if (process.platform === 'darwin') app.focus({ steal: true });
}

function openSettings() {
  if (settingsWindow) {
    focusApp();
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

  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWindow.once('ready-to-show', () => {
    focusApp();
    settingsWindow.show();
  });
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

/*
 * Same setting, different furniture: it anchors against the whole screen rather
 * than the work area, and what that lets the bar cover is the taskbar on Windows
 * and the Dock on a Mac. Naming the wrong one is a small lie that makes the
 * switch read as belonging to some other operating system.
 */
const OVER_EDGE_LABEL =
  { win32: 'Allow over the taskbar', darwin: 'Allow over the Dock' }[process.platform] ||
  'Allow over the panel';

function update(patch) {
  store.set(patch);
  applyWindowSettings();
  broadcastSettings();
  updateTray();
}

/**
 * The one line about updates that is worth a menu, or nothing at all.
 *
 * Compact mode has no buttons and the tray icon has no window, so for a good
 * number of people this menu is the only place a waiting update would ever be
 * seen. It sits at the top, where a thing you are being told belongs, and it
 * disappears completely the rest of the time.
 */
function updateMenuItems() {
  const update = updater.current();

  if (update.status === 'ready') {
    return [
      { label: `Restart and update to ${update.version}`, click: () => updater.install() },
      { type: 'separator' },
    ];
  }

  if (update.status === 'available') {
    return [
      { label: `Download update ${update.version}…`, click: () => updater.download() },
      { type: 'separator' },
    ];
  }

  return [];
}

function menuTemplate() {
  const settings = store.all();

  return [
    ...updateMenuItems(),
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
          label: OVER_EDGE_LABEL,
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

/**
 * Asks for the bar's own menu, from either of the two things that can want it: a
 * right-click the page saw, and a right-click Windows took for a title-bar click
 * before the page could.
 *
 * Nothing here opens a menu. Everything is put off to the next turn of the loop,
 * because one of those two callers is a window-message handler, and building or
 * showing a menu inside one is what killed the app. Deferring is also what folds
 * a single click into a single menu when both callers hear about it.
 */
function requestContextMenu() {
  if (menuPending || menuIsUp()) return;
  menuPending = true;

  setImmediate(() => {
    menuPending = false;
    showContextMenu();
  });
}

/**
 * Two rules here, each of which was a way to hang or kill the app.
 *
 * Never open a second menu over the first. Both request paths can fire for one
 * click, and a nested popup deadlocks — Windows is already running a modal menu
 * loop, and the second call waits on a loop that is waiting for it.
 *
 * Never let a menu be collected too early. A Menu built inline is unreachable the
 * moment popup() returns, and one freed out from under the native loop takes the
 * process with it. Holding it only until it starts closing is not enough either:
 * menu-will-close arrives while that loop is still unwinding. So the menu that
 * just closed stays reachable until the next one replaces it, which costs one
 * live object and removes the timing question entirely.
 */
function showContextMenu() {
  if (!barWindow || barWindow.isDestroyed() || menuIsUp()) return;

  const menu = Menu.buildFromTemplate(menuTemplate());

  openMenu = menu; // claimed before the popup, so a second request has something to see
  lastMenu = menu; // outlives openMenu on purpose
  menuOpenedAt = Date.now();

  const release = () => {
    if (openMenu !== menu) return;
    openMenu = null;
    settleTopmost();
  };
  menu.once('menu-will-close', release); // a click outside never reaches the callback

  try {
    menu.popup({ window: barWindow, callback: release });
  } catch {
    release(); // the menu never opened, so nothing should be waiting on it
  }
}

/* --------------------------------------------------------------------- tray */

function trayIcon() {
  const source = nativeImage.createFromPath(
    path.join(__dirname, '..', '..', 'build', 'icon.png')
  );
  if (source.isEmpty()) return nativeImage.createEmpty();

  const icon = source.resize({ width: 16, height: 16, quality: 'best' });

  /*
   * Every Mac still sold draws its menu bar at 2x, and Windows tray icons are
   * drawn larger the moment display scaling is turned up. A single 16px bitmap
   * stretched to fill either one is visibly soft, which on a bar whose whole job
   * is looking precise is the wrong first impression. Carrying the double-size
   * drawing alongside lets the system pick the one that fits the screen.
   */
  icon.addRepresentation({
    scaleFactor: 2,
    dataURL: source.resize({ width: 32, height: 32, quality: 'best' }).toDataURL(),
  });

  return icon;
}

function updateTray() {
  if (!tray) return;

  // Found rather than counted: an update notice sits above Refresh now when there
  // is one, and a fixed index would put Show widget inside it.
  const template = [...menuTemplate()];
  const refreshAt = template.findIndex((item) => item.label === 'Refresh now');

  template.splice(refreshAt + 1, 0, {
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

  // A staged update is worth a line in the one piece of text that is always
  // reachable, since the widget itself can be hidden and often is.
  const pending = updater.isReady() ? `\nUpdate ${updater.current().version} ready — restart` : '';

  if (lastFailure && !lastGood) {
    tray.setToolTip(`Claude Usage — ${lastFailure.message}${pending}`);
  } else if (lastGood) {
    const session = lastGood.session?.percent ?? 0;
    const week = lastGood.week?.percent ?? 0;
    const suffix = lastFailure ? ' (not updating)' : '';
    tray.setToolTip(`Claude Usage — session ${session}%, week ${week}%${suffix}${pending}`);
  } else {
    tray.setToolTip(`Claude Usage${pending}`);
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
    if (patch && 'autoUpdate' in patch) {
      updater.applySettings();
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
    // fullscreen app from the taskbar, nor whether anything is covering it, and
    // falls back to holding its place on a timer.
    fullscreenDetection: win32Available(),
  }));

  ipcMain.handle('update:state', () => updater.current());
  ipcMain.handle('update:check', () => updater.check(true));
  ipcMain.handle('update:download', () => updater.download());
  ipcMain.handle('update:install', () => updater.install());
  ipcMain.on('update:release-notes', () => updater.openReleaseNotes());

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

  ipcMain.on('window:context-menu', requestContextMenu);
  ipcMain.on('shell:open-credentials-folder', () => shell.showItemInFolder(credentialsPath()));
  ipcMain.on('shell:open-external', (_event, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url))
      shell.openExternal(url);
  });
}

/* --------------------------------------------------------------- lifecycle */

/*
 * Two gates, in this order for a reason.
 *
 * Electron's lock goes first because it is the one that can *answer*: a second
 * launch from the same install hands the running widget a 'second-instance'
 * event, so clicking the shortcut again brings the bar back instead of doing
 * nothing. Losing that would be a worse bug than the one being fixed.
 *
 * The session-wide name goes second, for the copies that lock cannot see —
 * a different user-data folder, a build run beside the installed one. There is
 * nobody to notify there, so it just stands down.
 */
if (!app.requestSingleInstanceLock() || !claimSingleInstance(APP_ID)) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!barWindow) return createBar();

    // Whatever state it was left in: hidden from the tray, buried, or moved off
    // a monitor that has since been unplugged.
    barWindow.show();
    placeWindow();
    if (!raiseToTop(barHandle)) barWindow.moveTop();
    updateTray();
  });

  app.whenReady().then(() => {
    if (isWindows) app.setAppUserModelId(APP_ID);

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

    // Every surface that can show an update state is repainted from the one
    // callback, so none of them can be showing a stale one.
    updater.init((update) => {
      send('update:changed', update);
      updateTray();
    });

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

  // Tells the bar's 'closed' handler that this one was meant, so it does not
  // helpfully rebuild the window the app is in the middle of shutting down.
  app.on('before-quit', () => {
    app.isQuiting = true;
  });

  // The widget lives in the tray, so closing its windows should not quit the app.
  // Subscribing at all is what suppresses Electron's default quit.
  app.on('window-all-closed', () => {});
}
