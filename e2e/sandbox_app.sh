#!/bin/bash
# Run the debug app (test hook :14211, WebDriver :4445) on a SNAPSHOT of the
# real calendar DB with Google sync off (CAL_SANDBOX, src-tauri/src/state.rs)
# and the everyday app's UI settings (e2e/sandbox_mirror.py),
# so the real WKWebView window can be tested while the everyday app keeps
# running on the live data. Nothing it does reaches Google or the live DB.
#   e2e/sandbox_app.sh start   # snapshot the DB read-only, launch, wait for WebDriver
#   e2e/sandbox_app.sh stop
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=${CAL_SANDBOX_DIR:-/tmp/claude/cal-sandbox}
LIVE="$HOME/Library/Application Support/com.joshuayang.calendar-app/calendar.db"

case "${1:-start}" in
  start)
    if curl -s http://127.0.0.1:4445/status | grep -q '"ready":true'; then
      echo "a debug app is already up on :4445"; exit 0
    fi
    mkdir -p "$DIR"
    rm -f "$DIR"/calendar.db "$DIR"/calendar.db-wal "$DIR"/calendar.db-shm
    sqlite3 -readonly "file:$LIVE?mode=ro" ".backup '$DIR/calendar.db'"
    # reuse a dev server already serving this repo on :1420 (strictPort)
    EXTRA=()
    if curl -s -o /dev/null http://127.0.0.1:1420/; then
      EXTRA=(-- --config '{"build":{"beforeDevCommand":""}}')
    fi
    CAL_SANDBOX="$DIR" nohup npm run tauri dev "${EXTRA[@]}" > "$DIR/app.log" 2>&1 &
    for _ in $(seq 1 300); do
      if curl -s http://127.0.0.1:4445/status | grep -q '"ready":true'; then
        grep -rq "SANDBOX: data in" "$DIR/logs" 2>/dev/null \
          || { echo "app is up but did not report sandbox mode; stopping it"; "$0" stop; exit 1; }
        # same UI settings as the everyday app (seam style, stars, recon...)
        python3 "$(dirname "$0")/sandbox_mirror.py" || true
        echo "sandbox app up (data: $DIR, sync off)"
        exit 0
      fi
      sleep 1
    done
    echo "sandbox app did not come up; see $DIR/app.log"
    exit 1
    ;;
  stop)
    pkill -f "target/debug/calendar-app" || true
    pkill -f "tauri dev" || true
    echo "sandbox app stopped"
    ;;
  *)
    echo "usage: $0 start|stop"
    exit 2
    ;;
esac
