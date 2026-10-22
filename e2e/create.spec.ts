// Creating events (quick create, click/drag on the grid): found by the
// 2026-10-18 bug-finder pass, run 2 (each failed before its fix).
import { expect, test, type Page } from "@playwright/test";

const fixture = { calendars: [{ id: "p", summary: "Me", color: "#9fe1e7", is_primary: true, hidden: false, access_role: "owner" }], events: [] };
async function open(page: Page, nowIso: string) {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, fixture);
  await page.goto(`/?now=${encodeURIComponent(nowIso)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
}
const stored = (page: Page) => page.evaluate(async () =>
  (await (window as any).__mockBackend.listEvents("2026-01-01T00:00:00Z", "2028-01-01T00:00:00Z"))
    .map((e: any) => ({ summary: e.summary, start: e.start, end: e.end, all_day: e.all_day, recurrence: e.recurrence })));
async function quick(page: Page, text: string) {
  await page.keyboard.press("c");
  await page.getByTestId("quick-create").locator("input").fill(text);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("quick-create")).toHaveCount(0);
  return stored(page);
}
const local = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });

test("quick create: 'every weekday' typed on a Saturday starts on Monday", async ({ page }) => {
  await open(page, "2026-10-17T15:00:00");
  const [ev] = await quick(page, "standup every weekday 9:30");
  expect(ev.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"]);
  expect(local(ev.start)).toBe("Mon 9:30 AM");
});

test("quick create: a bare 'at 5' is the afternoon", async ({ page }) => {
  await open(page, "2026-10-14T09:00:00");
  const [ev] = await quick(page, "call at 5");
  expect(ev.summary).toBe("call");
  expect(local(ev.start)).toBe("Wed 5:00 PM");
});

test("quick create: 'dentist friday 4:30' is 4:30 PM", async ({ page }) => {
  await open(page, "2026-10-14T09:00:00");
  const [ev] = await quick(page, "dentist friday 4:30");
  expect(local(ev.start)).toBe("Fri 4:30 PM");
});

test("quick create: a bare hour range is a time range", async ({ page }) => {
  await open(page, "2026-10-14T09:00:00");
  const [ev] = await quick(page, "lunch tomorrow 12-1");
  expect({ summary: ev.summary, all_day: ev.all_day }).toEqual({ summary: "lunch", all_day: false });
  expect([local(ev.start), local(ev.end)]).toEqual(["Thu 12:00 PM", "Thu 1:00 PM"]);
});

test("quick create: '9-5' runs morning to afternoon", async ({ page }) => {
  await open(page, "2026-10-14T07:00:00");
  const [ev] = await quick(page, "workshop thursday 9-5");
  expect([local(ev.start), local(ev.end)]).toEqual(["Thu 9:00 AM", "Thu 5:00 PM"]);
});

test("quick create: 'gym mon wed fri 7am' repeats on those days at 7", async ({ page }) => {
  await open(page, "2026-10-14T09:00:00");
  const [ev] = await quick(page, "gym mon wed fri 7am");
  expect(ev.summary).toBe("gym");
  expect(ev.all_day).toBe(false);
  expect(ev.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"]);
  expect(local(ev.start)).toBe("Fri 7:00 AM"); // the next of the three
});

test("quick create: still right — explicit am/pm, dates, 'every monday'", async ({ page }) => {
  await open(page, "2026-10-14T09:00:00");
  await quick(page, "coffee tomorrow 9am");
  await quick(page, "trip oct 22");
  await quick(page, "yoga every monday 6pm");
  const rows = await stored(page);
  const by = (s: string) => rows.find((r: any) => r.summary === s)!;
  expect(local(by("coffee").start)).toBe("Thu 9:00 AM");
  expect(by("trip").all_day).toBe(true);
  expect(by("trip").start).toBe("2026-10-22");
  expect(local(by("yoga").start)).toBe("Mon 6:00 PM");
});

test("grid: a click in a day's last minutes drafts on that day", async ({ page }) => {
  await open(page, "2026-10-14T09:00:00");
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 99999));
  const b = (await page.getByTestId("day-col-3").boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + 1435 * 0.8);
  await expect(page.getByTestId("day-col-3").getByTestId("draft-chip")).toBeVisible();
  await expect(page.getByTestId("event-panel")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("event-panel")).toHaveCount(0);
  expect(local((await stored(page))[0].start)).toBe("Wed 11:45 PM");
});

test("grid: a 15-minute drag previews what it creates", async ({ page }) => {
  await open(page, "2026-10-14T09:00:00");
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 8 * 48));
  const b = (await page.getByTestId("day-col-3").boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 540 * 0.8);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 556 * 0.8, { steps: 8 });
  const ghostH = await page.locator(".chip-ghost:not(.chip-draft)").evaluate((g) => (g as HTMLElement).offsetHeight);
  await page.mouse.up();
  await expect(page.getByTestId("event-panel")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("event-panel")).toHaveCount(0);
  const [ev] = await stored(page);
  const minutes = (Date.parse(ev.end) - Date.parse(ev.start)) / 60000;
  expect(minutes).toBe(15);
  expect(ghostH).toBe(Math.max(minutes * 0.8, 17)); // (chips have a minimum height); it previewed 30 min

});

test("grid: on the fall-back day the draft is as tall as its wall-clock hours", async ({ page }) => {
  await open(page, "2026-11-01T09:00:00");
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 0));
  const b = (await page.getByTestId("day-col-0").boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 60 * 0.8);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 180 * 0.8, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("draft-chip")).toContainText("1 – 3 AM");
  expect(await page.getByTestId("draft-chip").evaluate((g) => (g as HTMLElement).offsetHeight)).toBe(96);
});

test("grid: clicking the all-day row with an editor open only closes it", async ({ page }) => {
  await open(page, "2026-10-14T09:00:00");
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 8 * 48));
  const b = (await page.getByTestId("day-col-3").boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + 540 * 0.8);
  await expect(page.getByTestId("event-panel")).toBeVisible();
  const c = (await page.getByTestId("allday-row").locator(".allday-cell").nth(1).boundingBox())!;
  await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2);
  await expect(page.getByTestId("event-panel")).toHaveCount(0);
});

// regressions of the above (found reviewing them)
test("quick create: day ranges and numbers in titles aren't read as hours", async ({ page }) => {
  await open(page, "2026-10-21T10:00:00");
  await quick(page, "vacation nov 2-4");
  await quick(page, "study chapters 3-4 tomorrow");
  await quick(page, "dinner tomorrow 7-9");
  const rows = await stored(page);
  const by = (s: string) => rows.find((r: any) => r.summary === s)!;
  expect(by("vacation")).toMatchObject({ all_day: true, start: "2026-11-02", end: "2026-11-05" });
  expect(by("study chapters 3-4")).toMatchObject({ all_day: true, start: "2026-10-22" });
  expect([local(by("dinner").start), local(by("dinner").end)]).toEqual(["Thu 7:00 PM", "Thu 9:00 PM"]);
});

test("quick create: an all-day day list typed in the afternoon counts today", async ({ page }) => {
  await open(page, "2026-10-21T13:00:00");
  const [ev] = await quick(page, "yoga mon wed fri");
  expect(ev.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"]);
  expect({ all_day: ev.all_day, start: ev.start }).toEqual({ all_day: true, start: "2026-10-21" });
});

test("quick create: hour ranges with the day after them, a month date before, or a repeat", async ({ page }) => {
  await open(page, "2026-10-21T10:00:00");
  await quick(page, "meeting 2-3 tomorrow");
  await quick(page, "dentist oct 22 3-4");
  await quick(page, "standup every weekday 9-10");
  const rows = await stored(page);
  const by = (s: string) => rows.find((r: any) => r.summary === s)!;
  expect([local(by("meeting").start), local(by("meeting").end)]).toEqual(["Thu 2:00 PM", "Thu 3:00 PM"]);
  expect(by("dentist").all_day).toBe(false);
  expect(local(by("dentist").start)).toBe("Thu 3:00 PM");
  expect([local(by("standup").start), local(by("standup").end)]).toEqual(["Thu 9:00 AM", "Thu 10:00 AM"]);
});
