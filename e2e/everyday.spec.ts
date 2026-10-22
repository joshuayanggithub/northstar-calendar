// Everyday navigation, all-day events, month view and sidebar: found by the
// 2026-10-18 bug-finder pass (each failed before its fix).
import { expect, test, type Page } from "@playwright/test";

const cal = { id: "p", summary: "Personal", color: "#4986e7", is_primary: true, hidden: false, access_role: "owner" };
const ev = (id: string, summary: string, start: string, end: string, all_day: boolean) => ({
  id, calendar_id: "p", etag: null, summary, description: null, location: null, start, end, all_day,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {},
});
async function open(page: Page, now: string, events: unknown[]) {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, { calendars: [cal], events });
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner");
  if (await s.count()) await s.locator(".toast-close").click();
}
const stored = (page: Page, id: string) => page.evaluate(async (id) => {
  const r = (await (window as any).__mockBackend.listEvents("2026-01-01T00:00:00Z", "2027-12-31T00:00:00Z")).find((r: any) => r.id === id);
  return r && { start: r.start, end: r.end, summary: r.summary };
}, id);
const allRows = (page: Page) => page.evaluate(async () =>
  (await (window as any).__mockBackend.listEvents("2026-01-01T00:00:00Z", "2027-12-31T00:00:00Z"))
    .map((r: any) => [r.summary, r.start, r.end, r.all_day]));

test("all-day: dragging a later day of a multi-day event shifts it by the days moved", async ({ page }) => {
  await open(page, "2026-10-14T09:00:00", [ev("r", "Retreat", "2026-10-12", "2026-10-15", true)]);
  const b = (await page.locator(".chip-allday", { hasText: "Retreat" }).nth(2).boundingBox())!;
  const w = (await page.getByTestId("day-col-0").boundingBox())!.width;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + w, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => stored(page, "r")).toMatchObject({ start: "2026-10-13", end: "2026-10-16" });
});

test("all-day: a click with a little jitter doesn't move a multi-day event", async ({ page }) => {
  await open(page, "2026-10-14T09:00:00", [ev("r", "Retreat", "2026-10-12", "2026-10-15", true)]);
  const b = (await page.locator(".chip-allday", { hasText: "Retreat" }).nth(2).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 2, b.y + b.height / 2);
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await stored(page, "r")).toMatchObject({ start: "2026-10-12", end: "2026-10-15" });
});

test("all-day: an event ending on the spring-forward Sunday keeps that day on Save", async ({ page }) => {
  await open(page, "2026-03-04T09:00:00", [ev("w", "Ski weekend", "2026-03-07", "2026-03-09", true)]);
  await page.locator(".chip-allday", { hasText: "Ski weekend" }).first().click();
  const panel = page.getByTestId("event-panel");
  expect(await panel.getByTestId("allday-end").inputValue()).toBe("2026-03-08");
  await panel.locator(".panel-title").fill("Ski weekend!");
  await panel.getByRole("button", { name: /Save/ }).click();
  await expect.poll(() => stored(page, "w")).toEqual({ start: "2026-03-07", end: "2026-03-09", summary: "Ski weekend!" });
});

test("month: overlapping multi-day events past the bar lanes are counted in “more”", async ({ page }) => {
  await open(page, "2026-10-14T09:00:00", [ev("a", "Conf A", "2026-10-12", "2026-10-15", true),
    ev("b", "Trip B", "2026-10-12", "2026-10-15", true), ev("c", "Visit C", "2026-10-12", "2026-10-15", true)]);
  await page.keyboard.press("m");
  const g = page.getByTestId("month-grid");
  expect((await g.getByText("Visit C").count()) + (await g.locator(".mchip-more").count())).toBeGreaterThan(0);
});

test("month: an event on the fall-back day shows once that day and once the next", async ({ page }) => {
  await open(page, "2026-11-04T09:00:00", [ev("n", "Red-eye", "2026-11-01T22:00:00-05:00", "2026-11-02T01:00:00-05:00", false)]);
  await page.keyboard.press("m");
  const counts = await page.locator(".month-cell").evaluateAll((els) => els
    .map((el) => [el.querySelector(".month-dnum")?.textContent, el.querySelectorAll(".mchip").length] as const)
    .filter(([, n]) => n > 0));
  expect(counts).toEqual([["Nov 1", 1], ["2", 1]]);
});

test("nav: an arrow after a swipe steps on from the days shown", async ({ page }) => {
  await open(page, "2026-10-14T09:00:00", []);
  const g = (await page.getByTestId("week-grid").boundingBox())!;
  const w = (await page.getByTestId("day-col-0").boundingBox())!.width;
  await page.mouse.move(g.x + g.width / 2, g.y + 200);
  await page.mouse.wheel(Math.round(w * 7), 0);
  const first = () => page.locator(".day-headers .day-head .dnum").first().textContent();
  await expect.poll(first).toBe("18");
  await page.mouse.move(5, 5);
  await page.keyboard.press("ArrowRight");
  await expect.poll(first).toBe("25");
});

