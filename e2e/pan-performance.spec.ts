import { expect, test } from "@playwright/test";

const liveClock = process.env.CAL_PAN_LIVE_CLOCK === "1";
function nyDateBase(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(date);
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)!.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

const fixtureBase = liveClock ? nyDateBase() : { year: 2026, month: 10, day: 14 };

function fixtureLocalTime(dayOffset: number, minute: number, base = fixtureBase): string {
  // Derive New York's offset at local noon on the target date, then encode
  // the intended wall-clock minute. Noon avoids the DST transition hour.
  const targetNoonUtc = new Date(Date.UTC(base.year, base.month - 1, base.day + dayOffset, 12));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(targetNoonUtc);
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)!.value);
  const localNoonAsUtc = Date.UTC(
    part("year"), part("month") - 1, part("day"), part("hour"), part("minute"),
  );
  const offsetMs = localNoonAsUtc - targetNoonUtc.getTime();
  const targetLocalTimeAsUtc = Date.UTC(base.year, base.month - 1, base.day + dayOffset, 0, minute);
  return new Date(targetLocalTimeAsUtc - offsetMs).toISOString();
}

function panFixture(
  eventCount: number,
  idPrefix: string,
  withNotes: boolean,
  base = fixtureBase,
  eventsPerDay = 45,
  dayOffsetStart = 0,
) {
  const events = Array.from({ length: eventCount }, (_, i) => {
    const dayOffset = Math.floor(i / eventsPerDay) + dayOffsetStart;
    // Keep the original 45/day fixture unchanged. Denser profiles pack
    // events across a 10-hour workday so event count increases within the
    // fetched viewport instead of only extending history.
    const minuteStep = eventsPerDay === 45 ? 10 : Math.max(1, Math.floor(600 / eventsPerDay));
    const minuteOfDay = 8 * 60 + (i % eventsPerDay) * minuteStep;
    const endMinute = minuteOfDay + 30 + (i % 3) * 15;
    return {
      id: `${idPrefix}-${i}`,
      calendar_id: "primary",
      etag: null,
      summary: `Dense ${i}`,
      description: withNotes && i % 20 === 0 ? `[DRILL] note ${i}` : null,
      location: null,
      start: fixtureLocalTime(dayOffset, minuteOfDay, base),
      end: fixtureLocalTime(dayOffset, endMinute, base),
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
  return {
    calendars: [{ id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" }],
    events,
  };
}

function allDayPanFixture(eventCount: number, idPrefix: string) {
  const fixture = panFixture(eventCount, idPrefix, false);
  return {
    ...fixture,
    events: fixture.events.map((event) => {
      const date = event.start.slice(0, 10);
      const [year, month, day] = date.split("-").map(Number);
      const end = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
      return { ...event, start: date, end, all_day: true };
    }),
  };
}

function profileUrl() {
  return liveClock ? "/" : `/?now=${encodeURIComponent("2026-10-14T09:00:00")}`;
}

test("gesture: a clear trackpad stream switches to passive native scrolling", async ({ page }) => {
  await page.addInitScript(() => {
    const add = EventTarget.prototype.addEventListener;
    (window as any).__weekWheelOptions = [];
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if (type === "wheel" && this instanceof Element &&
          (this.classList.contains("weekview") || this.classList.contains("main"))) {
        (window as any).__weekWheelOptions.push({
          passive: typeof options === "object" && options !== null ? options.passive === true : false,
          target: this.className,
          nativePanHandler: String(listener).includes("nativeDeltaLimit"),
        });
      }
      return add.call(this, type, listener, options);
    };
  });
  await page.goto(profileUrl());
  await expect(page.getByTestId("week-grid")).toBeVisible();
  await page.keyboard.press("9");
  await expect(page.locator(".day-head")).toHaveCount(9);

  const grid = page.getByTestId("week-grid");
  await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>("[data-testid=week-grid]")!;
    (window as any).__weekWheelEvents = [];
    element.addEventListener("wheel", (event) => {
      (window as any).__weekWheelEvents.push({ trusted: event.isTrusted, prevented: event.defaultPrevented });
    }, { passive: true });
  });
  const start = await grid.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }));
  const bounds = await grid.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + 200);
  await page.mouse.wheel(36, 0);
  await expect.poll(() => grid.evaluate((element) => element.scrollLeft)).toBeGreaterThan(start.left);
  await expect.poll(() => page.evaluate(() =>
    ((window as any).__weekWheelOptions as Array<{ passive: boolean; nativePanHandler: boolean }>)
      .some(({ passive, nativePanHandler }) => passive && nativePanHandler),
  )).toBe(true);

  const afterHorizontal = await grid.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }));
  const wheelState = await page.evaluate(() => ({
    options: (window as any).__weekWheelOptions as Array<{ passive: boolean; target: string; nativePanHandler: boolean }>,
    events: (window as any).__weekWheelEvents as Array<{ trusted: boolean; prevented: boolean }>,
  }));
  const mainListeners = wheelState.options.filter(({ target }) => target === "main");
  expect(mainListeners.length).toBeGreaterThan(0);
  expect(mainListeners.every(({ passive }) => passive), "the app shell must not block descendant wheel scrolling").toBe(true);
  expect(wheelState.events.length).toBeGreaterThan(0);
  expect(wheelState.events.every(({ trusted }) => trusted), "Playwright must exercise browser-delivered input").toBe(true);
  expect(wheelState.events.every(({ prevented }) => !prevented), "native trackpad input must reach the browser scroller").toBe(true);

  await page.mouse.wheel(0, 60);
  await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(afterHorizontal.top);
  await expect.poll(() => grid.evaluate((element) => element.scrollLeft)).toBe(afterHorizontal.left);

  await page.keyboard.down("Control");
  await expect.poll(() => page.evaluate(() =>
    ((window as any).__weekWheelOptions as Array<{ passive: boolean; target: string }>).some(({ passive, target }) =>
      target === "main" && !passive,
    ),
  )).toBe(true);
  await page.keyboard.up("Control");
});

