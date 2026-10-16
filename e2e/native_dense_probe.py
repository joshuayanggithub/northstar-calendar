"""Exercise dense overlaps in the real debug WKWebView with self-deleting events."""

import base64
import json
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from live_calendar_move import call


TITLE = "qa-probe dense"
DAY = datetime(2026, 10, 16, 20, tzinfo=timezone.utc)  # 4 PM EDT
SPANS = [(0, 210), (5, 20), (10, 25), (15, 40),
         (30, 60), (65, 70), (70, 75), (75, 80),
         (120, 165), (130, 160), (135, 150)]
OUT = Path("logs/real-window-2026-10-15/dense-probe.png")


def iso(minutes):
    return (DAY + timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")


def screenshot():
    base = "http://127.0.0.1:4445"
    request = urllib.request.Request(
        base + "/session", b'{"capabilities":{"alwaysMatch":{}}}',
        {"Content-Type": "application/json"}, method="POST")
    sid = json.load(urllib.request.urlopen(request, timeout=8))["value"]["sessionId"]
    try:
        data = json.load(urllib.request.urlopen(base + f"/session/{sid}/screenshot", timeout=8))
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_bytes(base64.b64decode(data["value"]))
    finally:
        urllib.request.urlopen(urllib.request.Request(
            base + f"/session/{sid}", method="DELETE"), timeout=8).close()


def main():
    if call({"cmd": "pending_ops"})["count"]:
        raise RuntimeError("pre-existing pending operations; probe not started")
    primary = next(c for c in call({"cmd": "list_calendars"}) if c["is_primary"])
    created = []
    previous_scroll = None
    try:
        for number, (begin, end) in enumerate(SPANS):
            summary = f"{TITLE} {number:02d} (auto, self-deletes)"
            event_id = call({"cmd": "create_event", "input": {
                "calendar_id": primary["id"], "summary": summary,
                "description": "Automated overlap QA probe; self-deletes.",
                "location": None, "start": iso(begin), "end": iso(end),
                "all_day": False,
            }})["id"]
            created.append((event_id, summary))
        time.sleep(0.5)
        result = call({"cmd": "eval", "script": """
            const grid = document.querySelector('[data-testid=week-grid]');
            if (!grid) throw new Error('not in week view');
            const oldScroll = grid.scrollTop;
            grid.scrollTop = 15 * 48;
            await new Promise(r => setTimeout(r, 160));
            const matches = [...document.querySelectorAll('.chip-timed,.cluster-row')]
              .filter(el => (el.title || '').includes('qa-probe dense') ||
                            (el.textContent || '').includes('qa-probe dense'));
            const issues = [];
            for (const el of matches) {
              const r = el.getBoundingClientRect();
              const label = el.querySelector('.chip-title');
              if (label && label.getBoundingClientRect().bottom > r.bottom + 1.5)
                issues.push((el.title || '').slice(0, 60) + ': sliced title');
            }
            return {oldScroll, count:matches.length,
              labels:matches.map(el => el.title || el.textContent?.trim().slice(0, 70)),
              issues};
        """})
        previous_scroll = result["oldScroll"]
        print(json.dumps(result, indent=2), flush=True)
        if result["issues"]:
            raise RuntimeError(f"native layout issues: {result['issues']}")
        if result["count"] < len(created):
            raise RuntimeError(f"only {result['count']} of {len(created)} probes rendered")
        screenshot()
        print(f"screenshot -> {OUT}", flush=True)
    finally:
        if previous_scroll is not None:
            try:
                call({"cmd": "eval", "script": f"document.querySelector('[data-testid=week-grid]').scrollTop={previous_scroll}; return true;"})
            except Exception as error:
                print(f"could not restore scroll: {error}", flush=True)
        for event_id, _ in created:
            try:
                call({"cmd": "delete_event", "calendar_id": primary["id"], "event_id": event_id})
            except Exception as error:
                print(f"delete failed for {event_id}: {error}", flush=True)
        for _ in range(30):
            call({"cmd": "sync_now"})
            rows = call({"cmd": "list_events", "start": iso(0), "end": iso(240)})
            leftovers = [row["id"] for row in rows if row["id"] in {item[0] for item in created}]
            if not leftovers and call({"cmd": "pending_ops"})["count"] == 0:
                print("all dense probes deleted; sync queue drained", flush=True)
                break
            time.sleep(2)
        else:
            raise RuntimeError(f"probe cleanup incomplete; leftover IDs: {leftovers}")


if __name__ == "__main__":
    main()
