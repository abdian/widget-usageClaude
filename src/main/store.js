'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  /*
   * Five minutes. Usage moves slowly, the reset countdown ticks locally between
   * polls anyway, and checking every minute is close enough to Anthropic's rate
   * limit to trip it — which costs you a working widget to learn nothing new.
   */
  refreshSeconds: 300,
  alwaysOnTop: true,
  startAtLogin: false,
  lockPosition: false,
  clickThrough: false,
  compact: false,
  opacity: 0.96,

  /*
   * macOS only, and only on a Mac that has a camera housing to sit under. Drops
   * everything except a hairline of the 5-hour session, pinned below the notch.
   * It ignores anchor, position and compact entirely — the notch is the position.
   *
   * Spread in rather than declared, so off macOS the key does not exist at all:
   * it never reaches settings.json, and the validator below drops any patch that
   * names it. A Windows build has no such setting to set.
   */
  ...(process.platform === 'darwin' ? { notchMode: false } : {}),

  // Which meters to draw. Session and week are the two that always exist; the
  // other two only appear when the account actually reports them.
  showSession: true,
  showWeek: true,
  showScopedWeekly: false,
  showCredit: false,

  /*
   * Off means a fullscreen app covers the bar, which is almost always what you
   * want while watching something. On keeps re-asserting the bar's position,
   * which is the only way to stay reliably above the taskbar — at the cost of
   * also floating over fullscreen video.
   */
  stayAboveFullscreen: false,

  // Where the bar parks itself. One of the nine screen anchors, or 'free' once
  // you drag it somewhere of your own choosing. Anchors are re-applied on every
  // launch and whenever the screen layout changes.
  anchor: 'bottom-right',
  position: null, // {x, y} — only consulted while anchor is 'free'

  // Anchor against the whole screen rather than the desktop work area, which
  // lets the bottom positions sit on the taskbar instead of above it.
  overTaskbar: false,

  showRefreshTime: true,
};

/*
 * Settings arrive from the renderer over IPC, and a value that is merely wrong
 * rather than malicious is enough to break things: an opacity of 40 makes the
 * panel opaque, an anchor of 'middle' has no geometry and silently falls back,
 * a position of null-ish coordinates puts the bar off-screen. So every key is
 * checked here — the one place that owns what a setting is allowed to be —
 * and anything unrecognised is dropped rather than written to disk.
 */

const ANCHOR_NAMES = new Set([
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'middle-center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
  'free',
]);

const bool = (value) => Boolean(value);

const clamped = (min, max) => (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : undefined;
};

/** A dropped monitor can leave a saved position far outside any screen, so the
 *  coordinates are bounded too — clampToDisplay in main.js pulls it the rest of
 *  the way back, but only if the numbers are finite to begin with. */
function point(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;

  const bounded = (n) => Math.round(Math.min(32000, Math.max(-32000, n)));
  return { x: bounded(x), y: bounded(y) };
}

const VALIDATORS = {
  // 120s is the floor the poller enforces anyway; an hour is past the point
  // where a "live" widget means anything.
  refreshSeconds: clamped(120, 3600),
  // Below about a fifth the panel is unreadable, which reads as a broken widget
  // rather than a subtle one.
  opacity: clamped(0.2, 1),
  anchor: (value) => (ANCHOR_NAMES.has(value) ? value : undefined),
  position: point,

  alwaysOnTop: bool,
  startAtLogin: bool,
  lockPosition: bool,
  clickThrough: bool,
  compact: bool,
  // Absent off macOS, so sanitize() treats notchMode as an unknown key and drops
  // it — including out of a settings.json copied over from a Mac.
  ...(process.platform === 'darwin' ? { notchMode: bool } : {}),
  showSession: bool,
  showWeek: bool,
  showScopedWeekly: bool,
  showCredit: bool,
  stayAboveFullscreen: bool,
  overTaskbar: bool,
  showRefreshTime: bool,
};

function sanitize(patch) {
  if (!patch || typeof patch !== 'object') return {};

  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    // hasOwn, not a plain lookup: 'constructor' and 'toString' are keys any
    // object answers to, so indexing would hand back an inherited value and try
    // to call it. A patch naming one is exactly what an unchecked patch looks like.
    if (!Object.hasOwn(VALIDATORS, key)) continue; // unknown key — not ours to store

    const checked = VALIDATORS[key](value);
    if (checked !== undefined) clean[key] = checked;
  }
  return clean;
}

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function all() {
  if (cache) return cache;

  let stored = {};
  try {
    // Plenty of Windows editors save JSON with a byte-order mark, and JSON.parse
    // throws on one. Without stripping it, real settings would look corrupt and
    // be silently replaced by defaults on the next save.
    stored = JSON.parse(fs.readFileSync(file(), 'utf8').replace(/^﻿/, ''));
  } catch {
    // No settings yet, or the file really is unreadable — defaults are a fine
    // answer either way.
  }

  // The file on disk gets the same check as an IPC patch: it is editable by hand,
  // and a stale key from an older build should not outlive the setting it named.
  cache = { ...DEFAULTS, ...sanitize(stored) };
  return cache;
}

function get(key) {
  return all()[key];
}

function set(patch) {
  cache = { ...all(), ...sanitize(patch) };
  try {
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    // Disk write failed; the in-memory value still applies for this run.
  }
  return cache;
}

module.exports = { all, get, set, DEFAULTS };
