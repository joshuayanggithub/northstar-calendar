# TODO — open work ledger

> QA/stress-testing agents: start from e2e/HANDOFF-QA.md.

Working agreement: open items live here with enough context to resume cold.
When something ships, move it to the "Shipped" log at the bottom with its
commit, then into FEATURES.md / REQUESTS.md. Edits to this file are verified
(read back), never fire-and-forget.

## Features

- Zooming in should decrease the # of days in the current view, and zooming out should increase it. Granularity should be by number of days until we get to 14 in which we can go to month next. 

## Bugs — 2026-10-15 QA pass (committed; shipped in the 2026-10-15 afternoon release build)

LAW for all overlap rendering: overlapping events must never leave blank
horizontal space, and every overlapped event's title must stay visible. The
only resolutions are the joint (rabbet default) or the C-shape slab.

Layout engine note (afternoon): the multi-pass repair layout could chase
itself down the day on real data (traced: 400 rounds, boxes pushed to
3000px on a 864px day). Replaced by a single monotone placement pass
(each event placed once, in reading order, only ever moving down);
container titles now always sit at the container's top. Verified: 165 smoke
tests (dark + light) + 18 real-week LAW checks (6 weeks × 3 zooms) green.

- [x] **B1 Joint corners are square.** Rounded rabbet clip paths; mock joint
  regression passes.
- [x] **B2 Blank band / sliver between overlapping events.** Repaired final
  drawn boxes and the fractional-pixel seam. All 18 real-week overlap laws
  pass across six weeks and three zoom levels.
- [x] **B3 Text hidden in 3-deep nests.** Final label-band and slab-height
  repair keeps titles exposed. Real-week title checks pass.
- [x] **Long slab title ellipsized despite hours of open space.** Slab labels
  now wrap into the available uncovered band. Verified in native WebDriver
  screenshots and light/dark visual snapshots; real-week checks inspect every
  title line for occlusion.
- [x] **One-hour event title unnecessarily ellipsized at narrow width.**
  Corrected the title/time line budget so two title lines and the time fit in
  a 48px chip; verified at 600px browser width and with native text checks.
- [x] **B4 Chip tail into a slab gets no joint.** Chip/slab joint regression
  passes in the full E2E suite and real WKWebView layer check.
- [x] **B5 Reconcile row out of place.** Inspected an unsettled real event in
  the native editor; the joined control aligns with the panel rows.
- [x] **Narrow week headers shifted from event columns.** Grid tracks now use
  `minmax(0, 1fr)`; badges and dates fit at 800 CSS px. Playwright and native
  geometry checks pass.
- [x] **Nine-day horizontal pan lost 2px at each day boundary.** Removed the
  60px floor from the pan threshold and use the rendered column width. The
  real WKWebView moved exactly 80px through 20 four-pixel wheels with zero
  step error; browser regression checks 40 wheels across two boundaries.
- [x] **Hidden-weekend pan skipped movement and changed the column count.**
  The visible week now advances through a fixed five-business-day sequence;
  adjacent offscreen columns also skip weekends. A second regression clears
  partial pan offsets when switching the visible day count, and the weekend
  toggle preserves the first visible date. Browser E2E and native WKWebView
  checks pass.
- [x] **Calendar picker lacked color swatches.** Custom color-swatch menu
  verified in both Playwright themes and the refreshed WKWebView screenshot.
- [x] **Calendar change may not save.** A self-deleting `qa-probe` moved from
  the primary calendar to Career through the real editor, survived another
  Google sync, and was deleted with the queue drained.
- [x] **Recurring series ignored a calendar change with “All events.”** The
  scope action now moves the series master after patching its fields. The
  browser regression checks both occurrences, and a disposable two-occurrence
  Google series moved to Career through the native editor, synced both
  instances, then was deleted with the queue drained.
- [x] **Recurring “All events” dropped reminder and other settings edits.**
  The series patch now includes changed guests, busy/free, visibility, and
  reminder settings. A browser regression reopens both occurrences to check
  every field.
- [x] **Drill annotations in the live build.** An existing annotated event
  showed its red scrawl on the native chip and the matching note in the real
  editor; no event was changed.

The original 8-hour recurring Playwright loop (`e2e/stress_loop.py`) completed
at 2026-10-15 13:55 UTC. The current continuation runs every 15 minutes until
2026-10-16 02:59:44 UTC; results are in
`logs/stress-2026-10-16/index.tsv`.
The full suite passed 182/182 after the recurring-series settings fix. Native WebDriver
smoke and horizontal-pan checks also passed; debug pan had no backward steps.
An 11-event dense native probe rendered every QA event without sliced titles,
then deleted them all and drained the sync queue.
At 800 CSS px, 96 visible real-event title checks found no chip covering
another chip's displayed title line.
The 15:14 scheduled run lost the Vite server when the debug app exited; the
browser server now runs independently. The 15:59 run had one transient
`ERR_NETWORK_CHANGED` page-load failure. Surrounding scheduled runs passed
182/182, and their individual logs remain in the stress index.

## QA continuation — 2026-10-15 late night (committed `03b55d3`)

- [x] Horizontal scrolling no longer springs a partial swipe backwards after
  160 ms. The wheel handler no longer forces a synchronous React render;
  parsed event timestamps are cached per event object to reduce redraw cost.
  Browser regression checks pause/resume and narrow/nine-day alignment.
  Native WKWebView probe crossed a day boundary with zero backward steps;
  a dense 400-event production-browser probe averaged about 20 ms per day
  change after warmup.
