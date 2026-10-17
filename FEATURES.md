# Feature parity checklist

Tracks every essential feature from Google Calendar / Notion Calendar, per CLAUDE.md.
Status: `todo` → `building` → `in testing` → `tested`.
"Verified by" says how a feature graduates to `tested`: unit = cargo test, e2e = Playwright
against the browser build with mock backend, live = round-trip against the real Google
Calendar account, manual = user confirms in the running app.

## Sync & data (the foundation)

| Feature | Status | Verified by |
|---|---|---|
| Google OAuth connect (PKCE, loopback, keychain storage) | tested (live 2026-10-14) | live |
| Initial full sync (calendars + events, windowed ±1y/+2y) | tested (live: 24 cals, 2933 events) | live |
| Incremental two-way sync via syncToken (30s poll + after edits) | tested (live: all 4 legs, ~25s remote→local, ~2s local→remote) | unit + live |
| Offline edits queue + drain on reconnect | in testing (unit ✓) | unit |
| Conflict handling (If-Match, 412 → remote wins) | tested (unit) | unit |
| Echo suppression (own writes don't clobber newer local edits) | tested (unit) | unit |
| Client-generated event IDs (idempotent offline creates) | tested (unit) | unit |
| syncToken expiry (410) → clean full resync | tested (unit) | unit |
| Multiple calendars with per-calendar color and color-swatch editor picker | tested (live 2026-10-15) | e2e both themes + WKWebView screenshot + live calendar move |

## Views & navigation (Google/Notion core)

| Feature | Status | Verified by |
|---|---|---|
| Week view (primary, time grid, current-time line) | tested (e2e + snapshot) | e2e |
| Month view | tested (e2e + snapshot) | e2e |
| Day view | tested (e2e) | e2e |
| Agenda/schedule list (List view, kept per user preference) | tested (e2e) | e2e |
| Jump to today / date navigation (t, arrows) | tested (e2e) | e2e |
| Continuous horizontal pan in week and custom day-count views | mixed-axis and leading-packet loss fixes verified in working tree (2026-10-17; commit pending); physical-device performance remains under investigation | `WeekView` locks after horizontal intent, buffers lead-in `deltaX` until then, and clears candidates at 180 ms idle. Red tests proved prior packet loss of 116/120px in a noisy stream and 8px in a Y-dominant first packet; 7 focused gesture tests and build pass, final 15:32 suite 301/365 (64 skipped). Physical trackpad/WebKitGTK still unverified |
| Mini-month navigator in sidebar | tested (e2e) | e2e |
| Calendar visibility toggles (hover Hide/Show affordance, Google selected-flag seeding) | tested (e2e) | e2e |
| Notion chip anatomy: inline times, wrapped titles, capsule accent, ghosted past, weekend wash, tz gutter label | tested | e2e both themes |
| Layered overlap for ALL overlapping events: background slab + nested chips (C-shape), card-stacking for identical intervals; no columns, no sleeve bands | tested (2026-10-15 dense-data pass) | e2e across six real-data weeks at three zoom levels + native WebDriver |
| Event text as one aligned block (title lines, time, location, drill share one left edge; titles wrap instead of cutting; time under or after the title) | tested (2026-10-15, `7abd0889`) | textlaw + realdata alignment laws; real WKWebView window (e2e/realwindow.spec.ts, sandboxed DB snapshot) over five views |
| Overlap text placement: title + time fitted into each event's VISIBLE shape (joint step pockets, sideways time in a C-shape spine, extras below enclosed events); time kept unless no spot fits; paint order = layout order | tested (2026-10-15, `2fc384d8`) | textlaw.spec (dummy overlap calendar, 30 configs incl. scarf/overlay), realdata TEXT (6 real weeks × 4 views), labelplace.spec geometry + random property test, 2x column captures reviewed by eye |
| All-day row | in testing | e2e |

## Event CRUD (Google/Notion core)

| Feature | Status | Verified by |
|---|---|---|
| Click-drag to create event in grid | tested (e2e) | e2e |
| Drag to move, edge-drag to resize | tested (e2e + manual QA; sync listener fix) | e2e |
| Event editor: title, time, calendar, description, location; selection follows a moved event; Delete/Backspace and repeat-delete scope are safe | tested (live calendar move 2026-10-15; selection + upstream delete fixes full-suite verified 2026-10-17, commit pending) | e2e + live Google round-trip; 11:16 suite 291 passed / 63 skipped; panel-delete 3/3 |
| Multi-select delete clears selection and closes a panel for a deleted event | verified in working tree (2026-10-17) | regression opens an event, shift-adds a second, then deletes both; focused Playwright 1/1 at 14:12 and full suites 301/365 at 14:17, 14:32, 14:47, 15:02, 15:17, and 15:32 |
| Overnight time edits preserve duration when shifting start | tested in working tree (2026-10-17; commit pending) | regression fails before and passes after; same-day clamp + cross-midnight + overnight focused tests pass 3/3; production build and 13:02 full browser suite (297 passed / 64 skipped) pass after final guard alignment |
| Multi-day timed event edits preserve end date and duration | verified in working tree (2026-10-17; commit pending) | test reproduced ordinary title-save truncating 49h event to 25h; editor now stores calendar-day offset, displays +Nd and preserves duration on start-time change; DST fall-back badge reports actual elapsed 27h; focused checks pass 6/6, build passes, 13:02 full browser suite passes 297/64 |
| Multi-day all-day event date edits preserve the covered span | verified in working tree (2026-10-17; commit pending) | test reproduced moving a three-day event's start without its inclusive end, saving it as one day; date edit now shifts the end by the same calendar-day offset. Forward/backward edits and fall-back DST crossing test pass; the DST case passed focused Playwright 1/1 at 14:54 and full suites 301/365 at 15:02, 15:17, and 15:32. Four related date/conversion/drag checks pass |
| Guests/attendees (add emails, see RSVP status) | todo | live |
| Recurring events: display instances | tested (live: singleEvents sync, 29k instances) | unit + live |
| Recurring events: create (NL: daily/weekly/weekday/per-day) | tested (live: series create/edit/delete) | live |
| Recurring events: edit single instance | tested (live isolation) | live |
| Recurring events: move entire series to another calendar | tested (live 2026-10-15) | e2e + disposable two-instance Google round-trip |
| Recurring events: convert whole series timed ↔ all-day or shift its dates | tested (2026-10-15, `03b55d3`) | mock E2E + disposable two-instance live Google conversion both ways |
| Recurring events: edit “this and following” on fixed-count series | tested (2026-10-15, `a72e439`) | E2E edit/delete/first-instance cases + disposable live Google COUNT=3 split into 1+2 instances |
| Recurring all-day events: edit “this and following” on fixed-count series | in testing (2026-10-16, `bb0113b`) | mock E2E verifies date-valued `UNTIL` + remaining `COUNT`; disposable live Google all-day probe pending |
| Recurring events: change guests, busy/free, visibility, reminders for whole series | tested (mock 2026-10-15) | two-instance e2e |
| Recurring-series edit responsiveness | browser/mock + sync-core tested in working tree (2026-10-17) | delayed 5-second regressions for “all”, unbounded “this and following”, and COUNT-limited splits; COUNT path now projects locally before fetching Google instances, then computes exact remaining count including cancelled originals; 3/3 latency E2Es, 3 count-calculator unit tests (timed, all-day, missing selection), and build pass. Local projection remains timezone-independent through DST and preserves per-instance notes. Native Tauri build/in-app check still needs Linux GTK3 + WebKitGTK 4.1 development packages |
| Linux native in-app E2E setup | blocked pending authenticated system-package install | Xvfb and GTK3/WebKitGTK 4.0 runtimes exist, but required GTK3 + WebKitGTK 4.1 development files and WebKit driver are absent; fresh-sandbox `npm run test:e2e:app` fails its Tauri build on missing `gdk-3.0`, `pango`, `cairo`, and `gdk-pixbuf-2.0` pkg-config metadata. `npm run setup:e2e:linux` needs authenticated sudo and made no package changes |
| Dense horizontal-pan frame profile | tested in production Chromium (2026-10-17; residual outlier under investigation) | Twelve 400-event / 720px synthetic DOM-wheel profiles and six browser-delivered-wheel profiles: all p95 16.7–16.8ms; 8/18 had one 33.2–33.4ms frame. After the lead-in buffer fix, a fresh synthetic profile had p50/p95/max 16.7/16.7/16.8ms and no >25ms gap; browser-delivered p95 was 16.8ms with one 33.3ms gap during no wheel event/WeekView commit. Latest dispatch <=0.4ms, paint <=0.2ms, React commits 2–7ms. The 15:32 suite passes 301/365 (64 skipped). Physical OS trackpad/WebKit input and Linux WebKitGTK remain unverified; no claim that remaining lag is fixed |
| Annotation erase from editor and no-flash delete | tested | editor erase + undo and focused-note Delete E2Es; mutation observer confirms event chips are not remounted; recurring-series body edits preserve per-instance notes |
| Delete event with undo toast (⌘Z); delete series for recurring | tested (e2e + live) | e2e + live |
| Timezone-correct display incl. DST boundaries | building | unit |

## Notion-style niceties

| Feature | Status | Verified by |
|---|---|---|
| Command bar (cmdk): jump date, switch view, create, search | tested (e2e) | e2e |
| Natural-language quick create ("lunch tue 12:30") | tested (e2e) | e2e |
| Keyboard: t/d/w/m/l, 0-9 N-day, j/k, n/b/N, x, e, c, ⌘K, ./, /, ⌘Z/X/C/V/D/J, ⇧⌘E, ⇧⌘./,/0, ` | tested (e2e) | e2e |
| Event search (via ⌘K, client-side ±90d) | tested (e2e) | e2e |
| Secondary timezone column (⌘K → time zone; persisted) | tested (e2e) | e2e |
| Menubar tray: next event + join button + sync/open/quit | in testing (user verify) | manual |
| Global quick-create shortcut (⌥C) | in testing (user verify) | manual |
| Calendar colors = Google Calendar's displayed palette (legacy API hex mapped), tinted translucent | tested (2026-10-16, `10efe30e`) | e2e/color.spec.ts; checked against the live Google sidebar |
| Multi-select drag: shift-click / shift-drag several events, drag one, all move (ghost each, wall-clock shift, selection kept; remote-deleted events leave selection and close stale editor) | tested (2026-10-17) | e2e/groupdrag.spec.ts |
| Drag previews of events running past midnight drawn on every day they touch (move, resize, group) | tested (2026-10-17, `4794edc6`) | e2e/overnight-drag.spec.ts |
| Pinch on the trackpad zooms the day count (1–9), the day under the fingers kept in place | tested (2026-10-17, `b65701d8`) | e2e/pinch.spec.ts (WebKit gesture + ctrl+wheel); real pinch: user verify |
| Resizable sidebar and event panel (remembered, double-click reset, arrow keys); description grows with its text | tested (2026-10-17, `dbb37e81`) | e2e/panes.spec.ts |
| Past events faded: every ended event (unconfirmed, sleep, all-day, clustered too) at 30% of its calendar's tint, hue kept | tested (2026-10-16, `04135f78`, `8ef1d0f7`) | e2e/pastfade.spec.ts (all 24 Google colors, both themes: past/future gap, hue, chroma, title contrast) |
| Margin notes: free-space placement, arrows, drag, remembered edge/corner sizing and writing scale; worker annealing | tested (2026-10-16/17, `7180685a`, `e1a55b97`, `237f33d`, `56ab03a1`, `996b84d1`) | e2e/marginnotes.spec.ts (property + captured real pages), e2e/notes.spec.ts (drag/size/font/reload/reset/delete/no-flash/swipe rigidity), textprobe law 5 in Chromium + real window (7 views) |
| Goals in the sidebar (daily / weekly / long-term, kept by the app; ticks reset per day / week) | tested (2026-10-16, `f940f148`) | e2e/goals.spec.ts; Rust migration test |
| Pessimistic focus score: deep work = Homework / Learning and Research / Enrichment only; clean stretches, interruptions, distraction, sleep duration/timing/regularity, late nights | tested (2026-10-16, `31c58084`) | e2e/focus.spec.ts (incl. gaming attempts); design/focus-score.md |

## Conferencing & notifications

| Feature | Status | Verified by |
|---|---|---|
| Google Meet link creation on events | tested (live: real Meet URL round-trip) | live |
| Join button on events with conference links (Meet/Zoom detect) | tested (e2e) | e2e |
| Upcoming-meeting OS notification (T-60s) | tested (live, log-verified; banner = user verify) | manual |

## Availability / booking links (needs Cloudflare Worker)

| Feature | Status | Verified by |
|---|---|---|
| Booking page with open slots from free/busy | built (worker/; deploy needs Cloudflare login) | live |
| Slot rules: duration, working hours, buffer, min notice | built (KV rules + admin API) | live |
| Booking creates event + Meet link + attendee + invite email | built (worker/; deploy pending) | live |
| Share-availability panel in app | todo | e2e |

**Ground-truth parity pass (2026-10-14, vs design/references/notion-shortcuts.md):**
undo ⌘Z with toast on every mutation; selection model (click ring, Backspace/Delete,
⌘D duplicate, N/B cycle, Enter opens, two-stage Esc); ⌘J join; J/K + 0/1 + `.`//
shortcuts; backtick sidebar toggle; Esc cancels drags; gutter now-pill + full-width
now line; past events faded; persistent draft chip; duration-preserving time edits;
right-click context menu; tooltips; auto-scroll to now; month multi-day coverage.
**Remaining known gaps:** option-drag duplicate, shift-drag multiselect, E-then-X edit
chords, 2–9 N-day views, hour zoom, weekend/declined toggles, cut/copy/paste of events,
keyboard-opened panels anchor top-right.

## Extended Google Calendar parity
(from the Google Calendar help index, support.google.com/calendar topic 14286980)

| Feature | Status | Verified by |
|---|---|---|
| Respond to invitations (RSVP yes/no/maybe from the app) | todo | live |
| Invite guests + track responses on own events | todo | live |
| Holiday / birthday / subscribed calendars display (read-only cals); "Other calendars" read-only by default: no reconciliation, score, stars or goal suggestions; "Copy to my calendar…" picks the calendar (one occurrence or the series); a copied original steps aside for its copy (grid, menu bar, reminders); ⌘V pastes into yours | tested (2026-10-16, `a0ea5055`) | e2e/othercals.spec.ts, smoke readonly tests, cargo notify test; live data: 12 reader calendars |
| Per-event color override | todo | e2e + live |
| Event visibility (busy/free, private/public) on events | todo | live |
| Working hours display | todo | e2e |
| Import .ics events / export calendar data | todo | e2e |
| Offline use (view + edit queue — same machinery as offline sync) | building | unit |
| Dark theme (follows OS) | tested (tokens, light+dark) | e2e |
| Notification preferences (per-calendar default reminders) | todo | manual |
| Multiple time zones (primary + secondary gutter) | tested (e2e) | e2e |
| Search events | tested (e2e) | e2e |
| Keyboard shortcuts parity (Notion catalog) | tested (e2e) | e2e |
| Appointment schedules (= our booking links, Phase 5) | todo | live |

## Deliberately out of scope (personal desktop tool)

Gmail/Chat/Meet product integrations, Wear OS/Apple Watch, Gemini features,
spam/blocking flows, print, mobile home-screen, screen-reader certification
(basic a11y only), Workspace Experiments, calendar embedding on websites,
room/resource booking, family calendars, payments for appointments.

## Explicitly later (post-MVP)

Push-based instant sync (watch-channel relay), Tauri mobile builds, Zoom OAuth,
multiple Google accounts, tasks & reminders, calendar sharing management
(ACL editing), transfer/labels, add-ons.
