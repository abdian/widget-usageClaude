'use strict';

/**
 * The small amount of Windows the widget cannot ask Electron for.
 *
 * Two questions live here. Is a fullscreen app in front — so the bar knows to get
 * out of the way of a film rather than float over it. And is the bar actually
 * covered right now — so it can take its place back *only* when it has lost it.
 *
 * That second one is the whole point. The taskbar is an always-on-top window too,
 * and Windows re-raises it whenever it feels like, which drops the bar behind it.
 * Re-raising the bar on a timer fixes that but makes it blink, because most ticks
 * had nothing to fix. Asking first means the bar only moves when it has to.
 *
 * Windows only. Everywhere else these report "nothing to do" and the caller falls
 * back to the plain Electron behaviour.
 */

const { screen } = require('electron');

let user32 = null;
let kernel32 = null;

try {
  if (process.platform === 'win32') {
    const koffi = require('koffi');
    const lib = koffi.load('user32.dll');
    koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    koffi.struct('POINT', { x: 'long', y: 'long' });

    user32 = {
      getForegroundWindow: lib.func('void* GetForegroundWindow()'),
      getWindowRect: lib.func('bool GetWindowRect(void*, _Out_ RECT*)'),
      getClassName: lib.func('int GetClassNameW(void*, _Out_ uint16_t *buf, int)'),
      isZoomed: lib.func('bool IsZoomed(void*)'),

      // Declared with pointer-sized integers rather than void*, because these are
      // compared and passed back as plain numbers rather than dereferenced.
      windowFromPoint: lib.func('intptr_t WindowFromPoint(POINT)'),
      getAncestor: lib.func('intptr_t GetAncestor(intptr_t, uint)'),
      getWindowThreadProcessId: lib.func('uint32 GetWindowThreadProcessId(intptr_t, _Out_ uint32 *)'),
      setWindowPos: lib.func('bool SetWindowPos(intptr_t, intptr_t, int, int, int, int, uint)'),

      // BOOL is a four-byte int, so bRevert is declared int rather than bool:
      // a one-byte bool leaves the rest of the register undefined, and this call
      // takes the difference between reading the menu and resetting it.
      getSystemMenu: lib.func('intptr_t GetSystemMenu(intptr_t, int)'),
      getMenuItemCount: lib.func('int GetMenuItemCount(intptr_t)'),
      removeMenu: lib.func('int RemoveMenu(intptr_t, uint, uint)'),

      findWindow: lib.func('intptr_t FindWindowW(str16, str16)'),
      isWindow: lib.func('bool IsWindow(intptr_t)'),
      getWindowLongPtr: lib.func('intptr_t GetWindowLongPtrW(intptr_t, int)'),
      setWindowLongPtr: lib.func('intptr_t SetWindowLongPtrW(intptr_t, int, intptr_t)'),
    };

    const kernel = koffi.load('kernel32.dll');
    kernel32 = {
      createMutex: kernel.func('intptr_t CreateMutexW(void*, bool, str16)'),
      getLastError: kernel.func('uint32 GetLastError()'),
    };
  }
} catch {
  // No FFI available — every caller has a plain-Electron path to fall back to.
  user32 = null;
  kernel32 = null;
}

const ERROR_ALREADY_EXISTS = 183;

// Held for the life of the process: Windows destroys the mutex when the last
// handle to it closes, which is exactly the moment another copy may start.
let instanceMutex = null;

/**
 * Claims the right to be the only widget in this login session. Returns false if
 * some other copy already holds it.
 *
 * Electron's own single-instance lock is keyed to the user-data folder, so it
 * catches the ordinary case — the shortcut clicked twice — and nothing else. Two
 * copies pointed at different folders, a dev build run beside the installed one,
 * an old install left behind by a rename: each of those is a second widget on
 * screen, both polling the same account, and Anthropic rate-limits the pair of
 * them until one starts showing "No connection". A name the whole session shares
 * is what makes the second copy notice the first.
 *
 * `Local\` rather than `Global\` on purpose: another person signed in to the same
 * machine is a different session, and is entitled to their own widget.
 */
