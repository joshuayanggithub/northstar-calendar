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
- [x] **Annotation placement was running during a continuing horizontal
  gesture.** After a day-boundary shift, `MarginNotes` scheduled its geometry
  scan 160ms later, but later sub-column wheel packets did not reset the timer.
  A 400-event / 20-note E2E reproduced the scan between packets; the scan read
  355 visible chips and took 2.5-2.7ms in Chromium. The wheel listener now restarts
  settlement on every horizontal packet and defers concurrent range/layout
  updates until the stream rests. The regression fails with the reset removed
  and passes with it; all 12 focused pan/gesture E2Es and the production build
  pass. This removes a confirmed source of main-thread interruption; it does
  not prove the full macOS trackpad lag is fixed.
- [x] **Adding Google Meet to a recurring series did nothing for “All events.”**
  The editor kept `with_meet`, but `applyScope` built a manual master patch and
  omitted it. A new two-occurrence E2E failed before the fix and passes after;
  the patch now includes a unique Google `conferenceData.createRequest`, and
  the mock projects the resulting link onto each occurrence. `npm run build`,
  the full browser suite (303 passed / 64 intentional skips), and all 12
  sync-core series tests pass. The unfiltered `npm run test:rust` run has one
  unrelated sandbox failure: OAuth PKCE cannot read OS entropy (`Operation
  not permitted`). The native command forwards the patch through
  `conferenceDataVersion=1`; a live Google round-trip remains unverified.
- [x] **Dense cluster rows were being rebuilt on every horizontal day step.**
  The production probe's fixed `?now=` hid this: live `now()` creates a new
  timestamp on every React render, and `clusterDeps` used that millisecond
  value even though the cached rows' time-sensitive state only needs the
  existing 30-second clock tick. With a live clock and 400 overlapping events,
  pan rebuilt the cluster subtree 77 times (12.8ms measured in the render
  stage); under 4x CPU throttle it took 30.4ms and React commits reached 29ms.
  The cache now depends on the 30-second tick. A live-clock regression asserts
  one day step rebuilds at most two cluster groups; it passes. Matched profiles
  now rebuild 17 groups / 1.5ms unthrottled and 17 / 4.1ms at 4x; the sampled
  4x run's >25ms frame gaps fell from four (max 50ms) to two (max 33.4ms).
  This is a confirmed density-sensitive render cost and its local fix, not a
  claim that the user's physical Mac lag is fully resolved.
- [x] **Exposing a day rescanned the entire fetched event history.** A live
  4,000-event fixture (1,014 events in the active fetch window) spent 11.3ms
  across 17 `day-items` cache misses before the fix. `WeekView` now indexes
  timed-event pieces by local day when the event snapshot changes; cross-midnight
  rendering/editing regressions still pass. After the fix the measured day-item
  stage is below 0.1ms total at both 400 and 4,000 fixture events.
- [x] **MarginNotes rebuilt its note map on every WeekView render.** Its render
  walked every fetched timed event and re-parsed descriptions on every pan-day
  commit. The note map/signature now memoize against the event snapshot; the
  4,000-event pan test records one build when its fetch snapshot changes, not
  once per exposed day.
- [x] **Out-of-order range loads could replace the current week's events.** A
  deterministic test deferred two `listEvents` calls, resolved the newer range
  first (showing a Nov 12 event), then resolved the stale range and reproduced
  the event disappearing. `useEvents` now ignores superseded requests, including
  older `db-changed` refreshes; the red/green navigation regression passes. The
  full browser suite then passed 308/372 (64 intentional skips).
- [ ] Resolve remaining pan uncertainty in the actual macOS Tauri/WKWebView
  window with a physical trackpad. This host is Linux, so the user's reported
  macOS input/presentation path remains unverified; Joshua confirms the lag is
  on the macOS app with a trackpad and that it is worse with many events. One production-preview
  Chromium wheel-input trace (400 events,
  720px) measured p95/max 16.8ms, no >25ms RAF gaps, wheel dispatch <=0.2ms,
  strip transform-write JavaScript <=1ms, and WeekView commits 2.1-7.1ms. Input-window compositor
  DrawAndSwap spans reached ~20ms on Chromium's software renderer. This neither
  reproduces the 33ms idle-frame outlier nor identifies the user's real
  trackpad/WebKit bottleneck; do not claim the remaining lag is fixed. A first
  follow-up accidentally profiled Vite dev and measured a 25.7ms React commit;
  the diagnostic now explicitly skips dev builds so that result is not treated
  as production evidence. After the lead-in buffer fix, a fresh synthetic
  production trace measured p50/p95/max 16.7/16.7/16.8ms with no >25ms gaps;
  its browser-delivered counterpart measured p95 16.8ms and one 33.3ms gap at
  ~1249ms, during which there was no wheel event or WeekView commit. Dispatch
  stayed <=0.4ms, transform-write JavaScript <=0.2ms, React commits 2-7ms; the latter gap remains
  outside app JS work and still needs physical-device/macOS WebKit evidence.
  Five more isolated production runs on 2026-10-17 found one 33.3ms gap in
  five synthetic wheel profiles (three wheel packets landed in it; handler
  <=0.2ms, no JS long task), while all five browser-delivered wheel traces had
  p95/max 16.7-16.8ms and no >25ms gap (wheel-to-transform p95 <=0.4ms, max
  <=0.9ms; WeekView commits 2.0-8.2ms). These are headless Chromium/CDP,
  not physical trackpad or native WebKit evidence.
