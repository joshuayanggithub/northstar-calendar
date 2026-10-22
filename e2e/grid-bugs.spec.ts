// Week/day grid: found by the 2026-10-19 bug-finder pass (each failed before
// its fix).
import { expect, test, type Page } from "@playwright/test";
import { packDayWithSleeves } from "../src/lib/layout";

const cal = (id: string, summary: string, color: string, extra: Record<string, unknown> = {}) =>
  ({ id, summary, color, is_primary: id === "p", hidden: false, access_role: "owner", ...extra });
const ev = (id: string, summary: string, start: string, end: string, calendar_id = "p") => ({
  id, calendar_id, etag: null, summary, description: null, location: null,
  start: start.length === 10 ? start : `${start}:00-04:00`, end: end.length === 10 ? end : `${end}:00-04:00`,
  all_day: start.length === 10, timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {},
});
async function open(page: Page, now: string, events: unknown[], calendars: unknown[] = [cal("p", "Personal", "#4986e7")], init?: () => void) {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, { calendars, events });
  if (init) await page.addInitScript(init);
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner"); if (await s.count()) await s.locator(".toast-close").click();
}
const stored = (page: Page, id: string) => page.evaluate(async (id) => {
  const r = (await (window as any).__mockBackend.listEvents("2026-01-01T00:00:00Z", "2027-12-31T00:00:00Z")).find((r: any) => r.id === id);
  return r && { start: r.start, end: r.end, summary: r.summary, calendar_id: r.calendar_id };
}, id);
const local = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
const chip = (page: Page, t: string) => page.locator(".chip-timed", { hasText: t });
const scrollTo = (page: Page, px: number) => page.getByTestId("week-grid").evaluate((el, px) => { el.scrollTop = px; }, px);

test("jitter: a 3px wobble on a 9:05 event is a click, not a move", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", [ev("n", "Nap", "2026-10-14T09:05", "2026-10-14T10:05")]);
  await scrollTo(page, 8 * 48);
  const b = (await chip(page, "Nap").boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 10); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 13); await page.mouse.up();
  await page.waitForTimeout(300);
  expect(local((await stored(page, "n")).start)).toBe("Wed 9:05 AM");
  await expect(page.getByTestId("event-panel")).toBeVisible();
});

test("resize: dragging a handle 15 min down extends by 15 min, wherever the box is drawn", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", [ev("a", "Block", "2026-10-14T10:00", "2026-10-14T11:00"), ev("b", "ping", "2026-10-14T10:55", "2026-10-14T11:00")]);
  await scrollTo(page, 8 * 48);
  const hb = (await page.locator(".chip-cfull", { hasText: "Block" }).locator(".chip-resize").boundingBox())!;
  const x = hb.x + 6, y = hb.y + hb.height - 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, y + 12, { steps: 4 }); await page.mouse.up();
  await page.waitForTimeout(300);
  expect(local((await stored(page, "a")).end)).toBe("Wed 11:15 AM");
});

const PX = 48 / 60, m = (h: number, min = 0) => h * 60 + min;
test("layout: the lower chip of a joint starts no later than halfway through the overlap", () => {
  const p = packDayWithSleeves([{ item: "a", startMin: m(9), endMin: m(12) }, { item: "b", startMin: m(10), endMin: m(13) }], PX);
  const rb = p.regular.find((r) => r.item === "b")!;
  const natural = m(10) * PX, overlapPx = (m(12) - m(10)) * PX;
  expect(rb.top).toBeLessThanOrEqual(natural + overlapPx / 2 - rb.seamTopPx / 2 + 1);
});

test("group drag (hidden weekends): the other selected event stays on a shown day", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", [ev("t", "Thu thing", "2026-10-15T10:00", "2026-10-15T11:00"), ev("f", "Fri thing", "2026-10-16T10:00", "2026-10-16T11:00")],
    undefined, () => localStorage.setItem("hideWeekends", "1"));
  await scrollTo(page, 8 * 48);
  await chip(page, "Thu thing").click({ modifiers: ["Shift"] }); await chip(page, "Fri thing").click({ modifiers: ["Shift"] });
  const b = (await chip(page, "Thu thing").boundingBox())!, w = (await page.getByTestId("day-col-0").boundingBox())!.width;
  await page.mouse.move(b.x + b.width / 2, b.y + 10); await page.mouse.down(); await page.mouse.move(b.x + b.width / 2 + w, b.y + 10, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => local((await stored(page, "t")).start)).toBe("Fri 10:00 AM");
  await expect(chip(page, "Fri thing")).toHaveCount(1);
  expect(local((await stored(page, "f")).start)).toBe("Mon 10:00 AM");
});

