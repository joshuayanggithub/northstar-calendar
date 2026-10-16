"""Run the mock E2E suite repeatedly until a UTC deadline, keeping every log.

Example: python3 e2e/stress_loop.py --until 2026-10-15T13:55:46+00:00
"""

import argparse
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path


parser = argparse.ArgumentParser()
parser.add_argument("--until", required=True, help="ISO 8601 deadline with timezone")
parser.add_argument("--interval", type=int, default=900, help="seconds between run starts")
args = parser.parse_args()

end = datetime.fromisoformat(args.until).astimezone(timezone.utc).timestamp()
if args.interval < 60:
    parser.error("interval must be at least 60 seconds")
root = Path(__file__).resolve().parents[1]
day = datetime.fromtimestamp(end, timezone.utc).date().isoformat()
log_dir = root / "logs" / f"stress-{day}"
os.umask(0o077)
log_dir.mkdir(parents=True, exist_ok=True)

while time.time() < end:
    started = time.time()
    stamp = datetime.fromtimestamp(started, timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    log = log_dir / f"{stamp}.log"
    command = [
        "npx", "playwright", "test", "e2e/smoke.spec.ts", "e2e/realdata.spec.ts",
        "--reporter=line", f"--output={log_dir / stamp}",
    ]
    env = dict(os.environ, PLAYWRIGHT_BROWSERS_PATH="0")
    try:
        with log.open("w") as out:
            result = subprocess.run(command, cwd=root, env=env, stdout=out,
                                    stderr=subprocess.STDOUT, timeout=600, check=False)
        code = result.returncode
    except subprocess.TimeoutExpired:
        code = 124
        with log.open("a") as out:
            out.write("\nE2E run timed out after 600 seconds\n")
    except Exception as error:
        code = 125
        with log.open("a") as out:
            out.write(f"\nRunner error: {error}\n")
    summary = re.findall(r"\d+ (?:passed|failed|skipped)", log.read_text(errors="replace"))
    line = f"{stamp}\tcode={code}\t{', '.join(summary[-3:])}\t{log}\n"
    with (log_dir / "index.tsv").open("a") as index:
        index.write(line)
    print(line, end="", flush=True)
    time.sleep(max(0, min(started + args.interval, end) - time.time()))

print("stress window complete", flush=True)
