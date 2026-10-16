"""Shift a disposable all-day series via the real editor, then delete it."""

import json
import time

from live_series_move import call, instances

TITLE = "qa-probe all-day series shift (auto, self-deletes)"


def wait_for(master_id, starts):
    for _ in range(30):
        call({"cmd": "sync_now"})
        rows = instances(master_id)
        if (sorted(row["start"] for row in rows) == starts
                and call({"cmd": "pending_ops"})["count"] == 0):
            return rows
        time.sleep(2)
    raise RuntimeError(f"series dates did not settle: {[r['start'] for r in instances(master_id)]}")


def master_resource(calendar_id, master_id):
    return call({"cmd": "eval", "script": f"""
        const m = await window.__TAURI_INTERNALS__.invoke('get_series_master', {{
          calendarId:{json.dumps(calendar_id)}, masterId:{json.dumps(master_id)}
        }});
        return {{start:m.start,end:m.end,recurrence:m.recurrence,etag:m.etag}};
    """})


def main():
    if call({"cmd": "pending_ops"})["count"]:
        raise RuntimeError("pre-existing pending operations; probe not started")
    source = next(c for c in call({"cmd": "list_calendars"})
                  if c["is_primary"] and c["access_role"] in ("owner", "writer"))
    master_id = None
    try:
        master_id = call({"cmd": "create_event", "input": {
            "calendar_id": source["id"], "summary": TITLE,
            "description": "Automated QA probe; self-deletes after all-day date verification.",
            "location": None, "start": "2026-10-16", "end": "2026-10-17", "all_day": True,
            "recurrence": ["RRULE:FREQ=DAILY;COUNT=2"],
        }})["id"]
        wait_for(master_id, ["2026-10-16", "2026-10-17"])
        print("two all-day instances synced on original dates", flush=True)
        print("master before", master_resource(source["id"], master_id), flush=True)
        print(call({"cmd": "eval", "script": f"""
            return [...document.querySelectorAll('.chip-allday')].filter(el=>el.title==={TITLE!r})
              .map(el=>({{text:el.textContent,day:[...document.querySelectorAll('.allday-cell')]
                .indexOf(el.closest('.allday-cell'))}}));
        """}), flush=True)
        call({"cmd": "eval", "script": f"""
            const chip=[...document.querySelectorAll('.chip-allday')].filter(
              el=>el.title==={TITLE!r}).at(0);
            if(!chip) throw Error('all-day QA chip missing');
            const r=chip.getBoundingClientRect();
            const p={{bubbles:true,clientX:r.x+10,clientY:r.y+10,pointerId:91,isPrimary:true,button:0}};
            chip.dispatchEvent(new PointerEvent('pointerdown',p));
            window.dispatchEvent(new PointerEvent('pointerup',p));
            await new Promise(r=>setTimeout(r,150));
            if(!document.querySelector('[data-testid=event-panel]')) throw Error('editor did not open');
            return true;
        """})
        stage = call({"cmd": "eval", "script": """
            const panel=document.querySelector('[data-testid=event-panel]');
            if(!panel) return {stage:'panel missing'};
            panel.querySelector('.panel-date-pretty').click();
            await new Promise(r=>setTimeout(r,50));
            const input=panel.querySelector('input[type=date]:not(.allday-end)');
            if(!input) return {stage:'date input missing'};
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'2026-10-17');
            input.dispatchEvent(new Event('input',{bubbles:true}));
            input.dispatchEvent(new Event('change',{bubbles:true}));
            input.blur();
            await new Promise(r=>setTimeout(r,80));
            const shown=panel.querySelector('.panel-date-pretty')?.textContent;
            if(!shown?.includes('Oct 17')) return {stage:'date selection lost',shown};
            panel.querySelector('.panel-footer .btn-accent').click();
            await new Promise(r=>setTimeout(r,200));
            return {stage:'saved',scope:!!document.querySelector('[data-testid=scope-dialog]')};
        """})
        if stage.get("stage") != "saved":
            raise RuntimeError(f"editor did not reach scope dialog: {stage}")
        for _ in range(20):
            state = call({"cmd": "eval", "script": """
                return {scope:!!document.querySelector('[data-testid=scope-dialog]'),
                  toast:document.querySelector('[data-testid=toast]')?.textContent || '',
                  panel:!!document.querySelector('[data-testid=event-panel]'),
                  error:document.querySelector('.panel-error')?.textContent || ''};
            """})
            if state["scope"]:
                break
            if "Updated" in state["toast"] or "failed" in state["toast"].lower():
                raise RuntimeError(f"scope dialog skipped: {state}")
            time.sleep(0.5)
        else:
            raise RuntimeError(f"scope dialog did not appear: {state}")
        call({"cmd": "eval", "script": """
            document.querySelector('[data-testid=scope-dialog]')
              .querySelector('[data-testid=scope-all]').click();
            return true;
        """})
        for _ in range(20):
            result = call({"cmd": "eval", "script": """
                return document.querySelector('[data-testid=toast]')?.textContent || '';
            """})
            if "Updated all" in result:
                break
            if "Series update failed" in result:
                raise RuntimeError(result)
            time.sleep(0.5)
        else:
            raise RuntimeError("series update did not complete")
        after = master_resource(source["id"], master_id)
        print("master after", after, flush=True)
        if after["start"].get("date") != "2026-10-17":
            raise RuntimeError("Google master did not move to the requested start date")
        wait_for(master_id, ["2026-10-17", "2026-10-18"])
        print("both all-day instances shifted and synced", flush=True)
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
                raise RuntimeError("all-day series cleanup did not settle")


if __name__ == "__main__":
    main()