for (const [label, deltaY] of [["native", 0], ["mixed-axis", 2]] as const) {
test(`gesture: sustained ${label} horizontal input keeps a continuous visual position`, async ({ page }) => {
  const fixture = panFixture(900, "trusted-snap", false, nyDateBase(), 120, -3);
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, fixture);
  await page.goto("/");
  await page.keyboard.press("9");
  await expect(page.locator(".day-head")).toHaveCount(9);
  const grid = page.getByTestId("week-grid");
  const bounds = (await grid.boundingBox())!;
  await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>("[data-testid=week-grid]")!;
    const ordinal = () => Date.parse(document.querySelector<HTMLElement>(".day-head")!.dataset.day + "T00:00:00Z") / 86400000;
    const initialDay = ordinal();
    const samples: { position: number; width: number; input: number; day: number }[] = [];
    let input = 0;
    let trusted = 0;
    let prevented = 0;
    let live = true;
    element.addEventListener("wheel", (event) => {
      input += event.deltaX;
      if (event.isTrusted) trusted++;
      if (event.defaultPrevented) prevented++;
    }, { passive: true });
    const tick = () => {
      const width = document.querySelector<HTMLElement>(".day-clip")!.clientWidth / document.querySelectorAll(".day-head").length;
      samples.push({ position: (ordinal() - initialDay) * width + element.scrollLeft - 2 * width,
        width, input, day: ordinal() - initialDay });
      if (live) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    (window as any).__trustedPanTrace = {
      samples,
      stop: () => { live = false; return { samples, trusted, prevented, input }; },
    };
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  for (let index = 0; index < 80; index++) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: bounds.x + bounds.width / 2, y: bounds.y + 200,
      deltaX: 50, deltaY,
    });
    await page.waitForTimeout(8);
  }
  await page.waitForTimeout(200);
  const result = await page.evaluate(() => (window as any).__trustedPanTrace.stop()) as {
    samples: { position: number; width: number; input: number; day: number }[];
    trusted: number; prevented: number; input: number;
  };
  const steps = result.samples.slice(1).map((sample, index) => sample.position - result.samples[index].position);
  const summary = {
    trusted: result.trusted, prevented: result.prevented, input: result.input,
    movement: result.samples.at(-1)!.position - result.samples[0].position,
    maxBack: Math.min(...steps), maxForward: Math.max(...steps),
    widthRange: Math.max(...result.samples.map((sample) => sample.width)) - Math.min(...result.samples.map((sample) => sample.width)),
    daySteps: result.samples.at(-1)!.day,
  };
  console.log(`trusted horizontal pan: ${JSON.stringify(summary)}`);
  expect(summary.trusted).toBeGreaterThan(60);
  expect(summary.daySteps).toBeGreaterThan(2);
  expect(summary.maxBack, "a date rebase must not move the calendar backward").toBeGreaterThan(-1);
  expect(Math.abs(summary.movement - summary.input), "day rebases must preserve horizontal distance").toBeLessThan(2);
});
}

test("pan: a dense day step reuses cluster rows when the live clock is unchanged", async ({ page }) => {
  const fixture = panFixture(400, "cluster-cache", false, nyDateBase());
  expect(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hourCycle: "h12",
  }).format(new Date(fixture.events[0].start))).toBe("8:00 AM");
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, fixture);
  await page.goto("/");
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await page.keyboard.press("9");
  await expect(page.locator(".day-head")).toHaveCount(9);
  await expect.poll(() => page.locator(".cluster-row").count()).toBeGreaterThan(0);
  expect(await page.locator(".cluster-row").count()).toBeLessThan(400);
  expect(await page.locator(".cluster-block").evaluateAll((blocks) => blocks.reduce((total, block) =>
    total + Number((block as HTMLElement).dataset.rowCount), 0))).toBe(400);

  await page.evaluate(() => { (window as any).__weekRenderStages = []; });
  const firstDay = (await page.locator(".day-head .dnum").first().textContent())?.trim();
  const deltaX = await page.locator(".day-clip").evaluate((el) => el.clientWidth / 9 + 1);
  await page.getByTestId("week-grid").evaluate((grid, dx) => {
    grid.dispatchEvent(new WheelEvent("wheel", { deltaX: dx, deltaY: 0, bubbles: true, cancelable: true }));
  }, deltaX);
  await expect.poll(async () => (await page.locator(".day-head .dnum").first().textContent())?.trim())
    .not.toBe(firstDay);

  const clusterRebuilds = await page.evaluate(() =>
    ((window as any).__weekRenderStages as Array<{ id: string }>).filter(({ id }) => id === "clusters").length,
  );
  const chipRebuilds = await page.evaluate(() => {
    const stages = (window as any).__weekRenderStages as Array<{ id: string }>;
    return {
      regular: stages.filter(({ id }) => id === "regular").length,
      containers: stages.filter(({ id }) => id === "containers").length,
    };
  });
  expect(clusterRebuilds, "only the newly exposed day should need fresh cluster rows").toBeLessThanOrEqual(2);
  expect(chipRebuilds.regular, "unchanged visible days should reuse regular-chip subtrees").toBeLessThanOrEqual(2);
  expect(chipRebuilds.containers, "unchanged visible days should reuse container subtrees").toBeLessThanOrEqual(2);
});