- [x] Recurring “All events” now converts timed ↔ all-day and shifts the
  entire timed series when a later instance's date changes. Browser tests
  cover both conversions and a later-instance day shift. A disposable live
  Google series converted both ways, synced both occurrences, and was
  deleted with the pending queue drained.
- [x] Fixed-count recurring “This and following” is enabled. The old master
  now receives an `UNTIL` rule without `COUNT`, and the new series gets only
  the remaining count. A disposable live `COUNT=3` series split into 1 old +
  2 new occurrences through the native editor, then both masters were
  deleted and the queue drained. The first occurrence edits the original
  master directly. Committed `a72e439`.
- [ ] Continue the 15-minute full-suite stress loop and inspect every failure.
  The original five-hour window ended at 11:12 UTC; the CI-owned continuation
  now runs through 2026-10-17 11:35 UTC for the requested follow-up. Results are
  preserved under `logs/stress-2026-10-17/`.

## QA continuation — 2026-10-17 Linux merge and root-cause pass

- [x] Merged the latest `origin/main` (`d8c44e4`) into
  `linux-e2e-root-cause-fixes` as `348c379`. Upstream annotation resizing,
  overnight drag previews, pane resizing, pinch zoom, read-only calendars, and
  copy-to-calendar work are now present alongside this branch's fixes.
- [x] Resolved the merge's two Linux browser screenshot differences after
  reviewing both themes at original resolution; refreshed only the week-view
  snapshots. Fixed two newly merged overnight-drag test fixtures to use
  explicit New York offsets, avoiding the Linux host's Pacific timezone.
- [x] Reproduced and fixed the recurring edit's five-second stale display:
  local instance rows were not updated/emitted until after Google PATCH/move.
  Whole-series edits and “this and following” now project locally, emit the
  update, and close the editor before network I/O; failures restore snapshots.
  Added delayed-write regressions for both paths and nine platform-independent
  series projection/rollback tests. `npm run build`, both latency E2Es, and the
  full Linux browser suite pass (286 passed, 63 intentional skips).
- [x] Audited the optimistic projection across host timezones. Found it was
  converting IANA wall times through `chrono::Local`, so a series could shift
  when run outside the event's timezone. It now uses Jiff's system zoneinfo
  database for the event IANA zone, with fixed-offset fallback; fall-back DST
  coverage passes under both `TZ=UTC` and `TZ=America/Los_Angeles`. All 9 series
  projection/rollback tests and 12 sync-engine tests pass offline (one unrelated
  OAuth entropy test skipped because sandbox `getrandom` is denied).
- [x] Reproduced a recurring-edit annotation loss: changing the shared series
  description replaced each expanded instance's full description and erased
  its private `[DRILL]` note. The local projection and browser mock now merge
  the new shared body with each existing occurrence note. A Rust regression
  and the focused browser E2E both pass.
- [x] Reproduced two stale-state paths after a remote deletion: App refreshed
  selected objects that still existed but retained deleted events, so WeekView
  rendered a ghost and submitted a doomed group update; and an open event
  editor remained actionable from its stale snapshot. Selection now drops
  events absent from the visible DB snapshot, and the editor closes when its
  live event disappears. Both tests failed before the fixes; all five
  group-drag/sync-delete tests pass afterward.
- [x] The 08:01 full suite caught one intermittent drill-note input failure:
  replacing a note after Escape occasionally appended to the prior note. The
  trace matched a deferred RAF focus/caret callback racing Playwright/user text
  replacement and moving the caret to the end mid-operation. Focus and caret
  placement now run in `useLayoutEffect` at the textarea's mount. The production
  build passes; the affected note suites pass 11/11 and the flaky case passes
  20 consecutive isolated repetitions. The next CI-owned full suites at 08:16,
  08:31, 08:46, 09:01, 09:16, 09:31, 09:46, 10:01, 10:16, and 10:31 all
  passed (288 passed, 63 intentional skips, zero failures), including the note
  case; treat the focus/caret race as fixed.
- [x] Corrected pan profiling: measurements include only wheel-input frames
  and use the optimized production build (Vite dev timing is invalid). Seven
  isolated 400-event / 720px production-Chromium runs at 10:47–10:53 measured
  p95 16.7–16.8ms; four runs had one 33.4ms frame, the other three maxed at
  16.7–16.8ms. None showed long tasks or long-animation frames. The latest
  probe measured max synchronous wheel dispatch at 0.2ms, with three wheel
  events during its 33.4ms frame; this rules out a slow wheel callback but does
  not yet identify the missed-frame cause. The gate is now p95 <18ms and the
  probe reports slow-frame context. Browser pan behavior/regressions pass.