- [ ] **Continue dense-pan root-cause work (2026-10-18):** an experimental
  shared horizontal scroll surface is now in the working tree. It removes the
  three per-frame strip transforms, but its wheel listener still calls
  `preventDefault()` and writes `scrollLeft`; it is not yet proven to improve
  macOS/WKWebView. The first test pass caught a real regression introduced by
  making `.weekview` horizontally scrollable: ambiguous/vertical-dominant
  wheel packets with a small `deltaX` fell through and moved `scrollLeft`
  outside the pan accumulator. `WeekView` now cancels only those mixed packets
  and forwards their `deltaY` to vertical scroll; the regression checks both
  no sideways jump and preserved vertical movement. Build and all 16 focused
  gesture E2Es pass; five pan/cache E2Es pass.
  Production Chromium with 2,160 fixture events (240/day) delivered 60×12px
  browser wheel inputs with p95 RAF 16.8ms, max wheel dispatch 0.5ms, wheel-to-
  scroll p95 0.6ms, and 719.7px measured movement. A test-only native-default
  wheel path kept the same RAF budget but delayed `scroll` events to 30.2ms p95
  and moved only 668.7px; do not replace the current accumulator with raw
  default scrolling.
  Production WebKitGTK/Xvfb on this Linux host showed density-sensitive frame
  gaps: one event/day p95 15ms vs 2,640 rendered cluster rows at 240/day p95
  31-32ms for a continuous 2px pan with zero React commits. The old
  transform-based control was p95 33ms, so neither movement mechanism fixes
  this WebKitGTK/Xvfb trace. Hiding title glyphs improved p95 only to 28ms;
  `content-visibility:auto` on cluster rows worsened it to 56ms. `will-change:
  scroll-position` had no measurable effect. Day-boundary stress reached p95
  59ms / max 62ms; handler <=1ms and React commit max 12ms. This points to
  dense rendering/presentation cost outside the wheel callback/React commit,
  but the exact paint/compositor stage and the user's Mac remain unverified.
  Next: keep all event rows visible; run repeated matched production profiles
  with stable idle controls; do not claim fixed until physical Mac Web Inspector
  evidence or a robust cross-engine improvement exists. `e2e/webkit_pan_probe.py`
  supports `CAL_PAN_TRANSFORM_CONTROL=1` for matched path comparisons; its
  synthetic wheels are not native trackpad input.
  Follow-up on 2026-10-17:
  - A profiling fixture bug was masking density: `CAL_PAN_EVENTS_PER_DAY=240`
    still defaulted to 400 total events, covering only two days. The browser
    diagnostic now defaults to 21 days × the selected density, asserts all 13
    visible/runway columns remain populated, and allows an explicit
    `CAL_PAN_EVENT_COUNT` override. `TESTING.md` now documents this.
  - With that full fixture (5,040 events, 3,120 rendered cluster rows), three
    production Chromium runs of 60 × 12px packets each retained all 720px.
    RAF p95 stayed 16.8ms, max 33.3–33.4ms (2–3 isolated >25ms gaps/run).
    Gaps had no wheel packet; two or three overlapped short 4–5ms React
    commits, another had none. Wheel dispatch stayed <=0.5ms. Scroll-event
    delivery was ~29–31ms p95, but the first RAF reading the changed
    `scrollLeft` was ~16.3–16.5ms p95; do not equate event delivery with visual
    lag. A CDP trace measured renderer `DrawFrame` p95/max 14.45/14.63ms and
    `DrawAndSwap` 14.70/14.87ms in the headless software renderer.
  - **Verified paint root cause in the WebKitGTK probe (2026-10-17):** the
    profiler now records the initial/final horizontal offset and has
    `CAL_PAN_REQUIRE_MOTION=1` to fail closed when packets do not move the
    calendar. On a deterministic 120px pan with no date shift or React commit,
    3,120 visible/runway `.cluster-row` buttons produced 33–34ms RAF p95; with
    the exact same DOM mounted but `.day-cols` paint suppressed as a
    diagnostic, p95 was 11–12ms. At 585 and 1,560 rows, the corresponding
    full/paint-suppressed p95s were 27/11ms and 31/12ms. Trusted GDK events
    also now pass the movement guard (DOM `deltaX=2`, `isTrusted=true`): three
    dense runs measured p95 33–34ms, <1ms wheel dispatch, zero React commits,
    and 41–85px displacement during the input window (120px after settling);
    one same-stream paint-suppressed control moved 120px and measured p95
    16ms. So the dense event body is a real WebKitGTK paint cost, not just a
    missing-input or React-handler artifact. The content ablation at 240/day
    measured p95 34ms baseline, 29ms with titles hidden, 17ms with row buttons
    hidden, 13ms with cluster blocks hidden; rows remained mounted in every
    profile. These are diagnostic-only visual suppression controls; no event
    rows were hidden in production.
  - Whole-surface promotion (`will-change:transform`, `translateZ(0)`, and
    `will-change:scroll-position` on `.day-clip`/`.weekview`) stayed at 32–34ms
    p95 with verified 120px movement. Environment correction: this host does
    have `/dev/dri` (NVIDIA RTX 3090), but the Python probe uses WebKitGTK 4.0,
    whose effective hardware acceleration policy is `NEVER`; explicitly
    requesting `ALWAYS` still reads back `NEVER`, and no WebKit GPU process was
    observed. The prior “no `/dev/dri`” explanation was wrong. Headed Chromium
    did use a GPU process and stayed at 16.7–16.8ms p95 at DPR 1 and 2, with or
    without body paint suppression. This confirms a renderer-specific
    difference, not that the app has no accelerated renderer available on this
    host. The probe does not characterize the Tauri app's WebKitGTK 4.1 runtime.
    Dense row text/buttons are expensive to repaint in the WebKitGTK probe;
    there is still no Mac WKWebView layer/timeline evidence, so do not claim
    this Linux renderer cost is the Mac root cause or ship a speculative layer
    hint. `CAL_PAN_REQUIRE_MOTION=1` successfully rejected a zero-delta run.
    The opt-in Chromium full/paint-suppressed diagnostics pass, as do
    `npm run build` and `git diff --check`.
    A longer annotation-seeded capture still had `notesPending=1` and zero
    rendered note nodes after an approximately 912ms worker pass; the new
    `CAL_PAN_REQUIRE_NOTES=1` guard rejected it. Do not attribute or rule out
    note-overlay paint cost from that invalid sample.
  - The Playwright full-coverage assertion caught a fixture boundary error:
    its 21-day fixture began on the focused date and left a previous runway
    day empty. The diagnostic now seeds from one day earlier; production
    Chromium verified all 3,120 rows, moved 119.7px, and passed both the normal
    and paint-suppressed runs. Its `CAL_PAN_STYLE` override is diagnostic only.
  - Current production WebKitGTK/Xvfb independently shows a continuous-pan
    frame gap at 240/day: 3,120 rows, 60 × 2px packets without a day crossing,
    p50/p95/max 23/33/33ms, no React commit, and <=1ms wheel dispatch. This
    reproduces a dense WebKitGTK rendering/presentation problem in the
    WebKitGTK 4.0 probe, whose effective acceleration policy reads `NEVER`; it
    is not proof of the Linux Tauri 4.1 or Mac WKWebView cause.
    An annotation-seeded run found 252 marker records and 108 visible note
    specs; the worker was still pending and zero note DOM nodes were present
    at capture, so it is not a valid note-overlay paint comparison yet.
  - Trusted GDK smooth-wheel control: at 3,120 rows, 60 × 2px horizontal
    packets with `deltaY=0` reached 120px after settling, called `preventDefault`
    zero times, and measured p95 33ms. Matched 2px X + 0.366px Y packets called
    `preventDefault` 60/60 times (the current `e.deltaY === 0` gate rejects
    native scrolling) and measured p95 33ms, with no React commits and <=1ms
    dispatch. This proves that tiny vertical noise selects the synchronous
    custom-scroll path, but not that it causes the user's Mac lag: this
    WebKitGTK configuration showed no p95 improvement for the native path.
    Changing the gate also changes vertical-scroll behavior, so no production
    change is justified until the physical Mac event stream is captured.
  - Re-ran `npm run test:e2e:app` in a disposable sandbox with loopback access.
    Tauri starts the Cargo build but exits before creating a window: `gdk-3.0`,
    Cairo, and Pango pkg-config development files are absent, and
    `webkit2gtk-4.1.pc`/runtime are absent. `sudo -n -v` confirms this user
    cannot install the documented prerequisites non-interactively. The first
    sandboxed attempt failed earlier at Vite's loopback bind and was not an app
    test. No direct in-app Tauri E2E result is available on this host yet.
  - Additional 2026-10-18 controls: in headed GPU-backed Chromium with 3,120
    rows, changing the listener to passive did not change RAF p95 (16.8ms);
    adding `will-change:transform` per day column also left p95 at 16.8ms and
    produced a 50ms maximum, so neither is a supported fix. A 0.5px vertical
    component made all 60 trusted wheel packets default-prevented, while pure
    horizontal packets were not; both still measured 16.8ms p95. However,
    Playwright's `page.mouse.wheel` DOM events arrived at p50 100ms / p95
    150ms despite 12ms waits, so these headed browser traces are not continuous
    trackpad-cadence evidence. Use the 12ms GDK stream for cadence checks, and
    do not interpret its browser-input-to-frame metric as physical input lag.
  - **Fixed a separate small pan drift at fractional day rebases.** The initial
    720px profile formula assumed the starting scroll offset was exactly two
    day widths; using the actual starting offset and rendered day width showed
    a 1.97px overshoot after six shifts, and the stricter (<1px) regression
    failed before the fix. `onScroll` had rebuilt `pan.acc` from integer-
    quantized `scrollLeft` after every rebase, repeatedly discarding the
    fractional remainder. It now accumulates observed scroll deltas, tracks the
    last programmatic offset, and carries the residual through window and width
    changes. The default smoke E2E was red with the old logic (1.97px error)
    and green with the fix (0.03px); a reverse 720px swipe returns within 1px.
    The production-preview profile also passes at DPR 1 and DPR 2, and the
    diagonal custom-wheel path passes. The earlier
    attempted “normalize acc from actual scrollLeft” line measured the same
    result before and after and was removed. This corrects small positional
    drift only; it does not fix dense-frame lag.
  - Repeated trusted-GDK WebKitGTK 4.0 profiles on 2026-10-18: at 585 visible
    rows (45/day), 120px input, no day-window shift, no React commits, and
    <=1ms wheel dispatch, RAF p95 was 27ms (max 38ms); at 1,170 rows
    (90/day), p50/p95/max was 29/31/36ms. At 3,120 rows the
    matched profile remained 33ms p95; `contain:paint` on each cluster block
    stayed at 33ms and promoting each block with `translateZ(0)`/`will-change`
    measured 34ms. For pure horizontal packets, making the listener passive
    also stayed at 33ms; removing `.day-col`'s stacking context measured
    33ms in one run, within the 33–34ms baseline variation. These diagnostic
    styles did not reduce the density-linked frame cost. The probe renderer still reports effective
    acceleration `never`; these are not Tauri 4.1 or macOS WKWebView results.
    After the logical-offset fix, the production build again moved a verified
    120px with 3,120 rows and no React commit; frame p50/p95/max was 33/34/34ms,
    confirming the small drift fix does not resolve the continuous paint hitch.
  - Repeated the no-boundary trusted-GDK profile against the current production
    preview at DPR 1: 585 rows (45/day) measured RAF p95/max 27/40ms; 3,120
    rows (240/day) measured 34/34ms and 33/33ms across two runs. Intermediate
    densities measured 31/36ms at 1,170 rows (90/day) and 32/35ms at 1,560
    rows (120/day). Every run moved the expected 120px over 60 packets, had
    zero React commits, and kept wheel dispatch at or below 1ms.
    With the 3,120-row dense fixture, adding 0.366px vertical noise caused all
    60 wheel events to call/apply `preventDefault` (custom path) but left RAF
    p95/max at 34/35ms, versus 34/34ms for pure horizontal input (native path).
    The probe's post-handler observer now runs at window bubble, and confirms
    `defaultPrevented` on the same 60 events counted by the wrapper.
    This confirms a modest density-linked presentation cost and excludes the
    native/custom path switch as the cause of the measured Linux frame gap.
    Effective WebKitGTK acceleration remains `never`; this still cannot
    determine whether Mac WKWebView hitches have the same renderer mechanism.
    A matched DPR-2 repeat with no annotations measured p50/p95 55/66ms at
    585 rows and 72/77ms at 3,120 rows. Both had zero React commits, <=1ms
    wheel dispatch, <=7ms wheel-to-scroll latency, and settled at 120px. This
    Additional repeats measured sparse p95 67ms and dense p95 74ms, putting
    the matched no-annotation density gap at 7–11ms across runs. The set
    separates a substantial moving-body repaint cost from the added density
    cost in this software renderer, but cannot be projected onto accelerated
    Mac WKWebView without the requested physical-device timeline.
    At DPR 2, intermediate profiles measured 69ms p95 with 1,170 rows and
    72ms with 1,560 rows, consistent with the gradual density trend. DOM wheel
    interval p95 was 67ms and 69ms respectively, reinforcing that these GTK
    timers are delayed/bunched by the same main-loop pressure.
    A further 3,120-row cross-axis run confirmed 60/60 packets were cancelled
    through the custom path; RAF p50/p95 was 61/75ms and DOM interval p50/p95
    was 1/66ms, versus 74/76ms and 1/72ms on the native path. The path change
    did not materially remove either frame gaps or timer bunching.
    A one-event/day DPR-2 control had no cluster rows (13 ordinary chips) yet
    still measured 42/45ms p50/p95, confirming the software-rendered moving
    body has a high baseline. At 3,120 rows, cross-axis noise selected the
    custom path but measured 66/76ms p50/p95 versus 72/77ms for the native
    path; both remained far outside the frame budget, so the input-path choice
    is not the material cause in this renderer.
    Added DOM wheel-interval metrics to the probe: on the same 12ms-scheduled
    GDK stream, sparse input arrived in bursts (interval p50 0ms, p95/max
    61/62ms) alongside 63ms RAF p95; dense input had interval p50 1ms,
    p95/max 72/72ms alongside 76ms RAF p95. The probe schedules 60 GTK
    timeouts on the same main loop, so overdue callbacks can bunch up; this
    indicates main-loop stalls consistent with the separately observed paints,
    not physical-device input cadence or a Mac diagnosis.
    A same-host Chromium production-bundle control at DPR 2 and 3,120 rows
    again measured 16.8ms p95/max and no >25ms frame; handler dispatch was
    <=0.5ms, but browser wheel intervals were 100–150ms rather than trackpad
    cadence. Thus renderer behavior differs sharply here, while this control
    still does not substitute for the physical Mac gesture.
    A diagnostic-only `.cluster-row{visibility:hidden}` ablation at DPR 2 kept
    all 3,120 row nodes in the DOM but removed their visible paint: p50/p95
    fell from 72/77ms to 48/49ms, with zero React commits and <=1ms handler
    dispatch. This estimates a substantial event-row paint contribution in
    software WebKitGTK, but the remaining 49ms cost shows body movement/paint
    is also expensive. It is not a product fix (rows must remain visible) and
    does not prove the accelerated Mac renderer has the same bottleneck.
    With the new packet metric, a repeated hidden-row run measured 49/52ms RAF
    p50/p95 and DOM packet interval p50/p95 1/49ms; the matched visible-row
    run was 74/76ms RAF and 1/72ms packet interval. This is consistent with
    row paint contributing to GTK main-loop congestion, while substantial
    body-level stalls remain even in the ablation.
    This continuation's focused pan E2E set passed 3/3 (day-step distance,
    fractional rebase, and mixed-axis retention); the full browser suite passed
    331 tests with 64 intentional skips; the opt-in production Chromium profile
    passed at DPR 2. `npm run build`, `python3 -m py_compile
    e2e/webkit_pan_probe.py`, and `git diff --check` pass (Vite reports the
    existing 535.95 kB main-chunk warning). No production scrolling behavior
    was changed in this continuation because the Mac cause is not established
    by the available renderers.
  - Fixed a timing bug in the WebKit probe: `CAL_PAN_REPORT_DELAY_MS` delayed
    Python's read but the page had already frozen all metrics at a hard-coded
    2s, so prior annotation readiness checks inspected stale state. The page
    now captures at the configured delay and Python reads it 100ms later. With
    `CAL_PAN_REQUIRE_NOTES=1`, a capture is rejected unless notes are laid out
    at the end. A later stricter check found this still did not prove notes
    existed during input: `CAL_PAN_START_DELAY_MS` was ignored by trusted GDK
    input, which always began 500ms after instrumentation. The probe now has
    separate `CAL_PAN_SETUP_DELAY_MS` and `CAL_PAN_START_DELAY_MS` controls,
    samples note count/pending state on each wheel packet, and
    `CAL_PAN_REQUIRE_NOTES_DURING_PAN=1` fails unless notes exist at start and
    throughout the gesture. Matched 3,120-row/60-packet runs now confirm 108
    visible notes for all 60 packets: default multi-shadow notes measured
    p95 55–56ms (two runs); no-note controls measured 33–34ms; removing note
    text shadows measured 33ms; a single 3px halo measured 46ms; removing only
    the SVG leader filter did not help (56ms), and row `content-visibility:auto`
    / per-row `contain:paint` worsened the result (53/51ms). Every run had zero
    React commits and <=1ms wheel dispatch. This implicates repeated note-text shadow painting as an
    additional cost in this software-rendered WebKitGTK 4.0 setup, on top of
    dense event-body paint; it does not establish the Mac root cause. No
    production style change is justified from this renderer alone. The probe
    reports effective hardware acceleration `never`; native Tauri 4.1 and
    macOS WKWebView/trackpad evidence remain outstanding. `python3 -m py_compile
    e2e/webkit_pan_probe.py` passes. The full Chromium browser suite passes
    331/395 (64 intentional skips, zero failures), including gesture,
    annotation-worker, and recurrence regressions; the focused fractional
    pan-drift test passes 1/1. `npm run build` and `git diff --check` pass.
  - Pinch zoom also had a confirmed adjacent regression: the enlarged runway
    made the first rendered header edge differ by 0.28 CSS px because browser
    `scrollLeft` is integer-quantized, so `floor(frac * newDayCount)` could
    move Wednesday just across a day boundary. `App` now measures the pinch
    fraction from the stable unscrolled header origin (`pan-clip.left +
    scrollLeft`); both Chromium and WebKit gesture regressions pass.
  - Reviewed dark/light screenshots and refreshed only the four Linux
    week/long-slab baselines for the resulting ~1px track-width changes. The
    full browser suite then passed 330 tests with 64 intentional skips; the
    focused scroll/pinch suite passed 19/19. `npm run build` passed before
    test-only profiler edits. The physical Mac trackpad issue remains open.
