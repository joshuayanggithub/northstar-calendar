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
- [ ] Continue the 15-minute full-suite stress loop and inspect every failure
  through the 02:59:44 UTC deadline. The 22:29 run had two assertions based
  on the previous spring behavior; those tests were updated and focused
  reruns passed. The 22:44 full run passed 210/210 and the 22:59 run passed
  212/212. The next run includes the fixed-count deletion and first-instance
  regressions added during the 22:59 run.

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
