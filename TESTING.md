Common bugs may include 1. UI bugs, new features impelemnted that don't belong int eh right place or look clunky or the title of an event being not shown due to overflowing
container box 2. UX bugs such as selecting an event and it doesnt highlight the entire event body correctly, and using the scroll feature to move horizontally but its constantly
bugging/freezing or reverting several pixels back in the viewport resulting in delay  and uisng the dropdown but it only shows the different calendars and not he corresponding
color icons taht google calendar would show in that same dropdown when omdifying an event's corresponding calendar 3. feature bugs such as trying to modify an event and not being
able to swithc the calendar of the event evne when saving. Also there are those already in the TODO.md.


UI/UX bugs are especially common, we must use end-to-end testing int he app, collect screenshots and verify behavior visually. 

## How to run it

- Root-causing a bug: follow `.claude/skills/bug-root-cause/SKILL.md`
  (reproduce first, find the failing line, fix, add a test that fails on the
  old code).
- Browser (mock backend): `npm run test:e2e`. The browser timezone is pinned
  to America/New_York in `playwright.config.ts`, so results match on any host.
- Real app window (macOS WKWebView or Linux WebKitGTK), sandboxed data and
  Google sync off: `npm run test:e2e:app` runs `e2e/real_window.sh` and
  `e2e/native_regressions.py` (annotation delete from the canvas and the
  editor, no flash, swipe never steps backwards). Linux needs
  `npm run setup:e2e:linux` once. It runs headless under Xvfb; set
  `CAL_E2E_DISPLAY=$DISPLAY` to watch the window instead (works over SSH X
  forwarding).
- Sync engine: `npm run test:rust` (fake Google API, `crates/sync-core/tests`).

Lessons from the 2026-10-16 pass:
- The mock backend can hide native-only bugs. It used to mutate events in
  place (native returns fresh snapshots), and it clears fields the native
  PATCH silently kept. Confirm UI fixes in the real window.
- To catch a one-frame visual glitch, sample at every DOM mutation
  (MutationObserver), not after each input round trip. The old native pan
  probe sampled between wheel events and missed the jitter every time.
- Visual snapshot baselines exist for macOS only; a Linux run writes new
  `-linux.png` files. Don't commit those without reviewing them.
