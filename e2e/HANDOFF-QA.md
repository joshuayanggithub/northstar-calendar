# QA / stress-testing handoff

For an agent picking up UI/UX bug-hunting on this repo cold. Read this, then
TODO.md (open work), REQUESTS.md (every user ask + status), FEATURES.md
(parity tracker), DEVELOPMENT.md (tooling recipes), design/goal-classifier.md.

## What this is

Joshua's personal calendar (Tauri 2 + React + `crates/sync-core` Rust), live
two-way Google Calendar sync against his REAL account. **Notion Calendar is
the UI/UX ground truth** (he has it in Chrome — compare side-by-side via the
claude-in-chrome tools; reference material in `design/references/`), Google
Calendar is the feature reference. He uses the app daily, mostly in **light
mode** on macOS, trackpad-heavy.

## Test layers (macOS has no tauri-driver — these replace it)

1. **Mock Playwright suite** — `PLAYWRIGHT_BROWSERS_PATH=0 npx playwright test`
   (needs `dangerouslyDisableSandbox`). 147 tests, projects `chromium` (dark)
   + `light` (visual tests only). Vite must be on **127.0.0.1**:1420 (IPv6
   rebinding broke this once; config is pinned). Browser mock mode = plain
   vite page; `src/lib/mockBackend.ts` mirrors the Rust command surface —
   divergence between mock and real behavior has caused real bugs before
   (hide/show emitted events in mock but not Rust). `?now=2026-10-14T09:00:00`
   injects the clock; mock events are generated RELATIVE to `now()` via
   `at(dayOffset, hour, min)`.
2. **Debug hook, `127.0.0.1:14211`** (debug builds only, `src-tauri/src/testhook.rs`):
   dispatches real command code paths — create/update/delete/list events,
   sync_now, pending_ops, **`eval`** (async-capable JS in the real WKWebView,
   results via `test_report`), `screenshot`. THE tool for real-data probes.
3. **tauri-plugin-webdriver, `127.0.0.1:4445`** (debug builds): W3C sessions,
   find/rect/text, screenshots of the real window. Caveats discovered:
   `execute/sync` cannot `await` (use the :14211 eval instead); element-click
   is `el.click()` and `/actions` emits Mouse not Pointer events — the grid
   listens to `pointerdown`, so drive drags by dispatching `PointerEvent`s
   through eval (see `e2e/real_window.sh` step 3 for the exact recipe).
4. **`./e2e/real_window.sh`** — real-window smoke suite: view switch via
   keydown, layer invariants (no inset slab without an overlapping slab
   beneath), text-anatomy invariants (no sliced/overflowing chip text, no
   two-line text in sub-27px chips), pointer-sequence panel open, screenshot.
   It restores whatever view the user had. Run it after ANY layout change.
5. `cargo test` in `crates/sync-core` — sync engine (etags, echo, 410).

## Hard rules when touching the real app

- **Never mutate real events.** Probes create events titled
  `qa-probe … (auto, self-deletes)` via the hook and delete them after
  (use the real calendar id (your account email), NOT the `primary` alias —
  alias rows orphan). Verify cleanup with a list after sync.
- **One app instance at a time** (dev vs release share the SQLite DB; two
  sync engines fight). Release bundle: `target/release/bundle/macos/…app`,
  Desktop symlink `~/Desktop/Calendar.app` points there. The hook/webdriver
  exist only in debug builds.
- Restore the user's view (press the view key he was on) after driving the
  real window; don't launch GUI apps via `open` from the sandbox (blocked).
- If his running binary predates your change, SAY SO — a "bug" report was
  once just a stale 23:04 binary vs a 00:05 feature.

## Visual-testing discipline (learned the hard way)

- `toHaveScreenshot` needs `threshold: 0.05` — pixelmatch's default 0.2 YIQ
  treats this dark theme's low-contrast chips as background; whole missing
  chips passed at any pixel-count budget. Ratios: 0.002 page / 0.005 panel.