- [ ] **Horizontal pan: remove avoidable main-thread wheel blocking; verify Mac result.**
  A new density-linked root cause is now fixed in the shared week renderer:
  cluster blocks previously mounted all their event buttons, including rows
  far outside the vertical viewport. A native dense fixture measured 2,645
  mounted rows but only 296 intersecting the viewport; the WebKitGTK swipe
  reached 114ms RAF p95 with 9 frames over 50ms. Cluster blocks now keep
  their full height and row order but mount buttons only near the vertical
  viewport, updating as the user scrolls vertically. The same 240/day native
  regression now mounted 636 rows and reached 34ms and 32ms RAF p95 in two
  clean runs, with 0 frames over 50ms and 0 backward pan samples each time.
  The 120/day control reached 35ms p95 (previously 70ms); 45/day reached
  31ms (previously 46ms). Removing day-column CSS isolation in a diagnostic
  run yielded 35ms p95 at 240/day, so it was not adopted. The annotation/editor
  native checks passed, and the clean browser suite passed 333 tests with 64
  intentional skips. This is a concrete Linux app improvement, not yet a
  physical Mac measurement.
  Root-cause tracing found two always-cancelable listeners on the normal path:
  the app-shell pinch observer on `.main` and WeekView's custom wheel handler.
  The shell observer is now passive except while Control is held. Clear trusted,
  low-amplitude pure-X input switches WeekView to the browser's native scroller
  and a passive listener for the remainder of that gesture; the custom axis-lock
  logic remains for ambiguous, vertical, and large-delta input. A regression
  checks listener options, trusted/unprevented horizontal input, vertical
  scrolling, and Control-wheel cancellation. Full browser E2E passed 332 tests
  with 64 intentional skips; `npm run build`, `git diff --check`, and Python
  probe compilation passed. The 3,120-row Linux WebKitGTK 4.0 trusted-input
  probe still measured about 22/33/34ms RAF p50/p95/max, with zero React
  commits and <=1ms wheel dispatch; acceleration reads `never`. Thus the input
  path is fixed where it was needlessly synchronous, but the dense paint hitch
  remains in that renderer and the user's Mac lag is not yet verified fixed.
  Linux native in-app E2E is now available after installing GTK3/WebKitGTK 4.1.
  The sparse `npm run test:e2e:app` passed the real-window, annotation, and swipe
  checks (9 day widths, 0 backward samples, RAF p95 18ms, 0 frames >50ms,
  wheel dispatch p95/max 1ms; no cluster rows were visible).
  Added opt-in `CAL_E2E_DENSE_EVENTS_PER_DAY=240` seeding (5,040 events across
  21 days) and made native smoke selectors accept clustered event rows. The
  full dense app E2E now passes, including annotation deletion without flash or
  event removal. With 2,405 visible cluster rows, the swipe crossed 9 day
  widths with 0 backward samples, but RAF p95 was 114ms (9 frames >50ms);
  synchronous dispatch was only 2ms p95/max. That reproduces a severe dense
  presentation stall in the actual Linux Tauri/WebKitGTK 4.1 app, downstream of
  the wheel callback. Intermediate native runs show the monotonic density
  relationship: 455 rows → 46ms RAF p95, 1,205 → 70ms, and 2,405 → 114ms;
  dispatch stayed 1–2ms and all three runs had 0 backward samples. A diagnostic
  `visibility:hidden` row-paint ablation kept
  all 2,640 rows mounted and improved p95 only 101ms→86ms (10→9 frames >50ms),
  so row text contributes but does not explain most of the stall. XTest button-6
  input produces trusted but discrete `deltaX=-86px` events, which the current
  64px amplitude guard routes through the custom path; the native
  passive path still lacks low-amplitude trusted GTK input coverage. All these
  pan profiles use Xvfb/synthetic input and do not establish physical Mac
  behavior. Continue profiling the native input path and obtain the Mac Web
  Inspector capture in `e2e/MAC-PAN-PROFILE.md` before claiming the lag is fixed.