test("dense cluster rows retain their positions and mount as the vertical viewport moves", async ({ page }) => {
  const fixture = panFixture(400, "row-window", false, nyDateBase());
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, fixture);
  await page.goto("/");
  await page.keyboard.press("9");
  const grid = page.getByTestId("week-grid");
  const blocks = page.getByTestId("cluster-block");
  await expect(blocks).toHaveCount(9);
  await grid.evaluate((element) => { element.scrollTop = 0; });
  const firstKeys = await blocks.locator(".cluster-row").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.ek));
  const heights = await blocks.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  await grid.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => blocks.locator(".cluster-row").evaluateAll((rows) =>
    rows.map((row) => (row as HTMLElement).dataset.ek))).not.toEqual(firstKeys);
  expect(await blocks.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))).toEqual(heights);
  const geometry = await blocks.evaluateAll((elements) => elements.reduce((acc, element) => {
    acc.total += Number((element as HTMLElement).dataset.rowCount);
    acc.mounted += element.querySelectorAll(".cluster-row").length;
    acc.spacerPixels += [...element.querySelectorAll<HTMLElement>(".cluster-row-spacer")]
      .reduce((sum, spacer) => sum + spacer.offsetHeight, 0);
    return acc;
  }, { total: 0, mounted: 0, spacerPixels: 0 }));
  expect(geometry.mounted).toBeLessThanOrEqual(geometry.total);
  expect(geometry.mounted + geometry.spacerPixels / 15).toBe(400);
});

test("pan: a day step replaces only the departing dense body column", async ({ page }) => {
  const fixture = panFixture(400, "column-move", false, nyDateBase());
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, fixture);
  await page.goto("/");
  await page.keyboard.press("9");
  await expect(page.locator(".day-head")).toHaveCount(9);
  await expect.poll(() => page.locator(".cluster-row").count()).toBeGreaterThan(0);
  const mountedRows = await page.locator(".cluster-row").count();
  expect(mountedRows).toBeLessThan(400);

  await page.evaluate(() => {
    const strip = document.querySelector(".day-cols")!;
    const changes = { added: 0, removed: 0 };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        changes.added += [...record.addedNodes].filter((node) =>
          node instanceof Element && node.classList.contains("day-col")).length;
        changes.removed += [...record.removedNodes].filter((node) =>
          node instanceof Element && node.classList.contains("day-col")).length;
      }
    });
    observer.observe(strip, { childList: true });
    (window as any).__panColumnChanges = { changes, observer };
  });
  const firstDay = await page.locator(".day-head .dnum").first().textContent();
  const deltaX = await page.locator(".day-clip").evaluate((el) => el.clientWidth / 9 + 1);
  await page.getByTestId("week-grid").evaluate((grid, dx) => {
    grid.dispatchEvent(new WheelEvent("wheel", { deltaX: dx, deltaY: 0, bubbles: true, cancelable: true }));
  }, deltaX);
  await expect.poll(async () => page.locator(".day-head .dnum").first().textContent()).not.toBe(firstDay);
  const result = await page.evaluate(() => {
    const { changes, observer } = (window as any).__panColumnChanges;
    observer.disconnect();
    return changes as { added: number; removed: number };
  });
  expect(result).toEqual({ added: 1, removed: 1 });
  await expect(page.locator(".cluster-row")).toHaveCount(mountedRows);
  const firstColumnAlignment = await page.evaluate(() => {
    const head = document.querySelector(".day-head")!.getBoundingClientRect();
    const body = document.querySelector('[data-testid="day-col-0"]')!.getBoundingClientRect();
    return Math.abs(head.left - body.left);
  });
  expect(firstColumnAlignment).toBeLessThan(1);
});

test("pan: a clock tick does not rebuild dense cluster rows if their status is unchanged", async ({ page }) => {
  const base = nyDateBase();
  const fixture = panFixture(400, "clock-cache", false, base, 120);
  await page.clock.install({ time: new Date(fixtureLocalTime(0, 9 * 60, base)) });
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, fixture);
  await page.goto("/");
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await page.keyboard.press("9");
  await expect(page.locator(".day-head")).toHaveCount(9);
  await expect.poll(() => page.locator(".cluster-row").count()).toBeGreaterThan(0);
  expect(await page.locator(".cluster-row").count()).toBeLessThan(400);

  await page.evaluate(() => {
    (window as any).__weekRenderStages = [];
    (window as any).__weekViewRenderMarks = [];
  });
  await page.clock.fastForward(30_000);
  await expect.poll(() => page.evaluate(() => (window as any).__weekViewRenderMarks.length))
    .toBeGreaterThan(0);

  const clusterRebuilds = await page.evaluate(() =>
    ((window as any).__weekRenderStages as Array<{ id: string }>).filter(({ id }) => id === "clusters").length,
  );
  expect(clusterRebuilds, "time-only rerenders should reuse unchanged cluster rows").toBe(0);
});