- Playwright runs `reducedMotion: "reduce"`: animated things (orbit ring,
  spotlight transition) must have reduce-guards or snapshots flake.
- Screenshot + EYEBALL (Read the png) every visual change; behavior tests
  pass while rendering looks wrong. Close-up day-column clips beat full-page.
- Chips grid-place with explicit `gridColumn` + **`gridRow: 1`** — grid
  auto-placement wrapped a column-1 overscan child to row 2 once and halved
  every column.

## The user's standing UX laws (violating these = bug)

- **No side-by-side column splitting, ever.** All overlaps layer: background
  slab (quiet tint) + chips on top inset 20px/depth; nesting only when the
  overlap ≥ 50% of the shorter event; tail overlaps tile via **rabbet** joint
  (default; scarf/overlay under View settings); chains of 3+ events with
  <20px vertical room each merge into a **cluster block** of rows (rows must
  stay draggable-out, clickable, reconcilable).
- **No sliced or overlapping text anywhere, any zoom.** Labels seek gaps,
  drop the time line when tight, tooltip-only as last resort; sub-16px chips
  use the `chip-xs` tier.
- Chip anatomy: no accent bar/capsule; body tint 55%/60% ("meet halfway");
  short chips = one line `TITLE start-time`; tall chips wrap titles; past =
  washed (desaturate), **dashed outline = unvalidated only**, confirmed
  events look like plain past events (no ✓ decoration); missed = strikethrough.
- Buttons, not just keyboard shortcuts, for any workflow (reconcile has
  panel segmented control + chip hover ✓/✕ + cluster-row hover + pill buttons).
- Colors keep their Google hue AND character (OKLCH bands 0.55–0.80 dark /
  0.42–0.62 light; Cocoa must look brown, graphite gray).
- Swipe = continuous pixel panning with spring settle; p95 frame gap ≤ ~17ms
  in prod profile (measure with the rAF-gap probe in git history, commit
  `fa4f9020`).

## Feature inventory most likely to harbor bugs (newest first)

- Reconciliation (`src/lib/recon.ts`): unsettled/done/missed, 48h grandfather,
  sleep/all-day exempt, R triage pill, morning sweep banner, score credits
  confirmed only. Watch: interactions with clusters, undo, recurring instances.
- Drill annotations (`run_drill` in `src-tauri/src/classify.rs`, UI
  `src/lib/drill.ts`): [DRILL] marker inside descriptions (syncs to Google!),
  red scrawl on chips, red-pen block in panel, erase = permanent. Watch:
  marker survival through every save path (scope dialogs! series edits!),
  double-annotation, description round-trips.
- Goal stars + classifier (`stars.ts`, classify.rs): manual solid/orbit ring,
  auto hollow, suppression tri-state; Ollama queue 4/45s. Spotlight lens (G).
- Pixel panning (strips/overscan/flushSync/settle in WeekView): watch drags
  during pan, hideWeekends, dayCount 2–9, month view (NO panning there yet).
- Time dropdown, location autocomplete (Photon; stub with page.route),
  multi-day all-day drag, calendar split sidebar, goals outline sidebar.

## Stress recipes

- Dense-data torture: hook-create 20+ qa-probe events in one afternoon with
  varied overlaps (identical times, 5-min chains, 3-deep nests), eyeball the
  real window via :4445 screenshots at hourPx 24/48/120, run real_window.sh,
  then delete them all.
- Fuzz: the suite has two seeded fuzz tests (keys + clicks); extend seeds
  rather than loosening assertions; any `pageerror` is a failure.
- Edge weeks: DST spring/fall (tests exist — extend), cross-midnight events,
  `?now=` at 23:59 / 00:01, hideWeekends + pan, zoom extremes during drag.
- Both themes for EVERYTHING visual; he lives in light mode.

## Conventions

Fix → regression test → full suite green (both projects) → commit (one topic
per commit; end with the attribution lines in the session reminder) → update
TODO.md/REQUESTS.md/FEATURES.md per repo CLAUDE.md. Known-open items live in
TODO.md — check it before filing something as new.
