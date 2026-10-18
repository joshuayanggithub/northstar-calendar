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
- [F] A11 dragging a view-only event refuses the move without opening its
  editor; an actual click still opens the view-only panel

## B. Event panel semantics
- [F] B1 end before start on save → clamp/bump (Google auto-adjusts)
- [F] B2 (live: PATCH nulls verified) timed → all-day toggle round-trips (REAL backend: PATCH must null dateTime)
- [F] B3 (same fix) all-day → timed toggle round-trips (PATCH must null date)
- [F] B4 (Move op; live-verified primary→Homework) calendar switch on existing event; selected chip now remains highlighted when its composite calendar/event key changes (REAL backend: patch hits wrong calendar URL — needs Move; `smoke.spec.ts` covers single + series moves)
- [F] B5 description/location round trip
- [F] B6 local or remote deletion closes a panel showing the event; sync-deleted
  events are pruned from selection before group drag (e2e/groupdrag.spec.ts)
- [OK] B7 (instance ids patch; singleEvents sync) editing a recurring instance patches only that instance
- [F] B8 Delete/Backspace in an open recurring event starts one scope request;
  repeated Delete is ignored while the scope dialog is pending
- [F] B9 Adding Google Meet to a recurring event with “All events” sends a
  `conferenceData.createRequest` to the series master and updates every
  occurrence (two-instance browser regression; live Google round-trip pending)
- [F] B10 Undo restores the full attendee resources (including RSVP state),
  busy/free, visibility, and all reminder overrides; selecting Default clears
  a prior reminder override and visibility. A third regression covers adding
  the first guest then Undo restoring an empty list. All three pass; a
  Tauri/Rust request-body regression also checks explicit `attendees: []`, but
  GTK/Pango/Cairo dev dependencies are missing here, so native execution
  remains pending.
- [F] B11 Editing a single event's guest list preserves retained guests' RSVP
  state. The PATCH-replacement mock reproduced `accepted` becoming
  `needsAction` when the native-shaped payload supplied email-only attendee
  objects. Unchanged lists are now omitted and changed lists send the existing
  attendee resource plus `needsAction` only for new guests. Focused browser
  regression fails before/passes after; live Google round-trip remains pending.
- [F] B12 Undo after deleting “this event” restores the same recurring
  occurrence, not a detached one-off copy. The mock regression failed before
  (Undo generated a new ID with no `recurring_event_id`); browser restore now
  reinstates the original ID/series metadata. Native implementation queues a
  status-restore PATCH on that ID; Google round-trip and Linux Tauri validation
  remain pending.
- [F] B13 Single and recurring guest-list edits must retain attendee resources
  without `email`. Series title-only save failed with `toLowerCase` on
  undefined; single-event guest edits silently dropped such rows. Regressions
  failed before and pass after the fixes. Recurring “This event” title edits
  also now use the same RSVP-safe update path; focused test passes 1/1.
- [F] B14 A title-only edit must preserve multiple existing reminder overrides.
  The editor shows the first reminder but should not collapse an untouched
  popup/email pair into a single popup. Regression now covers recurring
  “This event” together with RSVP metadata; focused pass 1/1.
- [F] B15 Adding/removing guests on “All events” must preserve the series
  master's retained RSVP state, not copy the selected exception's response.
  Red regression: master attendee `accepted`, selected occurrence `declined`;
  adding a guest incorrectly PATCHed the master as `declined`. The series path
  now sources retained attendee resources from the fetched master and falls
  back to the instance only when master attendee data is absent. Focused test
  fails before/passes after; live Google propagation remains pending.
- [F] B16 “All events” attendee edits apply only the change relative to the
  selected exception to the master list. Regression: the exception has an
  exception-only guest while the master has a distinct master-only guest;
  adding a third guest must retain the master-only guest/RSVP and must not add
  the exception-only guest to the master. Red before the fix, green after.

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
- [F] G4 delete-selected clears selection + closes its panel; new regression
  opens one event, shift-selects another, then deletes both; focused test passed
  1/1 at 14:12 UTC and full stress runs passed 301/365 with 64 skips at 14:17,
  14:32, 14:47, 15:02, 15:17, and 15:32 UTC.