test("pan: cluster rows refresh when an event crosses its end time", async ({ page }) => {
  const base = nyDateBase();
  const events = [0, 1, 2].map((index) => ({
    id: `clock-boundary-${index}`,
    calendar_id: "primary",
    etag: null,
    summary: `Boundary ${index}`,
    description: null,
    location: null,
    start: fixtureLocalTime(0, 9 * 60 + 50 + index, base),
    end: fixtureLocalTime(0, 10 * 60 + index, base),
    all_day: false,
    timezone: "America/New_York",
    status: "confirmed",
    recurrence: null,
    recurring_event_id: null,
    conference_url: null,
    updated: null,
    raw: {},
  }));
  await page.clock.install({
    time: new Date(new Date(fixtureLocalTime(0, 9 * 60 + 59, base)).getTime() + 30_000),
  });
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, {
    calendars: [{ id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" }],
    events,
  });
  await page.goto("/");
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await page.keyboard.press("1");
  await expect(page.locator(".day-head")).toHaveCount(1);
  await expect(page.locator(".cluster-row")).toHaveCount(3);
  const firstRow = page.locator('[data-ek="primary/clock-boundary-0"]');
  await expect(firstRow).not.toHaveClass(/past/);

  await page.clock.fastForward(30_000);
  await expect(firstRow).toHaveClass(/past/);
  await expect(firstRow).toHaveClass(/unsettled/);
});

test("pan: a fetched range shift only re-lays out days whose events changed", async ({ page }) => {
  const fixture = panFixture(4000, "range-cache", false);
  await page.addInitScript((fx) => {
    (globalThis as any).__calFixture = fx;
    (globalThis as any).__weekRenderStages = [];
  }, fixture);
  await page.goto(profileUrl());
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await page.keyboard.press("9");
  await expect(page.locator(".day-head")).toHaveCount(9);
  await expect.poll(() => page.evaluate(() =>
    ((window as any).__weekRenderStages as Array<{ id: string }>).some(({ id }) => id === "day-items-index"),
  )).toBe(true);
  await page.waitForTimeout(100);
  await page.evaluate(() => { (window as any).__weekRenderStages = []; });

  const firstDay = (await page.locator(".day-head .dnum").first().textContent())?.trim();
  const eightDays = await page.locator(".day-clip").evaluate((el) => (el.clientWidth / 9) * 8 + 1);
  await page.getByTestId("week-grid").evaluate((grid, dx) => {
    grid.dispatchEvent(new WheelEvent("wheel", { deltaX: dx, deltaY: 0, bubbles: true, cancelable: true }));
  }, eightDays);
  await expect.poll(async () => (await page.locator(".day-head .dnum").first().textContent())?.trim())
    .not.toBe(firstDay);
  // The eight-day jump crosses App's week-quantized fetch boundary. Wait for
  // the resulting snapshot to rebuild the event index before measuring cache hits.
  await expect.poll(() => page.evaluate(() =>
    ((window as any).__weekRenderStages as Array<{ id: string }>).filter(({ id }) => id === "day-items-index").length,
  )).toBeGreaterThan(0);

  const rebuiltDays = await page.evaluate(() =>
    ((window as any).__weekRenderStages as Array<{ id: string }>).filter(({ id }) => id === "day-layout").length,
  );
  expect(rebuiltDays, "an overlapping fetch must preserve layouts for unchanged dates").toBeLessThanOrEqual(10);
});

test("all-day index keeps a long event visible on every covered date", async ({ page }) => {
  const fixture = allDayPanFixture(1, "long-all-day");
  const [year, month, day] = fixture.events[0].start.split("-").map(Number);
  fixture.events[0].start = new Date(Date.UTC(year, month - 1, day - 7)).toISOString().slice(0, 10);
  fixture.events[0].end = new Date(Date.UTC(year, month - 1, day + 33)).toISOString().slice(0, 10);
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, fixture);
  await page.goto(profileUrl());
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await page.keyboard.press("9");
  await expect(page.locator(".day-head")).toHaveCount(9);
  // WeekView includes the 9 visible columns and two scroll-runway columns on each side.
  await expect(page.locator(".chip-allday")).toHaveCount(13);
});

test("timed day index keeps a 40-day event on every covered date", async ({ page }) => {
  const fixture = panFixture(1, "long-timed", false);
  fixture.events[0].start = "2026-10-07T09:00:00-04:00";
  fixture.events[0].end = "2026-11-16T10:00:00-05:00";
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, fixture);
  await page.goto(profileUrl());
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await page.keyboard.press("9");
  await expect(page.locator(".day-head")).toHaveCount(9);
  // The event crosses the 31-day index bound and spans the entire visible window.
  await expect(page.getByTestId("event-chip")).toHaveCount(13);
});

test("timed day index preserves a midnight end on the prior date", async ({ page }) => {
  const fixture = panFixture(1, "midnight-end", false);
  fixture.events[0].summary = "Midnight end";
  fixture.events[0].start = "2026-10-14T22:00:00-04:00";
  fixture.events[0].end = "2026-10-15T00:00:00-04:00";
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, fixture);
  await page.goto(profileUrl());
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const event = page.getByTestId("event-chip").filter({ hasText: "Midnight end" });
  await expect(event).toHaveCount(1);
  const box = await event.boundingBox();
  expect(box?.height).toBeGreaterThan(90);
  expect(box?.height).toBeLessThan(100);
});