- [x] Reproduced event-editor Undo losing guest/busy-free/visibility/reminder
  metadata: the undo snapshot contained only title, time, description, and
  location; additionally, native Option<i64> collapsed explicit Default
  reminder (null) with an omitted field, so Google PATCH left the old override
  in place. Undo snapshots now carry full attendee resources (including RSVP
  state) and reminder resources (including multiple overrides); the mock keeps
  omitted fields unchanged; Tauri distinguishes omitted, explicit default, and
  a numeric override, and sends default visibility explicitly. The focused
  browser tests failed before these changes and pass now (2/2), including a
  two-reminder + accepted-RSVP round trip. A native Rust regression is added but
  cannot run on this host because GTK3/Pango/Cairo development packages are
  missing; re-run it in a native build environment.
- [x] **Undo left newly added guests behind when the original event had none.**
  Reproduced with an event whose Google resource omitted `attendees`: Undo
  stored `None`, which intentionally means “do not PATCH attendees,” so the
  just-added guest remained. Undo now represents the prior empty state as an
  explicit empty attendee-resource array. The focused regression failed before
  the fix and both the empty-list case and full RSVP/reminder metadata case pass
  afterward (2/2); `npm run build` passes. The Rust request-body assertion also
  checks PATCH emits `attendees: []`, but execution remains blocked by missing
  Linux GTK/Pango/Cairo development files.
