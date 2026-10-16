"""Edit a disposable COUNT=3 series from its second occurrence, then delete it."""

import json
import time

from live_series_move import call


TITLE = "qa-probe split count (auto, self-deletes)"
EDITED = "qa-probe split edited (auto, self-deletes)"
START = "2026-10-15T00:00:00Z"
END = "2026-10-22T00:00:00Z"


def rows():
    return [event for event in call({"cmd": "list_events", "start": START, "end": END})
            if event["summary"] in (TITLE, EDITED)]


def main():
    if call({"cmd": "pending_ops"})["count"]:
        raise RuntimeError("pre-existing pending operations; probe not started")
    source = next(c for c in call({"cmd": "list_calendars"})
                  if c["is_primary"] and c["access_role"] in ("owner", "writer"))
    masters = set()
    old_scroll = None
    try:
        master = call({"cmd": "create_event", "input": {
            "calendar_id": source["id"], "summary": TITLE,
            "description": "Automated QA probe; self-deletes after split verification.",
            "location": None, "start": "2026-10-16T18:00:00-04:00",
            "end": "2026-10-16T18:30:00-04:00", "all_day": False,
            "recurrence": ["RRULE:FREQ=DAILY;COUNT=3"],
        }})["id"]
        masters.add(master)
        for _ in range(30):
            call({"cmd": "sync_now"})
            if len([r for r in rows() if r.get("recurring_event_id") == master]) == 3 \
                    and call({"cmd": "pending_ops"})["count"] == 0:
                break
            time.sleep(2)
        else:
            raise RuntimeError("COUNT=3 series did not sync")
        print("created starts", [r["start"] for r in rows()], flush=True)
        expanded = call({"cmd": "eval", "script": f"""
            const instances=await window.__TAURI_INTERNALS__.invoke('get_series_instances',{{
              calendarId:{json.dumps(source['id'])},masterId:{json.dumps(master)}
            }});
            return instances.map(i=>({{id:i.id,originalStartTime:i.originalStartTime}}));
        """})
        if len(expanded) != 3:
            raise RuntimeError(f"Google returned {len(expanded)} instances, expected 3")
        for _ in range(20):
            visible = call({"cmd": "eval", "script": f"""
                return [...document.querySelectorAll('[data-testid=day-col-6] .chip-timed')]
                  .some(el=>el.title?.startsWith({json.dumps(TITLE)}));
            """})
            if visible:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("second occurrence did not render on Saturday")
        old_scroll = call({"cmd": "eval", "script": f"""
            const grid=document.querySelector('[data-testid=week-grid]');
            if(!grid) throw Error('week view required');
            const before=grid.scrollTop;
            const chip=[...document.querySelectorAll('[data-testid=day-col-6] .chip-timed')]
              .find(el=>el.title?.startsWith({json.dumps(TITLE)}));
            if(!chip) throw Error('second occurrence not rendered on Saturday');
            const r=chip.getBoundingClientRect();
            const p={{bubbles:true,clientX:r.x+10,clientY:r.y+8,pointerId:92,isPrimary:true,button:0}};
            chip.dispatchEvent(new PointerEvent('pointerdown',p));
            window.dispatchEvent(new PointerEvent('pointerup',p));
            return before;
        """})
        for _ in range(20):
            if call({"cmd": "eval", "script":
                    "return !!document.querySelector('[data-testid=event-panel]')"}):
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("editor did not open")
        call({"cmd": "eval", "script": f"""
            const panel=document.querySelector('[data-testid=event-panel]');
            const title=panel.querySelector('.panel-title');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(title,{json.dumps(EDITED)});
            title.dispatchEvent(new Event('input',{{bubbles:true}}));
            title.dispatchEvent(new Event('change',{{bubbles:true}}));
            panel.querySelector('.panel-footer .btn-accent').click();
            return true;
        """})
        for _ in range(20):
            if call({"cmd": "eval", "script":
                    "return !!document.querySelector('[data-testid=scope-following]')"}):
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("scope dialog did not open")
        call({"cmd": "eval", "script": """
            const follow=document.querySelector('[data-testid=scope-following]');
            if(!follow || follow.disabled) throw Error('following option is disabled');
            follow.click();
            return true;
        """})
        for _ in range(20):
            toast = call({"cmd": "eval", "script":
                          "return document.querySelector('[data-testid=toast]')?.textContent || ''"})
            if "Updated" in toast and "following" in toast:
                break
            if "failed" in toast.lower():
                raise RuntimeError(toast)
            time.sleep(0.5)
        else:
            raise RuntimeError("split action did not complete")
        for _ in range(30):
            call({"cmd": "sync_now"})
            current = rows()
            masters.update(r["recurring_event_id"] for r in current if r.get("recurring_event_id"))
            old = [r for r in current if r["summary"] == TITLE]
            new = [r for r in current if r["summary"] == EDITED]
            if len(old) == 1 and len(new) == 2 and \
                    call({"cmd": "pending_ops"})["count"] == 0:
                print("COUNT=3 split into 1 old + 2 new occurrences", flush=True)
                break
            time.sleep(2)
        else:
            raise RuntimeError(f"incorrect split: {[(r['summary'], r['start']) for r in rows()]}")
    finally:
        if old_scroll is not None:
            try:
                call({"cmd": "eval", "script": f"""
                    document.querySelector('[data-testid=week-grid]').scrollTop={old_scroll};
                    return true;
                """})
            except Exception:
                pass
        try:
            call({"cmd": "sync_now"})
            masters.update(r["recurring_event_id"] for r in rows() if r.get("recurring_event_id"))
        except Exception:
            pass
        for master_id in masters:
            call({"cmd": "delete_event", "calendar_id": source["id"], "event_id": master_id})
        for _ in range(30):
            call({"cmd": "sync_now"})
            if not rows() and call({"cmd": "pending_ops"})["count"] == 0:
                print("both series deleted and queue drained", flush=True)
                break
            time.sleep(2)
        else:
            raise RuntimeError(f"split cleanup did not settle: {rows()}")


if __name__ == "__main__":
    main()
