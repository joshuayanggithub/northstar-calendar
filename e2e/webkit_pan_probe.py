#!/usr/bin/python3
"""Profile a dense production calendar in WebKitGTK 4.0 under Xvfb.

Build with `npm run build`, then serve with
`npm run preview -- --host 127.0.0.1 --port 15321`.
Run: `TZ=America/New_York xvfb-run -a /usr/bin/python3 e2e/webkit_pan_probe.py`.
Requires Python GI, GTK3, WebKitGTK 4.0 runtime, and Xvfb; it does not use
the native Tauri app and cannot reproduce macOS trackpad/WKWebView behavior.
"""

import json
import os
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.0")
from gi.repository import Gdk, GLib, Gtk, WebKit2


EVENTS_PER_DAY = int(os.environ.get("CAL_PAN_EVENTS_PER_DAY", "240"))
DAY_COUNT = int(os.environ.get("CAL_PAN_DAY_COUNT", "21"))
CSS_OVERRIDE = os.environ.get("CAL_PAN_STYLE", "")
WHEEL_DX = float(os.environ.get("CAL_PAN_WHEEL_DX", "12"))
NATIVE_BODY = os.environ.get("CAL_PAN_NATIVE_BODY") == "1"
NATIVE_OUTER = os.environ.get("CAL_PAN_NATIVE_OUTER") == "1"
PASSIVE_WHEEL_CONTROL = os.environ.get("CAL_PAN_PASSIVE_WHEEL") == "1"
TRANSFORM_CONTROL = os.environ.get("CAL_PAN_TRANSFORM_CONTROL") == "1"
WITH_NOTES = os.environ.get("CAL_PAN_WITH_NOTES") == "1"
GDK_INPUT = os.environ.get("CAL_PAN_GDK_INPUT") == "1"
GDK_DELTA_SCALE = float(os.environ.get("CAL_PAN_GDK_DELTA_SCALE", "1"))
GDK_DELTA_Y = float(os.environ.get("CAL_PAN_GDK_DELTA_Y", "0"))
GDK_X_FRACTION = float(os.environ.get("CAL_PAN_GDK_X_FRACTION", "0.75"))
GDK_Y_FRACTION = float(os.environ.get("CAL_PAN_GDK_Y_FRACTION", "0.5"))
ACCELERATION_POLICY = os.environ.get("CAL_PAN_ACCELERATION_POLICY", "default").lower()
TRACE_PREVENT_DEFAULT = os.environ.get("CAL_PAN_TRACE_PREVENT_DEFAULT") == "1"
BASE_URL = os.environ.get("CAL_PAN_URL", "http://127.0.0.1:15321")
HOLD_MS = int(os.environ.get("CAL_PAN_HOLD_MS", "0"))
SETUP_DELAY_MS = int(os.environ.get("CAL_PAN_SETUP_DELAY_MS", "2500"))
START_DELAY_MS = int(os.environ.get("CAL_PAN_START_DELAY_MS", "500"))
REPORT_DELAY_MS = int(os.environ.get("CAL_PAN_REPORT_DELAY_MS", "3500"))
START_DATE = datetime(2026, 10, 10, tzinfo=ZoneInfo("America/New_York"))