- [x] Fixed a mock-only RSVP state regression exposed during the broad audit:
  time-only group moves omit attendees in the native PATCH, but the mock
  converted existing attendee objects to email strings and back to
  needsAction. The mock now preserves unchanged attendee resources; the group
  drag regression asserts an accepted guest remains accepted.
- [x] Reproduced partial backend failures in grouped event operations. `Promise.all`
  in group move and multi-delete rejected before undo/toast registration after
  a sibling event had already changed; sequential bulk duplicate had the same
  lost-recovery path. Each now records successful items only, reports partial
  counts, and leaves failures selected/unchanged where applicable. Three
  failure-injection E2Es failed before the fix and pass after; the full browser
  suite passes (307 passed, 64 intentional skips).
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
  `cargo test -p sync-core -- --skip pkce_challenge_is_s256_of_verifier`
  passes all 24 series/sync tests (12 unit + 12 integration), including
  occurrence swapping and queued edit/delete ordering. The unfiltered
  `npm run test:rust` has one environment-limited failure: the OAuth PKCE test
  cannot bind its loopback `TcpListener` (`PermissionDenied: Operation not
  permitted`) in this sandbox; the other 24 tests pass. This is a test-host
  permission limit, not a calendar regression.
- [ ] Pan follow-up: reproduce the user's residual lag through physical
  trackpad delivery and Linux WebKitGTK. Existing 18 production-Chromium
  profiles (12 synthetic + 6 browser-delivered; 400 events / 720px) measured
  p95 16.7–16.8ms; 8/18 had one 33.2–33.4ms gap, usually with no wheel event
  or WeekView commit. New input-window CDP trace against the production bundle
  passed twice: p95/max 16.7–16.8ms, no >25ms RAF gaps, dispatch <=0.3ms,
  transform-write JavaScript <=0.2ms, React commit <=7.2ms, and measured JSX stage work
  <=1.4ms total. Chromium's software renderer showed ~20–22ms DrawAndSwap
  spans, but those did not cause a missed RAF frame in these samples. An
  initial Vite-dev run showed a 25.7ms commit and is excluded; the opt-in probe
  now skips dev builds and summarizes its stage timings.
  **Three wheel-intent cases are now reproduced and fixed in the app:** the
  wheel handler chose an axis independently for every packet. A horizontal
  start followed by 29 packets at `deltaX=4, deltaY=5` moved only 4 of the
  requested 120 pixels (red regression). The handler now locks to horizontal
  after the first horizontally dominant sample until 180 ms idle. Further
  tracing found the undecided lead-in also discarded X from a Y-dominant first
  packet; a red browser regression lost exactly 8px before lock. The handler
  now buffers candidate X so that a prompt lead-in is replayed. A third red
  regression found sustained diagonal vertical noise (20 packets at dx=4/dy=5)
  accumulated 80 stale pixels; the next 12px horizontal gesture moved 92px.
  Candidate replay is now limited to the first 100ms of axis intent and remains
  discarded until the existing 180ms idle reset. All seven focused gesture tests pass, including
  leading-delta retention, idle expiry, pure vertical scrolling, and alignment;
  `npm run build` passes. Two production-bundle profiles after this change
  measured synthetic p95/max 16.7/16.8ms with no >25ms gaps, and
  browser-delivered p95 16.8ms / max 33.3ms with one gap at 1249ms containing
  zero wheel events and zero WeekView commits. Dispatch peaked at 0.4ms,
  transform-write JavaScript at 0.2ms, React commits at 2–7ms; no long tasks or
  long frames. This supports
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
- [x] Traced the remaining dense-pan boundary hitch to fetch-snapshot churn.
  When the padded range moved, `useEvents` returned new event objects and
  `WeekView` cleared every day's pack/chip caches even for unchanged dates.
  The 1,149-event index build took 7.2ms unthrottled / 16.8ms at 4x; the
  refresh rebuilt 17 day layouts before the fix. Unchanged event snapshots now
  retain object identity, and layout caches invalidate per date only when its
  event list/content changes. The new 4,000-event, eight-day boundary
  regression passes (≤10 day-layout rebuilds; production profile observed 6,
  down from 17). A boundary App commit fell from 24ms to 13.2ms unthrottled
  and from 53.1ms to 35.2ms at 4x.
- [x] Further reduced timed-index work at the range boundary: iterating local
  day keys directly instead of repeatedly normalizing with `startOfDay` /
  `isSameDay` cut the 1,170-event index from 17.1ms to 7.5–7.6ms at 4x CPU
  and from 3.9ms to 2.7ms at normal speed. The first full run caught an
  introduced exact-midnight end regression (the prior date incorrectly got
  `endMin=1`); the index now keeps that day at 1,440 minutes. A dedicated
  10 PM–midnight height test and both previously failing narrow text-law cases
  pass. A React-transition scheduling experiment did not reduce the measured
  boundary hitch and was removed.
- [ ] Pan is improved but not declared fixed. The corrected 4,000-event
  production fixture now encodes its intended 8 AM New York event time across
  DST. Normal-speed synthetic profile: p50/p95/max 16.7ms, no >25ms frame;
  browser-delivered wheel profile p95/max 16.7/16.8ms, no >25ms frame, and
  wheel-to-transform latency 0.4–0.7ms. Two synthetic 4x timed runs still
  record 8–10 frames over 25ms (p95 33.4–50ms, max 50–83.3ms); App commits
  reach 28.5ms while index work is 7.5–7.6ms. All-day 4x p95 was 16.8ms with
  two >25ms gaps and a 7.7ms index. Some timed frame gaps had no app commit.
  These Chromium results do not reproduce native macOS trackpad/WKWebView
  delivery or Linux WebKitGTK; keep the issue open and validate on the affected
  Mac before claiming lag is resolved.
- [ ] **Dense event-list rendering remains the pan bottleneck at extreme
  density.** Corrected the fixture to control events/day (the 8k/16k total
  event comparison alone had not increased viewport density). At 90/day,
  normal browser-delivered p95/max remained 16.8ms with no >25ms gaps. At
  120/day, the 9 visible + 2 overscan columns produce 1,320 `.cluster-row`