- [F] G5 group move/delete/duplicate backend failures report partial results
  and keep successful items undoable; injected failures reproduced all three
  lost-undo paths before fixes; focused tests pass.
- [F] G6 time-only group move keeps RSVP state unchanged in the browser mock,
  matching the native PATCH contract; focused group-drag test checks accepted
  attendee status after moving.

## H. Real backend (test hook)
- [F] H1 (live ✅) all-day conversion live round-trip
- [F] H2 (live ✅) calendar move live round-trip
- [OK] H3 (live ✅) cross-midnight event syncs correctly
- [F] Horizontal pan retains `deltaX` from cross-axis-noisy packets and from
  the ambiguous lead-in before axis lock. Candidate X is limited to the first
  100 ms of intent detection, then stays discarded until the existing 180 ms
  idle reset; a prolonged diagonal vertical stream can no longer accumulate
  stale X and make a later horizontal gesture jump. A red regression measured
  92px movement when only the later 12px swipe was intended; after the fix the
  new regression and all seven focused gesture tests pass.
  The earlier 14:02 UTC full suite also covered pure vertical scroll and idle
  reset. Margin-note re-placement now also waits past
  the complete horizontal packet stream (220 ms after the latest X packet),
  not merely the first day-boundary shift; the dense 400-event/20-note
  regression fails without the timer reset. A second live-clock profile found
  77 dense cluster-row rebuilds per pan (12.8ms unthrottled; 30.4ms at 4x CPU)
  because the cache depended on millisecond `now()`; the 30-second clock tick
  now keys it instead. A live-clock E2E asserts each day step reuses unaffected
  cluster rows; after-fix profile: 17 rebuilds / 1.5ms unthrottled and 17 / 4.1ms
  at 4x CPU. Fresh Chromium p95 stayed 16.7-16.8ms unthrottled; the sampled 4x
  run's >25ms gaps fell 4→2, but this does not prove Mac responsiveness. The
  4,000-event follow-up found and fixed two more history-scaled costs: exposed
  days no longer scan the whole fetched event list (11.3ms/17 misses before,
  <0.1ms total after), and MarginNotes memoizes its note index across unchanged
  event snapshots. A separate deferred-query regression reproduced stale
  `listEvents` results replacing a newer range; `useEvents` now ignores older
  completions. A 4,000-event production trace then found the fetch-boundary
  hitch: refreshing the padded range replaced event identities and cleared
  every date's layout caches. Stable snapshots plus per-date invalidation now
  reduce a fetch-boundary App commit from 24ms to 13.2ms and rebuild 6 day
  layouts rather than 17. The all-day lane also filtered all history in each
  column (67ms over the pan); a day index reduces lookups to 0.1ms total and
  retains 40-day events via a long-span fallback. Corrected the 4,000-event
  fixture to generate its claimed 8 AM New York times across DST. A timed-index
  loop optimization cut build time to 2.7ms normal / 7.5–7.6ms at 4x, and its
  introduced midnight-end regression is now fixed with a dedicated test; both
  narrow text-law cases that exposed it pass. Normal synthetic timed pan has
  p95/max 16.7ms and no >25ms frame; browser-delivered input has p95/max
  16.7/16.8ms and 0.4–0.7ms wheel-to-transform latency. Two 4x timed runs still
  show 8–10 >25ms frames (p95 33.4–50ms, max 50–83.3ms; App commit up to
  28.5ms); all-day 4x p95 16.8ms with two >25ms frames. Full suite: 312 passed
  / 64 skipped. These are not real Mac trackpad/WKWebView results; keep the
  issue open and validate on the affected device before claiming lag is fixed.
  The follow-up fixture now controls density rather than total history: 90
  overlapping events/day keeps normal delivered-input p95 at 16.8ms. At
  120/day, 9 visible + 2 overscan days contain 1,320 cluster rows. Before the
  clock-cache fix, one run measured p95 33.4ms/max 49.9ms (7 gaps >25ms);
  hiding row paints removed those misses, but the user explicitly requires
  every row stay visible, so do not collapse, virtualize, or hide rows. A
  30-second clock tick had needlessly rebuilt all 11 day subtrees (400 row
  buttons) without a status change. Per-row past/reconciliation signatures
  now keep row DOM stable on no-op ticks; a boundary regression checks that
  ended rows still update. Five post-fix 120/day browser-input profiles have
  p95 16.7–16.8ms and max 33.4ms, with 1–6 long gaps outside wheel handling
  and usually outside WeekView commits. A paired browser-input control at
  45/day (495 events) had p95/max 16.7/16.8ms, no >25ms gaps, and max 2.6ms
  WeekView commit; 120/day (1,320 events) had p95/max 16.8/33.3ms, two >25ms
  RAF gaps, max 6.4ms WeekView commit, and <=0.8ms wheel-to-transform latency.
  Those two slow frames contained no wheel packet or app commit. The CDP trace
  saw software-renderer DrawAndSwap up to 25.9ms. Headless Chromium's software
  renderer is a confounder; physical macOS trackpad/WebKit remains unverified.
  A final 120/day input repeat after the code changes still measured 16.7ms
  p50/p95 and 33.3ms max (three >25ms gaps); each gap had no wheel packet or
  WeekView commit. Wheel-to-transform max was 0.6ms; transform-write JS max
  0.3ms; largest WeekView commit 5ms.
  User's macOS trackpad report says the residual spikes happen continuously,
  not only at day-boundary shifts, and are much worse at high event density.
  Therefore a boundary-only React-commit explanation is inadequate; the
  continuous presentation/compositor path remains unproven without a Mac trace.
  A 240/day production Chromium trace (2,640 fixture events, all rows retained)
  measured max 50ms RAF gap (three >25ms), with no wheel packet or WeekView
  commit during those gaps; wheel-to-transform max was 0.6ms, largest commit
  4.9ms. CDP recorded ProxyMain::BeginMainFrame to 30.2ms and DrawAndSwap near
  21.1ms. Linux density correlation is stronger; Mac WKWebView is still unknown.
  The historical `panPaint` metric timed only synchronous CSS transform
  property writes, not actual paint/presentation; it is now labeled
  transform-write duration, and compositor timing comes from the browser
  trace.
  Superseded annotation-worker jobs are canceled; a new delayed-worker E2E
  proved that a pre-pan placement could otherwise commit margin DOM mid-gesture.
  Horizontal input now cancels that job and settled placement waits 220ms after
  the last packet; the regression is green. Post-fix five-run profiling was
  variable (4/5 p95 passes; one p95 33.3ms), while an isolated run had p95
  16.7ms, max 33.4ms, no long-animation frame, and ~1.36s placement for 30 notes.
  Delayed-worker erase and attendee-preservation regressions are green. The
  latest full suite passes 329/393 (64 intentional skips, 0 failures). Keep all
  rows visible as requested. Real Mac trackpad/WebKit remains unverified.

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
- [F] Fixed-count “this and following” no longer waits on Google instance pagination before optimistic split; latency E2E verifies immediate UI and exact remaining COUNT. Native Linux path awaits GTK/WebKit dev deps.
- [F] delete series (context menu + panel); mock mirrors Google master-delete semantics
- [OK] fuzz seeds 42 & 1337 clean; full sweep green (8 rust, 73 e2e, live round-trip)

## Final verification sweep (14:15Z): 8 cargo + 73 playwright + live round-trip all green.