def fixture():
    events = []
    step = max(1, 600 // EVENTS_PER_DAY)
    for day_index in range(DAY_COUNT):
        day = START_DATE + timedelta(days=day_index)
        for event_index in range(EVENTS_PER_DAY):
            start = day + timedelta(minutes=8 * 60 + event_index * step)
            end = start + timedelta(minutes=30 + (event_index % 3) * 15)
            events.append({
                "id": f"webkit-pan-{day_index}-{event_index}",
                "calendar_id": "primary", "etag": None,
                "summary": f"Dense {day_index}-{event_index}",
                "description": f"[DRILL] note {day_index}-{event_index}"
                if WITH_NOTES and event_index % 20 == 0 else None,
                "location": None,
                "start": start.isoformat(), "end": end.isoformat(),
                "all_day": False, "timezone": "America/New_York",
                "status": "confirmed", "recurrence": None,
                "recurring_event_id": None, "conference_url": None,
                "updated": None, "raw": {},
            })
    return {"calendars": [{
        "id": "primary", "summary": "Personal", "color": "#4f8cff",
        "is_primary": True, "hidden": False, "access_role": "owner",
    }], "events": events}


manager = WebKit2.UserContentManager.new()
seed = (
    "window.__calFixture = " + json.dumps(fixture(), separators=(",", ":")) + ";"
    "window.__marginNoteIndexBuilds = [];"
    "window.__marginPlaceSyncMs = [];"
    "window.__marginWorkerStages = [];"
)
if PASSIVE_WHEEL_CONTROL:
    seed += r"""
      (() => {
        const add = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function(type, listener, options) {
          if (type === 'wheel' && this instanceof Element && this.classList.contains('weekview') &&
              options && typeof options === 'object' && options.passive === false) {
            window.__calPassiveWheelIntercepted = (window.__calPassiveWheelIntercepted || 0) + 1;
            options = { ...options, passive: true };
          }
          return add.call(this, type, listener, options);
        };
      })();
    """
if TRACE_PREVENT_DEFAULT:
    seed += r"""
      (() => {
        const add = EventTarget.prototype.addEventListener;
        window.__calWeekWheelRegistrations = [];
        EventTarget.prototype.addEventListener = function(type, listener, options) {
          if (type === 'wheel' && this instanceof Element &&
              (this.classList.contains('weekview') || this.classList.contains('main'))) {
            window.__calWeekWheelRegistrations.push({
              target: this.className,
              capture: typeof options === 'boolean' ? options : !!options?.capture,
              passive: typeof options === 'object' ? options?.passive ?? null : null,
            });
          }
          return add.call(this, type, listener, options);
        };
        const preventDefault = Event.prototype.preventDefault;
        window.__calWheelPreventDefaultCalls = 0;
        window.__calWheelPreventDefaultApplied = 0;
        Event.prototype.preventDefault = function() {
          if (this.type === 'wheel' && this.target instanceof Element && this.target.closest('.weekview')) {
            window.__calWheelPreventDefaultCalls++;
          }
          const result = preventDefault.call(this);
          if (this.type === 'wheel' && this.defaultPrevented) window.__calWheelPreventDefaultApplied++;
          return result;
        };
      })();
    """
manager.add_script(WebKit2.UserScript.new(
    seed, WebKit2.UserContentInjectedFrames.ALL_FRAMES,
    WebKit2.UserScriptInjectionTime.START, None, None,
))
view = WebKit2.WebView.new_with_user_content_manager(manager)
if ACCELERATION_POLICY == "always":
    view.get_settings().set_hardware_acceleration_policy(
        WebKit2.HardwareAccelerationPolicy.ALWAYS
    )
elif ACCELERATION_POLICY == "ondemand":
    view.get_settings().set_hardware_acceleration_policy(
        WebKit2.HardwareAccelerationPolicy.ON_DEMAND
    )
effective_acceleration_policy = view.get_settings().get_hardware_acceleration_policy()
effective_acceleration_policy_name = getattr(
    effective_acceleration_policy, "value_nick", str(effective_acceleration_policy)
)
if HOLD_MS:
    view.get_settings().set_enable_developer_extras(True)
window = Gtk.Window()
window.set_default_size(1440, 900)
window.add(view)
window.connect("destroy", Gtk.main_quit)
window.show_all()


def evaluate(source, callback):
    def finished(webview, result, _data):
        try:
            value = webview.run_javascript_finish(result).get_js_value().to_string()
            callback(value)
        except Exception as error:
            print("JS ERROR:", error, file=sys.stderr, flush=True)
            Gtk.main_quit()

    view.run_javascript(source, None, finished, None)


def start_probe(_unused=None):
    source = r"""
    (() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {key:'9',code:'Digit9',bubbles:true}));
      const css = __CSS_OVERRIDE__;
      if (css) {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
      }
      const grid = document.querySelector('[data-testid=week-grid]');
      const strip = document.querySelector('.day-headers .pan-strip');
      if (!grid || !strip) return JSON.stringify({error:'calendar not ready', body:document.body.innerText.slice(0,500)});
      if (__TRANSFORM_CONTROL__) {
        const style = document.createElement('style');
        style.textContent = '.weekview{overflow-x:hidden!important}.pan-clip,.day-clip{overflow:hidden!important}.pan-strip{will-change:transform!important}';
        document.head.appendChild(style);
        const strips = [...document.querySelectorAll('.day-headers .pan-strip,.allday-row .pan-strip,.day-cols')];
        window.__transformWheelTimes = [];
        window.__transformDispatches = [];
        let offset = 0, frame = 0;
        grid.addEventListener('wheel', event => {
          const started = performance.now();
          window.__transformWheelTimes.push(started);
          const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? grid.clientWidth : 1;
          offset += event.deltaX * unit;
          event.preventDefault();
          event.stopImmediatePropagation();
          if (!frame) frame = requestAnimationFrame(() => {
            frame = 0;
            for (const node of strips) node.style.transform = `translate3d(${-offset}px,0,0)`;
          });
          window.__transformDispatches.push(performance.now() - started);
        }, {capture:true, passive:false});
        window.__transformPanState = {strips, get offset(){return offset}};
      }
      if (__NATIVE_BODY__) {
        const clip = document.querySelector('.day-clip');
        const nativeStyle = document.createElement('style');
        nativeStyle.textContent = '.day-cols{transform:none!important}';
        document.head.appendChild(nativeStyle);
        clip.scrollLeft = clip.clientWidth / 9;
        grid.addEventListener('wheel', event => {
          clip.scrollLeft += event.deltaX;
        });
      }
      if (__NATIVE_OUTER__) {
        window.__nativePanWheelTimes = [];
        const nativeStyle = document.createElement('style');
        nativeStyle.textContent = '.weekview{overflow-x:auto!important;overscroll-behavior-x:contain}.pan-clip,.day-clip{overflow:visible!important}.pan-strip{transform:none!important}';
        document.head.appendChild(nativeStyle);
        grid.scrollLeft = document.querySelector('.day-clip').clientWidth / 9;
        grid.addEventListener('wheel', event => {
          event.stopImmediatePropagation();
          grid.scrollLeft += event.deltaX;
        }, {capture:true, passive:true});
      }
      const gaps = [], wheelTimes = window.__transformWheelTimes || [], trustedWheelTimes = [], wheelSamples = [], preventedSamples = [], dispatches = window.__transformDispatches || [], visualChanges = [];
      let defaultPreventedCount = 0;
      const bodyMoves = [];
      new MutationObserver(records => {
        for (const record of records) {
          bodyMoves.push({time:performance.now(),added:record.addedNodes.length,removed:record.removedNodes.length});
        }
      }).observe(document.querySelector('.day-cols'),{childList:true});
      const starts = new WeakMap();
      let live = true, previous = performance.now();
      function tick(time) {
        gaps.push({time, gap:time-previous}); previous=time;
        if (live) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
      if (__TRANSFORM_CONTROL__) {
        new MutationObserver(() => visualChanges.push({time:performance.now(), left:grid.scrollLeft}))
          .observe(strip, {attributes:true,attributeFilter:['style']});
      } else {
        grid.addEventListener('scroll', () => visualChanges.push({time:performance.now(), left:grid.scrollLeft}), {passive:true});
      }
      window.__weekViewRenderMarks = [];
      window.__weekViewRenderDurations = [];
      window.__weekRenderStages = [];
      grid.addEventListener('wheel', event => {
        const t=performance.now(); wheelTimes.push(t); if(event.isTrusted) trustedWheelTimes.push(t); if(wheelSamples.length<12) wheelSamples.push({x:event.deltaX,y:event.deltaY,mode:event.deltaMode,trusted:event.isTrusted,target:event.target?.className??event.target?.nodeName}); starts.set(event,t);
        if (Array.isArray(window.__panNoteSamples)) {
          const noteLayer = document.querySelector('[data-testid=margin-notes]');
          window.__panNoteSamples.push({
            count: document.querySelectorAll('[data-testid=margin-note]').length,
            pending: noteLayer?.dataset.pending ?? null,
          });
        }
      },true);
      // Observe at window bubble, after a WeekView wheel handler that may have
      // been re-registered after this probe installed its grid listeners.
      window.addEventListener('wheel', event => {
        const t=starts.get(event); if (t!=null) {
          dispatches.push(performance.now()-t);
          if (event.defaultPrevented) defaultPreventedCount++;
          if (preventedSamples.length<12) preventedSamples.push({x:event.deltaX,y:event.deltaY,cancelable:event.cancelable,prevented:event.defaultPrevented});
        }
      });
      window.__beginPanInput = () => {
        window.__weekViewRenderMarks = [];
        window.__weekViewRenderDurations = [];
        window.__weekRenderStages = [];
        window.__panStartScrollLeft = grid.scrollLeft;
        window.__panStartDate = document.querySelector('.day-head .dnum')?.textContent?.trim() ?? null;
        window.__panStartWheelCount = wheelTimes.length;
        window.__panNotesAtStart = document.querySelectorAll('[data-testid=margin-note]').length;
        window.__panNotesPendingAtStart = document.querySelector('[data-testid=margin-notes]')?.dataset.pending ?? null;
        window.__panNoteSamples = [];
        console.timeStamp('northstar-pan-start');
      };
      window.__endPanInput = () => {
        window.__panEndScrollLeft = grid.scrollLeft;
        window.__panEndDate = document.querySelector('.day-head .dnum')?.textContent?.trim() ?? null;
        console.timeStamp('northstar-pan-end');
      };
      if (!__GDK_INPUT__) setTimeout(() => {
        window.__beginPanInput();
        for (let i=0;i<60;i++) setTimeout(() => grid.dispatchEvent(new WheelEvent('wheel', {
          deltaX:__WHEEL_DX__,deltaY:0,bubbles:true,cancelable:true
        })),i*12);
        setTimeout(window.__endPanInput,730);
      },__START_DELAY_MS__);
      setTimeout(() => {
        live=false;
        const first=wheelTimes[0]??0,last=wheelTimes[wheelTimes.length-1]??0;
        const duringPanScrolls=visualChanges.filter(x=>x.time>=first&&x.time<=last);
        const afterPanScrolls=visualChanges.filter(x=>x.time>last);
        const panPositions=[window.__panStartScrollLeft,window.__panEndScrollLeft,...duringPanScrolls.map(x=>x.left)].filter(Number.isFinite);
        const panMotionRange=panPositions.length?Math.max(...panPositions)-Math.min(...panPositions):0;
        const panGaps=gaps.filter(x=>x.time>=first&&x.time<=last);
        const sorted=panGaps.map(x=>x.gap).sort((a,b)=>a-b);
        const inputIntervals=wheelTimes.slice(1).map((t,i)=>t-wheelTimes[i]).sort((a,b)=>a-b);
        const idle=gaps.filter(x=>x.time>=first-350&&x.time<first-50).map(x=>x.gap).sort((a,b)=>a-b);
        const pct=p=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]??0;
        const inputPct=p=>inputIntervals[Math.min(inputIntervals.length-1,Math.floor(inputIntervals.length*p))]??0;
        const idlePct=p=>idle[Math.min(idle.length-1,Math.floor(idle.length*p))]??0;
        const lag=wheelTimes.map(t=>visualChanges.find(x=>x.time>=t&&x.time<=t+100)?.time-t)
          .filter(Number.isFinite).sort((a,b)=>a-b);
        const commits=window.__weekViewRenderMarks||[];
        const slow=panGaps.filter(x=>x.gap>25).map(x=>({
          gap:x.gap,
          wheels:wheelTimes.filter(t=>t>x.time-x.gap&&t<=x.time).length,
          commits:commits.filter(c=>c.commitTime>x.time-x.gap&&c.startTime<x.time)
        }));
        const panNoteSamples=window.__panNoteSamples||[];
        window.__webkitPanResult={
          agent:navigator.userAgent,
          dpr:devicePixelRatio,
          viewport:[innerWidth,innerHeight],
          rows:document.querySelectorAll('.cluster-row').length,
          hoveredRows:document.querySelectorAll('.cluster-row:hover').length,
          hoverTarget:document.querySelector(':hover')?.className??document.querySelector(':hover')?.nodeName??null,
          eventChips:document.querySelectorAll('.day-col [data-testid="event-chip"]').length,
          clusterEvents:document.querySelectorAll('.day-col .cluster-row').length,
          notes:document.querySelectorAll('[data-testid=margin-note]').length,
          notesReady:document.querySelectorAll('[data-testid=margin-note]').length>0&&document.querySelector('[data-testid=margin-notes]')?.dataset.pending==='0',
          notesAtPanStart:window.__panNotesAtStart??null,
          notesPendingAtPanStart:window.__panNotesPendingAtStart??null,
          notesDuringPanMin:panNoteSamples.length?Math.min(...panNoteSamples.map(x=>x.count)):null,
          noteSamplesDuringPan:panNoteSamples.length,
          fixtureNotes:window.__calFixture.events.filter(event=>event.description?.includes('[DRILL]')).length,
          noteIndexBuilds:window.__marginNoteIndexBuilds.slice(-3),
          notePlacements:window.__marginPlaceSyncMs.slice(-3),
          noteWorkerStages:window.__marginWorkerStages.slice(-10),
          notesPending:document.querySelector('[data-testid=margin-notes]')?.dataset.pending??null,
          days:document.querySelectorAll('.day-head').length,
          mode:__TRANSFORM_CONTROL__?'transform-control':__GDK_INPUT__?'trusted-gdk-scroll':'scroll-surface',
          passiveWheelIntercepted:window.__calPassiveWheelIntercepted??0,
          requestedWebkitHardwareAccelerationPolicy:__ACCELERATION_POLICY__,
          effectiveWebkitHardwareAccelerationPolicy:__EFFECTIVE_ACCELERATION_POLICY__,
          gdkDeltaScale:__GDK_DELTA_SCALE__,
          requestedGdkDeltaY:__GDK_DELTA_Y__,
          supportsContentVisibilityAuto:CSS.supports('content-visibility','auto'),
          bodyScrollLeft:document.querySelector('.day-clip').scrollLeft,
          outerScrollLeft:grid.scrollLeft,
          panStartScrollLeft:window.__panStartScrollLeft??null,
          panEndScrollLeft:window.__panEndScrollLeft??null,
          panScrollDelta:(window.__panStartScrollLeft==null)?null:grid.scrollLeft-window.__panStartScrollLeft,
          panStartDate:window.__panStartDate??null,
          panEndDate:window.__panEndDate??null,
          panWheelCount:wheelTimes.length-(window.__panStartWheelCount??0),
          panMotionRange,
          movementVerified:__TRANSFORM_CONTROL__
            ? Math.abs(window.__transformPanState?.offset??0)>1
            : panMotionRange>1||window.__panStartDate!==window.__panEndDate,
          panScrollEvents:duringPanScrolls.length,
          panFirstScrollLeft:duringPanScrolls[0]?.left??null,
          panLastScrollLeft:duringPanScrolls.at(-1)?.left??null,
          settleScrollEvents:afterPanScrolls.length,
          settleFirstScrollLeft:afterPanScrolls[0]?.left??null,
          settleLastScrollLeft:afterPanScrolls.at(-1)?.left??null,
          outerScrollWidth:grid.scrollWidth,
          outerClientWidth:grid.clientWidth,
          dayClipWidth:document.querySelector('.day-clip').clientWidth,
          bodyTransform:getComputedStyle(document.querySelector('.day-cols')).transform,
          wheelCount:wheelTimes.length,
          trustedWheelCount:trustedWheelTimes.length,
          wheelSamples,
          preventedWheelSamples:preventedSamples,
          defaultPreventedWheelCount:defaultPreventedCount,
          preventDefaultCalls:window.__calWheelPreventDefaultCalls??null,
          preventDefaultApplied:window.__calWheelPreventDefaultApplied??null,
          weekWheelRegistrations:window.__calWeekWheelRegistrations??null,
          p50:pct(0.5),p95:pct(0.95),max:sorted[sorted.length-1]??0,
          wheelIntervalP50:inputPct(0.5),wheelIntervalP95:inputPct(0.95),
          wheelIntervalMax:inputIntervals.at(-1)??0,
          idleP50:idlePct(0.5),idleP95:idlePct(0.95),idleMax:idle[idle.length-1]??0,
          slow,
          maxDispatch:Math.max(0,...dispatches),
          p95WheelToScrollLatency:lag[Math.min(lag.length-1,Math.floor(lag.length*.95))]??0,
          maxWheelToScrollLatency:lag[lag.length-1]??0,
          visualUpdateEvents:visualChanges.length,
          transformOffset:window.__transformPanState?.offset??null,
          maxCommit:Math.max(0,...commits.map(c=>c.actualDuration)),
          bodyMoveCount:bodyMoves.filter(m=>m.time>=first&&m.time<=last).length,
          bodyMoves:bodyMoves.filter(m=>m.time>=first&&m.time<=last),
          stageMax:Object.fromEntries(Object.entries((window.__weekRenderStages||[]).reduce((a,x)=>{
            a[x.id]=Math.max(a[x.id]||0,x.duration);return a;
          },{})))
        };
      },__REPORT_DELAY_MS__);
      return JSON.stringify({started:true, initialRows:document.querySelectorAll('.cluster-row').length});
    })()
    """
    source = source.replace("__CSS_OVERRIDE__", json.dumps(CSS_OVERRIDE))
    source = source.replace("__WHEEL_DX__", str(WHEEL_DX))
    source = source.replace("__START_DELAY_MS__", str(START_DELAY_MS))
    source = source.replace("__NATIVE_BODY__", "true" if NATIVE_BODY else "false")
    source = source.replace("__NATIVE_OUTER__", "true" if NATIVE_OUTER else "false")
    source = source.replace("__TRANSFORM_CONTROL__", "true" if TRANSFORM_CONTROL else "false")
    source = source.replace("__GDK_INPUT__", "true" if GDK_INPUT else "false")
    source = source.replace("__GDK_DELTA_SCALE__", str(GDK_DELTA_SCALE))
    source = source.replace("__GDK_DELTA_Y__", str(GDK_DELTA_Y))
    source = source.replace("__REPORT_DELAY_MS__", str(REPORT_DELAY_MS))
    source = source.replace("__ACCELERATION_POLICY__", json.dumps(ACCELERATION_POLICY))
    source = source.replace(
        "__EFFECTIVE_ACCELERATION_POLICY__", json.dumps(effective_acceleration_policy_name)
    )
    evaluate(source, lambda value: print("START", value, flush=True))
    if GDK_INPUT:
        GLib.timeout_add(START_DELAY_MS, begin_gdk_pan)
    # The page captures metrics after this same settle delay. Give its JS
    # callback a small head start so Python never reports a stale snapshot.
    GLib.timeout_add(REPORT_DELAY_MS + 100, report)
    return False


def begin_gdk_pan():
    evaluate("window.__beginPanInput()", lambda _value: None)
    display = Gdk.Display.get_default()
    pointer = display.get_default_seat().get_pointer()
    allocation = view.get_allocation()
    x = allocation.width * GDK_X_FRACTION
    y = allocation.height * GDK_Y_FRACTION

    def dispatch_one(_unused=None):
        event = Gdk.Event.new(Gdk.EventType.SCROLL)
        event.scroll.window = view.get_window()
        event.scroll.send_event = True
        event.scroll.time = Gdk.CURRENT_TIME
        event.scroll.x = x
        event.scroll.y = y
        event.scroll.state = Gdk.ModifierType(0)
        event.scroll.direction = Gdk.ScrollDirection.SMOOTH
        event.scroll.delta_x = WHEEL_DX / GDK_DELTA_SCALE
        event.scroll.delta_y = GDK_DELTA_Y / GDK_DELTA_SCALE
        event.scroll.device = pointer
        Gtk.main_do_event(event)
        return False

    for index in range(60):
        GLib.timeout_add(index * 12, dispatch_one)
    GLib.timeout_add(750, lambda: (evaluate("window.__endPanInput()", lambda _value: None), False)[1])
    return False


def report():
    def print_result(value):
        if os.environ.get("CAL_PAN_BRIEF") == "1":
            result = json.loads(value)
            result.pop("slow", None)
            result.pop("bodyMoves", None)
            value = json.dumps(result, separators=(",", ":"))
        print("RESULT", value, flush=True)
        if os.environ.get("CAL_PAN_REQUIRE_MOTION") == "1":
            result = json.loads(value)
            if not result.get("movementVerified"):
                print("INVALID: the input stream did not produce verified horizontal movement", flush=True)
                raise SystemExit(2)
        if os.environ.get("CAL_PAN_REQUIRE_NOTES") == "1":
            result = json.loads(value)
            if not result.get("notesReady"):
                print("INVALID: annotation placement was pending or no note DOM nodes were rendered", flush=True)
                raise SystemExit(3)
        if os.environ.get("CAL_PAN_REQUIRE_NOTES_DURING_PAN") == "1":
            result = json.loads(value)
            if not result.get("notesAtPanStart") or not result.get("notesDuringPanMin"):
                print("INVALID: annotation DOM was not visible for the full pan input window", flush=True)
                raise SystemExit(4)
        if HOLD_MS:
            GLib.timeout_add(HOLD_MS, lambda: (Gtk.main_quit(), False)[1])
        else:
            Gtk.main_quit()
    evaluate("JSON.stringify(window.__webkitPanResult || {pending:true})", print_result)
    return False


def on_load(_view, event):
    if event == WebKit2.LoadEvent.FINISHED:
        GLib.timeout_add(SETUP_DELAY_MS, start_probe)


view.connect("load-changed", on_load)
GLib.timeout_add(60000, lambda: (print("TIMEOUT", flush=True), Gtk.main_quit(), False)[2])
view.load_uri(BASE_URL.rstrip("/") + "/?now=2026-10-14T09:00:00")
Gtk.main()
