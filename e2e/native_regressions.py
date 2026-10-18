"""Native-webview regressions for annotations and horizontal swipes.

Runs against the sandboxed debug app (e2e/sandbox_app.sh) through the
in-app WebDriver (:4445) and the debug test hook (:14211), so it exercises
the real Rust store and the platform webview (WebKitGTK / WKWebView), not
the browser mock. Creates its own disposable events and deletes them.

  python3 e2e/native_regressions.py [screenshot-dir]
"""

import base64
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.request

WD = "http://127.0.0.1:4445"
HOOK = "http://127.0.0.1:14211"
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.environ.get("TMPDIR", "/tmp"), "northstar-calendar", "real-window")


def post(url, body, method="POST"):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data, {"Content-Type": "application/json"}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        # the hook and the WebDriver plugin say why in the body
        raise SystemExit(f"FAIL: {url} answered {e.code}: {e.read().decode(errors='replace')[:400]}")


def hook(cmd, **args):
    res = post(HOOK, {"cmd": cmd, **args})
    if not res.get("ok"):
        raise RuntimeError(f"hook {cmd}: {res.get('error')}")
    return res["result"]


SID = post(f"{WD}/session", {"capabilities": {"alwaysMatch": {}}})["value"]["sessionId"]


def js(script, *args):
    return post(f"{WD}/session/{SID}/execute/sync", {"script": script, "args": list(args)})["value"]


def jsa(script, *args):
    """async script: call done(value) when finished. Runs through the test
    hook's eval (it can await): the WebDriver plugin's execute/async loses
    its callback on macOS while the page pans (HTTP 500 after 30s)."""
    wrapped = ("const args = " + json.dumps(list(args)) + ";\n"
               "return await new Promise((done) => {\n" + script + "\n});")
    return hook("eval", script=wrapped)


