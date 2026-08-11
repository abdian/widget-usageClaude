<div align="center">

![Claude Usage](assets/poster.png)

**A floating bar that shows how much of your Claude Code subscription is left, and how long until it resets.**

[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-1a1614)](#macos)
[![License](https://img.shields.io/badge/license-MIT-d97757)](LICENSE)

</div>

---

Claude Code tells you your usage when you ask it. This keeps the answer on screen:
the 5-hour session window, the weekly window, and a live countdown to each reset —
in a small bar you park wherever you like and stop thinking about.

## Install

Download the installer from [Releases](../../releases) and run it.

Or build it yourself:

```bash
npm install
npm run dist       # Windows .exe -> release/
```

## Reading the bar

```
 SESSION  ████░░░░░░░░░░░░░░▒▒▒   20%   1h 40m
 WEEK     ████████████░░░░░░▒▒▒   68%   5d 18h
 ─────────────────────────────────────────────
 Updated just now                        MAX
```

Each meter is a 20-tick track, one tick per 5%. The last three ticks are the
**redline**: the 85–100% zone is tinted on the *empty* part of the track, so you can
see how much headroom is left before you are in trouble, not just where you stand.

Colour means severity and nothing else:

| Colour | Range   | Reading               |
| ------ | ------- | --------------------- |
| Clay   | 0–59%   | Plenty left           |
| Amber  | 60–84%  | Worth pacing yourself |
| Red    | 85–100% | In the redline        |

The strip along the bottom says when the numbers were last refreshed, and takes over
to say why if they stopped. The dot on the left is the connection: clay means current,
amber means the last refresh failed and you are seeing the previous reading, red means
Claude Code is not signed in here.

A failed refresh keeps the last good reading on screen — a stale number still answers
"how much have I got left". Only a sign-in problem replaces the meters, since that is
the case where you have to do something.

## Settings

Reachable from the gear on the bar, a right-click anywhere on the bar, or the tray
icon.

| Tab        | Holds                                                                |
| ---------- | -------------------------------------------------------------------- |
| **Meters** | Which limits to draw, and how often to check                         |
| **Look**   | Opacity, compact size, last refresh time                             |
| **Place**  | Nine screen anchors, over-the-taskbar, lock, on top, fullscreen, startup |
| **About**  | Version, credentials location, the repo                              |

Checking defaults to every 5 minutes and cannot be set below 2 — usage moves slowly,
the countdown ticks locally between polls anyway, and checking every minute sits close
enough to Anthropic's rate limit to trip it.

Pick a position and the bar returns to it on every launch. **Allow over the taskbar**
lets the bottom positions sit *on* the taskbar rather than above it, and pairing it
with **Start when Windows starts** brings the bar back in the same place every boot.

Compact mode shrinks the bar and moves every control into the right-click menu.

## Fullscreen video

The bar holds its place against the taskbar but drops out of the way for a fullscreen
app, then takes its place back when that ends. **Stay above fullscreen apps** turns the
courtesy off if you want the numbers visible over everything.

## How it reads your usage

It calls the same endpoint the `/usage` command inside Claude Code uses:

```http
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <your Claude Code token>
```

The token comes from the Claude Code sign-in already on your machine —
`~/.claude/.credentials.json` on Windows and Linux, the login keychain on macOS — and
is re-read on every poll rather than cached, so the app never needs a login of its own
and never breaks when Claude Code refreshes it.

Nothing is sent anywhere except to Anthropic, and nothing is stored beyond your own
settings.

> [!NOTE]
> This is an internal endpoint, not a documented public API. It works today and the app
> degrades gracefully if it changes — you get the "no connection" state rather than a
> crash — but it carries no stability promise.

There is no "days left in your subscription" meter: no endpoint the app can reach
reports a renewal date, and showing the token's expiry instead would be a different
number wearing the wrong label.

## macOS

The code is cross-platform — credentials come from the login keychain, and the tray
becomes a menu bar item showing the live numbers next to the clock.

```bash
npm run dist:mac   # .dmg -> release/
```

The catch: a `.dmg` has to be built on a Mac, and distributing it beyond your own
machine needs an Apple Developer ID for signing.

## License

MIT © [Ali Abdian](https://github.com/abdian)
