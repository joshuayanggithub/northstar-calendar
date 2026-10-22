Common bugs may include 1. UI bugs, new features impelemnted that don't belong int eh right place or look clunky or the title of an event being not shown due to overflowing
container box 2. UX bugs such as selecting an event and it doesnt highlight the entire event body correctly, and using the scroll feature to move horizontally but its constantly
bugging/freezing or reverting several pixels back in the viewport resulting in delay  and uisng the dropdown but it only shows the different calendars and not he corresponding
color icons taht google calendar would show in that same dropdown when omdifying an event's corresponding calendar 3. feature bugs such as trying to modify an event and not being
able to swithc the calendar of the event evne when saving. Also there are those already in the TODO.md.


UI/UX bugs are especially common, we must use end-to-end testing int he app, collect screenshots and verify behavior visually. 

## How to run it

- Root-causing a bug: follow `.claude/skills/bug-root-cause/SKILL.md`
  (reproduce first, find the failing line, fix, add a test that fails on the
  old code).
- Browser (mock backend): `npm run test:e2e`. The browser timezone is pinned
  to America/New_York in `playwright.config.ts`, so results match on any host.
- Real app window (macOS WKWebView or Linux WebKitGTK), sandboxed data and
  Google sync off: `npm run test:e2e:app` runs `e2e/real_window.sh` and
  `e2e/native_regressions.py` (annotation delete from the canvas and the
  editor, no flash, swipe never steps backwards). Linux needs
  `npm run setup:e2e:linux` once. It runs headless under Xvfb; set
  `CAL_E2E_DISPLAY=$DISPLAY` to watch the window instead (works over SSH X
  forwarding). For dense native rendering, run
  `CAL_E2E_DENSE_EVENTS_PER_DAY=240 npm run test:e2e:app`; this opts into
  240 events/day across 21 days while keeping the default seed small. Use 45
  or 120 for intermediate density controls. The
  swipe report includes mounted/viewport-intersecting cluster-row counts,
  RAF p95/slow-frame count, and synchronous wheel-dispatch timings. Its
  JS-generated `WheelEvent`s are
  untrusted and exercise the custom path, not a physical trackpad. X11 button-6
  input in WebKitGTK reports a large discrete delta and also stays on the
  custom path; do not treat either input as the low-amplitude native-scroll
  path used by the trackpad regression. `CAL_E2E_PAN_STYLE='CSS'` applies a
  diagnostic-only CSS override immediately before the native swipe; leave it
  unset for product measurements. Dense cluster blocks retain their full row
  positions, but only mount buttons near the vertical viewport. The browser
  row-window regression checks that vertical scrolling mounts additional rows
  without changing block height.