test("dense-calendar horizontal pan stays within a frame budget", async ({ page }) => {
  test.skip(process.env.CAL_PAN_PROFILE !== "1", "Run isolated against vite preview with CAL_PAN_PROFILE=1; background workers distort frame timing");
  const fixture = process.env.CAL_PAN_ALL_DAY === "1"
    ? allDayPanFixture(Number(process.env.CAL_PAN_EVENT_COUNT ?? 400), "dense-all-day")
    : panFixture(
      Number(process.env.CAL_PAN_EVENT_COUNT ?? 400),
      "dense",
      true,
      fixtureBase,
      Number(process.env.CAL_PAN_EVENTS_PER_DAY ?? 45),
    );
  const { events } = fixture;
  await page.addInitScript((fx) => {
    (globalThis as any).__calFixture = fx;
    (globalThis as any).__marginNoteIndexBuilds = [];
    (globalThis as any).__marginWorkerStages = [];
  }, fixture);
  await page.goto(profileUrl());
  const viteDevServer = await page.evaluate(() => Boolean(document.querySelector('script[src*="/@vite/client"]')));
  test.skip(viteDevServer, "Frame-budget profiling is meaningful against the production build; run npm run preview on port 1420");
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await page.keyboard.press("9");
  await expect(page.locator(".day-head")).toHaveCount(9);
  await page.waitForTimeout(300); // include the first note-layout pass, not initial page load
  if (process.env.CAL_PAN_STYLE) {
    await page.addStyleTag({ content: process.env.CAL_PAN_STYLE });
  }

  const cpuSession = process.env.CAL_PAN_CPU_PROFILE === "1" || process.env.CAL_PAN_CPU_THROTTLE
    ? await page.context().newCDPSession(page)
    : null;
  if (cpuSession && process.env.CAL_PAN_CPU_THROTTLE) {
    await cpuSession.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.CAL_PAN_CPU_THROTTLE) });
  }
  if (cpuSession && process.env.CAL_PAN_CPU_PROFILE === "1") {
    await cpuSession.send("Profiler.enable");
    await cpuSession.send("Profiler.start");
  }
  const metrics = await page.evaluate(async (includeSettle: boolean) => {
    (window as any).__weekViewRenderDurations = [];
    (window as any).__calendarAppRenderDurations = [];
    (window as any).__weekViewRenderMarks = [];
    (window as any).__calendarAppRenderMarks = [];
    (window as any).__weekRenderStages = [];
    (window as any).__marginRenderMarks = [];
    (window as any).__marginNoteIndexBuilds.length = 0;
    const grid = document.querySelector<HTMLElement>("[data-testid=week-grid]")!;
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
    const scrollChanges: Array<{ time: number; left: number; day: number }> = [];
    const tick = (time: number) => {
      gaps.push({ time, gap: time - previous });
      previous = time;
      if (live) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    grid.addEventListener("scroll", () => {
      scrollChanges.push({
        time: performance.now(),
        left: grid.scrollLeft,
        day: Number(document.querySelector(".day-head .dnum")!.textContent),
      });
    }, { passive: true });
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
          setTimeout(resolve, includeSettle ? 350 : 0);
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
    const lastDay = Number(document.querySelector(".day-head .dnum")!.textContent);
    const panSamples = gaps.filter((sample) => sample.time >= inputStart && sample.time <= inputEnd);
    const panGaps = panSamples.map((sample) => sample.gap).sort((a, b) => a - b);
    const settleGaps = gaps.filter((sample) => sample.time > inputEnd).map((sample) => sample.gap).sort((a, b) => a - b);
    const percentile = (samples: number[], fraction: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))] ?? 0;
    const slowFrames = panSamples.filter(({ gap }) => gap > 25).map(({ time, gap }) => {
      const eventsInFrame = wheelTimes
        .map((at, i) => ({ at, duration: wheelDispatchMs[i] }))
        .filter(({ at }) => at > time - gap && at <= time);
      const commitsInFrame = (marks: Array<{ startTime: number; commitTime: number; actualDuration: number }>) =>
        marks.filter((mark) => mark.commitTime > time - gap && mark.startTime < time);
      return {
        gapMs: gap,
        elapsedFromInputStartMs: time - inputStart,
        wheelEventsInFrame: eventsInFrame.length,
        maxWheelDispatchMs: Math.max(0, ...eventsInFrame.map((e) => e.duration)),
        weekViewCommits: commitsInFrame(weekViewMarks),
        appCommits: commitsInFrame(appMarks),
      };
    });
    return {
      p50Ms: percentile(panGaps, 0.50),
      p95Ms: percentile(panGaps, 0.95),
      maxMs: panGaps[panGaps.length - 1],
      framesOver25Ms: panGaps.filter((gap) => gap > 25).length,
      slowFrames,
      maxWheelDispatchMs: Math.max(0, ...wheelDispatchMs),
      wheelToScrollLatency: (() => {
        const latencies = wheelTimes.map((started) => {
          const changed = scrollChanges.find((change) => change.time >= started);
          return changed ? changed.time - started : Number.POSITIVE_INFINITY;
        }).filter(Number.isFinite).sort((a, b) => a - b);
        return {
          samples: latencies.length,
          p50Ms: percentile(latencies, 0.50),
          p95Ms: percentile(latencies, 0.95),
          maxMs: latencies[latencies.length - 1] ?? 0,
          missing: wheelTimes.length - latencies.length,
        };
      })(),
      scrollEventCount: scrollChanges.length,
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
      renderStageMs: Object.fromEntries(["day-items-index", "day-items", "day-layout", "all-day-items-index", "all-day-items", "containers", "clusters", "regular"].map((id) => {
        const samples = weekRenderStages.filter((sample) => sample.id === id).map((sample) => sample.duration);
        return [
        id,
        { calls: samples.length, total: samples.reduce((sum, duration) => sum + duration, 0), max: Math.max(0, ...samples) },
        ];
      })),
      marginRenderMarks: (window as any).__marginRenderMarks,
      marginNoteIndexBuilds: (window as any).__marginNoteIndexBuilds,
      marginWorkerStages: (window as any).__marginWorkerStages,
      marginNoteDomCount: document.querySelectorAll('[data-testid="margin-note"]').length,
      calendarDomCounts: {
        timedChips: document.querySelectorAll('[data-testid="event-chip"]').length,
        allDayChips: document.querySelectorAll('.chip-allday').length,
        clusterRows: document.querySelectorAll('.cluster-row').length,
        clusterBlocks: document.querySelectorAll('.cluster-block').length,
        inlineSvgs: document.querySelectorAll('.day-col svg').length,
      },
      marginPlacementPending: document.querySelector<HTMLElement>('[data-testid="margin-notes"]')?.dataset.pending,
      marginPlacementMs: (window as any).__marginMs ?? null,
      pixelsMoved: (lastDay - firstDay) * width + grid.scrollLeft - 2 * width,
      frames: panGaps.length,
    };
  }, process.env.CAL_PAN_CPU_PROFILE !== "1");
  console.log(`pan frame profile (${events.length} events): ${JSON.stringify(metrics)}`);
  const annotationWaitStarted = Date.now();
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>('[data-testid="margin-notes"]')?.dataset.pending === "0",
    null,
    { timeout: 15_000 },
  );
  const annotationResult = await page.evaluate((startedAt) => ({
    waitMs: Date.now() - startedAt,
    workerMs: (window as any).__marginMs ?? null,
    stages: (window as any).__marginWorkerStages,
    noteCount: document.querySelectorAll('[data-testid="margin-note"]').length,
    pending: document.querySelector<HTMLElement>('[data-testid="margin-notes"]')?.dataset.pending,
  }), annotationWaitStarted);
  console.log(`pan annotation placement after settle: ${JSON.stringify(annotationResult)}`);
  expect(annotationResult.noteCount, "the dense viewport should keep annotations visible").toBeGreaterThan(0);
  expect(annotationResult.workerMs, "crowded-week note placement should finish promptly").toBeLessThan(1_500);
  if (cpuSession && process.env.CAL_PAN_CPU_PROFILE === "1") {
    const { profile } = await cpuSession.send("Profiler.stop");
    const selfMs = new Map<number, number>();
    profile.samples?.forEach((nodeId: number, index: number) => {
      selfMs.set(nodeId, (selfMs.get(nodeId) ?? 0) + (profile.timeDeltas?.[index] ?? 0) / 1000);
    });
    const frameById = new Map<number, any>(profile.nodes.map((node: any) => [node.id, node.callFrame]));
    const hot = [...selfMs.entries()]
      .map(([nodeId, ms]) => ({ ...frameById.get(nodeId), selfMs: Math.round(ms * 100) / 100 }))
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, 20);
    console.log(`dense pan sampled JS hot functions: ${JSON.stringify(hot)}`);
  }
  expect(metrics.pixelsMoved).toBeGreaterThan(500);
  expect(metrics.panAppCommits.length, "production probe should include the App shell's day-window renders").toBeGreaterThan(0);
  expect(metrics.renderStageMs.clusters.calls, "horizontal day steps should reuse unaffected cluster rows").toBeLessThanOrEqual(25);
  const cpuRate = Math.max(1, Number(process.env.CAL_PAN_CPU_THROTTLE ?? 1));
  if (process.env.CAL_PAN_ALL_DAY === "1") {
    expect(
      metrics.renderStageMs["all-day-items"].total,
      "each pan render should read date-indexed all-day items, not rescan the fetched history",
    ).toBeLessThan(Math.max(1, cpuRate));
  }
  expect(
    metrics.renderStageMs["day-items"].total,
    "exposing a day should use the day index, not rescan the fetched event history",
  ).toBeLessThan(cpuRate);
  expect(
    metrics.marginNoteIndexBuilds.length,
    "panning may rebuild notes when the fetch window changes, but not once per exposed day",
  ).toBeLessThanOrEqual(2);
  expect(metrics.p95Ms, "pan p95 should stay within the CPU-scaled frame budget").toBeLessThan(18 * cpuRate);
});