function claimSingleInstance(name) {
  if (!kernel32) return true; // cannot ask — never block startup over it

  try {
    const handle = kernel32.createMutex(null, true, `Local\\${name}`);

    // Read immediately: any further call through the FFI could overwrite it.
    const taken = kernel32.getLastError() === ERROR_ALREADY_EXISTS;

    if (!handle) return true;
    instanceMutex = handle;
    return !taken;
  } catch {
    return true;
  }
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

const EDGE_TOLERANCE = 2; // DIP of slack, since some players sit a pixel proud

const GA_ROOT = 2;
const GWLP_HWNDPARENT = -8; // the owner, despite the name — see pinAbove
const MF_BYPOSITION = 0x0400;
const HWND_TOP = 0;
const HWND_TOPMOST = -1;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOOWNERZORDER = 0x0200;

function classNameOf(hwnd) {
  const buffer = new Uint16Array(256);
  const length = user32.getClassName(hwnd, buffer, 256);
  if (!length) return '';
  return Buffer.from(buffer.buffer, 0, length * 2).toString('utf16le');
}

/**
 * Windows answers in real screen pixels; everything on the Electron side of this
 * file is in device-independent ones. They are the same number only at 100%
 * scaling, which is why comparing them survived being written.
 */
function toDip(rect) {
  try {
    return screen.screenToDipRect(null, rect);
  } catch {
    return rect; // not Windows, or the call is unavailable — raw is the best guess left
  }
}

function foregroundIsFullscreen() {
  if (!user32) return false;

  try {
    const hwnd = user32.getForegroundWindow();
    if (!hwnd) return false;

    if (SHELL_CLASSES.has(classNameOf(hwnd))) return false;

    /*
     * Maximized is not fullscreen, and Windows is willing to say which it is.
     *
     * A maximized window fills the work area by definition, so it stops short of
     * the taskbar and leaves it reachable — it is not the thing the bar should be
     * getting out of the way of. Measuring alone cannot tell the two apart on a
     * screen whose taskbar is set to auto-hide, because then the work area *is*
     * the whole screen. Asking removes the guesswork from the common case.
     */
    if (user32.isZoomed(hwnd)) return false;

    const rect = {};
    if (!user32.getWindowRect(hwnd, rect)) return false;

    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    if (width <= 0 || height <= 0) return false;

    /*
     * Converted before anything is compared, and this was the bug.
     *
     * A raw GetWindowRect was being measured against a display's DIP bounds. At
     * 150% — the default on most Windows laptops sold — an ordinary maximized
     * window reports about 1936 pixels wide against a screen the other side of
     * the comparison calls 1280 DIP, so it looked fullscreen by a mile. The bar
     * then stood down, dropped out of always-on-top, and sank behind the taskbar;
     * clicking it made the *bar* the foreground window, which is not fullscreen,
     * so two ticks later it came back. That is the blinking, and the widget
     * disappearing on right-click, and its going under again on the next click
     * elsewhere: all one wrong unit.
     */
    const area = toDip({ x: rect.left, y: rect.top, width, height });
    const { bounds } = screen.getDisplayMatching(area);

    return (
      area.x <= bounds.x + EDGE_TOLERANCE &&
      area.y <= bounds.y + EDGE_TOLERANCE &&
      area.width >= bounds.width - EDGE_TOLERANCE &&
      area.height >= bounds.height - EDGE_TOLERANCE
    );
  } catch {
    return false;
  }
}

/** A BrowserWindow's HWND as a plain number, or 0 if it cannot be read. */
function handleOf(win) {
  try {
    const buffer = win.getNativeWindowHandle();
    const value = buffer.length >= 8 ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0));
    return Number(value);
  } catch {
    return 0;
  }
}

/** Which process owns a window, or 0 if it cannot be read. */
function processIdOf(hwnd) {
  const out = [0];
  user32.getWindowThreadProcessId(hwnd, out);
  return out[0];
}

/**
 * Is something drawn on top of us at these points?
 *
 * Points arrive in Electron's device-independent pixels and are converted here,
 * because hit testing happens in real screen pixels and the two only agree at 100%
 * scaling — which is exactly the machine this would otherwise be tested on.
 *
 * "Something" means somebody else's window. Our own menu is drawn over the bar on
 * purpose and its own settings window may well be; counting either as a covering
 * has the bar shoving its way in front of the thing you just opened. Ownership is
 * asked by process rather than by handle, because a popup menu is a window of its
 * own and the bar's handle alone would not recognise it.
 *
 * Note the bar must be able to hit-test itself for this to mean anything: in
 * click-through mode it cannot, so the caller does not ask.
 */
