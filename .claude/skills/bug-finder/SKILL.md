---
name: bug-finder
description: High-signal correctness review for Northstar Calendar diffs, pull requests, patches, commits, and source files. Use when asked to find or triage bugs, review calendar behavior for regressions, or fix confirmed defects. Prioritize concrete failures in event editing/moving, recurrence and sync, annotations, calendar navigation, dates/timezones, and UI state; avoid style or speculative feedback.
---

# Northstar Calendar Bug Finder

## Objective

Find concrete, change-caused defects in Northstar Calendar with high precision and low churn. Prioritize behavior that can lose or misplace calendar data, confuse an event's state, break a common edit/navigation flow, or make the calendar visibly unstable or slow. Prefer no finding over a weak or speculative one.

## Establish Review Scope

1. Honor the user's review range. Otherwise state the comparison used: merge base for a branch/PR, parent for a commit, or `HEAD` for working-tree changes.
2. Keep unrelated staged, unstaged, untracked, generated, and pre-existing changes out of scope unless asked to review them.
3. Read `AGENTS.md`/`CLAUDE.md`, `TESTING.md`, the complete relevant diff, nearby code, callers, and existing regression tests before judging a changed line. Consult `TODO.md`, `FEATURES.md`, and `e2e/QA-BACKLOG.md` when they describe the behavior under review.
4. If the target or baseline is ambiguous in a way that could change the result, state that rather than guessing.

## Northstar Behavior Map

Trace behavior across the actual app layers; a UI symptom may originate below the component that displays it:

1. **Calendar UI:** `src/components/WeekView.tsx`, `EventPanel.tsx`, `MarginNotes.tsx`, and other view components render events, annotations/notes, selection, and gestures.
2. **App state and actions:** `src/components/App.tsx` owns event actions, selection, panel state, undo, and `db-changed` refresh behavior.
3. **Backend boundary:** `src/lib/backend.ts` invokes Tauri commands; browser tests use `src/lib/mockBackend.ts`.
4. **Native commands and persistence:** `src-tauri/src/lib.rs` applies commands to `crates/sync-core`'s SQLite store and emits database changes.
5. **Google sync:** the sync engine queues local operations, pushes/pulls remote changes, and reconciles echoes and conflicts.

Check both browser/mock and native behavior when the changed path crosses this boundary. The mock must not hide native defects: native reads return fresh snapshots, and native PATCH semantics can distinguish `null` (clear a field) from omission (leave it unchanged). Check the real-webview path for timing, focus, flashing, gesture, and snapshot-identity issues that browser tests cannot prove.

## General Correctness Lens

The calendar-specific checks below supplement this general review checklist; do not skip these categories just because a change is in a calendar feature:

- Incorrect conditions, off-by-one errors, inverted logic, bad defaults, and stale assumptions.
- Missing validation, authorization, escaping, bounds checks, null handling, or error handling.
- Data loss, partial writes, transaction gaps, cache invalidation errors, and inconsistent state.
- Race conditions, ordering bugs, async lifecycle leaks, and retry or idempotency mistakes.
- API contract drift, schema mismatches, unsafe type narrowing, and serialization failures.
- Time, timezone, locale, precision, pagination, filtering, sorting, and resource cleanup bugs.
- Tests that weaken assertions, remove meaningful coverage, or encode behavior contrary to the production contract.

Report these only when the reviewed change makes a concrete failure reachable; do not turn the list into speculative checklist findings.

## Calendar-Specific Bug Lens

Focus on correctness and perceptible behavior in these areas when relevant to the change:

- **Edit, move, resize, delete:** Does Save persist every edited field? Does changing calendars use the correct move operation? Do title, time, description, location, all-day state, and duration survive round trips? Does deleting an annotation/note act on that note rather than its containing event? Do undo, keyboard Delete/Backspace, and repeated input preserve the intended target?
- **Selection and panels:** Does selection continue to refer to the same event after a move or calendar change? Are remotely deleted or hidden events removed from selection? Does a panel close or refresh when its event disappears, instead of saving from a stale snapshot? Do group operations exclude deleted or read-only events?
- **Recurrence and sync:** Are “this event,” “this and following,” and “all events” applied to the correct instances/master? Are fixed `COUNT` and `UNTIL` rules, canceled instances, original start times, and split boundaries preserved? Do series edits appear promptly, preserve per-occurrence notes, and roll back coherently on remote failure? Can retries or sync echoes apply an operation twice?
- **Dates and time:** Distinguish wall-clock time from elapsed duration, local calendar days from 24-hour offsets, and all-day dates from timed instants. Check DST gaps/folds, IANA time zones, overnight and multi-day events, inclusive UI end dates versus exclusive stored ends, and timed/all-day conversions.
- **Pan, drag, and navigation:** Does horizontal wheel input move in the intended direction without losing `deltaX`, snapping backward, freezing, or disturbing vertical scrolling? Do partial swipes, axis-lock transitions, hidden weekends, and settlement stay consistent? Do drag/create/resize previews and commits use the same day/time, including cross-midnight and multi-day cases? Do annotations stay anchored to their events without triggering unrelated grid flashes or excess layout work?
- **Rendering and interaction state:** Are event titles/times legible and actionable in overlaps, clusters, narrow columns, and C-shaped layouts? Does highlighting cover the selected event? Do dialogs, popovers, focus, and keyboard shortcuts target the active control and avoid duplicate actions?