-  buttons. After the clock-cache fix below, five production browser-input
  runs measured p95 16.7–16.8ms, max 33.4ms, and 1–6 33ms gaps. In every run,
  all >25ms gaps occurred with no wheel event or WeekView commit; wheel-to-
  transform p95 was 0.3–0.4ms, max 0.4–0.5ms, transform writes <=0.3ms, and
  WeekView commits were 3.2–7.8ms. The Chromium trace attributes a prior long
  draw path to `SoftwareRenderer::DrawFrame`/`DrawAndSwap` (~22.7ms), so this
  host's headless software compositor is a material confounder; it does not
  establish the Mac WKWebView root cause. Hiding cluster rows removed dense
  stress misses in earlier experiments; `content-visibility:auto` and
  row/day paint containment did not. A `.day-col { will-change: transform }`
  compositor experiment was mixed (3/5 runs passed); adding the same hint to
  cluster blocks failed 5/5. No compositor CSS change is justified. User
  explicitly requires every event row to stay visible; do not collapse,
  virtualize, or hide rows. Physical macOS trackpad/WKWebView remains
  unverified. A paired browser-input control at 45/day (495 events) measured
  p95/max 16.7/16.8ms, no >25ms gaps, and a 2.6ms largest WeekView commit;
  the 120/day run (1,320 events) measured p95/max 16.8/33.3ms, two >25ms RAF
  gaps, and a 6.4ms largest WeekView commit. Its wheel-to-transform latency
  remained <=0.8ms; the two slow RAF gaps contained no wheel packet or app
  commit. CDP saw software-renderer DrawAndSwap up to 25.9ms. This confirms a
  density correlation in the Linux headless compositor, not the Mac/WebKit
  cause. Also corrected the diagnostic's `panPaint` label: it timed synchronous
  CSS transform property writes, not actual paint/presentation. The metric is
  now named transform-write duration; compositor timing comes from browser
  tracing. A final 120/day production-input repeat after the last code changes
  still showed p50/p95 16.7ms and max 33.3ms (three >25ms RAF gaps); all three
  gaps had no wheel packet or WeekView commit. Wheel dispatch peaked at 0.3ms,
  wheel-to-transform at 0.6ms, transform-write JavaScript at 0.3ms, and the
  largest WeekView commit was 5ms. This leaves the density-related presentation
  stalls unexplained outside this Linux headless compositor. User follow-up
  (macOS app + trackpad): the remaining lag spikes occur continuously, not just
  at day-boundary shifts, and are much worse with many visible events. This
  keeps continuous presentation/compositor stalls in scope; it does not match a
  day-boundary-only React update hypothesis. A new production Chromium stress
  trace at 240 overlapping events/day (2,640 fixture events, all rows still
  rendered) measured p50/p95 RAF gaps 16.7ms, max 50ms, and three >25ms gaps.
  Those gaps again had no wheel packet or WeekView commit; wheel dispatch max
  0.5ms, wheel-to-transform max 0.6ms, transform-write max 0.3ms, and largest
  WeekView commit 4.9ms. The same trace recorded ProxyMain::BeginMainFrame up
  to 30.2ms and DrawAndSwap around 21.1ms. This strengthens a density-scaled
  browser rendering/compositor hypothesis on Linux, but does not identify the
  macOS WKWebView cause. A separate production-bundle probe in installed
  WebKitGTK 4.0/Xvfb now reproduces density scaling with 9 visible days plus
  2 overscan days: at 240 overlapping events/day (2,640 rendered row buttons),
  60 synthetic 12px wheel packets gave p95 RAF gaps of 60–63ms, versus
  28–34ms at 45/day. A 2px packet stream that never crossed a day boundary
  still gave p95 31–35ms at 240/day; no-motion packets stayed <=16ms. Wheel
  dispatch and synchronous transform writes stayed near 1ms, while React
  day-step commits were 9–14ms, so the remaining gaps include rendering after
  those calls. Hiding the body only as a diagnostic cut moving-frame p50 to
  9ms but left boundary p95 around 42ms. Pixel snapping, 2D transforms, paint
  containment, and absolute day-column layout did not materially help.
  Native `scrollLeft` improved a partial pan but forced up to 32ms synchronous
  layout at a day rebase, so that trial was reverted. This Linux software/Xvfb
  evidence is not a physical macOS WKWebView trace; keep the Mac issue open.
  The checked-in `e2e/webkit_pan_probe.py` makes this repeatable. At device
  pixel ratio 2 (same 1440×900 CSS viewport), a 45/day partial pan measured
  p50/p95 50/75ms; no-motion control was 8/15ms and diagnostic-only body
  visibility off was 9/16ms. A 1/day run with no cluster rows still measured
  36/63ms, so moving the body region itself is expensive in this
  software WebKitGTK path, with event content adding ~12–14ms. Per-day layer
  hints, removing `will-change`, disabling day isolation, viewport paint
  containment, overflow clipping, and native `scrollLeft` did not materially
  improve the 2× partial pan. Moving each day as a separate transformed layer
  was mixed (p95 67ms then 79ms versus 75ms baseline) and was reverted. A
  45/day fixture with 27 visible annotations
  matched the no-annotation partial p95 (31ms at 1×), so annotations are not
  implicated in this particular synthetic profile. Next decisive evidence is
  a physical macOS WKWebView/Safari Web Inspector timeline with a dense pan;
  do not claim the Linux software compositor is the Mac root cause.
  User confirms the Mac pan is just as bad with annotations hidden. This rules
  out annotation rendering as a necessary trigger for the Mac symptom; the
  separately measured Linux annotation-shadow cost is not the Mac root cause.
  Rechecked this host for a runnable Tauri binary: none is present, and the
  WebKitGTK 4.1 development pkg-config package is absent, so this session
  cannot exercise the app in a native window here. The production-bundle
  browser/WebKitGTK probes remain useful for isolating UI/rendering stages but
  are not direct Mac app testing.
  WebKit's own remote Timeline now confirms the Linux mechanism more narrowly:
  during a marked 60-packet partial pan at 2×, it recorded 15 style
  recalculations, 15 layouts, and 15 paints with ~1,162×851 CSS-pixel clips;
  the matching zero-delta run recorded none of those inside its markers. No
  WeekView commit occurred. `LayerTree.layersForNode` returned no compositing
  layers for the page root or `.day-cols` in this Xvfb run, so the Linux host
  is apparently repainting the body rather than moving a retained GPU layer.
  The distribution reports zeroed Timeline timestamps, so durations cannot
  be inferred from those records. A pure-pixel `translate3d` instead of the
  percentage/pixel `calc(...)` did not improve 2× p95 (75ms), and was reverted;
  an Inspector repeat also recorded the same 16 style recalculations, layouts,
  and large paints as the `calc(...)` baseline. A sequential, diagnostic-only
  CSS ablation at 2× and 45 events/day measured p50/p95 RAF gaps of 50/76ms
  normally, 41/65ms with cluster rows hidden, 40/65ms with row descendants
  hidden, and 34/58ms with entire cluster blocks hidden. This separates some
  text/cluster paint cost from the larger cost of moving the body itself;
  hiding rows is not an acceptable product fix and none of these overrides
  were retained. The four probes ran sequentially to avoid CPU contention.
  Additional non-hiding CSS probes at the same density and scale showed no
  material gain: `content-visibility:auto` on day columns measured 49/75ms,
  `contain:layout paint style` on cluster blocks 50/76ms, and `contain:paint`
  on day columns 51/75ms (p50/p95; baseline 50/75ms). These were diagnostic
  overrides only. This Xvfb host exposes no `/dev/dri` GPU device, reinforcing
  that its full-repaint behavior should not be presumed on a GPU-backed Mac.
  Per-row `content-visibility:auto` was also tested without removing any
  button nodes: at 2×, 45/day changed from 50/75ms to 62/80ms, and 240/day
  changed from 55/79ms to 73/79ms (p50/p95). It was worse or neutral and
  was not retained. Native Tauri configuration has no transparent window or
  custom WebView acceleration setting; it uses the default Tauri window.
  An immediate-transform-write experiment cut wheel-to-style latency from
  ~7ms to ~1ms. The 2× dense partial-pan p50/p95 was 56/81ms coalesced
  versus 56/69ms immediate in one run, still well above the frame budget;
  full-pan p95 was 97ms coalesced versus 102ms
  immediate. It also wrote styles for every packet instead of every frame,
  so the existing frame-coalesced path was restored. The isolated native
  Tauri E2E attempt on this host failed before app launch because the GTK
  development packages (`cairo.pc`, `gdk-pixbuf-2.0.pc`, `pango.pc`) are absent;
  sandbox privileges do not permit installing them. WebKitGTK browser probes
  remain usable, but a native WKWebView run still needs a Mac host.
  Dense-row paint-primitives ablation at 2× and 240 events/day kept all 2,640
  row buttons: baseline p50/p95 was 56/79ms; hiding only colored dots was
  52/77ms; replacing cluster backgrounds/borders with flat fill was 55/72ms;
  both together was 48/72ms. These visual simplifications are not an
  acceptable solution and still miss the frame budget, so were not retained.
  Forcing/disabling WebKitGTK compositing by environment flag also had no
  measurable effect in this Xvfb setup. This makes the Linux profile a poor
  stand-in for macOS acceleration; the Mac Web Inspector Layers/Timeline trace
  remains required to prove whether the same full repaint occurs there.
  `e2e/MAC-PAN-PROFILE.md` gives the physical-trackpad capture steps and
  privacy cautions for the affected Mac.
