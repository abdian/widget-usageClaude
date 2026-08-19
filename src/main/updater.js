'use strict';

/**
 * Keeping the widget current, and — the half that is easy to forget — telling you
 * about it.
 *
 * A tray widget is the kind of app nobody ever thinks to go and update. It sits in
 * the corner being quietly out of date for months. So the checking happens on its
 * own, and the only thing ever asked of you is the restart, at a moment of your
 * choosing.
 *
 * The download is deliberately separated from the install. Downloading in the
 * background costs you nothing and can be automatic. Replacing a running app
 * cannot be, so the new version is staged and applied on the next quit — which,
 * for something that starts with Windows and never closes, is why the menus and
 * the notification offer to do that quit for you.
 *
 * Everything here is reported through one state object rather than a scattering of
 * events, because three different surfaces draw it: the settings window, the bar's
 * own menu, and the tray.
 *
 * Two rules run underneath all of it, and both exist because breaking either one
 * looks exactly like nothing happening:
 *
 *   An update must replace the copy that is running. Not a copy — the copy. An
 *   installer that lands somewhere else leaves the old build in place, still
 *   starting at login, still finding the same update, forever.
 *
 *   Pressing restart must visibly do something. If the quit is refused, or the
 *   installer never starts, that is a sentence on screen, not a silence.
 */

const fs = require('fs');
const path = require('path');

const { app, Notification, shell } = require('electron');

const mac = require('./macupdate');
const store = require('./store');
const pkg = require('../../package.json');

/*
 * Late enough that a launch is never spending its first seconds on this instead of
 * the reading the widget exists to show, and far enough apart afterwards that a
 * machine left on for a week still asks a handful of times rather than hundreds.
 */
const FIRST_CHECK_DELAY = 30 * 1000;
const RECHECK_INTERVAL = 6 * 60 * 60 * 1000;

/*
 * How long the restart is given before it is taken rather than asked for. An
 * Electron quit is milliseconds of work; anything still here after six seconds is
 * not slow, it is stuck — and by then the installer is already running and
 * waiting on this process to release the files it is about to replace.
 */
const QUIT_GRACE = 6 * 1000;

const LOG_LIMIT = 256 * 1024;

let autoUpdater = null;
let broadcast = () => {};
let timer = null;
let announcedVersion = null; // the version already put on screen, so it is said once
let pendingInfo = null; // what the last check found, kept for the macOS download
let pendingImage = null; // the .dmg staged on macOS, waiting to be swapped in

/*
 * Whether this copy can replace itself at all, which is not a given on either
 * platform, for opposite reasons.
 *
 * On Windows the installer replaces a fixed location — the one recorded when the
 * app was installed. A copy running from anywhere else (an unpacked build, a
 * folder someone moved) is not that location, so the update installs perfectly
 * and changes nothing about the app you are looking at. The uninstaller sitting
 * beside the executable is what an installed copy has and an unpacked one does
 * not, and it is the cheapest honest test there is.
 *
 * On macOS there is no installer at all — see ./macupdate for why, and for what
 * happens instead — so the question is only whether the bundle can be written to.
 */
let canSelfInstall = false;
let blockedReason = null; // and, when it cannot, the sentence that says why

/**
 * status is the whole story, in one word:
 *   unavailable — this build cannot update itself (running from source, no updater)
 *   idle        — nothing has been asked yet
 *   checking    — a check is in flight
 *   none        — checked, and this is the newest there is
 *   available   — there is a newer one, waiting to be fetched
 *   downloading — fetching it now; percent is meaningful
 *   ready       — staged on disk, applies on the next restart
 *   installing  — the restart has been asked for and is under way
 *   unpublished — the repository has no releases in it to compare against
 *   manual      — there is a newer one, and this copy cannot install it itself
 *   error       — message says what went wrong, in words
 */
const state = {
  status: 'idle',
  currentVersion: app.getVersion(),
  version: null,
  percent: 0,
  message: null,
  checkedAt: null,
  releaseUrl: null,
};

/* --------------------------------------------------------------------- log */

