#!/usr/bin/env python3
"""Window restore, proven on the real window (macOS, sandbox app):
for every monitor, place the window there (hook window_set), quit the app
the way ⌘Q does (the Quit item of its own app menu, clicked through System
Events by pid: the native terminate path), relaunch, and read where it
came back (hook window_get). Then the same through app.exit() (hook quit).

  ./e2e/sandbox_app.sh start && python3 e2e/winstate_check.py

Needs the terminal to have Accessibility access (System Events clicks).
"""
import json, os, subprocess, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SANDBOX = os.environ.get("CAL_SANDBOX_DIR") or os.path.join(os.environ.get("TMPDIR", "/tmp"), "northstar-calendar", "cal-sandbox")
HOOK = "http://127.0.0.1:14211/"
TOL = 2.0  # points; macOS may nudge a window by a pixel


def hook(cmd, **args):
    data = json.dumps({"cmd": cmd, **args}).encode()
    req = urllib.request.Request(HOOK, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = json.loads(r.read())
    if not body.get("ok"):
        raise RuntimeError(body.get("error"))
    return body.get("result")


def hook_up():
    try:
        hook("window_get")
        return True
    except Exception:
        return False


def app_pid():
    # (the debug binary is target/debug/calendar-app; the installed app is
    # target/release/…/northstar, never touched here)
    out = subprocess.run(["pgrep", "-f", "target/debug/calendar-app"], capture_output=True, text=True).stdout.split()
    return int(out[0]) if out else None


def wait(pred, secs, what):
    for _ in range(int(secs * 4)):
        if pred():
            return
        time.sleep(0.25)
    raise SystemExit(f"timed out waiting for {what}")


def quit_native(pid):
    """the Quit item of the app's own menu, as ⌘Q: NSApp terminate, no
    ExitRequested first"""
    script = f'''
tell application "System Events"
  set p to first application process whose unix id is {pid}
  set frontmost of p to true
  delay 0.3
  tell p to click last menu item of menu 1 of menu bar item 2 of menu bar 1
end tell'''
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"osascript failed: {r.stderr.strip()}")


POLL = """
set seen to {}
repeat 400 times
  try
    tell application "System Events" to tell process "calendar-app" to set r to {position, size} of window 1
    log r
  end try
  delay 0.01
end repeat
"""


def relaunch():
    """relaunch, with a poller watching the window's frame from the first
    moment it exists (~100 Hz): the frames it saw, in order, come back"""
    poller = subprocess.Popen(["osascript", "-e", POLL], stderr=subprocess.PIPE, text=True)
    subprocess.run([os.path.join(ROOT, "e2e", "sandbox_app.sh"), "start"], check=True, capture_output=True, text=True)
    wait(hook_up, 240, "the sandbox app's hook after relaunch")
    time.sleep(1.0)
    poller.wait(timeout=30)
    frames = []
    for line in poller.stderr.read().splitlines():
        nums = [float(v) for v in line.replace(",", " ").split() if v.replace(".", "").replace("-", "").isdigit()]
        if len(nums) == 4:
            f = {"x": nums[0], "y": nums[1], "w": nums[2], "h": nums[3]}
            if not frames or frames[-1] != f:
                frames.append(f)
    return frames


def close(a, b):
    return all(abs(a[k] - b[k]) <= TOL for k in ("x", "y", "w", "h"))


def log_tail(n=6):
    logs = os.path.join(SANDBOX, "logs")
    try:
        f = sorted(os.listdir(logs))[-1]
        lines = open(os.path.join(logs, f)).read().splitlines()
        return "\n".join(l for l in lines if "window state" in l)[-1500:]
    except Exception as e:
        return f"(no log: {e})"


def main():
    wait(hook_up, 60, "the sandbox app's hook")
    info = hook("window_get")
    monitors = info["monitors"]
    print(f"monitors: {json.dumps(monitors)}")
    failures = []
    rounds = [(m, "native quit (menu)") for m in monitors] + [(monitors[-1], "app.exit (hook quit)")]
    for i, (m, how) in enumerate(rounds):
        w, h = 760 + 40 * i, 560 + 30 * i
        x, y = m["x"] + 60 + 25 * i, m["y"] + 70 + 20 * i
        target = {"x": x, "y": y, "w": w, "h": h}
        hook("window_set", **target)
        time.sleep(0.8)
        placed = {k: hook("window_get")[k] for k in ("x", "y", "w", "h")}
        if not close(placed, target):
            print(f"  note: macOS placed it at {placed} for target {target} (menu bar / edges); using that")
            target = placed
        pid = app_pid()
        if how.startswith("native"):
            quit_native(pid)
        else:
            hook("quit")
        wait(lambda: app_pid() is None, 20, "the app to quit")
        time.sleep(0.5)
        saved = json.load(open(os.path.join(SANDBOX, "window.json")))
        frames = relaunch()
        back = {k: hook("window_get")[k] for k in ("x", "y", "w", "h")}
        # no frame anywhere but the saved spot, from the first one seen
        # (System Events reports the frame's top-left and the content
        # size, as we save them)
        strays = [f for f in frames if abs(f["x"] - target["x"]) > TOL or abs(f["y"] - target["y"]) > TOL]
        ok = close(saved, target) and close(back, target) and frames and not strays
        print(f"[{'ok' if ok else 'FAIL'}] {m.get('name') or 'monitor'} ({m['w']}x{m['h']} @{m['scale']}x) via {how}: target {target} saved {saved} back {back}; frames seen {len(frames)}, elsewhere {strays[:3]}")
        if not ok:
            failures.append((m, how, target, saved, back))
    print(log_tail())
    if failures:
        sys.exit(f"{len(failures)} failure(s)")
    print("window restore: every monitor, both quit paths: ok")


if __name__ == "__main__":
    main()
