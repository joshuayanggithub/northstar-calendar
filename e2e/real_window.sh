#!/bin/bash
# Real-window E2E against the live dev app's native webview, via the in-app W3C
# WebDriver endpoint (tauri-plugin-webdriver, debug builds only, :4445).
#
# What the plugin gives us natively: sessions, element find/rect/text,
# execute/sync, screenshots of the real window. Its element-click and
# /actions synthesize DOM Mouse events, not PointerEvents, so grid
# interactions (which listen to pointerdown) are driven via execute with
# dispatched PointerEvents instead.
set -euo pipefail
WD=http://127.0.0.1:4445
OUT=${1:-${TMPDIR:-/tmp}/northstar-calendar/real-window}
mkdir -p "$OUT"

fail() { echo "FAIL: $1"; exit 1; }
js() { # js <script> -> prints value JSON
  curl -s -X POST "$WD/session/$SID/execute/sync" -H 'Content-Type: application/json' \
    --data "$(python3 -c 'import json,sys; print(json.dumps({"script": sys.argv[1], "args": []}))' "$1")" \
    | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['value']))"
}

curl -s "$WD/status" | grep -q '"ready":true' || fail "webdriver endpoint not up (is the debug app running?)"
SID=$(curl -s -X POST "$WD/session" -H 'Content-Type: application/json' -d '{"capabilities":{"alwaysMatch":{}}}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['value']['sessionId'])")
echo "session $SID"

# remember the user's current view so we can restore it
BEFORE=$(js 'return document.querySelector("[data-testid=week-grid]") ? "week" : document.querySelector("[data-testid=month-grid]") ? "month" : document.querySelector(".agendaview") ? "list" : "other"' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin))')
echo "view before: $BEFORE"

# 1. switch to week view with a real keydown
js 'window.dispatchEvent(new KeyboardEvent("keydown", {key: "w", bubbles: true})); return true' > /dev/null
sleep 0.3
js 'return !!document.querySelector("[data-testid=week-grid]")' | grep -q true || fail "week view did not open"

# 2. layered-overlap invariants on real data: no chip may be inset without
#    a slab underneath it, and slabs never leave the column edge staircase-style
VIOLATIONS=$(js 'const cols=[...document.querySelectorAll("[data-testid^=day-col-]")];let bad=0;for(const c of cols){const slabs=[...c.querySelectorAll(".chip-cfull")];for(const s of slabs){if(s.offsetLeft>0&&!slabs.some(o=>o!==s&&o.offsetLeft<s.offsetLeft&&o.offsetTop<s.offsetTop+s.offsetHeight&&o.offsetTop+o.offsetHeight>s.offsetTop))bad++}}return bad')
[ "$VIOLATIONS" = "0" ] || fail "$VIOLATIONS slab(s) inset without an overlapping slab beneath"
echo "layer invariants OK"

# 2b. text anatomy invariants: no sliced titles, no two-line text in short chips
BADTEXT=$(js 'let bad=0;for(const ch of document.querySelectorAll(".chip-timed")){const cr=ch.getBoundingClientRect();const t=ch.querySelector(".chip-title");if(t){const tr=t.getBoundingClientRect();if(tr.bottom>cr.bottom+1.5)bad++}if(cr.height<27&&ch.querySelector(".chip-time"))bad++}return bad')
[ "$BADTEXT" = "0" ] || fail "$BADTEXT chip(s) with sliced or overflowing text"
echo "text anatomy OK"

# 3. open a chip's editor with a real PointerEvent sequence
js 'const el=document.querySelector(".chip-timed, .cluster-row");if(!el)return false;const r=el.getBoundingClientRect();const o={bubbles:true,clientX:r.x+r.width/2,clientY:r.y+8,pointerId:1,isPrimary:true,button:0};el.dispatchEvent(new PointerEvent("pointerdown",o));window.dispatchEvent(new PointerEvent("pointerup",o));return true' > /dev/null
sleep 0.3
js 'return !!document.querySelector("[data-testid=event-panel]")' | grep -q true || fail "panel did not open from pointer sequence"
echo "panel opens from real-webview pointer events OK"
js 'window.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true})); return true' > /dev/null

# 4. screenshot the real window
curl -s "$WD/session/$SID/screenshot" | python3 -c "
import json,sys,base64
open('$OUT/week.png','wb').write(base64.b64decode(json.load(sys.stdin)['value']))"
echo "screenshot -> $OUT/week.png"

# restore the user's view
if [ "$BEFORE" != "week" ] && [ "$BEFORE" != "other" ]; then
  KEY=$([ "$BEFORE" = "month" ] && echo m || echo l)
  js "window.dispatchEvent(new KeyboardEvent(\"keydown\", {key: \"$KEY\", bubbles: true})); return true" > /dev/null
fi
curl -s -X DELETE "$WD/session/$SID" > /dev/null
echo "ALL REAL-WINDOW CHECKS PASSED"