test("isolate: an event created while a calendar is isolated stays on screen after Save", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", [ev("w", "Standup", "2026-10-14T10:00", "2026-10-14T10:30", "work")], [cal("p", "Personal", "#4986e7"), cal("work", "Work", "#2fbf71")]);
  await page.getByTestId("cal-row").filter({ hasText: "Work" }).click({ button: "right" });
  await page.getByTestId("cal-menu").getByRole("button", { name: "Isolate calendar" }).click();
  await scrollTo(page, 8 * 48);
  const b = (await page.getByTestId("day-col-3").boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 13 * 48); await page.mouse.down(); await page.mouse.move(b.x + b.width / 2, b.y + 14 * 48, { steps: 6 }); await page.mouse.up();
  await page.getByTestId("event-panel").locator(".panel-title").fill("Planning"); await page.keyboard.press("Enter");
  await expect(page.getByTestId("event-panel")).toHaveCount(0);
  await expect(chip(page, "Planning")).toHaveCount(1);
});

test("ctx menu: every item stays on screen near the bottom", async ({ page }) => {
  await open(page, "2026-10-14T20:00:00", [ev("l", "Lunch", "2026-10-14T12:00", "2026-10-14T13:00")]);
  const vh = await page.evaluate(() => window.innerHeight);
  await scrollTo(page, 0);
  const gridTop = (await page.getByTestId("week-grid").boundingBox())!.y, b0 = (await chip(page, "Lunch").boundingBox())!;
  await scrollTo(page, b0.y - gridTop - (vh - gridTop - 70));
  const b = (await chip(page, "Lunch").boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + 8, { button: "right" });
  const mb = (await page.getByTestId("ctx-menu").boundingBox())!;
  expect(mb.y + mb.height).toBeLessThanOrEqual(vh);
});

const topHour = (page: Page) => page.evaluate(() => {
  const grid = document.querySelector('[data-testid="week-grid"]')!, hb = grid.querySelector(".allday-row")!.getBoundingClientRect().bottom;
  return ([...grid.querySelectorAll(".gutter .hour-label:not(.hour-label-2)")] as HTMLElement[])
    .map((l) => { const r = l.getBoundingClientRect(); return { t: l.textContent!, y: r.top + r.height / 2 }; })
    .filter((l) => l.y >= hb - 1).sort((a, b) => a.y - b.y)[0]?.t;
});
test("zoom: ⇧⌘. keeps the hours in view", async ({ page }) => {
  await open(page, "2026-10-14T03:00:00", [ev("n", "Nap", "2026-10-14T10:00", "2026-10-14T11:00")]);
  await scrollTo(page, 10 * 48);
  expect(await topHour(page)).toBe("10 AM");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+Meta+.");
  await page.waitForTimeout(100);
  expect(await topHour(page)).toBe("10 AM");
});

test("select: x over a cluster row selects it; a dragged group dims its cluster rows", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", [
    ev("a", "A", "2026-10-14T15:00", "2026-10-14T15:20"), ev("b", "B", "2026-10-14T15:05", "2026-10-14T15:20"), ev("c", "C", "2026-10-14T15:10", "2026-10-14T15:20"),
    ev("n", "Nap", "2026-10-14T10:00", "2026-10-14T11:00"),
  ]);
  await scrollTo(page, 9 * 48);
  const row = page.locator(".cluster-row", { hasText: "A" }).first();
  await row.hover();
  await page.keyboard.press("x");
  await expect(page.locator(".cluster-row.selected")).toHaveCount(1);
});

test("marquee: the after-midnight part of an overnight event is selectable", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", [ev("o", "Overnight", "2026-10-13T22:00", "2026-10-14T02:00")]);
  await scrollTo(page, 0);
  const b = (await page.getByTestId("day-col-3").boundingBox())!;
  const y0 = b.y + 0.5 * 48, y1 = b.y + 3.5 * 48;
  await page.keyboard.down("Shift");
  await page.mouse.move(b.x + 8, y0); await page.mouse.down(); await page.mouse.move(b.x + b.width - 8, y1, { steps: 8 }); await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.locator(".chip-timed.selected", { hasText: "Overnight" }).first()).toBeVisible();
});

