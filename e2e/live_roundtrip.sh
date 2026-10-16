#!/bin/bash
# Clickless end-to-end test of the REAL app against the REAL Google Calendar.
# Requires: `npm run tauri dev` running (debug build => test hook on :14211)
# and Google connected. Asserts push acceptance via etag + drained queue.
set -euo pipefail
HOOK=http://127.0.0.1:14211
DB="$HOME/Library/Application Support/com.joshuayang.calendar-app/calendar.db"
CAL="${1:?usage: live_roundtrip.sh <calendar id, e.g. your Google account email>}"

hook() { curl -sf -X POST "$HOOK" -d "$1"; }
pending() { hook '{"cmd":"pending_ops"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['count'])"; }

start=$(date -v+2d -u +%Y-%m-%dT14:00:00Z); end=$(date -v+2d -u +%Y-%m-%dT15:00:00Z)
id=$(hook "{\"cmd\":\"create_event\",\"input\":{\"calendar_id\":\"$CAL\",\"summary\":\"e2e-live-roundtrip\",\"start\":\"$start\",\"end\":\"$end\",\"all_day\":false}}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['id'])")
echo "created $id"

for i in $(seq 1 15); do
  etag=$(sqlite3 "$DB" "SELECT etag IS NOT NULL FROM events WHERE id='$id';")
  [ "$etag" = "1" ] && [ "$(pending)" = "0" ] && { echo "PUSH OK (~$((i*2))s)"; ok=1; break; }
  sleep 2
done
[ "${ok:-0}" = "1" ] || { echo "FAIL: create not pushed"; exit 1; }

hook "{\"cmd\":\"delete_event\",\"calendar_id\":\"$CAL\",\"event_id\":\"$id\"}" > /dev/null
for i in $(seq 1 15); do
  [ "$(pending)" = "0" ] && [ -z "$(sqlite3 "$DB" "SELECT id FROM events WHERE id='$id';")" ] \
    && { echo "DELETE OK (~$((i*2))s)"; exit 0; }
  sleep 2
done
echo "FAIL: delete not pushed"; exit 1