- [ ] Resolve remaining pan uncertainty in the actual Linux Tauri/WebKitGTK
  window and on a real trackpad. This host has neither GTK3 nor WebKitGTK
  development packages and lacks passwordless sudo; the native behavior stays
  unverified. One new production-preview Chromium wheel-input trace (400 events,
  720px) measured p95/max 16.8ms, no >25ms RAF gaps, wheel dispatch <=0.2ms,
  strip paint <=1ms, and WeekView commits 2.1-7.1ms. Input-window compositor
  DrawAndSwap spans reached ~20ms on Chromium's software renderer. This neither
  reproduces the 33ms idle-frame outlier nor identifies the user's real
  trackpad/WebKit bottleneck; do not claim the remaining lag is fixed. A first
  follow-up accidentally profiled Vite dev and measured a 25.7ms React commit;
  the diagnostic now explicitly skips dev builds so that result is not treated
  as production evidence. After the lead-in buffer fix, a fresh synthetic
  production trace measured p50/p95/max 16.7/16.7/16.8ms with no >25ms gaps;
  its browser-delivered counterpart measured p95 16.8ms and one 33.3ms gap at
  ~1249ms, during which there was no wheel event or WeekView commit. Dispatch
  stayed <=0.4ms, paint <=0.2ms, React commits 2-7ms; the latter gap remains
  outside app JS work and still needs physical-device/WebKitGTK evidence.
- [x] Diagnosed the 06:46 UTC stress-run failure burst (183 failed / 103
  passed): the log had no Vite startup and failures were `ERR_CONNECTION_REFUSED`
  to port 1420. `reuseExistingServer: true` had attached the long suite to a
  transient preview/dev server that ended mid-run. Automated runs now set CI
  mode and own their Vite server; the periodic loop was restarted with that
  guard through the requested 11:35 UTC follow-up. This was a harness failure,
  not 183 application regressions. The first CI-owned rerun at 07:01 UTC passed
  (286 passed, 63 intentional skips, zero failures); the 07:16 run after adding
  the remote-delete regressions also passed (288 passed, 63 intentional skips,
  zero failures), as did the 07:31 run (288 passed, 63 intentional skips,
  zero failures) and the 07:46 run (288 passed, 63 intentional skips, zero
  failures). The 08:01 run exposed the intermittent drill-note focus race
  (287 passed, 63 skipped); after its fix, the 08:16, 08:31, 08:46, 09:01,
  09:16, 09:31, 09:46, 10:01, 10:16, and 10:31 runs all passed (288 passed,
  63 skipped, zero failures).
- [x] The prior CI-owned 15-minute E2E stress window ended at 11:35 UTC; its
  last full run (11:31) passed 292 tests with 63 intentional skips.
- [x] Restarted the 15-minute CI-owned full-suite loop at 12:17 UTC through
  15:37 UTC (live process session `76152`) with local-bind permission after
  diagnosing the 12:10 startup failure. Runs `20261017T121757Z` (292 passed /
  64 skipped), `20261017T123257Z` (294 passed / 64 skipped), and
  `20261017T124757Z` (295 passed / 64 skipped), and `20261017T130257Z`
  (297 passed / 64 skipped) are green; logs remain under
  `logs/stress-2026-10-17/`. The
  12:10 failure was Vite `listen EPERM` on 127.0.0.1:1420, rendered by Playwright
  as a misleading "port already used" message. `curl` confirmed no listener;
  restarting the loop with the required local-bind permission is the harness
  correction, not an app fix.
- [x] Rechecked upstream `origin/main` at 12:59 and 13:54 UTC: still
  `bb5945d973a70009eddef56fd9a3eb37e0dcae66`, already included by merge commit
  `ac1acf5`; no new upstream commit was available to merge. The unprivileged
  DNS lookup failed; the read-only elevated lookup confirmed the same hash.
- [x] Added the missing multi-select deletion edge regression: opening one
  event, shift-adding a second while its panel remains open, then deleting
  clears selection, deletes both, and closes the deleted event's panel. Focused
  Playwright test passed 1/1 at 14:12 UTC; the 14:17 UTC full stress run
  passed 301/365 with 64 intentional skips and zero failures.
- [x] The 14:17 UTC CI-owned full suite passed 301/365 (64 intentional skips,
  zero failures), including the new selection/panel deletion case and pan
  gesture regressions. Results: `logs/stress-2026-10-17/20261017T141757Z.log`.
- [x] The 14:32 UTC CI-owned full suite again passed 301/365 (64 intentional
  skips, zero failures). Results: `logs/stress-2026-10-17/20261017T143257Z.log`.
- [x] The 14:47 UTC CI-owned full suite again passed 301/365 (64 intentional
  skips, zero failures). Results: `logs/stress-2026-10-17/20261017T144757Z.log`.
- [x] The 15:02 UTC CI-owned full suite passed 301/365 (64 intentional skips,
  zero failures), including the DST-crossing all-day edit test. Results:
  `logs/stress-2026-10-17/20261017T150257Z.log`.
- [x] The 15:17 UTC CI-owned full suite again passed 301/365 (64 intentional
  skips, zero failures). Results: `logs/stress-2026-10-17/20261017T151757Z.log`.
- [x] The final 15:32 UTC CI-owned full suite passed 301/365 (64 intentional
  skips, zero failures). Results: `logs/stress-2026-10-17/20261017T153257Z.log`.
- [x] The five-hour stress-loop window ended at 15:37 UTC; the runner exited
  cleanly after the 15:32 full-suite pass. The next continuation is waiting in
  Codex task `01a14999-10a7-7c40-b9a3-80a85b3859f5` for Oct 18 at 7:35 AM
  America/New_York (7:35 AM EDT / 11:35 UTC).
- [x] User requested another continuation at 7:35 AM Eastern on 2026-10-17
  (11:35 UTC while daylight time is in effect). The separate Codex task
  `01a1496f-92dd-71b2-956b-c7e950a169d7` ran at 11:35, checked the active
  thread and latest stress result, and handed off without edits because this
  five-hour triage was still active. The goal is expected to run through about
  15:37 UTC. This is best-effort scheduling, not a durable OS scheduler.
