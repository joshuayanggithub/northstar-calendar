#!/usr/bin/env bash
# Launch the real Tauri webview against an isolated database with Google sync
# disabled. macOS snapshots the live DB by default; Linux seeds a disposable
# fixture and runs under a private Xvfb. Override the data with
# CAL_SANDBOX_SOURCE_DB, and on Linux the display with CAL_E2E_DISPLAY.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
SANDBOX_DIR=${CAL_SANDBOX_DIR:-${TMPDIR:-/tmp}/northstar-calendar/cal-sandbox}
PID_FILE="$SANDBOX_DIR/app.pid"
OS=$(uname -s)
CARGO_BIN=$(command -v cargo || true)
if [[ -z "$CARGO_BIN" && -x "$HOME/.cargo/bin/cargo" ]]; then
  CARGO_BIN="$HOME/.cargo/bin/cargo"
fi
RUST_PATH=${CARGO_BIN:+$(dirname "$CARGO_BIN"):}$PATH

case "$SANDBOX_DIR" in
  ""|/) echo "refusing unsafe CAL_SANDBOX_DIR: '$SANDBOX_DIR'"; exit 2 ;;
esac

webdriver_ready() {
  curl -fsS http://127.0.0.1:4445/status 2>/dev/null | grep -q '"ready":true'
}

# every process under pid, deepest first
descendants() {
  local child
  for child in $(pgrep -P "$1"); do
    descendants "$child"
    echo "$child"
  done
}

stop_app() {
  if [[ -f "$PID_FILE" ]]; then
    pid=$(tr -cd '0-9' < "$PID_FILE")
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      if [[ "$OS" == Linux ]]; then
        target=(-- "-$pid")
      else
        # npm → tauri → cargo → the app: macOS has no setsid process group
        # to signal, and killing npm alone leaves the app up (the next run
        # then reuses it, data and all), so take the whole tree
        target=($(descendants "$pid") "$pid")
      fi
      kill "${target[@]}" 2>/dev/null || kill "$pid" 2>/dev/null || true
      # wait for it to let go of :1420/:4445/:14211, so a run right after
      # this one doesn't find the old app still answering
      for _ in $(seq 1 50); do
        kill -0 "${target[@]}" 2>/dev/null || break
        sleep 0.2
      done
      kill -9 "${target[@]}" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
}

case "${1:-start}" in
  start)
    if webdriver_ready; then
      echo "a debug app is already up on :4445"
      exit 0
    fi
    mkdir -p "$SANDBOX_DIR"
    rm -f "$SANDBOX_DIR/calendar.db" "$SANDBOX_DIR/calendar.db-wal" "$SANDBOX_DIR/calendar.db-shm"

    default_source=""
    if [[ "$OS" == Darwin ]]; then
      default_source="$HOME/Library/Application Support/com.joshuayang.calendar-app/calendar.db"
    fi
    source_db=${CAL_SANDBOX_SOURCE_DB:-$default_source}
    if [[ -n "$source_db" && -f "$source_db" ]]; then
      # a WAL database nobody has open has no -shm, and read-only can't make
      # one: a given source file that isn't the live DB is static, so it can
      # be read as immutable instead
      if ! sqlite3 -readonly "file:$source_db?mode=ro" ".backup '$SANDBOX_DIR/calendar.db'" 2>/dev/null; then
        if [[ -n "${CAL_SANDBOX_SOURCE_DB:-}" && "$source_db" != "$default_source" ]]; then
          sqlite3 -readonly "file:$source_db?mode=ro&immutable=1" ".backup '$SANDBOX_DIR/calendar.db'"
        else
          echo "could not snapshot $source_db"
          exit 2
        fi
      fi
      echo "snapshotted sandbox source: $source_db"
    elif [[ -n "${CAL_SANDBOX_SOURCE_DB:-}" ]]; then
      echo "CAL_SANDBOX_SOURCE_DB does not exist: $CAL_SANDBOX_SOURCE_DB"
      exit 2
    else
      if [[ -z "$CARGO_BIN" ]]; then
        echo "cargo is required; run ./e2e/setup_linux.sh"
        exit 1
      fi
      "$CARGO_BIN" run --quiet -p sync-core --example seed_e2e -- "$SANDBOX_DIR/calendar.db"
    fi

    extra=()
    if curl -fsS -o /dev/null http://127.0.0.1:1420/ 2>/dev/null; then
      extra=(-- --config '{"build":{"beforeDevCommand":""}}')
    fi

    if [[ "$OS" == Linux && -n "${CAL_E2E_DISPLAY:-}" ]]; then
      # an existing X display, e.g. the SSH-forwarded one to watch the run
      # (CAL_E2E_DISPLAY=$DISPLAY) or an Xvfb you started yourself
      nohup setsid env CAL_SANDBOX="$SANDBOX_DIR" PATH="$RUST_PATH" DISPLAY="$CAL_E2E_DISPLAY" \
        npm run tauri dev ${extra[@]+"${extra[@]}"} > "$SANDBOX_DIR/app.log" 2>&1 &
    elif [[ "$OS" == Linux ]]; then
      command -v xvfb-run >/dev/null || {
        echo "xvfb-run is required; run ./e2e/setup_linux.sh"
        exit 1
      }
      nohup setsid env CAL_SANDBOX="$SANDBOX_DIR" PATH="$RUST_PATH" xvfb-run -a -s "-screen 0 1600x1000x24" \
        npm run tauri dev ${extra[@]+"${extra[@]}"} > "$SANDBOX_DIR/app.log" 2>&1 &
    else
      nohup env CAL_SANDBOX="$SANDBOX_DIR" PATH="$RUST_PATH" npm run tauri dev ${extra[@]+"${extra[@]}"} \
        > "$SANDBOX_DIR/app.log" 2>&1 &
    fi
    echo $! > "$PID_FILE"

    for _ in $(seq 1 300); do
      if webdriver_ready; then
        grep -rq "SANDBOX: data in" "$SANDBOX_DIR/logs" 2>/dev/null || {
          echo "app is up but did not report sandbox mode; stopping it"
          stop_app
          exit 1
        }
        python3 "$ROOT/e2e/sandbox_mirror.py" || true
        echo "sandbox app up (data: $SANDBOX_DIR, sync off, pid: $(cat "$PID_FILE"))"
        exit 0
      fi
      if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "sandbox app exited; see $SANDBOX_DIR/app.log"
        exit 1
      fi
      sleep 1
    done
    echo "sandbox app did not come up; see $SANDBOX_DIR/app.log"
    stop_app
    exit 1
    ;;
  stop)
    stop_app
    echo "sandbox app stopped"
    ;;
  *)
    echo "usage: $0 start|stop"
    exit 2
    ;;
esac