- Sync engine: `npm run test:rust` (fake Google API, `crates/sync-core/tests`).
- Dense-pan engine probe (Linux WebKitGTK 4.0, not the native Tauri window):
  run `npm run build`, start
  `npm run preview -- --host 127.0.0.1 --port 15321`, then run
  `TZ=America/New_York CAL_PAN_BRIEF=1 CAL_PAN_REQUIRE_MOTION=1 CAL_PAN_WHEEL_DX=2 xvfb-run -a /usr/bin/python3 e2e/webkit_pan_probe.py`.
  Use `CAL_PAN_EVENTS_PER_DAY=45` for a control, `240` for dense stress, and
  `CAL_PAN_WHEEL_DX=2` to measure a deterministic 120px continuous pan through
  the app's custom wheel path without a day shift. `CAL_PAN_REQUIRE_MOTION=1`
  makes the probe fail unless it observes actual horizontal displacement; do
  not interpret frame timing from a run with `movementVerified:false`.
  `CAL_PAN_GDK_INPUT=1 CAL_PAN_GDK_DELTA_SCALE=127` sends trusted GTK smooth
  wheel packets whose DOM `deltaX` is 2px; the same motion guard applies. This
  is closer to browser-native scrolling, but is still Xvfb input, not a
  physical trackpad. `CAL_PAN_GDK_DELTA_Y=0.5` adds a small cross-axis
  component in DOM-pixel units. `CAL_PAN_TRACE_PREVENT_DEFAULT=1` records the
  week-grid wheel-listener options and whether the app calls `preventDefault`.
  Results distinguish the requested from effective WebKitGTK acceleration
  policy; a requested setting may not be supported by the active renderer.
  `CAL_PAN_STYLE='.day-cols{visibility:hidden!important}'`
  is a diagnostic-only paint ablation, never a product setting.
  `CAL_PAN_WITH_NOTES=1` seeds drill annotations on every twentieth event.
  The Playwright browser-input profile defaults to 21 days of data at the
  selected density, so all visible and overscan dates stay populated while
  panning; set `CAL_PAN_EVENT_COUNT` only when intentionally limiting total
  events. `CAL_PAN_STYLE` can apply a diagnostic-only CSS ablation in this
  profile. It separates `scroll` event delivery from the first animation frame
  that observes `scrollLeft` change. The WebKit probe reports verified motion,
  RAF gaps, DOM wheel-packet intervals, wheel dispatch, scroll/update latency,
  React commits, rendered row count, and day-column DOM moves; its
  transform-control timing measures synchronous style writes, not painted or
  presented frames. The GDK probe's timeout callbacks share GTK's main loop, so
  renderer stalls can delay or bunch synthetic packets; those intervals are
  not physical-device cadence. The Playwright
  profile also reports actual DOM wheel-event intervals: on this Xvfb setup,
  `page.mouse.wheel` was delivered about every 100ms despite 12ms waits, so do
  not treat that profile as continuous trackpad cadence. Its full-pan
  displacement assertion uses the actual initial offset and rendered column
  width, and guards against >1px cumulative error across fractional day
  rebases. The GDK probe can deliver trusted packets every 12ms. These profiles
  require the GTK3/WebKitGTK 4.0 Python GI runtime and Xvfb; synthetic wheel
  packets and the specific WebKitGTK/Xvfb renderer configuration do not
  establish macOS trackpad performance. Check the active WebKitGTK hardware
  acceleration policy instead of assuming Xvfb is software-rendered; the
  Python probe uses WebKitGTK 4.0 and is not the Linux Tauri app's WebKitGTK
  4.1 window.
  With `CAL_PAN_WITH_NOTES=1`, it also reports the annotation fixture/index
  counts, placement-worker stages, and pending state. `CAL_PAN_REPORT_DELAY_MS`
  controls when the page captures and Python reports the post-pan result;
  `CAL_PAN_REQUIRE_NOTES=1` fails unless note DOM nodes are rendered and
  pending placement is zero at capture. `CAL_PAN_SETUP_DELAY_MS` waits after
  page load before installing the probe (default 2500ms); `CAL_PAN_START_DELAY_MS`
  waits after probe setup before injecting input (default 500ms). Use
  `CAL_PAN_REQUIRE_NOTES_DURING_PAN=1` to fail unless notes are already placed
  at gesture start and remain in the DOM for every captured wheel packet.
  For the affected Mac, follow `e2e/MAC-PAN-PROFILE.md` to export a physical
  trackpad Web Inspector timeline and inspect the calendar's compositing layer.
  The app shell's wheel observer is passive during ordinary input; it installs
  a cancelable listener only while Control is held for browser-zoom handling.
  In WeekView, clear trusted low-amplitude pure-horizontal streams switch to
  native scrolling/passive handling; the existing custom axis-lock path remains
  for ambiguous, vertical, and larger-delta input. `pan-performance.spec.ts`
  guards this split and the native vertical-scroll behavior. Linux WebKitGTK
  4.0 still measures dense-frame hitches under its software renderer, so this
  listener change is not considered a verified macOS fix without the physical
  WKWebView timeline.

Lessons from the 2026-10-16 pass:
- The mock backend can hide native-only bugs. It used to mutate events in
  place (native returns fresh snapshots), and it clears fields the native
  PATCH silently kept. Confirm UI fixes in the real window.
- To catch a one-frame visual glitch, sample at every DOM mutation
  (MutationObserver), not after each input round trip. The old native pan
  probe sampled between wheel events and missed the jitter every time.
- Visual snapshot baselines exist for macOS only; a Linux run writes new
  `-linux.png` files. Don't commit those without reviewing them.

## Window restore (real window, every monitor)

`./e2e/sandbox_app.sh start && python3 e2e/winstate_check.py` places the
sandbox window on each monitor, quits it through its own Quit menu item
(System Events, by pid: the native ⌘Q path, which fires Tauri's `Exit`
without `ExitRequested`), relaunches, and compares `window.json` and the
window's place (hook `window_get`/`window_set`/`quit`). Needs Accessibility
for the terminal. 2026-10-22: 3 monitors × native quit + app.exit, all ok.
