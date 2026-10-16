# Real-window QA sprint vs Notion Calendar (ground truth), 2026-10-14

Method: Notion Calendar in Chrome (user's real data) as interaction ground
truth; the in-app WebDriver (:4445) probing the real WKWebView window.
No mutations to real events; probes use hook-created `qa-probe` events.

## Findings

| # | Area | Notion ground truth | Ours | Status |
|---|---|---|---|---|
| 1 | Short chips (~<=30min) | one line: `TITLE  start-time` inline, muted time | title only, time hidden | FIXED |
| 2 | Tall chips | title wraps over multiple lines, clamps with ellipsis | single line ellipsis always | FIXED |
| 3 | Accent bar | rounded capsule notch at left | flat full-height inset bar | logged (polish) |
| 4 | Cursors | chip body: default arrow; resize zone: row-resize | chip: pointer, resize: ns-resize | FIXED |
| 5 | Hover | subtle bg shift only; no shadow, no z-pop, no transform | drop shadow + z-index 3 on hover | FIXED |
| 6 | Chip ring | 1px bg-colored ring on every chip | ours added for layering separation | validated ✓ |
| 7 | Scroll anchoring | week nav (next/prev/today) preserves scroll exactly | every nav re-centered on now/7am | FIXED |
| 8 | Real-window drag | — | PointerEvent drag −1h: snapped exactly, persisted to SQLite, ⌘Z restored | verified ✓ |
| 9 | Real-window resize | — | handle drag +30min persisted | verified ✓ |
| 10 | execute/sync caveat | — | plugin's execute is non-async; use :14211 eval for awaited sequences | documented |
| 11 | Light mode | user runs light; slabs invisible on white | theme-aware slab tint + light-only hairline border; light visual project added | FIXED |
| 3b | Accent bar | rounded capsule notch | now a ::before capsule (3px, rounded, inset); flat bar shadows removed everywhere | FIXED |
| 12 | Month rows | tinted mini-pills: notch + muted time + colored title | plain dot rows | FIXED |
| 13 | Time fields | focus opens 15-min dropdown; end options labeled with duration | raw time inputs only | FIXED (typing still works) |
| 14 | Weekend columns | barely-there gray wash | plain | FIXED (week + month) |
| 15 | Tiny chips (card-stack floor / deep zoom) | — | 13px chips sliced their 15px text; found by new real-window text invariant on live data | FIXED (chip-xs tier) |
| 16 | Day view | — | 1-col layering verified live (38 chips / 18 slabs) | verified ✓ |
| 17 | Past events | ghosted: desaturated toward gray, text legible | plain 0.55 opacity kept too much color in light | FIXED (saturate 0.35 + 0.7 opacity) |
| 18 | Ctx menu | color swatches · Block on calendar · Cut ⌘X · Copy ⌘C · Duplicate ⌘D · Delete | had Open/Duplicate/Delete only | Cut+Copy ADDED; color swatches → backlog (needs event colorId through sync) |
| 19 | Gutter tz label | "EDT" atop the time gutter | blank corner | FIXED |
| 20 | All-day lane | click drafts an all-day event; drag spans days | lane was inert | click-create FIXED; multi-day drag → backlog |

## Session 2 wrap (18:0x–19:00 EDT)

Shipped this hour (each with regression tests, both themes, suite green):
short-chip inline times · wrapped titles · chip-xs tier (fixes sliced 13px
cards found live) · cursor conventions · calm hover/selected · scroll
anchoring on nav · light visual project + slab visibility in light · accent
capsule · month pill rows · 15-min time dropdown with durations · weekend
wash · past-event ghosting · ctx-menu Cut/Copy · all-day click-create ·
gutter tz label. Real-window suite extended with text-anatomy invariants.

Backlog: per-event color swatches (needs colorId e2e; user has 0 colorId
events today) · all-day multi-day drag-create · Notion "Block on calendar".
| 20b | All-day lane | drag across days spans the draft | implemented: drag Sun→Tue drafts a 3-day all-day event; panel gained an all-day end-date field; save verified | FIXED |
