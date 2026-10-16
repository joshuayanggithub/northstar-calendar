# User feature requests log

Running log of custom features requested by Joshua, with status. (Deeper
tracking: FEATURES.md for the parity matrix, e2e/QA-BACKLOG.md for QA items.)

| # | Request | Status |
|---|---|---|
| 1 | Notion Calendar as UI ground truth, Google Calendar for features | done (design/references/) |
| 2 | List view kept as a selectable view | done |
| 3 | Rigorous end-to-end UX testing vs ground truth | ongoing (212-case full suite passed at 22:59 UTC; native WKWebView/WebDriver and live Google probes; 15-minute runs scheduled through 2026-10-16 02:59:44 UTC) |
| 4 | Fix drag text-selection, panel placement, calendar show/hide, add/subscribe calendars | done |
| 5 | Read-only calendars (subscribed feeds not movable/editable) | done |
| 6 | Recurring edit scope popup (this / this+following / all) | done (`a72e439` also enables safe fixed-count splits; native Google COUNT=3 round trip passed) |
| 7 | Better app icon (generic, no hardcoded date) | done |
| 8 | Shift/⌘ multi-select, marquee, ⌘A, bulk ops, group drag | done |
| 9 | Ghost/selection colors must keep the calendar color (no generic blue) | done |
| 10 | Selected events: no extraneous border ring | done (tint + elevation instead) |
| 11 | Event editor: Notion-style full-height right sidebar, less clunky | done |
| 12 | Custom # of days view with a UI selector (not just 2-9 keys) | done (view-switcher dropdown + 2–9 keys) |
| 13 | Better gcal→app color conversion: high contrast, don't confound gray/black | done (OKLCH normalization, hue-preserving) |
| 14 | Overlap redesign: background sleeves | done |
| 18 | Container overlap refinement: C-shape — outer event keeps full column width, pinching to a spine only while an inner event runs; slim sleeve only when children cover ≥60% of the container | done (layout.ts C_SHAPE_MAX_COVERED, cshape e2e tests) |
| 20 | C-shape v2: container renders as ONE quiet full-width slab; children paint on top, inset past the left strip (no segments, no seams); selection/hover treat it as one shape; label dodges a child flush with the container start | done |
| 21 | Draft "New event" chip: single clean line, no overlapped text | done |
| 22 | Clicking chrome outside the grid deselects (not just Escape) | done |
| 23 | Location: shows on week chips + list rows (saving verified live against Google) | done |
| 24 | Goals sidebar renders the whole Obsidian file inline — grouped by heading, ordered/nested items, wiki-links, collapsible groups; checklist toggles kept | done |
| 32 | All-day lane multi-day drag-create (Notion) | done |
| 33 | Sidebar: My calendars / Other calendars split (Google), collapsible + persisted | done |
| 34 | Single Notion-style view dropdown (Day/Week/Month/List/Insights/# days) with shortcut hints | done |
| 35 | Goals sidebar section highlighted (accent card) | done |
| 37 | Day-header focus score (today scores the day so far; dayScore guard now counts tracked 'other' time) | done |
| 38 | Goal stars: star events (ctx menu), link them to a goals-file goal in the panel, counts on sidebar goal rows; v1 local-only — sync via Google extendedProperties = follow-up | done |
| 42 | Local goal classifier: SHIPPED — Rust background queue (Ollama, cached by title+goals hash, 4/tick), hollow-star suggestions with confirm/suppress tri-state, panel + sidebar integration | done |
| 41 | Cluster rule generalized to crowded components (<20px/event room), catching deep-nested tangles | done |
| 40 | Tail-overlap joints: scarf (default) / rabbet / overlay as a View setting — chips tile the column via complementary clip-paths, labels dodge the cut | done |
| 39 | real-window layer invariant flag — resolved: the flagged slivers were crowded tangles, now merged by the component cluster rule (#41); suite green on live data | done |
| 36 | Trackpad horizontal swipe pages the view (threshold + cooldown; continuous pixel panning = future refinement) | done |
| 31 | Per-event color swatches in the context menu (Notion) — needs Google colorId end-to-end (db column, sync, google_body) | backlog |
| 30 | Notion-parity sprint via real-window WebDriver: short-chip inline time, wrapped titles, cursors, calm hover, scroll anchoring, light-mode slab visibility + light visual project, accent capsule, month pill rows, 15-min time dropdown with durations | done (e2e/QA-SPRINT-webdriver.md) |
| 29 | No staircase indents for barely-overlapping chains: nesting only when >=50% of the shorter event overlaps (real multitasking); tail overlaps render as one continuous full-width column, later chip over the earlier tail | done |
| 28 | NO column splitting ever, no sleeve bands: every overlap layers as full-width C slabs; identical-interval events card-stack (16px title band, pushed-down top card) so all titles stay readable | done |
| 26 | C-shape for ALL overlaps: any event another event nests into (containment, or starting 30min+ later) becomes the background slab; only same-start peers still split the column | done |
| 27 | No text collisions in layered overlaps: slab label seeks the first uncovered gap that fits the title, drops the time line in tight gaps, tooltip-only if nothing fits | done |
| 25 | Location field: Google-Maps-style place autocomplete (keyless OSM/Photon), embedded map preview with dark-mode tiles, Open-in-Google-Maps link | done |
| 19 | C-shape bug pass (user: "very very buggy"): per-event spine inset instead of whole-day, quieter container tint + hairline ring so same-color children stay legible, square-join/rounded-free corners, whole-shape hover, title moves off the spine to the first full segment | done (6 regression tests; visual snapshot tolerance tightened 10x) |
| 15 | Obsidian bridge (option B): goals sidebar + weekly review, CAS write-back | done |
| 16 | Insights tab: all 10 ideas as dense one-line stats; report appends to journal | done |
| 17 | Editor sidebar must match Notion row-for-row, verified side-by-side | done |
| 43 | Fix dense event overlap gaps, covered or ellipsized titles, narrow week header alignment, and horizontal pan snap | done (`03b55d3` removes idle springback and forced wheel render; browser/native pan probes and 210-case full suite passed) |
| 44 | Show each calendar's color in the event editor dropdown | fixed in working tree; both browser themes and native WebDriver screenshot verified; commit pending |
| 45 | Save an event's calendar change reliably | live Google round-trip passed with a self-deleting test event; no code change needed |
| 46 | Move an entire recurring series to another calendar | fixed in working tree; browser regression and disposable two-occurrence live Google round-trip passed; commit pending |
| 47 | Overlapped events (joints, C-shapes): title and time must never overlap or be covered in any combination; push enclosed events out when needed, drop the time only in extreme cases | done `2fc384d8` (visible-shape text placement + push-only-when-needed second layout pass) |
| 48 | Reorient title/time to fit the odd shapes the joints and C-shapes leave (step pockets, sideways spine time), verified with screenshots | done `2fc384d8` (CAPTURE=1 e2e/capture.spec.ts for 2x column crops) |
| 49 | Test in the real app window (not only Chromium) | done `7abd0889` (debug `CAL_SANDBOX` mode + e2e/sandbox_app.sh + e2e/realwindow.spec.ts; never touches the live DB or Google) |
| 50 | Titles extend to multiple lines; title + time block keeps one neat indent | done `7abd0889` (aligned-block placement, alignment laws in the probe) |
| 51 | Keep investigating calendar scrolling lag during the extended QA run | ongoing (`03b55d3` fixes backward springback and reduces wheel work; dense production-browser probe and native pan probe passed) |
| 52 | Recurring “All events” should save timed/all-day conversion and a later instance's date change | done `03b55d3` (mock E2E + disposable live two-occurrence Google conversion both ways) |
| 51 | Reconcile: "didn't happen" (✕) deletes the event; "canceled" = skipped but kept on the calendar (struck through) | done `d47e56b1` (all surfaces: hover ✕, cluster rows, context menu, panel, R triage X/C; ⌘Z restores a delete) |
| 52 | Goal-driven work must stand out: animated gold shine ring (like a shine-border button), bold title, no star glyphs | done `d2e3011f` (ring follows joints/C-shapes; suggestions get a still, quieter ring) |
| 53 | Explain the focus score on hover (reason + how it's calculated) | done `95e3b915` (popover was clipped before; now a fixed layer with reason, parts, uncounted time, formula) |
| 54 | Goal shine: brighter, metallic, periodic (not constant), no solid border; bold titles | done `95e3b915` |
| 55 | Goal classification much more conservative | done `95e3b915` (prompt v3, deterministic exclusions, stale verdicts hidden) |
| 56 | Focus hover: concise, no flowery language | done `827f8ab9` |
| 57 | Menu bar item (Notion Calendar style): next event + how soon; click for a 12-hour list | done `827f8ab9` |
| 58 | Goal light: short, constant speed along the outline (not a centred spin) | done `827f8ab9` |
| 59 | Past events keep their calendar color (darker), like Notion; not gray | done `975ba43b` |
| 60 | Edit the drill sergeant notes for self-reflection | done `975ba43b` (inline editor; supervisor never rewrites edited notes) |
| 61 | Distractions render pink, not brown: use Google Calendar's exact colors, tinted translucent | done `10efe30e` (API reports the legacy palette, e.g. Cocoa #ac725e; the app now maps to the color Google displays, #795548, verified against the live Google sidebar; e2e/color.spec.ts) |
| 62 | Pessimistic, hard-to-game focus score: deep work only from Homework / Learning and Research / Enrichment; interruptions, longest clean block; punish distraction, bad sleep, late nights; grounded in research | done `31c58084` (design/focus-score.md: formula, citations, calibration) |
| 63 | Annotations leave the event box: written in any free space like notes on a printout, with arrows to their event, never over text | done `7180685a` (leader label placement + simulated annealing; real-window laws) |
| 64 | Annotations always shown in full (wrap, rotate, use any free space) | done `7180685a`, `e1a55b97` (pre-wrapped, never clipped; smaller hand only when crowded) |
| 65 | Annotations can be dragged to adjust | done `7180685a` (arrow follows; spot remembered per event; double-click resets) |
| 66 | Goals tab styled like My calendars / Other calendars; goals stored in the app (no Obsidian link); Daily / Weekly / Long-term | done `f940f148` (goals.json via goals_read/write; one-time copy from the old note; e2e/goals.spec.ts) |
| 67 | README from the author's template, all media from a dummy calendar, a 10-second Remotion clip | done `a2da639e`, `b642605f` (Rosa demo week, scripts/readme; video/ with the Remotion agent skills) |
| 68 | Demo persona: no ML or the author's interests; Rosa, a freelance writer (NYT bestseller, Pulitzer goals) | done `a2da639e` |
| 69 | Video: overlap fixes side by side with Google's layout; less generic type; a self-reflection caption | done `b642605f` |
| 70 | Publish to github.com/joshuayanggithub/northstar-calendar | done (clean single-commit snapshot after a personal-data scrub: `5f863ac5`, `bdd18605`) |
| 71 | A 10-second 1080p video of a real session: the week, reconcile, plan a day (C-shape, rabbet joint), cluster | done `814a0239` (replaced by 73) |
| 72 | README images sized to the text; feature numbering fixed | done `c63d152b` |
| 73 | Video as a walkthrough you can follow (no 10-second limit), with annotations right after reconcile; screenshots a bit larger | done `7c11c824` (one minute, fake-clock recording; the Review pill no longer wraps the title) |
| 74 | Annotations screenshot a little larger (its notes are small) | done `80b9442b` (full text width) |
| 75 | Past events visibly faded next to future ones, colors still visible; then "even more faded", 30% picked from 30% vs 35% renders | done `04135f78`, `8ef1d0f7` (every ended event fades: unconfirmed, sleep, all-day, clustered; e2e/pastfade.spec.ts over all 24 Google colors, both themes) |
| 76 | Remove the drill sergeant and all current annotations | done `502fd205` (supervisor gone; once at launch every [DRILL] line comes off its event here and in Google, backup drill-removed.json; checked on a snapshot of the real DB: 12 of 12) |
| 77 | Rename the app "North Star" (from calendar-app) | done `6b0bf1b5` (bundle, menu, Dock, window, menu bar; identifier kept so data, sign-in, settings carry over; Desktop shortcut ~/Desktop/North Star.app) |
| 78 | README media match the app (stronger fade, no model writing notes) | done `c3bb97b1` |
| 79 | Past events at 40% (from 35% / 40% renders) | done `d7cda88c` (one variable, --past-fade) |
| 80 | Faded events kept a border in the original color | done `d7cda88c` (light-mode C-shape ring now fades with the fill; seen and checked in the real WebKit window) |
| 81 | /Applications/North Star.app should pick up every new build | done (now a symlink to target/release/bundle/macos/North Star.app, like the Desktop one) |
| 82 | All README screenshots and the video in light mode | done `5a441f0d` |
| 83 | A calendar's color changed in Google Calendar should show in the app | done `21677558` (colors and names always synced every 30s; the interface now reloads when only the calendar list changed) |
| 84 | Past events at 35% instead of 40% | done `44773b99` |