def wait(script, what, *args, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if js(script, *args):
            return
        time.sleep(0.1)
    raise SystemExit(f"FAIL: timed out waiting for {what}")


def check(ok, what):
    if not ok:
        raise SystemExit(f"FAIL: {what}")
    print(f"ok  {what}")


def shot(name):
    os.makedirs(OUT, exist_ok=True)
    png = post(f"{WD}/session/{SID}/screenshot", None, method="GET")["value"]
    with open(os.path.join(OUT, name), "wb") as f:
        f.write(base64.b64decode(png))


def stored(cal, eid):
    day = dt.date.today()
    evs = hook("list_events", start=f"{day - dt.timedelta(days=2)}", end=f"{day + dt.timedelta(days=2)}T23:59:59")
    return next((e for e in evs if e["id"] == eid and e["calendar_id"] == cal), None)


def queued_patch(eid):
    ops = [o for o in hook("pending_ops")["ops"] if o["event_id"] == eid and o["kind"] == "patch"]
    return ops[-1]["payload"] if ops else None


def pointer_click(selector):
    js("""
      const el = document.querySelector(arguments[0]);
      const r = el.getBoundingClientRect();
      const o = {bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + Math.min(8, r.height / 2),
                 pointerId: 1, isPrimary: true, button: 0};
      el.dispatchEvent(new PointerEvent('pointerdown', o));
      el.dispatchEvent(new PointerEvent('pointerup', o));
      window.dispatchEvent(new PointerEvent('pointerup', o));
      el.dispatchEvent(new MouseEvent('click', o));
      return true""", selector)


def key(selector_or_none, k):
    js("""
      const t = arguments[0] ? document.querySelector(arguments[0]) : (document.activeElement || document.body);
      t.dispatchEvent(new KeyboardEvent('keydown', {key: arguments[1], bubbles: true, cancelable: true}));
      return true""", selector_or_none, k)


# ---- fixtures: two annotated events today, on the primary editable calendar
cals = hook("list_calendars")
cal = next((c for c in cals if c["is_primary"]), cals[0])["id"]
today = dt.datetime.now().astimezone().replace(minute=0, second=0, microsecond=0)


def make(title, hour, note):
    start = today.replace(hour=hour)
    return hook("create_event", input={
        "calendar_id": cal, "summary": title,
        "description": f"Agenda stays.\n\n[DRILL] {note}",
        "start": start.isoformat(), "end": (start + dt.timedelta(hours=2)).isoformat(),
        "all_day": False,
    })["id"]


A = make("QA native canvas note", 13, "Canvas note must go, event must stay.")
B = make("QA native editor note", 16, "Editor x must erase this.")
KA, KB = f"{cal}/{A}", f"{cal}/{B}"
try:
    # Synthetic PointerEvents have no active pointer, so setPointerCapture
    # throws in the webview and the handler stops. Real pointers capture fine.
    js("""Element.prototype.setPointerCapture = function () {};
          Element.prototype.releasePointerCapture = function () {}; return true""")
    js("""window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
          window.dispatchEvent(new KeyboardEvent('keydown', {key: 'w', bubbles: true}));
          const t = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Today');
          t && t.click(); return true""")
    wait("return !!document.querySelector('[data-testid=week-grid]')", "week view")
    js("document.querySelector('[data-testid=week-grid]').scrollTop = 12 * 48; return true")
    note_a = f'.margin-note[data-ek="{KA}"]'
    wait("return !!document.querySelector(arguments[0])", "canvas note A placed", note_a, timeout=10)
    shot("notes-before.png")

    # ---- 1. Delete on a focused margin note removes the note, never the event
    js("""
      window.__qa = {chipsRemoved: 0, notesRemoved: [], gridSwapped: false};
      const grid = document.querySelector('[data-testid=week-grid]');
      window.__qaGrid = grid;
      new MutationObserver((recs) => {
        for (const r of recs) for (const n of r.removedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.matches('.chip-timed') || n.querySelector?.('.chip-timed')) window.__qa.chipsRemoved++;
          if (n.matches('.margin-note')) window.__qa.notesRemoved.push(n.dataset.ek);
        }
      }).observe(grid, {childList: true, subtree: true});
      return true""")
    pointer_click(note_a)
    check(js("return document.activeElement === document.querySelector(arguments[0])", note_a),
          "clicking a margin note focuses it (Delete belongs to the note)")
    key(note_a, "Delete")
    wait("return !document.querySelector(arguments[0])", "note A removed", note_a)
    time.sleep(0.6)
    # a chip, or a row of a cluster when other short events crowd that hour
    # (the macOS default runs on a copy of the real calendar)
    check(js("return !!document.querySelector(`:is(.chip-timed, .cluster-row)[data-ek=\"${arguments[0]}\"]`)", KA),
          "the annotated event is still on the calendar")
    qa = js("return {...window.__qa, gridSwapped: window.__qaGrid !== document.querySelector('[data-testid=week-grid]')}")
    check(qa["chipsRemoved"] == 0 and not qa["gridSwapped"],
          f"no flash: no event chip was torn down (removed={qa['chipsRemoved']})")
    check(qa["notesRemoved"] == [KA], f"only that note left the canvas (removed {qa['notesRemoved']})")
    ev = stored(cal, A)
    check(ev and ev["description"] == "Agenda stays.", "stored description keeps its body, loses the note")
    check(queued_patch(A) == {"description": "Agenda stays."}, "queued PATCH sends only the description")
    key(None, "Backspace")  # a second press (or key repeat) after the note is gone
    time.sleep(0.4)
    check(stored(cal, A) is not None, "a second Backspace does not delete the event")

    # ---- 2. the editor's x erases the note for good (and the PATCH clears it)
    hook("update_event", event_id=B, input={
        "calendar_id": cal, "summary": "QA native editor note", "description": "[DRILL] Editor x must erase this.",
        "start": today.replace(hour=16).isoformat(), "end": today.replace(hour=18).isoformat(), "all_day": False})
    chip_b = f':is(.chip-timed, .cluster-row)[data-ek="{KB}"]'
    wait("return !!document.querySelector(arguments[0])", "event B chip", chip_b)
    pointer_click(chip_b)
    wait("return !!document.querySelector('[data-testid=panel-drill]')", "editor shows the note")
    js("document.querySelector('[data-testid=drill-erase]').click(); return true")
    wait("return !document.querySelector('[data-testid=panel-drill]')", "note gone from the editor")
    time.sleep(0.6)
    check(not js("return !!document.querySelector('[data-testid=panel-drill]')"),
          "the erased note does not come back in the open editor after the db refresh")
    check(not js("return !!document.querySelector(`.margin-note[data-ek=\"${arguments[0]}\"]`)", KB),
          "the erased note is gone from the canvas")
    ev = stored(cal, B)
    check(ev and ev["description"] is None, "stored description is cleared")
    check(queued_patch(B) == {"description": None},
          "queued PATCH sends description:null (omitting it kept Google's copy)")
    key(None, "Escape")
    pointer_click(chip_b)
    wait("return !!document.querySelector('[data-testid=event-panel]')", "editor reopens")
    check(not js("return !!document.querySelector('[data-testid=panel-drill]')"), "reopened editor has no note")
    key(None, "Escape")
    shot("notes-after.png")

    # ---- 3. horizontal swipe: never steps backwards, notes stay up
    diagnostic_css = os.environ.get("CAL_E2E_PAN_STYLE")
    if diagnostic_css:
        js("const style = document.createElement('style'); style.textContent = arguments[0]; document.head.append(style); return true", diagnostic_css)
    res = jsa("""
      const grid = document.querySelector('[data-testid=week-grid]');
      const head = document.querySelector('.day-headers .pan-strip');
      const colW = () => document.querySelector('.day-clip').clientWidth / document.querySelectorAll('.day-head').length;
      const pos = () => {
        const d = document.querySelector('.day-head');
        const dnum = Number(d.querySelector('.dnum').textContent);
        const m = /-\\s*(-?[\\d.]+)px/.exec(head.style.transform);
        return dnum + (m ? Number(m[1]) : 0) / colW();
      };
      const samples = [pos()];
      const mo = new MutationObserver(() => samples.push(pos()));
      mo.observe(grid, {childList: true, subtree: true, attributes: true, attributeFilter: ['style'], characterData: true});
      const rows = grid.querySelectorAll('.cluster-row').length;
      const viewport = grid.getBoundingClientRect();
      const visibleRows = [...grid.querySelectorAll('.cluster-row')].filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom &&
          rect.right > viewport.left && rect.left < viewport.right;
      }).length;
      const frames = [];
      const wheelDispatch = [];
      let last = performance.now(), live = true;
      const tick = (t) => { frames.push(t - last); last = t; if (live) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      let i = 0;
      const step = () => {
        if (i++ < 60) {
          const dispatchStarted = performance.now();
          grid.dispatchEvent(new WheelEvent('wheel', {deltaX: 12, deltaY: 0, bubbles: true, cancelable: true}));
          wheelDispatch.push(performance.now() - dispatchStarted);
          setTimeout(step, 12);
        } else setTimeout(() => {
          live = false; mo.disconnect();
          let back = 0;
          for (let k = 1; k < samples.length; k++) if (samples[k] - samples[k - 1] < -0.02 && Math.abs(samples[k] - samples[k - 1]) < 20) back++;
          const percentile95 = (values) => {
            values.sort((a, b) => a - b);
            return values[Math.floor(values.length * 0.95)] || 0;
          };
          done({back, travelled: samples[samples.length - 1] - samples[0], n: samples.length,
                rows, visibleRows, p95: percentile95(frames), slow: frames.filter((f) => f > 50).length,
                wheelDispatchP95: percentile95(wheelDispatch),
                wheelDispatchMax: Math.max(...wheelDispatch)});
        }, 400);
      };
      step();""")
    print(f"    swipe: {json.dumps(res)}")
    check(res["travelled"] > 1, "the swipe crossed day boundaries")
    check(res["back"] == 0, f"the swipe never stepped backwards ({res['back']} backward samples)")
    shot("swipe-after.png")
finally:
    for eid in (A, B):
        try:
            hook("delete_event", calendar_id=cal, event_id=eid)
        except Exception as e:  # noqa: BLE001 - cleanup must not mask the result
            print(f"cleanup {eid}: {e}")
    js("""const t = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Today');
          t && t.click(); return true""")
    post(f"{WD}/session/{SID}", None, method="DELETE")

print("ALL NATIVE REGRESSION CHECKS PASSED")