- [x] A second continuation is scheduled for 2026-10-18 at 7:35 AM
  America/New_York (`01a14999-10a7-7c40-b9a3-80a85b3859f5`). It was instructed
  to inspect active tasks and repository state first, avoid overlapping edits
  if triage is still live, and resume unfinished bug work if this task has
  stopped or exhausted usage.
- [x] Verify the calendar-move selection fix and mock snapshot fidelity in the
  scheduled full-suite loop. Root cause found 10:38 UTC: mock
  `applySeriesPatch`/`moveSeriesMaster` mutated event objects held by React
  selection/editor state, unlike native DB updates; patch + move also emitted
  twice instead of the native atomic update. The mock now clones rows, applies
  patch + destination together, and emits once. That exposed a real UX bug:
  App selection reconciliation matched only `id + calendar_id`, so the moved
  event's new calendar ID made a live event look deleted and removed its
  highlight. Reconciliation now follows a unique event ID across calendars,
  while dropping missing/ambiguous IDs and recurring IDs mapped to another
  series. The whole-series regression failed before the fix (the single-event
  case shares the same reconciliation path); both single-event and series
  tests pass now, and the series test also asserts old snapshots stay
  immutable. `npm run build`, the focused tests, and all 16 `recurring:` browser
  tests passed; the five group-drag/remote-delete tests also pass. A screenshot
  of the selected moved series chip was reviewed: the selection remains on the
  green destination event. The 10:46 CI-owned full suite passed (288 passed,
  63 intentional skips, zero failures). A first focused retry in the restricted
  shell could not bind Vite; rerunning with local-server permission passed.
  Keep stress-running through 11:35 UTC.
- [x] Upstream merge: the initial sandboxed remote query failed DNS, but the
  elevated read-only check at 10:55 UTC found `bb5945d`; fetched and merged it
  as `ac1acf5`. Upstream adds a mounted-panel busy reset after Delete and a
  Delete/Backspace shortcut for the open event. Merge conflict was limited to
  the shipped log; all local QA edits were preserved in a scoped stash and
  reapplied. Rechecked `origin/main` at 12:02 UTC: it remains
  `bb5945d973a70009eddef56fd9a3eb37e0dcae66`, so there are no newer upstream
  changes to merge. The 11:01 suite passed (290 passed, 63 intentional skips).
- [x] Root-caused a duplicate recurring delete request from the new keyboard
  shortcut. Delete/Backspace handled the open panel before the general modal
  guard and lacked a `pendingScope` check, so a second keypress while choosing
  “this / following / all” called `getSeriesMaster` again and reset the dialog.
  Added the pending-scope guard and regression in
  `e2e/panel-delete.spec.ts`; confirmed it failed with 2 master reads before
  the fix and passes afterward. All three panel-delete E2Es pass and
  `npm run build` is clean. The 11:16 full suite also passed (291 passed,
  63 intentional skips, zero failures).
- [x] **Overnight event start-time edit:** reproduced a new editor bug while
  continuing event-edit triage. After moving Swim to 11 PM–1 AM, changing the
  start to 11:30 PM made the end 11:45 PM instead of 1:30 AM: the old handler
  subtracted clock values without accounting for midnight and clamped the
  negative duration to 15 minutes. The editor now accounts for the day wrap
  when preserving the event's elapsed duration. A browser regression covers
  drag → start-time edit → end-time edit → save/reopen. Confirmed red before
  the fix and green after in a fresh CI-owned Vite server; the existing time
  picker and cross-midnight editor regressions pass too. Preserve the separate
  documented behavior that an end entered earlier than a same-day start is
  clamped to 30 minutes. Re-aligned the duration fallback with that save rule;
  focused same-day-clamp/cross-midnight/overnight tests pass 3/3 and the build
  passes. The 12:12 manual, 12:17 scheduled, and 12:32 scheduled full browser
  suites passed (latest 294 passed / 64 skipped). Fix remains uncommitted in
  the working tree.
- [x] **Multi-day timed event truncated on any editor save:** after seeding a
  49-hour Offsite (Oct 14 09:00–Oct 16 10:00), changing only its title and
  saving persisted Oct 15 10:00 as the end. Root cause: EventPanel collapsed
  `endDate - startDate` to `endNextDay: boolean`, and `buildInput` added only
  one calendar day. Reproduced red with a browser test before changing code.
  The panel now tracks integer `endDayOffset`, shows `+2d`, applies the offset
  on save, and when the start clock changes preserves elapsed duration across
  DST using the actual local Date instants; the duration badge also reports the
  actual 27h (not 26 wall-clock hours) across fall-back. Regression asserts start
  09:00→09:30 changes end 10:00→10:30 while retaining +2d. Focused same-day
  clamp, cross-midnight, overnight-duration, normal multi-day, and DST
  fall-back multi-day tests pass (6/6 including the adjacent DST-layout test);
  production build passes. The 12:32 full suite passed (294 passed / 64
  skipped), including both new multi-day regressions. Fix is uncommitted.