Only raise a UI/UX issue when the change causes a reproducible behavior problem—such as an event becoming unreadable or unclickable, the wrong event appearing selected, a visible flash during an unrelated action, or input latency/jitter—not merely a difference in aesthetic preference.

## Prove Each Candidate

For every finding, establish:

- **Causality:** the reviewed change introduced the defect or makes it newly reachable.
- **Reachability:** a realistic calendar state or user action reaches the path.
- **Failure:** the exact wrong result is identifiable (wrong event/date/calendar, lost field/note, stale UI, duplicate operation, failed gesture, or visible/performance regression).
- **Impact:** explain what the user sees or what data/state is affected.
- **Evidence:** callers, guards, API/storage contracts, tests, and nearby code support rather than disprove the claim.

Trace both sides of changed contracts: UI producer and backend consumer, local write and sync reader, move source and destination, recurring master and instances, annotation and containing event, optimistic update and rollback. Merge symptoms that share a root cause. Do not report pre-existing issues or hypothetical risks unless the user asks for a broader audit.

## Validate Without Overreaching

- For a review-only request, do not edit source, tests, or fixtures. Run only safe, focused checks that materially confirm or refute a candidate; report exactly what ran.
- Prefer a regression test that reproduces the user action and asserts persisted state plus visible UI state. Avoid tests that only check implementation details.
- Use `npm run test:e2e` for browser/mock UI coverage and `npm run test:rust` for sync-core behavior. Use `npm run test:e2e:app` for native-only behavior such as annotation deletion, one-frame flashing, gesture settlement, fresh-snapshot races, or WebKit timing when available.
- For visual or motion defects, inspect screenshots/recorded frames at the point of the mutation or gesture, not only after it settles. Do not treat Chromium results as proof of WebKitGTK/WKWebView behavior.
- Read `TESTING.md` for setup and known limitations. If native Linux dependencies or a physical trackpad are unavailable, name that as a validation gap; do not claim the bug is fixed or absent on that platform.

## Calendar-Oriented Priority

Rate concrete user impact, likelihood, affected workflows, and recoverability. Do not use exploitability as a default criterion for ordinary calendar bugs; consider permission/security implications only when the change actually touches access boundaries.

- `P0`: Broad, immediate failure such as widespread unrecoverable event loss/corruption or the app/calendar becoming unusable for most users.
- `P1`: Severe failure in a core calendar flow, such as common edits or moves silently targeting the wrong event/calendar, recurring changes corrupting many instances, or sync causing broad data loss.
- `P2`: Definite bug in a narrower flow or subset of events, with meaningful user impact or a workable workaround (for example, a specific recurrence split, annotation delete path, or laggy pan mode).
- `P3`: Reachable low-impact edge case or localized visual/interaction defect that does not lose data or block the main flow.

Use the lowest priority supported by evidence. Explain severity through the affected action, event scope, and data/UI consequence—not a generic label.

## Findings and Fixes

Lead with confirmed findings ordered by priority. For each finding:

- Use an imperative title, such as `[P1] Keep the moved event selected under its new calendar ID`.
- Link the shortest useful changed line range when possible. If the root cause is elsewhere, explain how this change exposes it.
- In one compact paragraph, give the trigger, failure, impact, and smallest viable correction.

Do not duplicate findings, pad the report with style feedback, or disguise suggestions as findings. If no credible defects remain, say `No credible bugs found.` Then note only material untested paths or platform gaps.

When the user also asks for fixes, first confirm expected behavior and the proven root cause; make the smallest local correction, add a focused regression for user-visible/data-affecting failures, and run relevant validation. Keep review-only requests read-only. Do not infer authorization for Google account writes, production changes, external messages, or other side effects from a request to review code.
