// All-day row, multi-select, copy/paste and the 1-day view: found by the
// 2026-10-19 run 4 bug-finder (each failed before its fix).
import { expect, test, type Page } from "@playwright/test";

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
const all = (page: Page) => page.evaluate(async () =>
  (await (window as any).__mockBackend.listEvents("2026-01-01T00:00:00Z", "2027-12-31T00:00:00Z"))
    .map((r: any) => ({ id: r.id, summary: r.summary, start: r.start, end: r.end, all_day: r.all_day, calendar_id: r.calendar_id })));
const stored = async (page: Page, id: string) => (await all(page)).find((r: any) => r.id === id);
const local = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
const chip = (page: Page, t: string) => page.locator(".chip-timed", { hasText: t });
const allDayChip = (page: Page, t: string) => page.locator(".chip-allday", { hasText: t });
const scrollTo = (page: Page, px: number) => page.getByTestId("week-grid").evaluate((el, px) => { el.scrollTop = px; }, px);
const colW = async (page: Page) => (await page.getByTestId("day-col-0").boundingBox())!.width;

/** weekends hidden, swiped two weekdays: Wed 14, Thu 15, Fri 16, Mon 19, Tue 20 */
async function hiddenWeekendSwipe(page: Page) {
  await open(page, "2026-10-14T08:00:00", [
    ev("w", "Wed thing", "2026-10-14T10:00", "2026-10-14T11:00"),
    ev("s", "Saturday secret", "2026-10-17T10:00", "2026-10-17T11:00"),
    ev("m", "Mon thing", "2026-10-19T10:00", "2026-10-19T11:00"),
  ], undefined, () => localStorage.setItem("hideWeekends", "1"));
  await scrollTo(page, 8 * 48);
  const grid = (await page.getByTestId("week-grid").boundingBox())!;
  await page.mouse.move(grid.x + grid.width / 2, grid.y + 200);
  await page.mouse.wheel(Math.round((await colW(page)) * 2), 0);
  await expect.poll(() => page.locator(".day-headers .day-head .dnum").allTextContents()).toEqual(["14", "15", "16", "19", "20"]);
  await page.mouse.move(5, 5);
}

// P2-1
test("⌘A after a swipe with weekends hidden doesn't select (and Delete doesn't delete) the hidden Saturday", async ({ page }) => {
  await hiddenWeekendSwipe(page);
  await page.keyboard.press("Meta+a");
  await expect(page.getByTestId("toast")).toContainText("Selected");
  await page.keyboard.press("Backspace");
  await expect.poll(async () => (await all(page)).length).toBeLessThan(3);
  // got: undefined — toast said "Selected 3 events" with 2 on screen, then "Deleted 3 events"
  expect(await stored(page, "s")).toBeTruthy();
});

// P2-1 (same root cause)
test("n after a swipe with weekends hidden steps from Wed to Mon, not to the hidden Saturday", async ({ page }) => {
  await hiddenWeekendSwipe(page);
  await page.keyboard.press("n"); await page.keyboard.press("n");
  await page.keyboard.press("Enter");
  // got: "Saturday secret" (an off-screen event opened)
  await expect(page.getByTestId("event-panel").locator(".panel-title")).toHaveValue("Mon thing");
});

// P2-2
test("an all-day chip dragged sideways with the pointer drifting onto the date header stays all-day", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", [ev("h", "Holiday", "2026-10-14", "2026-10-15")]);
  await scrollTo(page, 8 * 48);
  const c = (await allDayChip(page, "Holiday").boundingBox())!, w = await colW(page);
  const lane = (await page.getByTestId("allday-row").boundingBox())!;
  await page.mouse.move(c.x + c.width / 2, c.y + 4); await page.mouse.down();
  await page.mouse.move(c.x + c.width / 2 + w, c.y + 4, { steps: 6 });
  await page.mouse.move(c.x + c.width / 2 + 2 * w, lane.y - 6, { steps: 6 }); // 6px above the lane, on the header
  await page.mouse.up();
  await page.waitForTimeout(300);
  // got: false — stored as a timed Fri 7:30–8:30 AM event, under the sticky header (no ghost or lane highlight was shown)
  expect((await stored(page, "h")).all_day).toBe(true);
});

// P2-3
test("'+1 more' in the all-day row reveals the hidden event instead of drafting a new one", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", ["Alpha", "Bravo", "Charlie", "Delta"].map((t) => ev(t, t, "2026-10-14", "2026-10-15")));
  const more = page.getByTestId("allday-row").locator(".allday-more");
  await expect(more).toHaveText("+1 more");
  await more.click();
  // got: not found — a blank NEW EVENT all-day draft opened instead; Delta can't be reached by mouse in week/day view
  await expect(allDayChip(page, "Delta").or(page.getByRole("button", { name: "Delta" }))).toBeVisible();
});

// P2-4
test("⌘Z after pasting two copied events takes back both pastes", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", [ev("a", "Alpha", "2026-10-14T10:00", "2026-10-14T11:00"), ev("b", "Bravo", "2026-10-14T13:00", "2026-10-14T14:00")]);
  await scrollTo(page, 8 * 48);
  await chip(page, "Alpha").click({ modifiers: ["Shift"] });
  await chip(page, "Bravo").click({ modifiers: ["Shift"] });
  await page.keyboard.press("Meta+c");
  await page.keyboard.press("Meta+v");
  await expect.poll(async () => (await all(page)).length).toBe(4);
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(400);
  // got: 3 — one undo entry per pasted event; the pasted "Alpha" stays
  expect((await all(page)).length).toBe(2);
});