test("dense annotation pan cancels superseded worker placements", async ({ page }) => {
  const fixture = panFixture(8000, "dense-note-cancel", true, fixtureBase, 180);
  await page.addInitScript((fx) => {
    (globalThis as any).__calFixture = fx;
    (globalThis as any).__marginWorkerStages = [];
  }, fixture);
  await page.goto(profileUrl());
  await page.keyboard.press("9");
  await expect(page.locator(".day-head")).toHaveCount(9);

  const grid = page.getByTestId("week-grid");
  const dx = await page.locator(".day-clip").evaluate((el) => el.clientWidth / 9 + 1);
  await grid.evaluate((el, deltaX) => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaX, deltaY: 0, bubbles: true, cancelable: true }));
  }, dx);
  // MarginNotes waits until the complete wheel burst settles before measuring.
  await page.waitForTimeout(260);
  const completedStages = await page.evaluate(() => (window as any).__marginWorkerStages.length);
  await page.waitForFunction(
    (before) => (window as any).__marginWorkerStages.length >= before + 5,
    completedStages,
    { timeout: 1_500 },
  );
  const result = await page.evaluate(() => ({
    workerMs: (window as any).__marginMs,
    notes: document.querySelectorAll('[data-testid="margin-note"]').length,
    pending: document.querySelector<HTMLElement>('[data-testid="margin-notes"]')?.dataset.pending,
  }));
  expect(result.workerMs, "the current note layout must not wait behind obsolete searches").toBeLessThan(1_500);
  expect(result.notes, "annotations remain visible in a crowded week").toBeGreaterThan(0);
  expect(result.pending).toBe("0");
});