function isCoveredAt(hwnd, points) {
  if (!user32 || !hwnd) return false;

  try {
    for (const point of points) {
      const { x, y } = screen.dipToScreenPoint(point);
      const hit = user32.windowFromPoint({ x: Math.round(x), y: Math.round(y) });
      if (!hit) continue; // no window there at all — nothing is covering us

      // Through Number() because a handle is compared, not used: koffi hands back
      // a plain number here, but a BigInt would fail every === against one and
      // report the bar as permanently covered.
      const root = Number(user32.getAncestor(hit, GA_ROOT)) || Number(hit);
      if (root === hwnd) continue;
      if (processIdOf(root) === process.pid) continue; // ours, and allowed to be there

      return true;
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * Takes every item out of the window's system menu, so Windows has nothing of its
 * own to open on the bar.
 *
 * A drag region is the title bar as far as Windows is concerned, and right-clicking
 * a title bar opens the system menu — Move, Size, Close — over a widget that has no
 * use for any of it. The bar wants to answer that click with its own menu instead.
 *
 * Emptying the menu is the quiet way to do that. The alternative, letting Windows
 * open it and then disabling the window to make it go away, meant reaching back
 * into the window from inside the very message that opened the menu, and that is
 * what was killing the process on every right-click. An empty menu never opens, so
 * there is nothing to take back.
 *
 * The menu is left in place rather than removed with the WS_SYSMENU style, because
 * the message that announces it is still how the bar hears about the click.
 */
function disableSystemMenu(hwnd) {
  if (!user32 || !hwnd) return false;

  try {
    const menu = user32.getSystemMenu(hwnd, 0);
    if (!menu) return false;

    // Backwards: removing by position renumbers everything after it.
    for (let index = user32.getMenuItemCount(menu) - 1; index >= 0; index -= 1) {
      user32.removeMenu(menu, index, MF_BYPOSITION);
    }

    return user32.getMenuItemCount(menu) === 0;
  } catch {
    return false;
  }
}

/**
 * Put the window back at the front of the topmost band, without activating it.
 *
 * Electron's moveTop() activates as it raises, which pulls focus off whatever you
 * were typing in and repaints the transparent window — the flicker people notice.
 *
 * Two calls, because they answer two different questions and only one of them was
 * being asked. HWND_TOPMOST puts the window back into the topmost band if it has
 * been knocked out of it; for a window already in that band it changes nothing.
 * The taskbar is in that band too, so beating it means HWND_TOP — the front of
 * whichever band we are in. On its own, the first call could detect a covering
 * every tick and never clear it.
 */
function raiseToTop(hwnd) {
  if (!user32 || !hwnd) return false;

  try {
    const flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
    const banded = user32.setWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);
    const fronted = user32.setWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, flags);
    return Boolean(banded && fronted);
  } catch {
    return false;
  }
}

/** The taskbar's window, or 0. Re-read rather than cached: Explorer can restart. */
function taskbarHandle() {
  if (!user32) return 0;

  try {
    const hwnd = Number(user32.findWindow('Shell_TrayWnd', null)) || 0;
    return hwnd && user32.isWindow(hwnd) ? hwnd : 0;
  } catch {
    return 0;
  }
}

/**
 * Makes the bar an *owned* window of the taskbar, which is what finally stops it
 * being covered by one.
 *
 * Everything before this was a race that could only be narrowed, never won. The
 * shell re-raises the taskbar; the bar notices and raises itself back. Even
 * checking every frame, the bar is still behind for the frame between the two,
 * and that is the flicker that survived.
 *
 * Ownership removes the race instead of shortening it. Windows keeps an owned
 * window above its owner as an invariant of the z-order — not a thing that is
 * restored after the fact, but a thing that is never untrue. Nothing has to run,
 * and there is no interval at which the bar is behind the taskbar.
 *
 * GWLP_HWNDPARENT sets the owner, not the parent. A parent would make the bar a
 * child window clipped inside the taskbar, which is not this.
 *
 * The cost is that the bar's fate is tied to the taskbar's: destroying a window
 * destroys the windows it owns, and Explorer does restart. That is why this is
 * re-applied against a freshly read handle rather than set once, and why the
 * caller watches for the bar going away.
 */
function pinAbove(hwnd, owner) {
  if (!user32 || !hwnd || !owner) return false;

  try {
    if (Number(user32.getWindowLongPtr(hwnd, GWLP_HWNDPARENT)) === owner) return true;
    user32.setWindowLongPtr(hwnd, GWLP_HWNDPARENT, owner);
    return Number(user32.getWindowLongPtr(hwnd, GWLP_HWNDPARENT)) === owner;
  } catch {
    return false;
  }
}

/** Drops an ownership set by pinAbove, so the bar stands alone again. */
function unpin(hwnd) {
  if (!user32 || !hwnd) return false;

  try {
    user32.setWindowLongPtr(hwnd, GWLP_HWNDPARENT, 0);
    return Number(user32.getWindowLongPtr(hwnd, GWLP_HWNDPARENT)) === 0;
  } catch {
    return false;
  }
}

module.exports = {
  claimSingleInstance,
  taskbarHandle,
  pinAbove,
  unpin,
  disableSystemMenu,
  foregroundIsFullscreen,
  handleOf,
  isCoveredAt,
  raiseToTop,
  isAvailable: () => Boolean(user32),
};
