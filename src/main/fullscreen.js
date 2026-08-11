'use strict';

/**
 * Answers one question: is a fullscreen app currently in front?
 *
 * The bar has to keep re-asserting its position to stay above the taskbar, since
 * the taskbar is an always-on-top window too and whichever was raised last sits in
 * front. Doing that blindly also drags the bar over fullscreen video. Knowing when
 * something is fullscreen is what lets the bar hold its place against the taskbar
 * and still get out of the way of a film.
 *
 * Windows only. Everywhere else this reports false and the caller behaves as before.
 */

const { screen } = require('electron');

let user32 = null;

try {
  if (process.platform === 'win32') {
    const koffi = require('koffi');
    const lib = koffi.load('user32.dll');
    koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });

    user32 = {
      getForegroundWindow: lib.func('void* GetForegroundWindow()'),
      getWindowRect: lib.func('bool GetWindowRect(void*, _Out_ RECT*)'),
      getClassName: lib.func('int GetClassNameW(void*, _Out_ uint16_t *buf, int)'),
    };
  }
} catch {
  // No FFI available — the caller falls back to its old behaviour rather than failing.
  user32 = null;
}

// The desktop and the taskbar themselves are screen-sized; they are not "a
// fullscreen app" and must not suppress the bar.
const SHELL_CLASSES = new Set([
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'WorkerW',
  'Progman',
  'Windows.UI.Core.CoreWindow',
]);

const EDGE_TOLERANCE = 2; // px of slack, since some players sit a pixel proud

function classNameOf(hwnd) {
  const buffer = new Uint16Array(256);
  const length = user32.getClassName(hwnd, buffer, 256);
  if (!length) return '';
  return Buffer.from(buffer.buffer, 0, length * 2).toString('utf16le');
}

function foregroundIsFullscreen() {
  if (!user32) return false;

  try {
    const hwnd = user32.getForegroundWindow();
    if (!hwnd) return false;

    if (SHELL_CLASSES.has(classNameOf(hwnd))) return false;

    const rect = {};
    if (!user32.getWindowRect(hwnd, rect)) return false;

    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    if (width <= 0 || height <= 0) return false;

    const { bounds } = screen.getDisplayMatching({
      x: rect.left,
      y: rect.top,
      width,
      height,
    });

    return (
      rect.left <= bounds.x + EDGE_TOLERANCE &&
      rect.top <= bounds.y + EDGE_TOLERANCE &&
      width >= bounds.width - EDGE_TOLERANCE &&
      height >= bounds.height - EDGE_TOLERANCE
    );
  } catch {
    return false;
  }
}

module.exports = { foregroundIsFullscreen, isAvailable: () => Boolean(user32) };
