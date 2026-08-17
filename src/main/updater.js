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
 */

const { app, Notification, shell } = require('electron');

const store = require('./store');
const pkg = require('../../package.json');

/*
 * Late enough that a launch is never spending its first seconds on this instead of
 * the reading the widget exists to show, and far enough apart afterwards that a
 * machine left on for a week still asks a handful of times rather than hundreds.
 */
const FIRST_CHECK_DELAY = 30 * 1000;
const RECHECK_INTERVAL = 6 * 60 * 60 * 1000;

let autoUpdater = null;
let broadcast = () => {};
let timer = null;
let announcedVersion = null; // the version already put on screen, so it is said once

/**
 * status is the whole story, in one word:
 *   unavailable — this build cannot update itself (running from source, unsigned)
 *   idle        — nothing has been asked yet
 *   checking    — a check is in flight
 *   none        — checked, and this is the newest there is
 *   available   — there is a newer one, waiting to be fetched
 *   downloading — fetching it now; percent is meaningful
 *   ready       — staged on disk, applies on the next restart
 *   unpublished — the repository has no releases in it to compare against
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

function publish(patch) {
  Object.assign(state, patch);
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
 * installer has no app-update.yml, and an unsigned Mac build cannot replace itself
 * whatever the server says. All three are permanent conditions of that copy, not
 * faults, and none of them is fixed by pressing anything.
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

  return { status: 'error', message: friendly(error) };
}

/**
 * Says, once per version, that there is a new one — and what pressing it will do.
 *
 * Once matters. The check repeats every few hours for as long as the machine is
 * on, and a notification per check for the same release is how a helpful app
 * becomes one you mute.
 *
 * There are two of these because there are two ways to arrive here. Normally the
 * release has already been fetched and the only thing left is the restart. With
 * automatic downloading switched off, nothing has been fetched, and offering a
 * restart that cannot happen yet would be a lie — so it offers the download.
 */
function announce(version, staged) {
  if (!version || announcedVersion === version || !Notification.isSupported()) return;
  announcedVersion = version;

  const notification = new Notification({
    title: staged ? `Claude Usage ${version} is ready` : `Claude Usage ${version} is available`,
    body: staged
      ? 'Restart the widget to finish updating. Click here to do it now.'
      : 'Click here to download it. It installs the next time you restart.',
    silent: true, // a version number is not worth a sound
  });

  notification.on('click', () => (staged ? install() : download()));
  notification.show();
}

function wire() {
  autoUpdater.on('checking-for-update', () => {
    publish({ status: 'checking', message: null });
  });

  autoUpdater.on('update-not-available', () => {
    publish({ status: 'none', version: null, message: null, checkedAt: Date.now() });
  });

  autoUpdater.on('update-available', (info) => {
    const version = info && info.version ? info.version : null;
    const fetching = autoUpdater.autoDownload;

    // autoDownload decides which of these two is true the moment this fires, so
    // the status has to follow the setting rather than assume either one.
    publish({
      status: fetching ? 'downloading' : 'available',
      version,
      releaseUrl: releaseUrl(version),
      percent: 0,
      message: null,
      checkedAt: Date.now(),
    });

    // Fetching it means update-downloaded is moments away and will say so itself;
    // saying it twice for one release is the thing announce() exists to prevent.
    if (!fetching) announce(version, false);
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.max(0, Math.min(100, Math.round((progress && progress.percent) || 0)));
    publish({ status: 'downloading', percent });
  });

  autoUpdater.on('update-downloaded', (info) => {
    const version = (info && info.version) || state.version;
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
    announce(version, true);
  });

  autoUpdater.on('error', (error) => {
    publish({ ...classify(error), percent: 0 });
  });
}

/* ------------------------------------------------------------------- public */

function isReady() {
  return state.status === 'ready';
}

/** True while there is something the menus could usefully offer to do. */
function hasNews() {
  return state.status === 'ready' || state.status === 'available';
}

async function check(manual = false) {
  if (!autoUpdater) {
    // A manual check should still answer, even if the answer is that it cannot.
    if (manual) broadcast(current());
    return current();
  }
  if (state.status === 'checking' || state.status === 'downloading') return current();

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
  if (!autoUpdater || state.status !== 'available') return current();

  publish({ status: 'downloading', percent: 0, message: null });
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    if (state.status === 'downloading') publish(classify(error));
  }
  return current();
}

/**
 * Quits and comes back on the new version.
 *
 * isSilent true, isForceRunAfter true: the installer this app ships is a
 * click-through NSIS one, and having asked for the restart already, being walked
 * through a wizard to get it is not what was agreed to.
 */
function install() {
  if (!autoUpdater || state.status !== 'ready') return false;

  // The widget lives in the tray and suppresses the usual quit, so the app has to
  // be told this one is real before the installer takes over.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return true;
}

function openReleaseNotes() {
  if (state.releaseUrl) shell.openExternal(state.releaseUrl);
}

/** Re-reads the one setting that changes how this behaves while it is running. */
function applySettings() {
  if (autoUpdater) autoUpdater.autoDownload = store.get('autoUpdate') !== false;
}

function init(onChange) {
  broadcast = typeof onChange === 'function' ? onChange : () => {};

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

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    publish({ status: 'unavailable', message: 'This build has no updater in it.' });
    return;
  }

  autoUpdater.autoInstallOnAppQuit = true;
  applySettings();
  wire();

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
  openReleaseNotes,
};