- [x] **Moving a multi-day all-day event's start date truncated its range:**
  seeded Oct 14–16 all-day Planning retreat, changed start to Oct 16, then
  observed the saved exclusive end move to Oct 17 instead of Oct 19. Root
  cause: the date input changed `date` but left the inclusive `allDayEnd` at
  Oct 16; `buildInput` then fell back to one day because the old end was no
  longer after the new start. Reproduced red. The handler now shifts the
  inclusive end by the same calendar-day offset as the start. Regression
  asserts the end-date control moves to Oct 18 and the persisted exclusive end
  is Oct 19, then reopens and shifts backward to confirm the three-day span
  again. The multi-day all-day regression plus timed/all-day conversion,
  all-day visibility, and lane-move tests pass 4/4; production build passes.
  Focused forward/backward regression re-ran at 12:42 UTC (1/1), then the
  12:47 full suite passed 295/359 with 64 intentional skips.
- [x] Extended the all-day range regression across DST fall-back: move a
  three-day Oct 31–Nov 2 event, preserve its three calendar-day span and
  exclusive Nov 3 end despite the clock change. Focused Playwright passed 1/1
  at 14:54 UTC; the 15:02 full suite passed 301/365 with 64 intentional skips,
  including this assertion.
- [x] Reproduced the remaining five-second delay for “this and following” on
  `COUNT=` series. `App.applyScope` awaited `getSeriesInstances` before calling
  `splitSeries`, so the existing local-first native transaction never started
  while Google paged through up to 5,000 instances. The UI now passes the
  original COUNT rule and selected `originalStartTime` to the backend; native
  split first projects the truncated old series + new placeholder and emits
  `db-changed`, then fetches Google instances, calculates the exact remaining
  COUNT (including cancelled originals), and only then patches/enqueues. Any
  count-fetch or truncate failure rolls the local projection back. The shared
  sync-core calculator has tests for cancelled instances, date-only all-day
  starts, and a missing selection. All three delayed series-latency browser
  tests and `npm run build` pass. Linux Tauri compilation/in-app validation
  still needs the absent GTK3/WebKitGTK 4.1 development packages.
- [x] Confirmed the original CI-owned 15-minute loop remained active; the
  13:17, 13:32, and 13:47 UTC full suites each passed 298/362 (64 intentional
  skips), and 14:02 passed 300/364 after adding the leading-packet and idle
  expiry regressions.
  A redundant 13:18 loop start correctly refused an occupied
  :1420; I stopped only that duplicate after its dedicated-port 13:19 run also
  passed 298/362. Playwright now accepts `PW_PORT` and the stress runner can
  use :1421 if an independent loop is ever needed. The original loop continues
  through 15:37 UTC; all logs remain under `logs/stress-2026-10-17/`.
- [x] Re-ran the series projection unit tests under this resumed pass:
  `cargo test -p sync-core --offline series::tests` passed 9/9, and the
  DST/IANA-zone regression passed under `TZ=UTC`; the sync-engine integration
  tests passed 12/12, including series instance swapping and queued edit/delete
  ordering. `cargo test -p sync-core --offline -- --skip
  pkce_challenge_is_s256_of_verifier` passes all 21 remaining tests. The
  unfiltered crate suite's only failure is the sandbox-denied OAuth entropy
  read (`getrandom`: `Operation not permitted`), not series projection or sync.
- [ ] Pan follow-up: reproduce the user's residual lag through physical
  trackpad delivery and Linux WebKitGTK. Existing 18 production-Chromium
  profiles (12 synthetic + 6 browser-delivered; 400 events / 720px) measured
  p95 16.7–16.8ms; 8/18 had one 33.2–33.4ms gap, usually with no wheel event
  or WeekView commit. New input-window CDP trace against the production bundle
  passed twice: p95/max 16.7–16.8ms, no >25ms RAF gaps, dispatch <=0.3ms,
  transform paint <=0.2ms, React commit <=7.2ms, and measured JSX stage work
  <=1.4ms total. Chromium's software renderer showed ~20–22ms DrawAndSwap
  spans, but those did not cause a missed RAF frame in these samples. An
  initial Vite-dev run showed a 25.7ms commit and is excluded; the opt-in probe
  now skips dev builds and summarizes its stage timings.
  **Two packet-loss cases are now reproduced and fixed in the app:** the
  wheel handler chose an axis independently for every packet. A horizontal
  start followed by 29 packets at `deltaX=4, deltaY=5` moved only 4 of the
  requested 120 pixels (red regression). The handler now locks to horizontal
  after the first horizontally dominant sample until 180 ms idle. Further
  tracing found the undecided lead-in also discarded X from a Y-dominant first
  packet; a red browser regression lost exactly 8px before lock. The handler
  now buffers only candidate X until horizontal intent locks, then replays it;
  candidates expire on idle. All seven focused gesture tests pass, including
  leading-delta retention, idle expiry, pure vertical scrolling, and alignment;
  `npm run build` passes. Two production-bundle profiles after this change
  measured synthetic p95/max 16.7/16.8ms with no >25ms gaps, and
  browser-delivered p95 16.8ms / max 33.3ms with one gap at 1249ms containing
  zero wheel events and zero WeekView commits. Dispatch peaked at 0.4ms, paint
  at 0.2ms, React commits at 2–7ms; no long tasks or long frames. This supports
  that the measured outlier isn't produced by the JS wheel handler, but it
  doesn't identify the renderer/scheduler cause. This fixes confirmed input-
  loss sources, but the user's actual
  physical trackpad/WebKitGTK symptom remains to be validated. The prior
  mixed-axis and new lead-in regressions passed the 14:17 full suite (301
  passed / 64 skipped, including the new G4 selection/panel delete regression).
  Native Linux setup is still
  blocked:
  Xvfb and GTK3/WebKitGTK 4.0 runtime libraries are present, but GTK3 and
  WebKitGTK 4.1 development `pkg-config` files (required by the repo setup
  script) and the WebKit driver are absent. A real `npm run test:e2e:app`
  attempt in a fresh `/tmp` sandbox failed before launch: `gdk-3.0`, `pango`,
  `cairo`, and `gdk-pixbuf-2.0` development pkg-config files are missing. The
  setup script previously stopped at `sudo: a password is required` before apt
  could install them. Exact build output is preserved in
  `/tmp/northstar-native-e2e-check-20261017/app.log`.