- [x] **Avoid an extra dense DOM column move on each day step.** The body
  rendered visible dates before the previous overscan date, so React removed
  and reinserted two populated day-column nodes for one step. Chronological
  DOM order makes a step remove/append just one. A focused browser regression
  failed 2/2 before and passed 1/1 after; the WebKitGTK 240/day full-pan p95
  improved only modestly (63ms baseline versus 57–60ms), so this is a partial
  fix, not resolution of the continuous Mac lag. The full pan-focused browser
  suite passed 9 tests with 2 diagnostic tests skipped.
- [x] **A 30-second clock tick needlessly rebuilt every dense cluster row.** A
  fake-clock regression failed before the change: with 400 fixture events it
  rebuilt 11 day-cluster subtrees (all 400 row buttons) even though no event
  changed past/reconciliation status. Cluster caches now key time-dependent
  classes by the actual per-row past/reconciliation signature, preserving row
  DOM on no-op ticks and rebuilding when an event crosses its end; two focused
  tests verify both paths. Minute-level focus-score refresh remains, while the
  layout caches are pruned to the 9 visible + 2 overscan dates.
- [x] **Superseded annotation-placement jobs delayed the latest visible notes.**
  Worker jobs for obsolete pages continued to run serially and their results
  were ignored only after completion. A dense one-day pan waited ~3.3s for
  notes; the worker now terminates the superseded job before starting the
  current page. In the 120/day stress fixture, the current placement finishes
  in ~0.35–0.41s and 54 notes appear; focused cancellation E2E passes. This
  improves annotation freshness but does not fix the remaining dense-row frame
  drops above.
- [x] Repeated the production pan profile with an 8,000-event fixture (1,170
  events in the fetched window, about 90/day). At normal speed, synthetic input
  stayed at 16.7ms p95 with one 33.3ms gap and no React commit; browser-delivered
  input stayed at 16.8ms max with zero >25ms frames, <=0.5ms wheel dispatch,
  and <=0.6ms wheel-to-transform. At artificial 4x CPU throttle, p95/max were
  50/50.1ms with 9–10 gaps above 25ms; the latest run's App commit peaked at
  33.8ms, the day index at 10.3ms, and one long-animation frame attributed
  29.6ms to a MessagePort task. This confirms density-related stress remains
  under throttling but does not reproduce ordinary Chromium lag or identify
  the native Mac/WebKit renderer behavior.
- [x] Found a second density-scaled pan cost in the all-day lane: each of 11
  visible/overscan cells filtered the entire all-day history on every render.
  With 4,000 all-day events the lookup stage consumed 67ms over a pan; the
  date index reduces repeated lookup to 0.1ms total (index build 2.4–4.1ms
  ordinary, 7.7ms at 4x). A 40-day all-day event remains rendered across all
  covered cells via a bounded-span fallback. Production all-day profile has
  p95/max 16.7/16.7ms and no >25ms frame.
- [x] Re-ran the complete Linux browser suite after event-snapshot reuse,
  date-targeted invalidation, fresh mock snapshots, long-span fallbacks, and the
  exact-midnight fix: 312 passed / 64 intentional skips, zero failures.
  Timed/all-day 40-day coverage and the new midnight regression pass.
  `npm run build` and `git diff --check` pass. Native Linux WebKitGTK remains
  blocked by missing GTK3/WebKitGTK 4.1 development packages and authenticated
  sudo (see the setup blocker above).
- [x] Freshly reran the complete browser suite after the no-op cluster-clock
  cache and empty-attendee Undo regressions: 318 passed / 64 intentional
  skips / 0 failures. `npm run build` and `git diff --check` pass. The dense
  120-events/day profile remains unresolved on the physical Mac: five Linux
  Chromium runs had p95 16.7–16.8ms and max 33.4ms; the long gaps were outside
  wheel handlers and usually outside WeekView commits. All rows remain visible
  per user direction. The full Mac/WKWebView path and Linux native WebKitGTK
  remain unvalidated.
- [x] **Erased annotation could reappear from an in-flight layout worker.** A
  delayed-worker browser regression failed before the fix: after adding and
  immediately erasing the last note, the stale worker result drew it again.
  `MarginNotes.place` returned early for an empty note set without advancing
  its request sequence or stopping the worker, so the old completion still
  passed its sequence guard. Empty/hidden pages now invalidate the request and
  cancel pending work; unmount also invalidates/cancels it. Focused regression
  passes after the fix, and the next full suite passed 319/383 with 64 skips.