test("all-day: right-clicking an all-day chip selects it like a timed chip", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", [ev("h", "Holiday", "2026-10-14", "2026-10-15")]);
  await page.locator(".chip-allday", { hasText: "Holiday" }).click({ button: "right" });
  await expect(page.locator(".chip-allday.selected", { hasText: "Holiday" })).toHaveCount(1);
});

test("group drag: a selected cluster row dims like the chips it moves with", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", [
    ev("a", "A", "2026-10-14T15:00", "2026-10-14T15:20"), ev("b", "B", "2026-10-14T15:05", "2026-10-14T15:20"), ev("c", "C", "2026-10-14T15:10", "2026-10-14T15:20"),
    ev("n", "Nap", "2026-10-14T13:00", "2026-10-14T14:00"),
  ]);
  await scrollTo(page, 9 * 48);
  await page.locator(".cluster-row", { hasText: "A" }).first().click({ modifiers: ["Shift"] });
  await chip(page, "Nap").click({ modifiers: ["Shift"] });
  await expect(page.locator(".cluster-row.selected")).toHaveCount(1);
  const b = (await chip(page, "Nap").boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 10); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 10 + 96, { steps: 8 });
  await expect(chip(page, "Nap").first()).toHaveClass(/dragging/);
  await expect(page.locator(".cluster-row", { hasText: "A" }).first()).toHaveClass(/dragging/);
  await page.mouse.up();
});

test("layout: the later of two overlapping events starts on the timeline at its own start time", () => {
  for (const px of [48 / 60, 24 / 60, 72 / 60]) {
    const p = packDayWithSleeves([{ item: "a", startMin: m(9), endMin: m(12) }, { item: "b", startMin: m(10), endMin: m(13) }], px);
    const rb = p.regular.find((r) => r.item === "b")!;
    // got: 10:54 at 48px/h (moved to the middle of the overlap)
    expect(Math.abs(rb.top - m(10) * px), `top at ${px * 60}px/h`).toBeLessThanOrEqual(1);
  }
});

test("week: an overlapping event's top edge lines up with its start time's hour line", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", [ev("a", "Deep work", "2026-10-14T09:00", "2026-10-14T12:00"), ev("b", "Lab meeting", "2026-10-14T10:00", "2026-10-14T13:00")]);
  await scrollTo(page, 8 * 48);
  const col = (await page.getByTestId("day-col-3").boundingBox())!;
  const b = (await chip(page, "Lab meeting").first().boundingBox())!;
  // the 10 AM line is 10h down the column
  expect(Math.abs(b.y - (col.y + 10 * 48))).toBeLessThanOrEqual(1.5); // got: ~43px lower
});

test("layout: an event starting inside a wrapped title's band still starts at its time", () => {
  // 2:30 seminar with a long, wrapped title (asks 3 rows), then a 3 PM call
  const PXM = 48 / 60;
  const p = packDayWithSleeves(
    [{ item: "seminar", startMin: m(14, 30), endMin: m(15, 30) }, { item: "call", startMin: m(15), endMin: m(16) }],
    PXM, 17, true, (it) => (it === "seminar" ? 51 : 17),
  );
  const call = p.regular.find((r) => r.item === "call")!;
  // got: 3:40 (pushed below the seminar's 3-row title band)
  expect(Math.abs(call.top - m(15) * PXM)).toBeLessThanOrEqual(1);
});

test("layout: a long event starting inside a cluster's run starts at its own time; the list wraps inside it", () => {
  // five short events from 10:00 (a cluster: 81px of rows for 30 minutes)
  // and a 10:15–12:00 event: it was drawn below the whole list, from 11:41
  const shorts = [0, 5, 10, 15, 20].map((m0, i) => ({ item: `s${i}`, startMin: m(10, m0), endMin: m(10, m0 + 10) }));
  const p = packDayWithSleeves([...shorts, { item: "long", startMin: m(10, 15), endMin: m(12) }], PX);
  expect(p.clusters).toHaveLength(1);
  const long = p.containers.find((c) => c.item === "long") ?? p.regular.find((r) => r.item === "long");
  expect(long, "the long event is laid out").toBeTruthy();
  expect(Math.abs(long!.top - m(10, 15) * PX), "its top is on 10:15").toBeLessThanOrEqual(1); // got: 93px late
  // the cluster sits inside it, under its title
  expect(p.clusters[0].top).toBeGreaterThanOrEqual(long!.top + 17 - 0.5);
  expect(p.clusters[0].insetPx).toBeGreaterThan(0);
});
