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
| Continuous horizontal pan in week and custom day-count views | tested (2026-10-16, `03b55d3`, `237f33d`) | e2e step-by-step + native WKWebView across day boundaries with zero backward steps; partial swipes stay put; hidden weekends stay five business days; annotations remain rigid during and after settlement |
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
| Event editor: title, time, calendar, description, location | tested (live calendar move 2026-10-15) | e2e + live Google round-trip |
| Guests/attendees (add emails, see RSVP status) | todo | live |
| Recurring events: display instances | tested (live: singleEvents sync, 29k instances) | unit + live |
| Recurring events: create (NL: daily/weekly/weekday/per-day) | tested (live: series create/edit/delete) | live |
| Recurring events: edit single instance | tested (live isolation) | live |
| Recurring events: move entire series to another calendar | tested (live 2026-10-15) | e2e + disposable two-instance Google round-trip |
| Recurring events: convert whole series timed ↔ all-day or shift its dates | tested (2026-10-15, `03b55d3`) | mock E2E + disposable two-instance live Google conversion both ways |
| Recurring events: edit “this and following” on fixed-count series | tested (2026-10-15, `a72e439`) | E2E edit/delete/first-instance cases + disposable live Google COUNT=3 split into 1+2 instances |
| Recurring events: change guests, busy/free, visibility, reminders for whole series | tested (mock 2026-10-15) | two-instance e2e |
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
| Multi-select drag: shift-click / shift-drag several events, drag one, all move (ghost each, wall-clock shift, selection kept) | tested (2026-10-16, `d3166cdd`) | e2e/groupdrag.spec.ts |
| Past events faded: every ended event (unconfirmed, sleep, all-day, clustered too) at 30% of its calendar's tint, hue kept | tested (2026-10-16, `04135f78`, `8ef1d0f7`) | e2e/pastfade.spec.ts (all 24 Google colors, both themes: past/future gap, hue, chroma, title contrast) |
| Margin notes: your red-pen notes placed in free space (any column, event bodies), arrows to the event, always whole, draggable (spot remembered), placed by annealing in a worker | tested (2026-10-16, `7180685a`, `e1a55b97`, `237f33d`) | e2e/marginnotes.spec.ts (property + captured real pages), e2e/notes.spec.ts (drag/reload/reset/delete/no-flash/swipe rigidity), textprobe law 5 in Chromium + real window (7 views) |
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
| Holiday / birthday / subscribed calendars display (read-only cals) | todo | live |
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
