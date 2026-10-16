"""Convert a disposable Google recurring series both ways, then delete it."""

import json
import time

from live_series_move import call, instances
from live_allday_series_shift import master_resource


TITLE = "qa-probe series mode (auto, self-deletes)"


def patch_master(calendar_id, master_id, patch):
    return call({"cmd": "eval", "script": f"""
        await window.__TAURI_INTERNALS__.invoke('update_series_master', {{
          calendarId:{json.dumps(calendar_id)}, masterId:{json.dumps(master_id)},
          patch:{json.dumps(patch)}
        }});
        return true;
    """})


def wait_for(master_id, start_values):
    for _ in range(30):
        call({"cmd": "sync_now"})
        rows = instances(master_id)
        if sorted(row["start"] for row in rows) == start_values and \
                call({"cmd": "pending_ops"})["count"] == 0:
            return rows
        time.sleep(2)
    raise RuntimeError(f"series did not settle: {[r['start'] for r in instances(master_id)]}")


def main():
    if call({"cmd": "pending_ops"})["count"]:
        raise RuntimeError("pre-existing pending operations; probe not started")
    source = next(c for c in call({"cmd": "list_calendars"})
                  if c["is_primary"] and c["access_role"] in ("owner", "writer"))
    master_id = None
    try:
        master_id = call({"cmd": "create_event", "input": {
            "calendar_id": source["id"], "summary": TITLE,
            "description": "Automated QA probe; self-deletes after mode verification.",
            "location": None, "start": "2026-10-16T18:00:00-04:00",
            "end": "2026-10-16T18:30:00-04:00", "all_day": False,
            "recurrence": ["RRULE:FREQ=DAILY;COUNT=2"],
        }})["id"]
        for _ in range(30):
            call({"cmd": "sync_now"})
            if len(instances(master_id)) == 2 and call({"cmd": "pending_ops"})["count"] == 0:
                break
            time.sleep(2)
        else:
            raise RuntimeError("timed series did not sync")
        patch_master(source["id"], master_id, {
            "start": {"date": "2026-10-16", "dateTime": None, "timeZone": None},
            "end": {"date": "2026-10-17", "dateTime": None, "timeZone": None},
        })
        master = master_resource(source["id"], master_id)
        if master["start"].get("date") != "2026-10-16":
            raise RuntimeError(f"Google master did not become all-day: {master}")
        wait_for(master_id, ["2026-10-16", "2026-10-17"])
        print("timed to all-day synced both instances", flush=True)
        patch_master(source["id"], master_id, {
            "start": {"dateTime": "2026-10-16T09:00:00-04:00", "timeZone": "America/New_York", "date": None},
            "end": {"dateTime": "2026-10-16T09:30:00-04:00", "timeZone": "America/New_York", "date": None},
        })
        master = master_resource(source["id"], master_id)
        if not master["start"].get("dateTime") or master["start"].get("date"):
            raise RuntimeError(f"Google master did not become timed: {master}")
        for _ in range(30):
            call({"cmd": "sync_now"})
            rows = instances(master_id)
            if len(rows) == 2 and all(not row["all_day"] for row in rows) and \
                    call({"cmd": "pending_ops"})["count"] == 0:
                print("all-day to timed synced both instances", flush=True)
                break
            time.sleep(2)
        else:
            raise RuntimeError(f"timed instances did not settle: {instances(master_id)}")
    finally:
        if master_id:
            call({"cmd": "delete_event", "calendar_id": source["id"], "event_id": master_id})
            for _ in range(30):
                call({"cmd": "sync_now"})
                if not instances(master_id) and call({"cmd": "pending_ops"})["count"] == 0:
                    print("series deleted and queue drained", flush=True)
                    break
                time.sleep(2)
            else:
                raise RuntimeError("series cleanup did not settle")


if __name__ == "__main__":
    main()
