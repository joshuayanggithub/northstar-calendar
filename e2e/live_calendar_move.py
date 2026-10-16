"""One self-cleaning calendar-move probe through the debug app's real sync path."""

import json
import time
import urllib.error
import urllib.request

HOOK = "http://127.0.0.1:14211"
START = "2026-10-16T18:00:00Z"
END = "2026-10-16T18:30:00Z"
TITLE = "qa-probe calendar move (auto, self-deletes)"


def call(command):
    request = urllib.request.Request(
        HOOK,
        json.dumps(command).encode(),
        {"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(json.load(error).get("error", str(error))) from error
    if not data.get("ok"):
        raise RuntimeError(data.get("error", data))
    return data["result"]


def rows(event_id):
    return [
        row for row in call({
            "cmd": "list_events",
            "start": "2026-10-16T00:00:00Z",
            "end": "2026-10-18T00:00:00Z",
        }) if row["id"] == event_id
    ]


def synced(event_id, calendar_id):
    for _ in range(30):
        call({"cmd": "sync_now"})
        found = rows(event_id)
        if (call({"cmd": "pending_ops"})["count"] == 0 and
                len(found) == 1 and found[0]["calendar_id"] == calendar_id and
                found[0].get("etag")):
            return
        time.sleep(2)
    raise RuntimeError(f"sync did not settle on expected calendar; pending={call({'cmd': 'pending_ops'})['count']}")


def main():
    if call({"cmd": "pending_ops"})["count"]:
        raise RuntimeError("pre-existing pending operations; probe not started")
    cals = call({"cmd": "list_calendars"})
    source = next(c for c in cals if c["is_primary"] and c["access_role"] in ("owner", "writer"))
    dest = next(c for c in cals if c["id"] != source["id"] and not c["hidden"]
                and c["access_role"] in ("owner", "writer"))
    data = {
        "calendar_id": source["id"], "summary": TITLE,
        "description": "Automated QA probe; self-deletes after calendar move verification.",
        "location": None, "start": START, "end": END, "all_day": False,
    }
    event_id = None
    scroll_top = None
    try:
        event_id = call({"cmd": "create_event", "input": data})["id"]
        synced(event_id, source["id"])
        print("create synced on primary calendar", flush=True)
        opened = call({"cmd": "eval", "script": """
            const grid = document.querySelector('[data-testid=week-grid]');
            const oldScroll = grid.scrollTop;
            let chip = [...document.querySelectorAll('.chip-timed')].find(
              el => el.title?.startsWith('qa-probe calendar move'));
            if (!chip) throw new Error('probe chip not rendered in current week');
            chip.scrollIntoView({block:'center'});
            await new Promise(r => setTimeout(r, 100));
            chip = [...document.querySelectorAll('.chip-timed')].find(
              el => el.title?.startsWith('qa-probe calendar move'));
            const rect = chip.getBoundingClientRect();
            const p = {bubbles:true, clientX:rect.x+Math.min(20,rect.width/2),
              clientY:rect.y+Math.min(8,rect.height/2), pointerId:91,
              isPrimary:true, button:0};
            chip.dispatchEvent(new PointerEvent('pointerdown',p));
            window.dispatchEvent(new PointerEvent('pointerup',p));
            await new Promise(r => setTimeout(r, 150));
            if (!document.querySelector('[data-testid=event-panel]'))
              throw new Error('event panel did not open');
            return {oldScroll};
        """})
        scroll_top = opened["oldScroll"]
        option_result = call({"cmd": "eval", "script": f"""
            const panel = document.querySelector('[data-testid=event-panel]');
            panel.querySelector('[data-testid=panel-cal-trigger]').click();
            await new Promise(r => setTimeout(r, 50));
            const menu = panel.querySelector('[data-testid=panel-cal-options]');
            if (!menu) throw new Error('calendar dropdown did not open');
            const options = [...menu.querySelectorAll('.panel-cal-option')];
            const colors = options.map(el => getComputedStyle(el.querySelector('.panel-cal-option-dot')).backgroundColor);
            const destination = options.find(el => el.textContent.trim() === {json.dumps(dest['summary'])});
            if (!destination) throw new Error('destination calendar missing from dropdown');
            if (colors.some(color => color === 'rgba(0, 0, 0, 0)'))
              throw new Error('calendar color icon missing');
            destination.click();
            await new Promise(r => setTimeout(r, 50));
            if (!panel.querySelector('[data-testid=panel-cal-trigger]').textContent.includes({json.dumps(dest['summary'])}))
              throw new Error('calendar selection did not update');
            panel.querySelector('.panel-footer .btn-accent').click();
            await new Promise(r => setTimeout(r, 200));
            return {{optionCount: options.length, colors}};
        """})
        print(f"UI dropdown showed {option_result['optionCount']} colored calendars; saved move", flush=True)
        synced(event_id, dest["id"])
        print(f"move synced to {dest['summary']}", flush=True)
        call({"cmd": "sync_now"})
        time.sleep(2)
        assert len(rows(event_id)) == 1 and rows(event_id)[0]["calendar_id"] == dest["id"]
        print("event still on destination after another sync", flush=True)
    finally:
        if scroll_top is not None:
            try:
                call({"cmd": "eval", "script": f"""
                    document.querySelector('[data-testid=week-grid]').scrollTop = {scroll_top};
                    return true;
                """})
            except Exception:
                pass
        if event_id:
            for row in rows(event_id):
                call({"cmd": "delete_event", "calendar_id": row["calendar_id"],
                      "event_id": event_id})
            for _ in range(30):
                call({"cmd": "sync_now"})
                if not rows(event_id) and call({"cmd": "pending_ops"})["count"] == 0:
                    print("probe deleted and queue drained", flush=True)
                    break
                time.sleep(2)
            else:
                raise RuntimeError("probe cleanup did not settle; inspect pending ops and Google")


if __name__ == "__main__":
    main()