test("diagnostic: browser-delivered wheel input keeps calendar pan responsive", async ({ page }) => {
  test.skip(process.env.CAL_PAN_INPUT_PROFILE !== "1", "Opt-in diagnostic; uses Playwright's browser input path");
  const wheelDx = Number(process.env.CAL_PAN_WHEEL_DX ?? 12);
  const wheelDy = Number(process.env.CAL_PAN_WHEEL_DY ?? 0);
  const legacyClusterDots = process.env.CAL_PAN_LEGACY_CLUSTER_DOTS === "1";
  const eventsPerDay = Number(process.env.CAL_PAN_EVENTS_PER_DAY ?? 45);
  const fullCoverage = process.env.CAL_PAN_EVENT_COUNT == null;
  // Keep a full three-week dense window by default. Setting only
  // CAL_PAN_EVENTS_PER_DAY used to leave this diagnostic at 400 total events,
  // populating just the first two days at 240/day and understating pan cost.
  const eventCount = fullCoverage
    ? eventsPerDay * 21
    : Number(process.env.CAL_PAN_EVENT_COUNT);
  const fixture = panFixture(
    eventCount,
    "dense-input",
    false,
    fixtureBase,
    eventsPerDay,
    fullCoverage ? -1 : 0,
  );
  const { events } = fixture;
  await page.addInitScript(({ fx, passiveWheel }) => {
    (globalThis as any).__calFixture = fx;
    if (passiveWheel) {
      const add = EventTarget.prototype.addEventListener;
      (globalThis as any).__calPassiveWheelIntercepted = 0;
      EventTarget.prototype.addEventListener = function(type, listener, options) {
        if (type === "wheel" && this instanceof Element && this.classList.contains("weekview") &&
            options && typeof options === "object" && options.passive === false) {
          (globalThis as any).__calPassiveWheelIntercepted++;
          options = { ...options, passive: true };
        }
        return add.call(this, type, listener, options);
      };
    }
  }, {
    fx: fixture,
    passiveWheel: process.env.CAL_PAN_PASSIVE_WHEEL === "1",
  });
  await page.goto(profileUrl());
  const viteDevServer = await page.evaluate(() => Boolean(document.querySelector('script[src*="/@vite/client"]')));
  test.skip(viteDevServer, "Pan performance traces require the production build; run npm run preview on port 1420");
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await page.keyboard.press("9");
  await expect(page.locator(".day-head")).toHaveCount(9);
  await page.waitForTimeout(300);
  if (process.env.CAL_PAN_STYLE) {
    await page.addStyleTag({ content: process.env.CAL_PAN_STYLE });
  }
  const geometry = await page.evaluate(({ allowNativeScroll, legacyClusterDots }) => {
    const grid = document.querySelector<HTMLElement>("[data-testid=week-grid]")!;
    const clip = document.querySelector<HTMLElement>(".day-clip")!;
    const width = clip.clientWidth / 9;
    const initialScrollLeft = grid.scrollLeft;
    grid.scrollLeft = initialScrollLeft + 0.375;
    const fractionalScrollResponse = grid.scrollLeft - initialScrollLeft;
    grid.scrollLeft = initialScrollLeft;
    const firstDay = Number(document.querySelector(".day-head .dnum")!.textContent);
    if (legacyClusterDots) {
      const style = document.createElement("style");
      style.textContent = [
        ".cluster-row::before{display:none!important}",
        ".cluster-dot{width:6px;height:6px;border-radius:2px;flex:none}",
        ".cluster-row.past .cluster-dot{opacity:.4}",
      ].join("");
      document.head.append(style);
      for (const row of document.querySelectorAll<HTMLElement>(".cluster-row")) {
        const marker = document.createElement("span");
        marker.className = "cluster-dot";
        marker.style.background = getComputedStyle(row).getPropertyValue("--cluster-dot-color");
        row.prepend(marker);
      }
    }
    const gaps: Array<{ time: number; gap: number }> = [];
    const wheelTimes: number[] = [];
    const scrollChanges: Array<{ time: number; left: number }> = [];
    const frameScrollChanges: Array<{ time: number; left: number }> = [];
    const wheelStarted = new WeakMap<Event, number>();
    const dispatchMs: number[] = [];
    const wheelSamples: Array<{ trusted: boolean; dx: number; dy: number; prevented: boolean }> = [];
    let defaultPreventedWheelCount = 0;
    let previous = performance.now();
    let previousFrameScrollLeft = grid.scrollLeft;
    let live = true;
    const tick = (time: number) => {
      gaps.push({ time, gap: time - previous });
      previous = time;
      const left = grid.scrollLeft;
      if (left !== previousFrameScrollLeft) {
        frameScrollChanges.push({ time, left });
        previousFrameScrollLeft = left;
      }
      if (live) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    grid.addEventListener("scroll", () => {
      scrollChanges.push({ time: performance.now(), left: grid.scrollLeft });
    }, { passive: true });
    (window as any).__weekViewRenderDurations = [];
    (window as any).__weekViewRenderMarks = [];
    (window as any).__weekRenderStages = [];
    grid.addEventListener("wheel", (event) => {
      const started = performance.now();
      wheelTimes.push(started);
      wheelStarted.set(event, started);
    }, true);
    grid.addEventListener("wheel", (event) => {
      const started = wheelStarted.get(event);
      if (started != null) {
        dispatchMs.push(performance.now() - started);
        if (event.defaultPrevented) defaultPreventedWheelCount++;
        if (wheelSamples.length < 12) {
          wheelSamples.push({ trusted: event.isTrusted, dx: event.deltaX, dy: event.deltaY, prevented: event.defaultPrevented });
        }
      }
    });
    if (allowNativeScroll) {
      // Diagnostic only: let a trusted browser wheel reach the scrollable
      // weekview's native default action. Its scroll listener still advances
      // the day window and rebases at each boundary.
      grid.addEventListener("wheel", (event) => event.stopImmediatePropagation(), {
        capture: true,
        passive: true,
      });
    }
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
      const wheelToScrollMs = wheelTimes.map((started) => {
        const changed = scrollChanges.find((change) => change.time >= started);
        return changed ? changed.time - started : Number.POSITIVE_INFINITY;
      }).filter(Number.isFinite).sort((a, b) => a - b);
      const wheelToFrameScrollMs = wheelTimes.map((started) => {
        const changed = frameScrollChanges.find((change) => change.time >= started);
        return changed ? changed.time - started : Number.POSITIVE_INFINITY;
      }).filter(Number.isFinite).sort((a, b) => a - b);
      const scrollLatency = {
        samples: wheelToScrollMs.length,
        p50Ms: wheelToScrollMs[Math.floor(wheelToScrollMs.length * 0.50)] ?? 0,
        p95Ms: wheelToScrollMs[Math.min(wheelToScrollMs.length - 1, Math.floor(wheelToScrollMs.length * 0.95))] ?? 0,
        maxMs: wheelToScrollMs[wheelToScrollMs.length - 1] ?? 0,
        missing: wheelTimes.length - wheelToScrollMs.length,
      };
      const frameScrollLatency = {
        samples: wheelToFrameScrollMs.length,
        p50Ms: wheelToFrameScrollMs[Math.floor(wheelToFrameScrollMs.length * 0.50)] ?? 0,
        p95Ms: wheelToFrameScrollMs[Math.min(wheelToFrameScrollMs.length - 1, Math.floor(wheelToFrameScrollMs.length * 0.95))] ?? 0,
        maxMs: wheelToFrameScrollMs[wheelToFrameScrollMs.length - 1] ?? 0,
        missing: wheelTimes.length - wheelToFrameScrollMs.length,
      };
      const wheelIntervals = wheelTimes.slice(1)
        .map((time, index) => time - wheelTimes[index])
        .sort((a, b) => a - b);
      const wheelIntervalAt = (p: number) => wheelIntervals[
        Math.min(wheelIntervals.length - 1, Math.floor(wheelIntervals.length * p))
      ] ?? 0;
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
        devicePixelRatio: window.devicePixelRatio,
        p50Ms: percentile(0.50),
        p95Ms: percentile(0.95),
        maxMs: sorted[sorted.length - 1] ?? 0,
        framesOver25Ms: sorted.filter((gap) => gap > 25).length,
        slowFrames,
        maxWheelDispatchMs: Math.max(0, ...dispatchMs),
        wheelInputIntervalMs: {
          p50: wheelIntervalAt(0.5),
          p95: wheelIntervalAt(0.95),
          max: wheelIntervals[wheelIntervals.length - 1] ?? 0,
        },
        trustedWheelCount: wheelSamples.filter(({ trusted }) => trusted).length,
        defaultPreventedWheelCount,
        wheelSamples,
        passiveWheelIntercepted: (window as any).__calPassiveWheelIntercepted ?? 0,
        wheelToScrollLatency: scrollLatency,
        wheelToFrameScrollLatency: frameScrollLatency,
        frameScrollChangeCount: frameScrollChanges.length,
        scrollEventCount: scrollChanges.length,
        weekViewRenderMs: (window as any).__weekViewRenderDurations,
        panWeekViewCommits: (window as any).__weekViewRenderMarks,
        weekRenderStages: stageSummary,
        pixelsMoved: (lastDay - firstDay) *
          document.querySelector<HTMLElement>(".day-col")!.getBoundingClientRect().width +
          grid.scrollLeft - initialScrollLeft,
        scrollLeft: grid.scrollLeft,
        maxScrollLeft: grid.scrollWidth - grid.clientWidth,
        scrollWidth: grid.scrollWidth,
        clientWidth: grid.clientWidth,
        firstDay,
        lastDay,
        scrollHistory: scrollChanges.map(({ left, day }) => ({ left, day })),
        clusterRows: document.querySelectorAll(".cluster-row").length,
        totalElements: document.querySelectorAll("*").length,
      };
    };
    return {
      x: grid.getBoundingClientRect().left + grid.clientWidth / 2,
      y: grid.getBoundingClientRect().top + 200,
      initialScrollLeft,
      fractionalScrollResponse,
      measuredDayWidth: width,
      renderedDayWidth: document.querySelector<HTMLElement>(".day-col")!.getBoundingClientRect().width,
    };
  }, {
    allowNativeScroll: process.env.CAL_PAN_NATIVE_SCROLL === "1",
    legacyClusterDots,
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
    await page.mouse.wheel(wheelDx, wheelDy);
    await page.waitForTimeout(12);
  }
  if (traceSession) await page.evaluate(() => console.timeStamp("pan-profile-input-end"));
  await page.waitForTimeout(350);
  const metrics = await page.evaluate((geometry) => ({
    ...(window as any).__finishPanInputProfile(),
    initialScrollLeft: geometry.initialScrollLeft,
    fractionalScrollResponse: geometry.fractionalScrollResponse,
    measuredDayWidth: geometry.measuredDayWidth,
    renderedDayWidth: document.querySelector<HTMLElement>(".day-col")!.getBoundingClientRect().width,
  }), geometry);
  console.log(`browser-input pan profile (${events.length} events, ${eventsPerDay}/day, dx=${wheelDx}, dy=${wheelDy}): ${JSON.stringify(metrics)}`);
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
    const inputRelated = inInput.filter((event) => /Latency|Wheel|Scroll|InputEvent/i.test(event.name));
    const counts = Object.fromEntries([...new Set(related.map((event) => event.name))]
      .map((name) => [name, related.filter((event) => event.name === name).length]));
    const inputCounts = Object.fromEntries([...new Set(inputRelated.map((event) => event.name))]
      .map((name) => [name, inputRelated.filter((event) => event.name === name).length]));
    const inputLatency = inputRelated
      .filter((event) => (event.dur ?? 0) > 0)
      .sort((a, b) => b.dur - a.dur)
      .slice(0, 8)
      .map((event) => ({ name: event.name, category: event.cat, durationMs: event.dur / 1000, timestamp: event.ts, thread: event.tid, details: event.args?.data }));
    const durationStats = Object.fromEntries([
      "DirectRenderer::DrawFrame",
      "DisplayScheduler::DrawAndSwap",
      "RasterTask",
      "DisplayItemList::Raster",
      "AnimationFrame::StyleAndLayout",
      "PrePaint",
    ].map((name) => {
      const samples = inInput.filter((event) => event.name === name && (event.dur ?? 0) > 0)
        .map((event) => (event.dur ?? 0) / 1000).sort((a, b) => a - b);
      const at = (p: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))] ?? 0;
      return [name, { count: samples.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: samples[samples.length - 1] ?? 0 }];
    }));
    console.log(`browser-input compositor trace: ${JSON.stringify({
      events: traceEvents.length,
      inputMarkers: markers.map((event) => ({ name: event.name, timestamp: event.ts, message: markerMessage(event) })),
      relatedCounts: counts,
      inputCounts,
      durationStats,
      inputLatency,
    })}`);
    await traceSession.detach();
  }
  expect(Math.abs(metrics.pixelsMoved - wheelDx * 60), "fractional day rebases should not accumulate scroll-position error")
    .toBeLessThan(1);
  if (fullCoverage) {
    expect(metrics.clusterRows, "the default fixture should keep every visible and overscan day dense throughout the pan")
      .toBeGreaterThanOrEqual(eventsPerDay * 13);
  }
});
