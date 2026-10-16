"""Move a disposable two-occurrence series through the real editor, then delete it."""

import json
import time
import urllib.error
import urllib.request

HOOK = "http://127.0.0.1:14211"
TITLE = "qa-probe series move (auto, self-deletes)"
START = "2026-10-16T18:00:00-04:00"
END = "2026-10-16T18:30:00-04:00"


def call(payload):
    request = urllib.request.Request(
        HOOK, json.dumps(payload).encode(), {"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(json.load(error).get("error", str(error))) from error
    if not data.get("ok"):
        raise RuntimeError(data.get("error", data))
    return data["result"]


def instances(master_id):
    return [
        row for row in call({
            "cmd": "list_events", "start": "2026-10-16T00:00:00Z", "end": "2026-10-19T00:00:00Z"
        }) if row.get("recurring_event_id") == master_id
    ]


def wait_for(master_id, calendar_id, count):
    for _ in range(30):
        call({"cmd": "sync_now"})
        rows = instances(master_id)
        if (len(rows) == count and all(r["calendar_id"] == calendar_id for r in rows)
                and call({"cmd": "pending_ops"})["count"] == 0):
            return rows
        time.sleep(2)
    raise RuntimeError(f"sync did not settle: {[(r['calendar_id'], r['id']) for r in instances(master_id)]}")


def main():
    if call({"cmd": "pending_ops"})["count"]:
        raise RuntimeError("pre-existing pending operations; probe not started")
    calendars = call({"cmd": "list_calendars"})
    source = next(c for c in calendars if c["is_primary"] and c["access_role"] in ("owner", "writer"))
    dest = next(c for c in calendars if c["id"] != source["id"] and not c["hidden"]
                and c["access_role"] in ("owner", "writer"))
    master_id = None
    moved = False
    old_scroll = None
    try:
        master_id = call({"cmd": "create_event", "input": {
            "calendar_id": source["id"], "summary": TITLE,
            "description": "Automated QA probe; self-deletes after series move verification.",
            "location": None, "start": START, "end": END, "all_day": False,
            "recurrence": ["RRULE:FREQ=DAILY;COUNT=2"],
        }})["id"]
        wait_for(master_id, source["id"], 2)
        print("two recurring instances synced on source", flush=True)
        old_scroll = call({"cmd": "eval", "script": f"""
            const grid = document.querySelector('[data-testid=week-grid]');
            const oldScroll = grid.scrollTop;
            let chip = [...document.querySelectorAll('.chip-timed')].find(
              el => el.title?.startsWith({json.dumps(TITLE)}));
            if (!chip) throw new Error('probe instance not rendered');
            chip.scrollIntoView({{block:'center'}});
            await new Promise(r => setTimeout(r, 100));
            chip = [...document.querySelectorAll('.chip-timed')].find(
              el => el.title?.startsWith({json.dumps(TITLE)}));
            const rect = chip.getBoundingClientRect();
            const p = {{bubbles:true, clientX:rect.x+Math.min(20,rect.width/2),
              clientY:rect.y+Math.min(8,rect.height/2), pointerId:91,
              isPrimary:true, button:0}};
            chip.dispatchEvent(new PointerEvent('pointerdown',p));
            window.dispatchEvent(new PointerEvent('pointerup',p));
            await new Promise(r => setTimeout(r, 150));
            if (!document.querySelector('[data-testid=event-panel]'))
              throw new Error('event panel did not open');
            return oldScroll;
        """})
        stage = call({"cmd": "eval", "script": f"""
            const panel = document.querySelector('[data-testid=event-panel]');
            if (!panel) return {{stage:'panel missing'}};
            panel.querySelector('[data-testid=panel-cal-trigger]').click();
            await new Promise(r => setTimeout(r, 50));
            const menu = panel.querySelector('[data-testid=panel-cal-options]');
            if (!menu) return {{stage:'calendar dropdown missing'}};
            const option = [...menu.querySelectorAll('.panel-cal-option')].find(
              el => el.textContent.trim() === {json.dumps(dest['summary'])});
            if (!option) return {{stage:'destination calendar missing'}};
            option.click();
            await new Promise(r => setTimeout(r, 50));
            if (!panel.querySelector('[data-testid=panel-cal-trigger]').textContent.includes(
                {json.dumps(dest['summary'])})) return {{stage:'calendar selection lost'}};
            const save = panel.querySelector('.panel-footer .btn-accent');
            if (!save) return {{stage:'save button missing'}};
            save.click();
            await new Promise(r => setTimeout(r, 250));
            return {{stage:'saved', scope:!!document.querySelector('[data-testid=scope-dialog]'),
                toast:document.querySelector('[data-testid=toast]')?.textContent || ''}};
        """})
        if stage.get("stage") != "saved" or not stage.get("scope"):
            raise RuntimeError(f"editor did not reach scope dialog: {stage}")
        call({"cmd": "eval", "script": """
            document.querySelector('[data-testid=scope-dialog]')
              .querySelector('[data-testid=scope-all]').click();
            return true;
        """})
        for _ in range(20):
            result = call({"cmd": "eval", "script": """
                return {toast: document.querySelector('[data-testid=toast]')?.textContent || '',
                    dialog: !!document.querySelector('[data-testid=scope-dialog]')};
            """})
            if "Updated all" in result["toast"]:
                moved = True
                break
            if "Series update failed" in result["toast"]:
                raise RuntimeError(result["toast"])
            time.sleep(0.5)
        if not moved:
            raise RuntimeError("series move did not complete")
        wait_for(master_id, dest["id"], 2)
        print(f"both instances synced on {dest['summary']}", flush=True)
    finally:
        if old_scroll is not None:
            try:
                call({"cmd": "eval", "script": f"""
                    document.querySelector('[data-testid=week-grid]').scrollTop = {old_scroll};
                    return true;
                """})
            except Exception:
                pass
        if master_id:
            calendar_id = dest["id"] if moved else source["id"]
            call({"cmd": "delete_event", "calendar_id": calendar_id, "event_id": master_id})
            for _ in range(30):
                call({"cmd": "sync_now"})
                if not instances(master_id) and call({"cmd": "pending_ops"})["count"] == 0:
                    print("series deleted and queue drained", flush=True)
                    break
                time.sleep(2)
            else:
                raise RuntimeError("series cleanup did not settle; inspect Google and pending ops")


if __name__ == "__main__":
    main()