- [x] The 12:12 manual and 12:17, 12:32, 12:47, and 13:02 UTC scheduled full
  browser runs passed with the latest editor/gesture changes (latest 297 passed / 64
  intentional skips, zero failures). Periodic run logs are preserved in
  `logs/stress-2026-10-17/`.

## Overlap text placement — 2026-10-15 evening (committed `2fc384d8`)

- [x] Title and time never covered or clipped in any joint / C-shape
  combination: lib/labelPlace.ts places text inside each event's visible
  shape (own clip minus boxes painted above). Time rules in order: own row
  under the title, inline, nearby pocket (a joint's step), sideways in a
  C-shape's spine, inline after a shortened title, far pocket; dropped only
  when nothing fits (one-row events in ~80px columns). Location, drill note
  and Join take the remaining open spots.
- [x] Layout places a container's whole subtree before anything after it;
  paint order = placement order (explicit z-index), so no earlier box can
  grow over a later title.
- [x] Push-only-when-needed: a second layout pass grants a title+time band
  (pushing enclosed events one row) only to events whose text still lost
  its time, got a shortened title, or had its time stranded.
- Verified: 241 Playwright tests (both themes) incl. textlaw (30 configs),
  realdata TEXT (6 real weeks × 4 views), labelplace geometry/property
  tests; 2x captures of dummy + real weeks reviewed (wide, narrow,
  zoomed-out, scarf, overlay). Re-review with
  `CAPTURE=1 npm run test:e2e -- e2e/capture.spec.ts --project=chromium`.
- [ ] Open question for Joshua: in narrow columns (~80px, 9-day view or a
  900px window) one-row events show title only. Alternatives if that
  bothers you: smaller time font, or a hover-only time.

## Neat text blocks + real-window testing — 2026-10-15 night (committed `7abd0889`)

- [x] One left-aligned block per event (title lines → time → location →
  drill): titles wrap to the lines they need, time on its own row under the
  whole title or after its last word; the second layout pass sizes bands
  for the whole block (≤3 title lines, or as much as the event is tall),
  lifting joints for the lower event. Step pockets removed; spine time is a
  last resort only.
- [x] Probe laws added: same left edge, time row directly under the title,
  title at the event's top; cut titles reported (`SHOW_CUT=1`).
- [x] WebKit fixes found only in the real window: -webkit-box mis-wraps
  text with inline children (whole titles now plain blocks; the star of a
  clamped title sits outside it); ☆ fallback glyph grew lines (pinned
  line-height); slash breaks via zero-width space.
- [x] Real-window testing without touching live data: debug builds honour
  `CAL_SANDBOX=<dir>` (no sync, no keychain token); `e2e/sandbox_app.sh
  start|stop` snapshots the DB read-only and runs the debug app;
  `e2e/realwindow.spec.ts` runs the laws in WKWebView over five views.
- Verified: 247 Playwright tests (both themes) incl. 5 real-window views of
  the live calendar snapshot; screenshots reviewed (week, zoomed, narrow,
  9-day).

## Root-cause pass — 2026-10-16 (branch linux-e2e-root-cause-fixes, merged as `d89a5923`)

Method: `.claude/skills/bug-root-cause/SKILL.md`. Every item was reproduced
before fixing: in the real Linux WebKitGTK window on the HEAD code
(`e66be3e`), then re-run with the same probe on the fix. When committed, move
these to FEATURES.md with the hash.

- [x] **Delete on an annotation deleted its event.** Clicking a margin note
  `preventDefault`s pointerdown (so no focus) and selects the event; Delete
  then hit App's global handler → `bulkRemove(selected)`. Fix: the note takes
  focus and handles Delete/Backspace itself, and clears the selection so a
  second press can't fall through (MarginNotes.tsx, WeekView.tsx).
- [x] **Editor ✕ didn't remove the annotation.** Three causes: (1) EventPanel
  reset every field from the snapshot it opened with whenever `calendars`
  changed identity, which every db-changed does → the erased note came back;
  (2) `google_body` omits `description` when None, so the PATCH left Google's
  note in place and the push response wrote it back locally (location had the
  same bug); (3) two queued edits to one event both carried the pre-edit etag,
  so the second 412'd against our own first and was dropped "remote wins".
  Fix: reset only on a new event; PATCH sends `null` for cleared
  description/location; new atomic `set_event_note` command (read-modify-write
  on the stored description, PATCHes only `description`); panel follows the
  stored note; sync engine rebases queued ops onto the etag our own push
  produced and holds later ops for an event whose earlier op failed.
- [x] **Calendar flashed on every annotation delete.** The note vanished
  (local write) then came back (push echo with Google's untouched copy, see
  above) and the editor re-ran its full reset. Verified on WebKitGTK: deleting
  a note now removes exactly that note; no event chip is torn down.
- [x] **Horizontal scroll laggy/jittery.** The wheel handler dropped the
  offset by a column as soon as it asked for a day shift, before React
  rendered the shifted days → one frame of the old days pulled back a column
  at every boundary (native HEAD: 9 backward jumps in 9.7 days; now 0). Also:
  overscan columns keyed `date-ovs` remounted at each step; MarginNotes
  cleared every note and re-measured the week on each step; the sidebar
  re-rendered every step (inline callbacks). Fix: offset only drops in the
  commit that renders the shift; date-only keys; notes follow their chips and
  re-place once the swipe settles; memoized sidebar.
- [x] **Recurring edits/deletes took ~5 s; the series vanished, then
  respawned.** Series commands were sync Tauri commands, which run on the
  main thread → each Google round trip froze the window. Series changes never
  touched the local store, and "this and following" was two calls (truncate,
  then create) that each kicked a sync, so a pass pulled the old series'
  cancelled tail before the new series existed. Fix: async commands
  (`off_main`), one-step `update_series_master(…, destination)` and
  `split_series`, optimistic local apply (delete tail / move / rename), the
  scope dialog opens at once (master loads behind it), a per-calendar pull
  gate, priority pull of the touched calendars, pulls applied atomically (all
  pages, one transaction; also fixes the 410 resync's empty window), and the
  pushed master's placeholder swapped for its instances in that transaction.
  Also fixed: "All events" copied the edited occurrence's red-pen note onto
  every instance.
- [ ] **Verify against live Google on the Mac**: series edit/split/move and an
  annotation erase with sync on (sandbox has sync off, so the PATCH payloads
  were checked in the queue, not on Google). `e2e/live_series_*.py` cover the
  series paths.
- [x] **Linux visual baselines**: reviewed at original resolution in both
  themes and committed as `2d122b3`; all 12 visual checks pass on Linux.
- [x] **Annotation snapped a column after horizontal scrolling stopped.**
  During the swipe each note followed its chip exactly, but 160 ms after the
  last wheel event the settled worker result replaced surviving notes with a
  newly chosen position (the reproduced jump was 66 px). Settlement now keeps
  each surviving note's event-relative position while using fresh placement
  only for notes entering the viewport (`237f33d`). The mutation-level
  regression and the full 269-test browser suite pass.
- [x] Re-run `npm run test:e2e:app` on macOS (`fd49d3f9`): stop now kills
  the whole app tree (npm alone left it up, and the next run reused it), the
  presence check accepts a cluster row, async scripts go through the hook
  (the WebDriver plugin's execute/async loses its callback while the page
  pans). Seeded (`CAL_SANDBOX_SOURCE_DB=<seed_e2e db>`): every check passes.
- [ ] macOS, default run on a copy of the real calendar: every check passes
  except the swipe check — its script stops reporting back (hook eval 20 s
  timeout) when it runs after the editor/note checks; run alone on the same
  data it passes in 1.2 s (9 days, 0 backward). Suspect leftover state from
  the editor steps (open panel/selection) or note re-placement storms.

### Saved, not merged: another session's uncommitted work (branch `wip/other-session-2026-10-16`, also `git stash list`)

Last edited 2026-10-16 01:59 and sitting uncommitted in the working tree;
saved before the merge. Its own tests, run against the merged code:
- [x] **Drag after a partial horizontal pan lands in the wrong day**: the
  WIP's column math (day-clip width + pan offset) is in `9e9f91a1`, along with
  day switching by sideways travel with slack.
- [x] **All-day COUNT series couldn't do "this and following"** (`bb0113b`).
  Reproduced at App.tsx's `canSplit` guard: the scope option was disabled
  before any service/backend call. It is enabled now; truncation emits the
  date-valued `UNTIL` required for an all-day DTSTART, and the new series
  keeps the remaining `COUNT`. The old mock accepted only UTC date-times and
  now mirrors both RFC 5545 forms. Focused timed/all-day COUNT cases pass.
- [ ] Run the disposable all-day COUNT split against live Google on the Mac;
  the current `e2e/live_series_split.py` probe covers the timed form.
- [ ] **Policy: a local delete vs a concurrent Google edit.** Current behavior
  is 412 → remote wins: a stale local delete refetches/reinstates the remotely
  edited event. Honoring the delete would require fetching the new etag and
  retrying, which could erase a collaborator's change. Asked Joshua to choose
  before changing this conflict policy; same-event local edit-then-delete is
  already rebased and covered separately.

Linux E2E (new): `npm run setup:e2e:linux` once (sudo apt), then
`npm run test:e2e:app` — sandboxed real WebKitGTK window under Xvfb,
`real_window.sh` + `native_regressions.py`. `CAL_E2E_DISPLAY=$DISPLAY` shows
the window on an existing display (e.g. SSH X forwarding) instead.
On this Linux host, GTK3/WebKitGTK 4.1 development packages are still absent
and `sudo -n` requires a password, so native setup cannot finish unattended.

## Ready to build (no decision needed)

- [ ] Stars + reconciliation + classifications sync via Google
  `extendedProperties` so ★/✓/✗ survive devices and reinstalls.
- [ ] Insights plan-adherence stat (% of planned events that happened).
- [ ] Pull a small Ollama model (qwen2.5:0.5b) for fast bulk classification;
  gemma3:12b stays the quality fallback.
- [ ] Per-event color swatches in the context menu (Google `colorId` through
  db + sync + google_body; low prio — user has 0 colorId events).
- [ ] Month view swipe panning (only week/day pan today).

## Blocked on Joshua

- [ ] Cloudflare worker deploy for booking links — needs `wrangler login`.

## Known feature gaps (FEATURES.md)

- [ ] Import/export (ICS), booking-rules in-app panel, E-then-key chords.

## Shipped log (newest first)

- `bb0113b` All-day fixed-count series can edit “this and following” with date-valued `UNTIL`
- `2d122b3` Reviewed Linux visual baselines for both themes
- `237f33d` Margin notes stay rigid after swipe settlement; drag E2E fixtures are host-timezone independent
- `a7242463` Save/Delete no longer go dead after a delete; Delete key deletes the open event
- `b65701d8` Pinch zooms the day count; `996b84d1` note corner scales; `4794edc6` overnight drag previews; `dbb37e81` resizable panes + growing description
- `b69ccc3b` C-shape title moves below events at its top (overnight tails start on the 12 AM line)
- `a0ea5055` Other calendars read-only by default + Copy to my calendar (picker, series), copied originals step aside
- `69537ede` Obsidian link removed (journal bridge, weekly-review view, goals import)
- `56ab03a1` Margin notes: size the box from its edges/corner, A−/A+ writing size
- `4352f531` App icon "Polaris is today" + north-star menu bar glyph
- `9e9f91a1` Drag day switching by sideways travel with slack (no more accidental day hops)
- `d3166cdd` Group drag: all selected events move together with live ghosts
- `dc7bd650` Joints: C-shape steps at its spine; jointed shapes keep the 1px seam
- `d89a5923` Merged linux-e2e-root-cause-fixes (annotations, swipe, recurring edits); `fd49d3f9` in-app E2E on macOS
- `79d8b089` Calendar colors/names changed in Google show without an event change; `44773b99` past at 35%
- `5a441f0d` README media in light mode; `d7cda88c` past at 40%, faded C-shape ring
- `6b0bf1b5` App renamed North Star (identifier unchanged); `c3bb97b1` README media redone
- `502fd205` Drill-sergeant supervisor retired; its notes cleared once at launch (backup kept)
- `04135f78`, `8ef1d0f7` Past events: every ended event faded to 30% of its tint, hue kept
- `7c11c824` README video: one-minute walkthrough (reconcile, annotations, plan a day,
  quick tasks); Review pill keeps the title on one line; larger README shots
- `c63d152b` README images sized to the text, numbering fixed; `814a0239` 10-second video
- `bdd18605` Mock data neutralised; `5f863ac5` personal data kept out of the repo
- `b642605f` README video (side-by-side overlaps, editorial type); `a2da639e` README + media
- `f940f148` Goals live in the app (daily / weekly / long-term), calendar-list styling
- `e1a55b97` Margin notes keep their line pitch in WebKit; laws look through notes
- `31c58084` Pessimistic focus score (deep calendars only, clean time, sleep, late nights)
- `7180685a` Margin notes: free-space placement with arrows, whole, draggable
- `10efe30e` Calendars use Google Calendar's exact displayed colors (Cocoa brown, not pink)
- `975ba43b` Past events keep hue (Notion contrast); editable drill notes
- `827f8ab9` Menu bar item (next event + 12h list); terse focus popover;
  constant-speed goal light

- `95e3b915` Focus-score hover explanation; periodic metallic goal shine (no
  border, bold titles); conservative goal classifier v3; sandbox mirrors
  the everyday app's settings

- `d2e3011f` Goal work: gold ring + travelling shine on the event outline, bold
  title, glyphs removed; scarf occlusion fix; DPR-aware real-window tests

- `d47e56b1` Reconcile semantics: ✕ didn't happen = delete (this occurrence,
  undoable); ⊘ canceled = kept, struck through, out of the score

- `a72e439` Fixed-count recurrence split uses Google instance ordinals and
  valid `UNTIL`/`COUNT` rules; native editor live 1+2 round trip
- `03b55d3` Continuous horizontal pan without idle springback; parsed event
  time cache; recurring whole-series timed/all-day conversion and date shift;
  browser/native/live regression probes and recurring stress runner
- `7abd0889` Neat aligned text blocks (wrapped titles + time, one left edge);
  CAL_SANDBOX real-window testing (sandbox_app.sh, realwindow.spec.ts)

- `2fc384d8` Overlap text placement in visible shapes (step pockets, spine
  time, push-only-when-needed); depth-first layout with z = placement order

- `fcb87dc1` QA handoff doc (e2e/HANDOFF-QA.md)
- `e1b57f7e` Reconcile panel → joined segmented control; confirmed events
  render as plain past events (no ✓); dashed = unvalidated only
- `b0286385` Panel reconcile buttons + "At…" retime; cluster-row reconcile;
  color band fix (Cocoa brown not pink)
- `70277d18` Spotlight lens (G / ★ button); chip hover ✓/✕; rabbet default
- `8ed42e42` Drill-sergeant annotations ([DRILL] in description, red scrawl)
- `41248fb2` Reconciliation stack (unsettled/done/missed, R triage, morning
  sweep, score credits confirmed only, strikethrough missed); orbiting gold
  trace on starred events; accent capsule removed, body tint 55%/60%
- `fa4f9020` Swipe jitter fix (fetch hysteresis, per-day layout/score caches)
- `45c35fed` Cluster rows draggable out of the block
- `9d8bd069` / `e3e0d9af` Local goal classifier (Ollama) + distraction rule
