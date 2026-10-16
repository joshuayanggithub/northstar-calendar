"""Measure horizontal panning in the real debug WKWebView via the test hook."""

import json
import time
import urllib.request


def evaluate(script):
    body = json.dumps({"cmd": "eval", "script": script}).encode()
    request = urllib.request.Request(
        "http://127.0.0.1:14211", body,
        {"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        result = json.load(response)
    if not result.get("ok"):
        raise RuntimeError(result.get("error"))
    return result["result"]


evaluate(r"""
    const grid = document.querySelector('[data-testid=week-grid]');
    if (!grid) throw new Error('Week view required');
    window.__panProbeStart = Number(document.querySelector('.day-head .dnum').textContent);
    window.__panProbeScroll = grid.scrollTop;
    window.__panProbeWidth =
      (grid.clientWidth - document.querySelector('.gutter').clientWidth) / 7;
    return true;
""")

positions = []
gaps = []
previous = time.perf_counter()
try:
    for _ in range(12):
        evaluate(r"""
            const grid = document.querySelector('[data-testid=week-grid]');
            grid.dispatchEvent(new WheelEvent('wheel', {
              deltaX: 12, deltaY: 0, bubbles: true, cancelable: true
            }));
            return true;
        """)
        position = evaluate(r"""
            const strip = document.querySelector('.day-headers .pan-strip');
            const m = strip.style.transform.match(/([+-]) ([\d.]+)px/);
            const residual = m ? Number(m[2]) * (m[1] === '-' ? 1 : -1) : 0;
            const day = Number(document.querySelector('.day-head .dnum').textContent);
            return (day - window.__panProbeStart) * window.__panProbeWidth + residual;
        """)
        now = time.perf_counter()
        gaps.append((now - previous) * 1000)
        previous = now
        positions.append(position)
finally:
    evaluate(r"""
        const today = [...document.querySelectorAll('button')]
          .find(el => el.textContent?.trim() === 'Today');
        today?.click();
        document.querySelector('[data-testid=week-grid]').scrollTop = window.__panProbeScroll;
        return true;
    """)

backsteps = [a - b for a, b in zip(positions, positions[1:]) if a - b > 2]
gaps.sort()
metrics = {
    "logicalDayWidth": evaluate("return window.__panProbeWidth"),
    "traveled": positions[-1] - positions[0],
    "largestBackstep": max(backsteps, default=0),
    "p95RequestGapMs": gaps[int((len(gaps) - 1) * 0.95)],
}
print(json.dumps(metrics, indent=2))
if backsteps:
    raise SystemExit("horizontal pan jumped backwards")
