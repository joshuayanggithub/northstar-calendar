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
  A fresh Linux continuation is running through 2026-10-16 19:03 PT; results
  are preserved under `logs/stress-2026-10-17/`. Before it began, the complete
  suite passed 269 with 62 intentional skips and zero failures. Continuation
  run 1 passed 179 with 42 intentional skips.

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
- [ ] **Policy: a local delete vs a concurrent Google edit.** The WIP makes
  the delete win (fetch the current etag, retry); the engine's rule is
  412 → remote wins. Its first test (delete queued after our own edit) already
  passes on main; the second encodes the policy change. Decide, don't drift.

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
