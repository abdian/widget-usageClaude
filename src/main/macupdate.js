'use strict';

/**
 * Updating a Mac build that has no Apple Developer ID behind it.
 *
 * The usual machinery is not available here. electron-updater hands macOS
 * updates to Squirrel.Mac, and Squirrel will only swap in a build whose code
 * signature satisfies the running app's designated requirement. An ad-hoc
 * signature has no identity to match on — its requirement is the bundle's own
 * cdhash, which every rebuild changes — so an ad-hoc copy can be told a new
 * version exists and can be sent to fetch it, but can never install it. For a
 * while the honest answer was to open the downloads page and let you do the rest
 * by hand.
 *
 * By hand is also where the second copies come from. A .dmg is a folder you drag
 * out of, and dragging is not replacing: a build that lands anywhere other than
 * exactly on top of the old one leaves two Claude Usages on the machine, one of
 * them stale and both of them launchable.
 *
 * So this does the drag itself, and does it in place. It fetches the .dmg for
 * this Mac's architecture, checks it against the hash the release publishes,
 * mounts it, and swaps the bundle the app is actually running from — the old one
 * deleted rather than left beside the new one. None of that needs a signature,
 * because nothing here asks macOS to vouch for the download: the check is the
 * SHA-512 out of latest-mac.yml, fetched over the same TLS connection as the
 * release itself.
 *
 * The swap cannot be done from inside the bundle being swapped, so it is a small
 * shell script, spawned detached, that waits for this process to go before it
 * touches anything. Every step of it is reversible until the last one, and the
 * last thing it does either way is start the app back up.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const { app } = require('electron');

const pkg = require('../../package.json');

const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT = 120 * 1000;

/** The .app bundle this process runs out of, or null when it is not in one. */
function bundlePath() {
  // .../Claude Usage.app/Contents/MacOS/Claude Usage
  const bundle = path.resolve(path.dirname(app.getPath('exe')), '..', '..');
  return bundle.endsWith('.app') ? bundle : null;
}

/**
 * Whether the swap could actually happen — asked before anything is downloaded.
 *
 * Two ways it could not: this is not a bundle at all, or the bundle sits
 * somewhere this user cannot write. A managed /Applications is one such place,
 * and so is a copy still running out of a mounted .dmg, which is read-only by
 * definition and a surprisingly popular place to leave an app.
 */
function canInstall() {
  if (process.platform !== 'darwin') return false;

  const bundle = bundlePath();
  if (!bundle) return false;

  try {
    fs.accessSync(bundle, fs.constants.W_OK);
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The one asset out of the release that belongs on this Mac.
 *
 * The names carry the architecture, and the wrong one would run — under Rosetta,
 * slower, and permanently — so it is worth not downloading rather than worth
 * coping with. process.arch is the architecture of the *running* binary, which
 * is the right question to ask: an x64 copy already under Rosetta keeps working,
 * and moving it to arm64 is not an update's decision to make.
 */
function pickAsset(info) {
  const files = (info && Array.isArray(info.files) ? info.files : []).filter(
    (file) => file && typeof file.url === 'string' && file.url.endsWith('.dmg'),
  );
  if (!files.length) return null;

  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return files.find((file) => file.url.includes(arch)) || null;
}

/** Where the release keeps that asset. Tags follow the version, as v1.2.3. */
function assetUrl(version, file) {
  const home = typeof pkg.homepage === 'string' ? pkg.homepage.replace(/\/+$/, '') : '';
  if (!home || !version || !file) return null;
  return `${home}/releases/download/v${version}/${encodeURIComponent(file)}`;
}

/**
 * Fetches a URL to a file, following the hops a release download is sent on.
 *
 * A release asset URL is a redirect into object storage, and that redirect is
 * signed and short-lived — so it has to be followed each time rather than
 * resolved once and remembered. The hop limit turns a redirect loop into a
 * failed download rather than a request that never comes back.
 *
 * Resolves with the SHA-512 of what arrived, computed on the way past, so
 * checking it costs no second read of a 120MB file.
 */
function fetchToFile(url, destination, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'User-Agent': `${pkg.name}/${app.getVersion()}`, Accept: '*/*' } },
      (response) => {
        const { statusCode, headers } = response;

        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          response.resume();
          if (redirects >= MAX_REDIRECTS) return reject(new Error('Too many redirects.'));
          return resolve(
            fetchToFile(new URL(headers.location, url).toString(), destination, onProgress, redirects + 1),
          );
        }

        if (statusCode !== 200) {
          response.resume();
          return reject(new Error(`The download answered ${statusCode}.`));
        }

        const total = Number(headers['content-length']) || 0;
        const hash = crypto.createHash('sha512');
        const file = fs.createWriteStream(destination);
        let done = 0;
        let reported = -1;

        response.on('data', (chunk) => {
          hash.update(chunk);
          done += chunk.length;
          if (!onProgress || !total) return;
          const percent = Math.round((done / total) * 100);
          if (percent === reported) return; // one call per whole percent, not per packet
          reported = percent;
          onProgress(percent);
        });

        response.on('error', reject);
        file.on('error', reject);
        file.on('finish', () => file.close(() => resolve(hash.digest('base64'))));

        response.pipe(file);
      },
    );

    request.on('error', reject);
    request.setTimeout(DOWNLOAD_TIMEOUT, () => request.destroy(new Error('The download timed out.')));
  });
}

/** A directory of our own, so a half-finished download is easy to sweep up. */
function workDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-update-'));
}