- [x] **Editing an event could reset retained guests' RSVP state.** The editor
  always supplied its email-only attendee list; native `google_body` replaced
  the Google attendees array with `{email}` objects, dropping `accepted` or
  `tentative` from the request (and a title-only Save resent the unchanged list
  too). Google documents that PATCH replaces supplied arrays; the regression
  mock reproduced `accepted` becoming `needsAction` under that contract.
  Single-event updates now omit an unchanged list and, when the guest set changes, send
  retained attendee resources with their RSVP state while new guests start at
  `needsAction`. The browser-mock regression passes both changed-list and
  title-only edits. The next full suite passed 321/385 (64 intentional skips);
  `npm run build` passes. Native Rust request-body execution remains blocked by
  missing GTK/WebKit development dependencies.
- [x] **Undo after deleting one recurring instance detached it from its series.**
  A regression failed before the fix: Undo recreated the occurrence as a new
  standalone event (`mock-59`, no `recurring_event_id`). It now restores the
  original event ID and instance snapshot; native Tauri queues a status PATCH
  for that same ID so Google can re-enable the cancelled exception rather than
  creating a duplicate. Focused browser regression passes. Google documents
  recurring cancelled exceptions as recoverable and `status` as writable, but
  the live round-trip/native Linux app remain unverified because GTK/WebKit dev
  dependencies are missing. A sync-core integration test verifies queued
  Delete → restore-PATCH ordering and retention of the recurring ID; all 25
  sync-core series/integration tests pass with only the sandbox-denied OAuth
  PKCE test skipped. The full browser suite passed 321/385 (64 intentional
  skips, 0 failures); `npm run build` and `git diff --check` pass. Physical
  Google/WebKit restoration remains unverified.
- [x] **Guest edits could drop attendee rows without an email.** The Calendar
  API permits attendee resources whose email is unavailable. On recurring
  events, the editor lowercased every address while comparing guest lists; a
  title-only save failed with `Cannot read properties of undefined (reading
  'toLowerCase')`. On single events, adding/removing guests silently omitted
  rows the editor cannot display. Both paths now compare only usable addresses
  and retain those attendee resources during guest-list changes. Regressions
  failed before and pass after: title-only and guest edits for a series, and
  guest edit for a single event; all four attendee-preservation focused tests
  pass. The latest full suite passes 329/393 (64 intentional skips, 0 failures).
  A follow-up contract review found the retained raw rows can also contain
  response-only fields (`organizer`, `self`, `asyncOperation`). Single-event
  `google_body` and the separate recurring-series network patch now project
  attendee resources to writable fields, while the local optimistic patch
  retains the full resource (including an email-less attendee ID). The focused
  series E2E passes 1/1 and asserts that RSVP and opaque local fields survive;
  a Rust serializer assertion covers filtering the outbound payload but could
  not run because GTK3, Pango, Cairo, and GDK development packages are missing.
  Live Google behavior remains unverified.
- [x] **Editing only one recurring occurrence could reset guest RSVP state.**
  The normal single-event save used `attendeeSafeUpdate`, but the recurring
  “This event” branch called `updateEvent` directly with the editor's
  email-only attendee list. Because Google PATCH replaces supplied arrays,
  retained `accepted`/`tentative` responses could be overwritten. That branch
  now uses the same preservation path. A focused browser regression verifies
  a title-only “This event” save leaves the accepted attendee resource intact
  and passes 1/1. The live Google request remains unverified.
- [x] **Editing the guest list for “All events” could copy an exception's RSVP
  onto the series master.** A red regression gave the master an `accepted`
  attendee and the selected exception `declined`; adding a new guest sent
  `declined` in the master PATCH even though RSVP is not an editor field. The
  path now uses the master attendee resources as the source for retained
  responses (falling back to the instance only if the master data is absent),
  while new guests remain `needsAction`. The focused regression failed before
  and passes after. Live Google propagation remains unverified.
- [x] **“All events” guest edits could drop attendees unique to the master.**
  The attendee editor reflects the selected exception, whose list can differ
  from the series master. The series path detected changes against the
  exception correctly, but filtered the master against the exception's entire
  desired list; adding a guest therefore dropped a master-only attendee. A red
  E2E reproduced the loss. The update now applies only the user's additions
  and removals to the master attendee resources, preserving master-only guests
  and their RSVP metadata. The new regression and the master-vs-exception RSVP
  regression both pass; live Google propagation remains unverified.
- [x] **Playwright could silently reuse a non-dev server.** Port 1420 was
  already serving a production preview, and local `reuseExistingServer` attached
  to it. Dev-only `window.__mockBackend` hooks were absent, causing 33
  unrelated end-to-end failures. A dedicated-port run passed 329/393; reuse is
  now opt-in with `PW_REUSE_SERVER=1`. Focused recurring-attendee tests pass
  through the owned-server path.
- [x] **Title-only edits could collapse multiple reminder overrides.** The
  editor displays the first reminder but always sent it back as the full
  reminder setting; a title-only save therefore replaced an event's popup +
  email reminders with one popup. `reminderSafeUpdate` now carries the stored
  reminder resource through unchanged single-event and recurring “this” saves,
  and the “this and following” split creation. Changing the visible selection
  still writes the selected single reminder. The focused recurring title-only
  test now asserts the accepted RSVP and both original reminder overrides stay
  intact; it passes 1/1. Live Google API execution remains unverified.
- [x] **A stale annotation-layout worker could add main-thread work mid-pan.**
  Dense production profiling (1,320 events, 720 visible cluster rows) showed a
  ~50ms long-animation frame containing a 14.4ms MessagePort task. A delayed
  worker regression proved the path: a placement started before horizontal
  input could complete during the swipe and commit margin DOM while the calendar
  was moving. The first horizontal wheel packet now invalidates/cancels that
  placement; a fresh layout waits until 220ms after the latest horizontal packet.
  The annealing search is bounded to 6,000 steps. The regression failed before
  and passes after the fix; the latest 393-test browser suite passes 329 with 64
  intentional skips. An isolated post-fix profile measured 16.7ms p95, 33.4ms
  max, no long-animation frame, and ~1.36s for 30 notes to settle. Five repeated
  profiles were variable (4/5 met the p95 assertion; the outlier had p95 33.3ms
  and three long frame gaps, mostly without wheel work or app commits). This
  removes a confirmed source of gesture-time work but does not prove the
  reported macOS trackpad lag is fully fixed; physical macOS/WKWebView testing
  remains necessary. All event rows remain visible as requested.
- [x] **Read-only event drag opened the view panel.** A refused drag used to
  install a one-shot `pointerup` handler that opened the event unconditionally,
  so dragging a subscribed-calendar event was treated like a click. The new
  assertion failed before the fix (panel count 1); the handler now tracks the
  originating pointer, movement threshold, release target, and cancellation.
  Focused read-only drag/click tests pass 2/2, and the full suite passes 312/376
  with 64 intentional skips.
- [x] **Event-range responses could arrive out of order during fast navigation.**
  The deterministic navigation regression proves an older query can finish
  after a newer one and remove a currently visible event. `useEvents` now
  guards range loads and overlapping DB-change refreshes with a request sequence;
  the test failed before the guard and passes after it.
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
and `npm run setup:e2e:linux` again failed because sudo requires a terminal and
password; it made no system-package changes, so native setup remains blocked.

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
