#!/usr/bin/env bash
# One command for isolated, real-webview E2E on macOS or Linux.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cleanup() { "$ROOT/e2e/sandbox_app.sh" stop; }
trap cleanup EXIT INT TERM
"$ROOT/e2e/sandbox_app.sh" start
OUT=${CAL_E2E_OUTPUT:-${TMPDIR:-/tmp}/northstar-calendar/real-window}
"$ROOT/e2e/real_window.sh" "$OUT"
python3 "$ROOT/e2e/native_regressions.py" "$OUT"