/**
 * Downloads the release for this Mac and hands back the .dmg, or throws.
 *
 * The hash is not a formality. It is the only thing standing where a code
 * signature normally stands, so a mismatch deletes the file rather than
 * installing it and saying nothing.
 */
async function stage(info, onProgress) {
  const asset = pickAsset(info);
  if (!asset) throw new Error('The release has no build for this Mac.');

  const url = assetUrl(info && info.version, asset.url);
  if (!url) throw new Error('The release has no download address.');

  const dir = workDir();
  const file = path.join(dir, asset.url);

  let digest;
  try {
    digest = await fetchToFile(url, file, onProgress);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  if (asset.sha512 && digest !== asset.sha512) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('The download did not match the published checksum.');
  }

  return file;
}

/** Single-quotes a path for /bin/sh — the only escaping such a string needs. */
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/**
 * The swap, as a script that outlives the app it is swapping.
 *
 * Order matters more than brevity. The new bundle is copied out of the image
 * *beside* the old one first, so a failed or interrupted copy costs a temporary
 * directory and nothing else — the app that was installed is still installed.
 * Only once a complete new bundle exists on disk is the old one moved aside, and
 * if the move that replaces it fails, the old one goes straight back.
 *
 * The deletion at the end is the point of doing it this way at all: the previous
 * version leaves the machine instead of accumulating beside the new one.
 *
 * Whatever happens, the last line starts the app again. A failed update should
 * cost you a version, not your widget.
 */
function script(options) {
  const { bundle, dmg, pid, mount, log, self } = options;

  return [
    '#!/bin/sh',
    `target=${shellQuote(bundle)}`,
    `dmg=${shellQuote(dmg)}`,
    `mnt=${shellQuote(mount)}`,
    `log=${shellQuote(log)}`,
    `self=${shellQuote(self)}`,
    '',
    'say() { echo "$(date "+%Y-%m-%d %H:%M:%S") swap: $1" >> "$log" 2>/dev/null; }',
    '',
    '# Wait for the app to let go of itself, but never forever: twenty seconds is',
    '# far longer than a quit takes and still short of looking hung.',
    'i=0',
    `while kill -0 ${pid} 2>/dev/null && [ $i -lt 100 ]; do sleep 0.2; i=$((i + 1)); done`,
    '',
    'mkdir -p "$mnt" || { say "cannot make a mount point"; open -n "$target"; exit 1; }',
    '',
    'if ! hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$dmg" >/dev/null 2>&1; then',
    '  say "cannot mount the download"',
    '  open -n "$target"',
    '  exit 1',
    'fi',
    '',
    'src=""',
    'for candidate in "$mnt"/*.app; do',
    '  if [ -d "$candidate" ]; then src="$candidate"; break; fi',
    'done',
    '',
    'ok=0',
    'if [ -n "$src" ]; then',
    '  staged="$target.updating"',
    '  rm -rf "$staged"',
    '  if ditto "$src" "$staged"; then',
    '    rm -rf "$target.previous"',
    '    if mv "$target" "$target.previous"; then',
    '      if mv "$staged" "$target"; then',
    '        ok=1',
    '      else',
    '        say "could not put the new version in place; restoring the old one"',
    '        mv "$target.previous" "$target"',
    '      fi',
    '    else',
    '      say "could not move the old version aside"',
    '    fi',
    '  else',
    '    say "could not copy the new version out of the image"',
    '  fi',
    '  rm -rf "$staged"',
    'else',
    '  say "the image had no application in it"',
    'fi',
    '',
    'hdiutil detach "$mnt" -force >/dev/null 2>&1',
    'rmdir "$mnt" >/dev/null 2>&1',
    'rm -rf "$(dirname "$dmg")"',
    '',
    'if [ "$ok" = 1 ]; then',
    '  # Nothing here was signed by anyone macOS recognises, and a bundle carrying',
    '  # a quarantine flag it cannot clear is a bundle that will not open.',
    '  xattr -dr com.apple.quarantine "$target" >/dev/null 2>&1',
    '  rm -rf "$target.previous"',
    '  say "installed"',
    'else',
    '  say "left the installed version alone"',
    'fi',
    '',
    'open -n "$target"',
    '',
    '# This script sits in a directory of its own, away from the .dmg, so that the',
    '# line above could delete 120MB without deleting the file /bin/sh is reading.',
    '# Its own turn comes from a subshell that already holds the work and no longer',
    '# needs the file it came out of.',
    '( sleep 5; rm -rf "$self" ) >/dev/null 2>&1 &',
    '',
  ].join('\n');
}

/**
 * Starts the swap and reports whether it is under way.
 *
 * Detached, with its output thrown away and its handle unreferenced, because the
 * entire point is that it survives the process that started it. The caller quits
 * straight afterwards; the script's first act is to wait for that to finish.
 */
function install(dmg, logPath) {
  const bundle = bundlePath();
  if (!bundle) return false;

  try {
    // Its own directory, because the last thing the script does is delete the one
    // the download is in, and a shell reading a file it has just deleted is a
    // reliable way to lose the end of it.
    const home = workDir();
    const runner = path.join(home, 'swap.sh');

    fs.writeFileSync(
      runner,
      script({
        bundle,
        dmg,
        pid: process.pid,
        mount: path.join(path.dirname(dmg), 'mnt'),
        log: logPath,
        self: home,
      }),
      { mode: 0o755 },
    );

    const child = spawn('/bin/sh', [runner], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  assetUrl,
  bundlePath,
  canInstall,
  install,
  pickAsset,
  stage,
};