// P2-5
test("pasting a Mon + Wed selection into next week keeps them two days apart from the target day", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", [ev("a", "Alpha", "2026-10-12T10:00", "2026-10-12T11:00"), ev("b", "Bravo", "2026-10-14T13:00", "2026-10-14T14:00")]);
  await scrollTo(page, 8 * 48);
  await chip(page, "Alpha").click({ modifiers: ["Shift"] });
  await chip(page, "Bravo").click({ modifiers: ["Shift"] });
  await page.keyboard.press("Meta+c");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Meta+v");
  await expect.poll(async () => (await all(page)).length).toBe(4);
  const pasted = (await all(page)).filter((r: any) => r.id !== "a" && r.id !== "b");
  // got: { Alpha: "Wed 10:00 AM", Bravo: "Wed 1:00 PM" } — every event landed on the anchor day.
  // Now the earliest goes to the target day (Wed 21, as a single paste does)
  // and the rest keep their distance from it
  expect(Object.fromEntries(pasted.map((r: any) => [r.summary, local(r.start)]))).toEqual({ Alpha: "Wed 10:00 AM", Bravo: "Fri 1:00 PM" });
  expect(pasted.every((r: any) => r.start.startsWith("2026-10-2"))).toBe(true);
});

// P3-1
test("a click on an all-day chip with a 5px wobble still opens it", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", [ev("h", "Holiday", "2026-10-14", "2026-10-15")]);
  const c = (await allDayChip(page, "Holiday").boundingBox())!;
  await page.mouse.move(c.x + c.width / 2, c.y + 6); await page.mouse.down();
  await page.mouse.move(c.x + c.width / 2 + 5, c.y + 6); await page.mouse.up();
  // got: no panel — the click was swallowed as a same-day "move" that writes nothing
  await expect(page.getByTestId("event-panel")).toBeVisible();
});

// P3-2
test("dragging a 3-day all-day event highlights the 3 days it will land on", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", [ev("t", "Trip", "2026-10-12", "2026-10-15")]);
  const c = (await allDayChip(page, "Trip").first().boundingBox())!, w = await colW(page);
  await page.mouse.move(c.x + c.width / 2, c.y + 8); await page.mouse.down();
  await page.mouse.move(c.x + c.width / 2 + 2 * w, c.y + 8, { steps: 8 });
  const lit = await page.locator(".allday-cell.drop").count();
  await page.mouse.up();
  await expect.poll(async () => (await stored(page, "t")).start).toBe("2026-10-14"); // drop: Wed 14 – Fri 16
  // got: 1 — only the pointer's cell is highlighted
  expect(lit).toBe(3);
});

// P3-3
test("the editor for a Wed→Fri drag-create in the all-day lane shows the whole span", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", []);
  const lane = (await page.getByTestId("allday-row").boundingBox())!;
  const c3 = (await page.getByTestId("day-col-3").boundingBox())!, c5 = (await page.getByTestId("day-col-5").boundingBox())!;
  await page.mouse.move(c3.x + c3.width / 2, lane.y + lane.height - 4); await page.mouse.down();
  await page.mouse.move(c5.x + c5.width / 2, lane.y + lane.height - 4, { steps: 6 });
  await page.mouse.up();
  // got: "Wed, Oct 14" (the draft itself is Oct 14–17 exclusive and saves as 3 days)
  await expect(page.getByTestId("event-panel").locator(".panel-date-pretty")).toContainText("Oct 16");
});

// P3-4
test("dragging a late event to the bottom of the 1-day view keeps it on that day", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", [ev("l", "Late", "2026-10-14T22:00", "2026-10-14T23:00")]);
  await page.keyboard.press("d");
  await expect(page.getByTestId("day-col-1")).toHaveCount(0);
  await scrollTo(page, 24 * 48);
  const b = (await chip(page, "Late").boundingBox())!;
  const vh = await page.evaluate(() => window.innerHeight);
  await page.mouse.move(b.x + b.width / 2, b.y + 2); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, vh - 2, { steps: 10 }); // (the ghost vanishes here)
  await page.mouse.up();
  await page.waitForTimeout(300);
  // got: "Thu 12:00 AM" — moved into tomorrow, off the only column shown
  expect(local((await stored(page, "l")).start)).toMatch(/^Wed /);
});

// P3-5
test("a paste while a read-only calendar is isolated shows the copy", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", [ev("hol", "Diwali", "2026-10-14", "2026-10-15", "hol")],
    [cal("p", "Personal", "#4986e7"), cal("hol", "Holidays", "#16a765", { access_role: "reader" })]);
  await page.getByTestId("cal-row").filter({ hasText: "Holidays" }).click({ button: "right" });
  await page.getByTestId("cal-menu").getByRole("button", { name: "Isolate calendar" }).click();
  await allDayChip(page, "Diwali").click({ modifiers: ["Shift"] });
  await page.keyboard.press("Meta+c");
  await page.keyboard.press("Meta+v");
  await expect.poll(async () => (await all(page)).length).toBe(2); // the copy exists, on Personal
  // got: the copy on Personal, hidden by the isolation. Now the isolation ends
  // and the copy shows (a copy of a read-only event is drawn in its place)
  await expect(page.getByTestId("isolate-pill")).toHaveCount(0);
  await expect(allDayChip(page, "Diwali")).toBeVisible();
});
