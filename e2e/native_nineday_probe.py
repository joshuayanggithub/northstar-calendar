"""Short-batch pan probe for the real nine-day WKWebView, restoring Week/Today."""

import json
import urllib.request


HOOK = "http://127.0.0.1:14211"


def evaluate(script):
    request = urllib.request.Request(
        HOOK,
        json.dumps({"cmd": "eval", "script": script}).encode(),
        {"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        result = json.load(response)
    if not result.get("ok"):
        raise RuntimeError(result.get("error", result))
    return result["result"]


try:
    if evaluate("return document.querySelector('[data-testid=view-menu-btn]')?.textContent") != "Week ▾":
        raise RuntimeError("start in Week view so it can be restored")
    n = evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'9',bubbles:true}));"
                 "await new Promise(r=>setTimeout(r,100));"
                 "return document.querySelectorAll('.day-headers .day-head').length")
    if n != 9:
        raise RuntimeError(f"expected nine days, got {n}")
    evaluate("window.__qaPan={start:Number(document.querySelector('.day-head .dnum').textContent),"
             "width:document.querySelector('.day-head').getBoundingClientRect().width,pos:[],gaps:[],prev:performance.now()};return true")
    for _ in range(4):
        evaluate(r"""
            const q=window.__qaPan,grid=document.querySelector('[data-testid=week-grid]');
            const strip=document.querySelector('.day-headers .pan-strip');
            for(let i=0;i<5;i++){
              grid.dispatchEvent(new WheelEvent('wheel',{deltaX:4,deltaY:0,bubbles:true,cancelable:true}));
              await new Promise(r=>requestAnimationFrame(r));
              const now=performance.now();q.gaps.push(now-q.prev);q.prev=now;
              const m=strip.style.transform.match(/([+-]) ([\d.]+)px/);
              const residual=m?Number(m[2])*(m[1]==='-'?1:-1):0;
              const day=Number(document.querySelector('.day-head .dnum').textContent);
              q.pos.push((day-q.start)*q.width+residual);
            }
            return q.pos.at(-1);
        """)
    result = evaluate("const q=window.__qaPan;return {width:q.width,traveled:q.pos.at(-1),"
                      "maxError:Math.max(...q.pos.map((v,i)=>Math.abs(v-4*(i+1)))),"
                      "p95FrameGapMs:q.gaps.sort((a,b)=>a-b)[Math.floor(q.gaps.length*.95)]}")
    print(json.dumps(result, indent=2))
    if result["maxError"] >= 1:
        raise SystemExit("nine-day pan lost pixels")
finally:
    evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'w',bubbles:true}));return true")
    evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='Today')?.click();return true")