test("quick create: a date range covers its last day", async ({ page }) => {
  await open(page, "2026-10-14T09:00:00", []);
  await page.keyboard.press("c");
  const qc = page.getByTestId("quick-create");
  await qc.locator("input").fill("vacation dec 20 - dec 23");
  await qc.locator("input").press("Enter");
  await expect.poll(() => allRows(page)).toEqual([["vacation", "2026-12-20", "2026-12-24", true]]);
});

test("paste keeps a multi-day all-day event's span", async ({ page }) => {
  await open(page, "2026-10-14T09:00:00", [ev("r", "Retreat", "2026-10-19", "2026-10-22", true)]);
  await page.keyboard.press("ArrowRight");
  await page.locator(".chip-allday", { hasText: "Retreat" }).first().click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+c");
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(async () => (await allRows(page)).filter((r: any) => r[0] === "Retreat")
    .map((r: any) => Number(r[2].slice(8)) - Number(r[1].slice(8)))).toEqual([3, 3]);
});

test("search: picking an event goes to its week", async ({ page }) => {
  await open(page, "2026-10-14T09:00:00", [ev("x", "Dentist appointment", "2026-11-18T10:00:00-05:00", "2026-11-18T11:00:00-05:00", false)]);
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".cmdk input").fill("dentist");
  await page.locator("[cmdk-item]", { hasText: "Dentist appointment" }).click();
  await expect(page.getByTestId("event-panel")).toBeVisible();
  await expect(page.locator(".chip-timed", { hasText: "Dentist appointment" })).toBeVisible();
});

test("sidebar: Today brings the mini-month back to this month", async ({ page }) => {
  await open(page, "2026-10-14T09:00:00", []);
  const mini = page.getByTestId("mini-month");
  await mini.getByRole("button", { name: "Next month" }).click();
  await expect(mini.locator(".mini-title")).toHaveText("November 2026");
  await page.mouse.click(5, 300);
  await page.keyboard.press("t");
  await expect(mini.locator(".mini-title")).toHaveText("October 2026");
});

test("sweep: a dismissed banner comes back the next morning without a restart", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-14T09:00:00") });
  const at = (d: number, h: number) => new Date(`2026-10-${d}T${String(h).padStart(2, "0")}:00:00-04:00`).toISOString();
  await page.addInitScript((fx) => ((globalThis as any).__calFixture = fx), {
    calendars: [cal],
    events: [ev("a", "Tuesday thing", at(13, 10), at(13, 11), false), ev("b", "Wednesday thing", at(14, 10), at(14, 11), false)],
  });
  await page.goto("/");
  const banner = page.getByTestId("sweep-banner");
  await expect(banner).toContainText("1 event to review");
  await banner.locator(".toast-close").click();
  await expect(banner).toHaveCount(0);
  await page.clock.setSystemTime(new Date("2026-10-15T09:00:00"));
  await page.clock.runFor(61_000);
  await page.locator(".chip-timed", { hasText: "Wednesday thing" }).first().click(); // a re-render
  await page.keyboard.press("Escape");
  await expect(banner).toContainText("1 event to review");
});

test("goals: renaming a goal keeps its starred events", async ({ page }) => {
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`);
  await page.locator(".chip-timed", { hasText: "Gym" }).first().click();
  await page.getByTestId("goal-link").selectOption("3 gym sessions");
  await page.keyboard.press("Escape");
  const row = () => page.getByTestId("goal-row").filter({ hasText: /gym sessions/ });
  await expect(row().locator(".goal-star-count")).toContainText("★ 1");
  await row().locator(".goal-text").dblclick();
  await page.locator(".goal-edit").fill("3 gym sessions!");
  await page.locator(".goal-edit").press("Enter");
  await expect(row().locator(".goal-text")).toHaveText("3 gym sessions!");
  await expect(row().locator(".goal-star-count")).toContainText("★ 1");
});

test("stars: “Star as goal work” on a declined suggestion stars it", async ({ page }) => {
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`);
  const c = page.locator(".chip-timed", { hasText: "Read style guide" }).first();
  await expect(c).toHaveClass(/starred-auto/);
  await c.click();
  await page.getByTestId("goal-link").selectOption("");
  await page.keyboard.press("Escape");
  await expect(c).not.toHaveClass(/starred/);
  await c.click({ button: "right" });
  await page.getByTestId("ctx-menu").getByRole("button", { name: /Star as goal work/ }).click();
  await expect(c).toHaveClass(/(^| )starred( |$)/);
});