/*
 * electron-updater talks to a logger and, with nothing supplied, talks to the
 * console — which in a packaged Windows app is a pipe to nowhere. Everything this
 * file does happens out of sight of a terminal, so the one question worth being
 * able to answer afterwards ("what did pressing restart actually do?") had no
 * answer at all. Now it has a file, kept small enough to never become a problem
 * of its own.
 */
function logPath() {
  try {
    return path.join(app.getPath('userData'), 'updater.log');
  } catch {
    return null;
  }
}

function log(level, text) {
  const file = logPath();
  if (!file) return;
  try {
    fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`);
  } catch {
    // A log that cannot be written is not worth failing an update over.
  }
}

/** Keeps the tail and throws the rest away, once per launch. */
function trimLog() {
  const file = logPath();
  if (!file) return;
  try {
    const { size } = fs.statSync(file);
    if (size <= LOG_LIMIT) return;
    const tail = fs.readFileSync(file).subarray(size - LOG_LIMIT / 2);
    fs.writeFileSync(file, tail);
  } catch {
    // Missing is the usual reason, and the usual reason is fine.
  }
}

/* ------------------------------------------------------------------- state */

function publish(patch) {
  Object.assign(state, patch);
  if (patch.status) log('info', `state: ${state.status}${state.message ? ` — ${state.message}` : ''}`);
  broadcast(current());
}

function current() {
  return { ...state };
}

/** The GitHub release page for a version, so "what changed" has somewhere to go. */
function releaseUrl(version) {
  const home = typeof pkg.homepage === 'string' ? pkg.homepage.replace(/\/+$/, '') : '';
  return home && version ? `${home}/releases/tag/v${version}` : null;
}

/* ------------------------------------------------------- can this copy do it */

const NOT_INSTALLED =
  'This copy is not the installed one, so an update would land beside it instead of on it.';
const NOT_WRITABLE = 'This copy sits somewhere it cannot be replaced, so it cannot update itself.';

/**
 * An installed Windows build keeps its uninstaller in the same folder as the
 * executable; nothing else does. That single file is the difference between an
 * update that replaces what you are running and one that quietly installs a
 * second copy somewhere else.
 */
function installedInPlace() {
  try {
    const dir = path.dirname(app.getPath('exe'));
    return fs.readdirSync(dir).some((name) => /^Uninstall .+\.exe$/i.test(name));
  } catch {
    return false;
  }
}

/**
 * Settles canSelfInstall, and the reason when the answer is no.
 *
 * Deliberately answered before the first check rather than after the first
 * download: the whole point is to never spend 100MB finding out.
 */
function detectSelfInstall() {
  if (process.platform === 'darwin') {
    canSelfInstall = mac.canInstall();
    return canSelfInstall ? null : NOT_WRITABLE;
  }

  if (process.platform === 'win32') {
    canSelfInstall = installedInPlace();
    return canSelfInstall ? null : NOT_INSTALLED;
  }

  canSelfInstall = true;
  return null;
}

/* ------------------------------------------------------------------ errors */

/*
 * electron-updater's errors are written for a log file: stack traces, HTTP bodies,
 * the odd Java-shaped exception name. None of that belongs in a settings window,
 * and most of it says the same three things.
 */
function friendly(error) {
  const text = String((error && error.message) || error || '');

  if (/net::|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|getaddrinfo/i.test(text)) {
    return 'Could not reach the update server.';
  }
  return text.split('\n')[0].slice(0, 160) || 'The update check did not finish.';
}

/**
 * Sorts a failure into a state, and most of the work is deciding what is not one.
 *
 * Three of these come back as errors from electron-updater and are nothing of the
 * kind. A repository with no releases in it answers with a 404 — that is simply
 * what an app looks like before its first release. A build running outside an
 * installer has no app-update.yml, and a copy that cannot be written over cannot
 * replace itself whatever the server says. All three are permanent conditions of
 * that copy, not faults, and none of them is fixed by pressing anything.
 *
 * Painting them red would leave the one colour that is supposed to mean "something
 * is wrong" lit on a perfectly healthy install, forever — at which point it stops
 * meaning anything at all.
 */
function classify(error) {
  const text = String((error && error.message) || error || '');

  if (/404|Cannot find latest|No published versions|Unable to find latest/i.test(text)) {
    return { status: 'unpublished', message: 'No release has been published yet.' };
  }
  if (/dev-app-update|app-update\.yml|is not packed/i.test(text)) {
    return { status: 'unavailable', message: 'Updates apply to installed builds only.' };
  }
  if (/code signature|not signed/i.test(text)) {
    return { status: 'unavailable', message: 'This build is not signed, so it cannot replace itself.' };
  }
  // Belt and braces for the macOS path. Nothing should reach electron-updater's
  // own download there any more — the .dmg is fetched by ./macupdate instead —
  // but if it ever does, it stops at the .zip the release does not carry, and
  // that is a permanent condition of the build rather than a fault.
  if (/ZIP file not provided|ERR_UPDATER_ZIP_FILE_NOT_FOUND/i.test(text)) {
    canSelfInstall = false;
    blockedReason = 'This build cannot replace itself.';
    return { status: 'manual', message: blockedReason };
  }

  return { status: 'error', message: friendly(error) };
}

/* ----------------------------------------------------------- announcements */

/**
 * Says, once per version, that there is a new one — and what pressing it will do.
 *
 * Once matters. The check repeats every few hours for as long as the machine is
 * on, and a notification per check for the same release is how a helpful app
 * becomes one you mute.
 *
 * There are three of these because there are three ways to arrive here. Normally
 * the release has already been fetched and the only thing left is the restart.
 * With automatic downloading switched off, nothing has been fetched, and offering
 * a restart that cannot happen yet would be a lie — so it offers the download.
 * And a copy that cannot install its own updates must not offer either; all it
 * can truthfully do is point at the page.
 */
function announce(version, mode) {
  if (!version || announcedVersion === version || !Notification.isSupported()) return;
  announcedVersion = version;

  const COPY = {
    ready: [`Claude Usage ${version} is ready`, 'Restart the widget to finish updating. Click here to do it now.'],
    available: [`Claude Usage ${version} is available`, 'Click here to download it. It installs the next time you restart.'],
    manual: [`Claude Usage ${version} is available`, 'This copy cannot update itself. Click here to open the download page.'],
  };
  const [title, body] = COPY[mode] || COPY.available;

  const notification = new Notification({ title, body, silent: true }); // a version number is not worth a sound

  notification.on('click', () => {
    if (mode === 'ready') return install();
    if (mode === 'manual') return openReleaseNotes();
    return download();
  });
  notification.show();
}

/* ------------------------------------------------------------------- wiring */

/** True when the found release should be fetched without being asked. */
function wantsAutoDownload() {
  return canSelfInstall && store.get('autoUpdate') !== false;
}

function found(info) {
  const version = info && info.version ? info.version : null;
  pendingInfo = info || null;

  // A copy that cannot install what it fetches is told here, before a byte of it
  // moves. The news is the same — there is a newer version — but the only honest
  // thing to offer is the page it can be downloaded from.
  if (!canSelfInstall) {
    publish({
      status: 'manual',
      version,
      releaseUrl: releaseUrl(version),
      percent: 0,
      message: blockedReason,
      checkedAt: Date.now(),
    });
    announce(version, 'manual');
    return;
  }

  const fetching = wantsAutoDownload();

  publish({
    status: fetching ? 'downloading' : 'available',
    version,
    releaseUrl: releaseUrl(version),
    percent: 0,
    message: null,
    checkedAt: Date.now(),
  });

  // Fetching it means a ready state is moments away and will announce itself;
  // saying it twice for one release is the thing announce() exists to prevent.
  if (!fetching) {
    announce(version, 'available');
    return;
  }

  // On macOS the fetch is ours to run. Everywhere else electron-updater has
  // already started it on the strength of autoDownload.
  if (process.platform === 'darwin') fetchImage();
}

function ready(version) {
  publish({
    status: 'ready',
    version,
    releaseUrl: releaseUrl(version),
    percent: 100,
    message: null,
  });
  // Cleared first: a download that was announced as merely available has now
  // become a restart, and that is a different thing worth saying once more.
  announcedVersion = null;
  announce(version, 'ready');
}

function wire() {
  autoUpdater.on('checking-for-update', () => {
    publish({ status: 'checking', message: null });
  });

  autoUpdater.on('update-not-available', () => {
    publish({ status: 'none', version: null, message: null, checkedAt: Date.now() });
  });

  autoUpdater.on('update-available', found);

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.max(0, Math.min(100, Math.round((progress && progress.percent) || 0)));
    publish({ status: 'downloading', percent });
  });

  autoUpdater.on('update-downloaded', (info) => {
    ready((info && info.version) || state.version);
  });

  autoUpdater.on('error', (error) => {
    log('error', String((error && error.stack) || error));
    if (state.status === 'installing') return abort(friendly(error));
    publish({ ...classify(error), percent: 0 });
  });
}

/* ------------------------------------------------------------------- macOS */

/**
 * The macOS download, which is ours rather than electron-updater's.
 *
 * Squirrel.Mac cannot install an ad-hoc signed build, so there is no point
 * handing it one — ./macupdate fetches the .dmg, checks it against the hash the
 * release publishes, and later swaps the bundle in place.
 */
async function fetchImage() {
  if (!pendingInfo) return;

  publish({ status: 'downloading', percent: 0, message: null });

  try {
    pendingImage = await mac.stage(pendingInfo, (percent) => {
      if (state.status === 'downloading') publish({ percent });
    });
    log('info', `staged ${pendingImage}`);
    ready(pendingInfo.version);
  } catch (error) {
    log('error', `download failed: ${(error && error.stack) || error}`);
    pendingImage = null;
    publish({ status: 'error', message: friendly(error), percent: 0 });
  }
}

/* ------------------------------------------------------------------- public */

function isReady() {
  return state.status === 'ready';
}

/** True while there is something the menus could usefully offer to do. */
function hasNews() {
  return state.status === 'ready' || state.status === 'available' || state.status === 'manual';
}

async function check(manual = false) {
  if (!autoUpdater) {
    // A manual check should still answer, even if the answer is that it cannot.
    if (manual) broadcast(current());
    return current();
  }
  if (state.status === 'checking' || state.status === 'downloading' || state.status === 'installing') {
    return current();
  }

  // Already staged: checking again would only find the same release and start the
  // same download over the top of it.
  if (state.status === 'ready') return current();

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    // The 'error' event usually beats us here, and it has already said this.
    if (state.status === 'checking') publish(classify(error));
  }

  return current();
}

/** Fetches a release that was found while automatic downloading was switched off. */
async function download() {
  // The one thing such a copy can do about a new version is show you where it is.
  if (state.status === 'manual' || !canSelfInstall) {
    openReleaseNotes();
    return current();
  }
  if (state.status !== 'available') return current();

  if (process.platform === 'darwin') {
    await fetchImage();
    return current();
  }

  if (!autoUpdater) return current();

  publish({ status: 'downloading', percent: 0, message: null });
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    if (state.status === 'downloading') publish(classify(error));
  }
  return current();
}

/**
 * The restart, and the reason this function is longer than it looks like it
 * should be.
 *
 * Quitting is the part that fails. The widget lives in the tray, suppresses the
 * ordinary quit, owns a window parented to the taskbar and holds a mutex nothing
 * else releases — any one of which can leave app.quit() asking politely and
 * getting nowhere. Meanwhile the installer has already started and is waiting for
 * exactly one thing: this process to stop holding its own files open.
 *
 * So the quit is asked for, and then, if the answer has not arrived, taken. There
 * is nothing to lose by exiting abruptly at that point — the update is staged, the
 * settings are on disk, and the alternative is an installer that waits, gives up,
 * and leaves the person who pressed the button looking at a widget that did not
 * change.
 */
function quitForUpdate() {
  app.isQuiting = true;

  const bail = setTimeout(() => {
    // An error arriving in the meantime means the installer never started, and
    // exiting then would cost the widget for nothing.
    if (state.status !== 'installing') return;
    log('warn', 'the quit was refused; exiting');
    app.exit(0);
  }, QUIT_GRACE);

  if (bail.unref) bail.unref();
}

/**
 * Stands the app back up after an install that never got going.
 *
 * isQuiting was set on the way in, and it is the flag that tells the bar's own
 * 'closed' handler that a window disappearing was meant. Leaving it set after a
 * failed install would mean the next Explorer restart takes the widget with it
 * for good.
 */
function abort(message) {
  app.isQuiting = false;
  publish({ status: 'error', message: message || 'The update could not be started.', percent: 0 });
}

function install() {
  if (state.status !== 'ready') {
    log('warn', `install asked for while ${state.status}`);
    return false;
  }

  log('info', `installing ${state.version} over ${app.getPath('exe')}`);
  publish({ status: 'installing', message: null });

  if (process.platform === 'darwin') {
    if (!pendingImage || !mac.install(pendingImage, logPath())) {
      abort();
      return false;
    }
    quitForUpdate();
    return true;
  }

  if (!autoUpdater) {
    abort();
    return false;
  }

  /*
   * isSilent true, isForceRunAfter true: the installer this app ships is a
   * click-through NSIS one, and having asked for the restart already, being walked
   * through a wizard to get it is not what was agreed to.
   *
   * setImmediate so this returns to the menu or the settings window first — a
   * click handler that never returns is a menu that never closes.
   */
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch (error) {
      log('error', `quitAndInstall threw: ${(error && error.stack) || error}`);
      abort(friendly(error));
    }
  });

  quitForUpdate();
  return true;
}

function openReleaseNotes() {
  if (state.releaseUrl) shell.openExternal(state.releaseUrl);
  else shell.openExternal(`${String(pkg.homepage || '').replace(/\/+$/, '')}/releases/latest`);
}

/**
 * Re-reads the one setting that changes how this behaves while it is running.
 *
 * canSelfInstall overrides it rather than the setting being hidden: the switch is
 * about bandwidth, and there is no version of "download it quietly" worth doing
 * when the download can only ever be thrown away.
 *
 * macOS never lets electron-updater download anything, whatever the setting says.
 * Its downloads are handled here — see fetchImage — and letting the library start
 * its own in parallel would fetch a .zip that the release does not publish.
 */
function applySettings() {
  if (!autoUpdater) return;
  autoUpdater.autoDownload = process.platform !== 'darwin' && wantsAutoDownload();
}

function init(onChange) {
  broadcast = typeof onChange === 'function' ? onChange : () => {};

  trimLog();
  log('info', `start ${app.getVersion()} from ${app.getPath('exe')}`);

  /*
   * A build run from source has no installer behind it and no release to compare
   * itself against. electron-updater refuses, loudly and with a stack trace; there
   * is nothing here the person running it can act on, so it is stated plainly and
   * the machinery is never started.
   */
  if (!app.isPackaged) {
    publish({ status: 'unavailable', message: 'Updates apply to installed builds only.' });
    return;
  }

  // Settled before anything else, because the answer decides whether a found
  // release is fetched or merely pointed at.
  blockedReason = detectSelfInstall();
  log('info', `self-install: ${canSelfInstall}${blockedReason ? ` — ${blockedReason}` : ''}`);

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    publish({ status: 'unavailable', message: 'This build has no updater in it.' });
    return;
  }

  autoUpdater.logger = {
    info: (text) => log('info', String(text)),
    warn: (text) => log('warn', String(text)),
    error: (text) => log('error', String(text)),
    debug: () => {},
  };

  autoUpdater.autoInstallOnAppQuit = true;
  wire();
  applySettings();

  timer = setTimeout(function loop() {
    check(false);
    timer = setTimeout(loop, RECHECK_INTERVAL);
  }, FIRST_CHECK_DELAY);

  // Nothing else holds this handle, and a timer outliving the app keeps the
  // process alive on the way out.
  if (timer.unref) timer.unref();
}

module.exports = {
  applySettings,
  check,
  current,
  download,
  hasNews,
  init,
  install,
  isReady,
  logPath,
  openReleaseNotes,
};
