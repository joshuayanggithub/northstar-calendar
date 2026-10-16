# Development

## Prereqs
- Rust (stable, via rustup), Node 20+
- Linux (Debian/Ubuntu): `npm run setup:e2e:linux` once. It installs the
  WebKitGTK 4.1 / GTK / Xvfb packages Tauri needs (sudo) and builds the app.
- `.oauth.local.json` at the repo root (gitignored) with `client_id` / `client_secret`
  from your own Google Cloud project (Desktop OAuth client).

## Run
- `npm run tauri dev` — the real app (WKWebView + Rust backend).
- `npm run dev` then open http://localhost:1420 in Chrome — UI only, mock backend
  (badge shows "browser mock mode"). This is the debuggable mode: full devtools,
  Playwright, Chrome automation.

## Test
- `npm run test:rust` — sync-engine unit tests (conflicts, echo suppression, 410, 409).
- `npm run test:e2e` — Playwright against the mock-backend UI.
  (Browsers are vendored into node_modules via PLAYWRIGHT_BROWSERS_PATH=0.)

## Real-window E2E (macOS and Linux)
`npm run test:e2e:app` starts the debug app on a sandboxed database with
Google sync off (`e2e/sandbox_app.sh`: macOS snapshots the live DB, Linux
seeds `crates/sync-core/examples/seed_e2e.rs` and runs under a private Xvfb).
It then runs `e2e/real_window.sh` and `e2e/native_regressions.py` against the
in-app WebDriver, and stops the app. On Linux, `CAL_E2E_DISPLAY=$DISPLAY`
puts the window on an existing display (e.g. SSH X forwarding) instead of
Xvfb. Linux data/logs: `~/.local/share/com.joshuayang.calendar-app/`.

## Debugging the real app
- Right-click → Inspect in a debug build opens Safari Web Inspector.
- Logs (Rust + forwarded frontend errors):
  `~/Library/Application Support/com.joshuayang.calendar-app/logs/calendar-app.log.*`
- SQLite store: `~/Library/Application Support/com.joshuayang.calendar-app/calendar.db`
- The refresh token lives in the macOS keychain under `com.joshuayang.calendar-app`.

## Architecture (short)
- `crates/sync-core` — platform-agnostic: SQLite store, OAuth PKCE, Google client,
  sync engine. No Tauri deps (mobile-ready). See FEATURES.md for the parity tracker.
- `src-tauri` — shell: commands, keychain, background sync thread (30s + kicks).
- `src/` — React UI; `src/lib/backend.ts` picks Tauri IPC or the browser mock.

## Automation test hook (debug builds only)
The app listens on `127.0.0.1:14211` in debug builds and accepts the same
operations the UI invokes, enabling clickless end-to-end tests of the real app
(macOS WKWebView has no WebDriver; tauri-driver is Windows/Linux only):

    curl -s -X POST http://127.0.0.1:14211 -d '{"cmd":"list_calendars"}'
    curl -s -X POST http://127.0.0.1:14211 -d '{"cmd":"create_event","input":{...EventInput}}'
    curl -s -X POST http://127.0.0.1:14211 -d '{"cmd":"delete_event","calendar_id":"…","event_id":"…"}'
    curl -s -X POST http://127.0.0.1:14211 -d '{"cmd":"pending_ops"}'  # queue depth

Compiled out of release builds (`#[cfg(debug_assertions)]`), loopback only.

## Design references
`design/references/` holds screenshots of Google Calendar (week/month) and
`gcal-tokens.json` with measured values (48px hour rows, 12px/500 chip text,
6px chip radius, 11px hour labels) — the Phase 2 grid builds to these numbers.

## Notifications, tray, global shortcut
- Scheduler thread (src-tauri/src/notify.rs) notifies at T-60s before timed
  events and keeps the menubar tray's "Next: …" entry + Join item fresh.
- ⌥C anywhere summons the app with the quick-create box open.
- Dev builds store the Google refresh token in a 0600 file
  (app data dir /google_refresh.token) instead of the keychain, because each
  `tauri dev` rebuild is a differently-signed binary and macOS would re-prompt
  on every rebuild. Release builds use the keychain.

## Booking links (worker/)
See worker/README.md — deploy to Cloudflare Workers (free), rules in KV,
bookings land as real Google events with Meet links and email invites.

## Real-webview probing (macOS)

WKWebView has no WebDriver/CDP endpoint, so external drivers can't attach to
the real window. Instead the debug test hook can evaluate JS *inside* the
running app's webview and return the result:

```sh
curl -s -X POST http://127.0.0.1:14211/ -d '{"cmd":"eval","script":"return document.querySelectorAll(\".chip-timed\").length"}'
```

The script body may use `return` and `await`, runs in page context, and can
query the real DOM, measure rendered geometry (offsetLeft/Width), read
computed styles, and dispatch synthetic events (keyboard/pointer). Results
round-trip through the `test_report` command. `{"cmd":"screenshot","path":…}`
captures the screen via `screencapture` (needs Screen Recording permission).
Debug builds only; everything binds 127.0.0.1.

For interactive debugging of the real webview, Safari's Develop menu can
attach its Web Inspector to the dev app's WKWebView (devtools are enabled in
debug builds), giving console + DOM inspection — just not automation.

## In-app WebDriver (tauri-plugin-webdriver)

Debug builds also serve a W3C WebDriver endpoint from inside the app at
`http://127.0.0.1:4445` (tauri-plugin-webdriver). This is the closest thing
to real E2E macOS allows, since WKWebView has no external endpoint:

- works: sessions, find element, rect/text/attributes, execute/sync,
  **screenshots of the real window** (no Screen Recording permission needed),
  and W3C `/actions` for UI that listens to Mouse events.
- caveat: element-click is a synthetic `el.click()` and `/actions` dispatches
  MouseEvents, not PointerEvents — the grid's drag/select handlers listen to
  `pointerdown`, so drive those by dispatching `PointerEvent`s via
  `execute/sync` (see `e2e/real_window.sh`).

`./e2e/real_window.sh` runs a real-window smoke suite: view switching via
keydown, layered-overlap geometry invariants over the live calendar data,
panel-open via pointer sequence, and a screenshot; it restores whatever view
the window was in.
