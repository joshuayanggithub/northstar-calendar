# QA backlog — Notion-parity correctness sprint (2026-10-14, 6h timer ends 15:40Z)

Statuses: [ ] untested · [B] bug found · [F] fixed+regression test · [OK] verified correct · [G] known gap (deferred)

## A. Time-grid interactions
- [F] A1 drag-create upward (bottom→top)
- [F] A2 drag-create constrained to anchor day when pointer crosses columns
- [F] A3 move event so it crosses midnight → renders on both days, times right
- [OK] A4 (clamped in commitDrag; covered by resize test) resize to zero/negative → clamps to 15m
- [F] A5 click precision in overlap cascade (short chip on top of long one)
- [F] A6 all-day row overflow shows "+N" (Notion shows expander)
- [OK] A7 (locate() clamps; anchor-day test covers) drag at first/last column edges, clamped day index
- [F] A8 keyboard (non-Esc) suppressed while dragging
- [F] A9 drag timed<->all-day conversions both directions + lane day moves
- [F] A10 now-line/pill update on tick

## B. Event panel semantics
- [F] B1 end before start on save → clamp/bump (Google auto-adjusts)
- [F] B2 (live: PATCH nulls verified) timed → all-day toggle round-trips (REAL backend: PATCH must null dateTime)
- [F] B3 (same fix) all-day → timed toggle round-trips (PATCH must null date)
- [F] B4 (Move op; live-verified primary→Homework) calendar switch on existing event (REAL backend: patch hits wrong calendar URL — needs Move)
- [F] B5 description/location round trip
- [F] B6 deleting an event closes a panel that is showing it
- [OK] B7 (instance ids patch; singleEvents sync) editing a recurring instance patches only that instance

## C. Quick create NL
- [F] C1 time range "3-4pm fri"
- [F] C2 bare weekday "saturday" → all-day
- [F] C3 (NL recurrence: daily/weekly/weekday/per-day; live series create/edit/delete verified) "every weekday 8am" → creates first occurrence (recurrence = known gap)

## D. Month view
- [F] D1 double-click day → all-day draft
- [F] D2 chip click opens panel
- [F] D3 "N more" opens day view

## E. List view
- [OK] E1 (loop breaks after first day for timed) zero-duration event doesn't loop/crash
- [OK] E2 (existing test) multi-day all-day shows on each covered day

## F. Command menu
- [F] F1 "jan 3" jumps forward (2027, not past)
- [OK] F2 (dedup by recurring_event_id) recurring dedup in search

## G. Selection/undo
- [F] G1 move-undo restores previous time
- [F] G2 undo with empty stack is a no-op
- [OK] G3 (uses visible list) n/b skips hidden calendars' events
- [F] G4 delete-selected clears selection + closes its panel

## H. Real backend (test hook)
- [F] H1 (live ✅) all-day conversion live round-trip
- [F] H2 (live ✅) calendar move live round-trip
- [OK] H3 (live ✅) cross-midnight event syncs correctly

## Iterations 5-9 additions (all [F] fixed+tested or [OK])
- [F] month spanning bars for multi-day all-day events (lane-packed, continuation styling)
- [F] hover + X selection toggle; shift+N previous-selection alias
- [F] seeded interaction fuzz test (zero page errors)
- [F] DST fall-back AND spring-forward drag correctness (wall-clock construction)
- [F] cross-midnight: panel edits preserved (+1d marker); continuation move (+24h bug); continuation resize (25h bug)
- [F] mini-month follows navigation; cross-month range titles
- [F] all-day -> timed conversion defaults to 09:00-10:00 (was midnight)
- [OK] perf: real-store week query ~60-70ms incl. hook HTTP; live round-trip re-verified post-changes
- [F] recurring: Google requires explicit IANA timeZone on recurring inserts (400 otherwise) — found live, fixed
- [F] live B7: instance edit isolation verified (1 edited, 2 untouched); series delete via master id

## Iterations 10-14 additions (all [F] or [OK])
- [F] secondary time zone gutter (cmd+K, persisted)
- [F] undo-stack depth; right-edge panel flip; light-theme audit
- [F] recurrence creation (NL + RRULE) + required-timeZone API fix; live series lifecycle
- [F] delete series (context menu + panel); mock mirrors Google master-delete semantics
- [OK] fuzz seeds 42 & 1337 clean; full sweep green (8 rust, 73 e2e, live round-trip)

## Final verification sweep (14:15Z): 8 cargo + 73 playwright + live round-trip all green.
