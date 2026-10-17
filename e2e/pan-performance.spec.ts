import { expect, test } from "@playwright/test";

test("dense-calendar horizontal pan stays within a frame budget", async ({ page }) => {
  test.skip(process.env.CAL_PAN_PROFILE !== "1", "Run isolated against vite preview with CAL_PAN_PROFILE=1; background workers distort frame timing");
  const events = Array.from({ length: 400 }, (_, i) => {
    const day = 14 + Math.floor(i / 45);
    const minuteOfDay = 8 * 60 + (i % 45) * 10;
    const endMinute = minuteOfDay + 30 + (i % 3) * 15;
    const stamp = (minute: number) => {
      const d = day + Math.floor(minute / 1440);
      const m = minute % 1440;
      return `2026-10-${String(d).padStart(2, "0")}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00-04:00`;
    };
    return {
      id: `dense-${i}`,
      calendar_id: "primary",
      etag: null,
      summary: `Dense ${i}`,
      description: i % 20 === 0 ? `[DRILL] note ${i}` : null,
      location: null,
      start: stamp(minuteOfDay),
      end: stamp(endMinute),
      all_day: false,
      timezone: "America/New_York",
      status: "confirmed",
      recurrence: null,
      recurring_event_id: null,
      conference_url: null,
      updated: null,
      raw: {},
    };
  });
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, {
    calendars: [{ id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" }],
    events,
  });
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`);
  const viteDevServer = await page.evaluate(() => Boolean(document.querySelector('script[src*="/@vite/client"]')));
  test.skip(viteDevServer, "Frame-budget profiling is meaningful against the production build; run npm run preview on port 1420");
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await page.keyboard.press("9");
  await expect(page.locator(".day-head")).toHaveCount(9);
  await page.waitForTimeout(300); // include the first note-layout pass, not initial page load

  const metrics = await page.evaluate(async () => {
    (window as any).__weekViewRenderDurations = [];
    (window as any).__calendarAppRenderDurations = [];
    (window as any).__weekViewRenderMarks = [];
    (window as any).__calendarAppRenderMarks = [];
    (window as any).__weekRenderStages = [];
    (window as any).__calendarPanPaintDurations = [];
    const grid = document.querySelector<HTMLElement>("[data-testid=week-grid]")!;
    const strip = document.querySelector<HTMLElement>(".day-headers .pan-strip")!;
    const width = (document.querySelector(".day-clip") as HTMLElement).clientWidth / 9;
    const firstDay = Number(document.querySelector(".day-head .dnum")!.textContent);
    const gaps: Array<{ time: number; gap: number }> = [];
    const longTasks: Array<{ duration: number; startTime: number; name: string; attribution: Array<Record<string, string>> }> = [];
    const longFrames: Array<{ duration: number; startTime: number; renderStart: number; styleAndLayoutStart: number; scripts: Array<Record<string, unknown>> }> = [];
    const taskObserver = new PerformanceObserver((entries) => {
      for (const raw of entries.getEntries()) {
        const entry = raw as PerformanceLongTaskTiming;
        longTasks.push({
          duration: entry.duration,
          startTime: entry.startTime,
          name: entry.name,
          attribution: (entry.attribution ?? []).map((a) => ({
            containerType: a.containerType,
            containerName: a.containerName,
            containerId: a.containerId,
            containerSrc: a.containerSrc,
          })),
        });
      }
    });
    taskObserver.observe({ type: "longtask", buffered: true });
    const frameObserver = PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")
      ? new PerformanceObserver((entries) => {
        for (const raw of entries.getEntries()) {
          const entry = raw as any;
          longFrames.push({
            duration: entry.duration,
            startTime: entry.startTime,
            renderStart: entry.renderStart,
            styleAndLayoutStart: entry.styleAndLayoutStart,
            scripts: (entry.scripts ?? []).map((script: any) => ({
              duration: script.duration,
              forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration,
              invoker: script.invoker,
              sourceURL: script.sourceURL,
              sourceFunctionName: script.sourceFunctionName,
            })),
          });
        }
      })
      : null;
    frameObserver?.observe({ type: "long-animation-frame", buffered: true } as PerformanceObserverInit);
    let previous = performance.now();
    let live = true;
    let inputStart = Number.POSITIVE_INFINITY;
    let inputEnd = Number.POSITIVE_INFINITY;
    const wheelTimes: number[] = [];
    const wheelDispatchMs: number[] = [];
    const tick = (time: number) => {
      gaps.push({ time, gap: time - previous });
      previous = time;
      if (live) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    let sent = 0;
    await new Promise<void>((resolve) => {
      const step = () => {
        if (sent === 0) inputStart = performance.now();
        const dispatchStart = performance.now();
        grid.dispatchEvent(new WheelEvent("wheel", {
          deltaX: 12, deltaY: 0, bubbles: true, cancelable: true,
        }));
        wheelTimes.push(dispatchStart);
        wheelDispatchMs.push(performance.now() - dispatchStart);
        if (++sent < 60) setTimeout(step, 12);
        else {
          inputEnd = performance.now();
          setTimeout(resolve, 350);
        }
      };
      step();
    });
    live = false;
    taskObserver.disconnect();
    frameObserver?.disconnect();
    const weekViewRenders = (window as any).__weekViewRenderDurations as number[];
    const appRenders = (window as any).__calendarAppRenderDurations as number[];
    const weekViewMarks = (window as any).__weekViewRenderMarks as Array<{ startTime: number; commitTime: number; actualDuration: number }>;
    const appMarks = (window as any).__calendarAppRenderMarks as Array<{ startTime: number; commitTime: number; actualDuration: number }>;
    const weekRenderStages = (window as any).__weekRenderStages as Array<{ id: string; duration: number }>;
    const panPaintMs = (window as any).__calendarPanPaintDurations as number[];
    const m = /([+-]) ([\d.]+)px/.exec(strip.style.transform);
    const residual = m ? Number(m[2]) * (m[1] === "-" ? 1 : -1) : 0;
    const lastDay = Number(document.querySelector(".day-head .dnum")!.textContent);
    const panSamples = gaps.filter((sample) => sample.time >= inputStart && sample.time <= inputEnd);
    const panGaps = panSamples.map((sample) => sample.gap).sort((a, b) => a - b);
    const settleGaps = gaps.filter((sample) => sample.time > inputEnd).map((sample) => sample.gap).sort((a, b) => a - b);
    const percentile = (samples: number[], fraction: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))] ?? 0;
    const slowFrames = panSamples.filter(({ gap }) => gap > 25).map(({ time, gap }) => {
      const eventsInFrame = wheelTimes
        .map((at, i) => ({ at, duration: wheelDispatchMs[i] }))
        .filter(({ at }) => at > time - gap && at <= time);
      return {
        gapMs: gap,
        elapsedFromInputStartMs: time - inputStart,
        wheelEventsInFrame: eventsInFrame.length,
        maxWheelDispatchMs: Math.max(0, ...eventsInFrame.map((e) => e.duration)),
      };
    });
    return {
      p50Ms: percentile(panGaps, 0.50),
      p95Ms: percentile(panGaps, 0.95),
      maxMs: panGaps[panGaps.length - 1],
      framesOver25Ms: panGaps.filter((gap) => gap > 25).length,
      slowFrames,
      maxWheelDispatchMs: Math.max(0, ...wheelDispatchMs),
      maxPanPaintMs: Math.max(0, ...panPaintMs),
      panPaintCalls: panPaintMs.length,
      panFrames: panGaps.length,
      inputDurationMs: inputEnd - inputStart,
      settleP95Ms: percentile(settleGaps, 0.95),
      panLongTasks: longTasks.filter((task) => task.startTime >= inputStart && task.startTime <= inputEnd),
      panLongFrames: longFrames.filter((frame) => frame.startTime >= inputStart && frame.startTime <= inputEnd),
      settleLongTasks: longTasks.filter((task) => task.startTime > inputEnd),
      weekViewRenderMs: weekViewRenders,
      calendarAppRenderMs: appRenders,
      panWeekViewCommits: weekViewMarks.filter((mark) => mark.commitTime >= inputStart && mark.commitTime <= inputEnd),
      panAppCommits: appMarks.filter((mark) => mark.commitTime >= inputStart && mark.commitTime <= inputEnd),
      renderStageMs: Object.fromEntries(["containers", "clusters", "regular"].map((id) => {
        const samples = weekRenderStages.filter((sample) => sample.id === id).map((sample) => sample.duration);
        return [
        id,
        { calls: samples.length, total: samples.reduce((sum, duration) => sum + duration, 0), max: Math.max(0, ...samples) },
        ];
      })),
      pixelsMoved: (lastDay - firstDay) * width + residual,
      frames: panGaps.length,
    };
  });
  console.log(`dense pan frame profile: ${JSON.stringify(metrics)}`);
  expect(metrics.pixelsMoved).toBeGreaterThan(500);
  expect(metrics.p95Ms, "dense-pan p95 should stay near a 60 Hz frame").toBeLessThan(18);
});

test("diagnostic: browser-delivered wheel input keeps dense pan responsive", async ({ page }) => {
  test.skip(process.env.CAL_PAN_INPUT_PROFILE !== "1", "Opt-in diagnostic; uses Playwright's browser input path");
  const events = Array.from({ length: 400 }, (_, i) => {
    const day = 14 + Math.floor(i / 45);
    const minuteOfDay = 8 * 60 + (i % 45) * 10;
    const endMinute = minuteOfDay + 30 + (i % 3) * 15;
    const stamp = (minute: number) => {
      const d = day + Math.floor(minute / 1440);
      const m = minute % 1440;
      return `2026-10-${String(d).padStart(2, "0")}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00-04:00`;
    };
    return {
      id: `dense-input-${i}`,
      calendar_id: "primary",
      etag: null,
      summary: `Dense ${i}`,
      description: null,
      location: null,
      start: stamp(minuteOfDay),
      end: stamp(endMinute),
      all_day: false,
      timezone: "America/New_York",
      status: "confirmed",
      recurrence: null,
      recurring_event_id: null,
      conference_url: null,
      updated: null,
      raw: {},
    };
  });
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, {
    calendars: [{ id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" }],
    events,
  });
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`);
  const viteDevServer = await page.evaluate(() => Boolean(document.querySelector('script[src*="/@vite/client"]')));
  test.skip(viteDevServer, "Pan performance traces require the production build; run npm run preview on port 1420");
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await page.keyboard.press("9");
  await expect(page.locator(".day-head")).toHaveCount(9);
  await page.waitForTimeout(300);
  const geometry = await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>("[data-testid=week-grid]")!;
    const strip = document.querySelector<HTMLElement>(".day-headers .pan-strip")!;
    const clip = document.querySelector<HTMLElement>(".day-clip")!;
    const width = clip.clientWidth / 9;
    const firstDay = Number(document.querySelector(".day-head .dnum")!.textContent);
    const gaps: Array<{ time: number; gap: number }> = [];
    const wheelTimes: number[] = [];
    const wheelStarted = new WeakMap<Event, number>();
    const dispatchMs: number[] = [];
    let previous = performance.now();
    let live = true;
    const tick = (time: number) => {
      gaps.push({ time, gap: time - previous });
      previous = time;
      if (live) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    (window as any).__weekViewRenderDurations = [];
    (window as any).__weekViewRenderMarks = [];
    (window as any).__weekRenderStages = [];
    (window as any).__calendarPanPaintDurations = [];
    grid.addEventListener("wheel", (event) => {
      const started = performance.now();
      wheelTimes.push(started);
      wheelStarted.set(event, started);
    }, true);
    grid.addEventListener("wheel", (event) => {
      const started = wheelStarted.get(event);
      if (started != null) dispatchMs.push(performance.now() - started);
    });
    (window as any).__finishPanInputProfile = () => {
      live = false;
      const panStart = wheelTimes[0] ?? 0;
      const panEnd = wheelTimes[wheelTimes.length - 1] ?? 0;
      const panGaps = gaps.filter(({ time }) => time >= panStart && time <= panEnd).map(({ gap }) => gap).sort((a, b) => a - b);
      const slowFrames = gaps.filter(({ time, gap }) => gap > 25 && time >= panStart && time <= panEnd).map(({ time, gap }) => {
        const events = wheelTimes
          .map((started, index) => ({ started, duration: dispatchMs[index] ?? 0 }))
          .filter(({ started }) => started > time - gap && started <= time);
        const commits = ((window as any).__weekViewRenderMarks as Array<{ startTime: number; commitTime: number; actualDuration: number }>)
          .filter((mark) => mark.commitTime > time - gap && mark.startTime < time);
        return {
          gapMs: gap,
          elapsedFromFirstWheelMs: time - panStart,
          wheelEventsInFrame: events.length,
          maxWheelDispatchMs: Math.max(0, ...events.map((event) => event.duration)),
          weekViewCommitsInFrame: commits,
        };
      });
      const sorted = panGaps;
      const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
      const match = /([+-]) ([\d.]+)px/.exec(strip.style.transform);
      const residual = match ? Number(match[2]) * (match[1] === "-" ? 1 : -1) : 0;
      const lastDay = Number(document.querySelector(".day-head .dnum")!.textContent);
      const stageSummary = ((window as any).__weekRenderStages as Array<{ id: string; duration: number }>).reduce(
        (totals, { id, duration }) => {
          const total = totals[id] ??= { count: 0, totalMs: 0, maxMs: 0 };
          total.count++;
          total.totalMs += duration;
          total.maxMs = Math.max(total.maxMs, duration);
          return totals;
        },
        {} as Record<string, { count: number; totalMs: number; maxMs: number }>,
      );
      return {
        p50Ms: percentile(0.50),
        p95Ms: percentile(0.95),
        maxMs: sorted[sorted.length - 1] ?? 0,
        framesOver25Ms: sorted.filter((gap) => gap > 25).length,
        slowFrames,
        maxWheelDispatchMs: Math.max(0, ...dispatchMs),
        maxPanPaintMs: Math.max(0, ...(window as any).__calendarPanPaintDurations),
        weekViewRenderMs: (window as any).__weekViewRenderDurations,
        panWeekViewCommits: (window as any).__weekViewRenderMarks,
        weekRenderStages: stageSummary,
        pixelsMoved: (lastDay - firstDay) * width + residual,
      };
    };
    return { x: grid.getBoundingClientRect().left + grid.clientWidth / 2, y: grid.getBoundingClientRect().top + 200 };
  });

  await page.mouse.move(geometry.x, geometry.y);
  const traceSession = process.env.CAL_PAN_TRACE === "1"
    ? await page.context().newCDPSession(page)
    : null;
  const traceEvents: any[] = [];
  if (traceSession) {
    traceSession.on("Tracing.dataCollected", ({ value }) => traceEvents.push(...value));
    await traceSession.send("Tracing.start", {
      categories: "devtools.timeline,disabled-by-default-devtools.timeline,toplevel,cc,viz,gpu,input,blink.user_timing",
      transferMode: "ReportEvents",
    });
  }
  if (traceSession) await page.evaluate(() => console.timeStamp("pan-profile-input-start"));
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(12, 0);
    await page.waitForTimeout(12);
  }
  if (traceSession) await page.evaluate(() => console.timeStamp("pan-profile-input-end"));
  await page.waitForTimeout(350);
  const metrics = await page.evaluate(() => (window as any).__finishPanInputProfile());
  console.log(`browser-input dense pan profile: ${JSON.stringify(metrics)}`);
  if (traceSession) {
    const complete = new Promise<void>((resolve) => traceSession.once("Tracing.tracingComplete", () => resolve()));
    await traceSession.send("Tracing.end");
    await complete;
    const markerMessage = (event: any) => event.args?.data?.message ?? event.args?.message ?? "";
    const markers = traceEvents.filter((event) => /TimeStamp|UserTiming/.test(event.name) && /pan-profile-input-(start|end)/.test(markerMessage(event)));
    const inputStart = markers.find((event) => /start/.test(markerMessage(event)))?.ts;
    const inputEnd = markers.find((event) => /end/.test(markerMessage(event)))?.ts;
    const inInput = traceEvents.filter((event) => inputStart != null && inputEnd != null && event.ts >= inputStart && event.ts <= inputEnd);
    const related = inInput.filter((event) => /Frame|Raster|Paint|Composite|Submit|BeginFrame|Swap|Dropped|DrawFrame|Tile/i.test(event.name));
    const counts = Object.fromEntries([...new Set(related.map((event) => event.name))]
      .map((name) => [name, related.filter((event) => event.name === name).length]));
    const long = related.filter((event) => (event.dur ?? 0) >= 1000)
      .sort((a, b) => b.dur - a.dur)
      .slice(0, 25)
      .map((event) => ({ name: event.name, category: event.cat, durationMs: event.dur / 1000, timestamp: event.ts, thread: event.tid, details: event.args?.data }));
    console.log(`browser-input compositor trace: ${JSON.stringify({ events: traceEvents.length, inputMarkers: markers.map((event) => ({ name: event.name, timestamp: event.ts, message: markerMessage(event) })), relatedCounts: counts, longest: long })}`);
    await traceSession.detach();
  }
  expect(metrics.pixelsMoved).toBeGreaterThan(500);
});
