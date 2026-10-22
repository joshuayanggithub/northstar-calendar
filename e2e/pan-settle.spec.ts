// A horizontal swipe scrolls natively and the days re-centre only once it
// rests (WeekView PAN_SETTLE_MS). Whatever the user does in that window —
// a drag, a marquee, "t" / Today — must act on the days as drawn, and a long
// fling must find its runway days fetched.
import { expect, test, type Page } from "@playwright/test";

const NOW = "2026-10-14T08:00:00"; // Wed; week Sun 11 – Sat 17

async function open(page: Page) {
  const at = (m: number, d: number, h: number) =>
    new Date(`2026-${m}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00-0${m === 11 && d > 1 ? 5 : 4}:00`).toISOString();
  const ev = (id: string, summary: string, m: number, d: number, h0: number, h1: number) => ({
    id, calendar_id: "p", etag: null, summary, description: null, location: null, start: at(m, d, h0), end: at(m, d, h1),
    all_day: false, timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null,
    conference_url: null, updated: null, raw: {},
  });
  const fixture = {
    calendars: [{ id: "p", summary: "Personal", color: "#4986e7", is_primary: true, hidden: false, access_role: "owner" }],
    events: [ev("mv", "Move me", 10, 14, 10, 11), ev("a", "Alpha", 10, 15, 12, 13), ev("w", "Wednesday lunch", 10, 14, 12, 13),
      ev("f8", "Far eight", 11, 8, 10, 11), ev("f9", "Far nine", 11, 9, 10, 11), ev("m19", "Monday thing", 10, 19, 10, 11)],
  };
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, fixture);
  await page.goto(`/?now=${encodeURIComponent(NOW)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 8 * 48));
}

const dateAtX = (page: Page, x: number) => page.evaluate((x) => {
  for (const h of document.querySelectorAll<HTMLElement>(".day-headers .day-head, .day-headers .day-head-x")) {
    const r = h.getBoundingClientRect();
    if (x >= r.left && x < r.right) return Number(h.querySelector(".dnum")!.textContent);
  }
  return null;
}, x);

const geom = async (page: Page) => {
  const g = (await page.locator(".gutter").boundingBox())!;
  const c = (await page.getByTestId("day-col-0").boundingBox())!;
  return { x0: g.x + g.width, top: c.y, colW: c.width };
};

/** a trusted horizontal wheel (the native path); resolves once the scroll
 *  lands, inside the settle window */
async function swipe(page: Page, cols: number) {
  const grid = (await page.getByTestId("week-grid").boundingBox())!;
  await page.mouse.move(grid.x + grid.width / 2, grid.y + 200);
  const { colW } = await geom(page);
  const before = await page.getByTestId("week-grid").evaluate((el) => el.scrollLeft);
  await page.mouse.wheel(Math.round(colW * cols), 0);
  await page.waitForFunction((b) => document.querySelector<HTMLElement>("[data-testid=week-grid]")!.scrollLeft !== b,
    before, { polling: "raf" });
}

test("settle: a chip dragged right after a swipe lands where its preview shows", async ({ page }) => {
  await open(page);
  await swipe(page, 3);
  const chip = page.locator(".chip-timed", { hasText: "Move me" });
  const b = (await chip.boundingBox())!;
  const x = b.x + b.width / 2, y = b.y + 10;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 48, { steps: 4 });
  await page.waitForTimeout(300);
  await page.mouse.move(x, y + 50, { steps: 2 });
  const ghostDate = await dateAtX(page, (await page.locator(".chip-ghost").boundingBox())!.x + 4);
  await page.mouse.up();
  await page.waitForTimeout(150);
  expect(ghostDate).toBe(14);
  expect(await dateAtX(page, (await chip.boundingBox())!.x + 4)).toBe(14);
});

test("settle: a drag-create right after a swipe stays on the pointer's day", async ({ page }) => {
  await open(page);
  await swipe(page, 3);
  const { x0, top, colW } = await geom(page);
  const x = x0 + colW / 2, y = top + 13 * 48 + 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 48, { steps: 3 });
  await page.waitForTimeout(300);
  await page.mouse.move(x, y + 50, { steps: 2 });
  const ghostDate = await dateAtX(page, (await page.locator(".chip-ghost").boundingBox())!.x + 4);
  await page.mouse.up();
  expect(ghostDate).toBe(14);
  await expect(page.getByTestId("event-panel")).toContainText("Oct 14");
});

test("settle: a shift-marquee right after a swipe selects only the boxed day", async ({ page }) => {
  await open(page);
  await swipe(page, 1);
  const { x0, top, colW } = await geom(page);
  const x = x0 + 3 * colW + colW / 2; // Thu 15
  await page.keyboard.down("Shift");
  await page.mouse.move(x, top + 11.5 * 48);
  await page.mouse.down();
  await page.mouse.move(x + 2, top + 12.5 * 48, { steps: 3 });
  await page.waitForTimeout(300);
  await page.mouse.move(x + 4, top + 12.6 * 48, { steps: 2 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.locator(".chip-timed.selected", { hasText: "Alpha" })).toHaveCount(1);
  await expect(page.locator(".chip-timed.selected", { hasText: "Wednesday lunch" })).toHaveCount(0);
});

for (const [label, act] of [
  ["t", (page: Page) => page.keyboard.press("t")],
  ["the Today button", (page: Page) => page.getByRole("button", { name: /^Today$/ }).first().click()],
] as const) {
  test(`settle: ${label} pressed as a swipe comes to rest goes to this week`, async ({ page }) => {
    await open(page);
    await swipe(page, 3);
    await act(page);
    await page.waitForTimeout(400);
    expect(await dateAtX(page, (await geom(page)).x0 + 5)).toBe(11);
  });
}

test("settle: a long fling shows the far runway days' events", async ({ page }) => {
  await open(page);
  await swipe(page, 4);
  await page.waitForTimeout(300);
  await swipe(page, 6);
  await page.waitForTimeout(300);
  await expect(page.locator(".day-head").first()).toHaveAttribute("data-day", "2026-10-21");
  await swipe(page, 13); // Nov 3 – Nov 9 drawn, not yet re-centred
  const g = await geom(page);
  expect(await dateAtX(page, g.x0 + 6.5 * g.colW)).toBe(9);
  await expect(page.locator(".chip-timed", { hasText: "Far nine" })).toHaveCount(1);
});

test("settle: an event on a just-swiped-in day opens on the first click", async ({ page }) => {
  await open(page);
  await swipe(page, 3); // Wed 14 – Tue 20 drawn; Sun 18 – Tue 20 were runway
  // a raw click at once (locator.click would wait for the column to take it)
  const b = (await page.locator(".chip-timed", { hasText: "Monday thing" }).boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + 6);
  await expect(page.getByTestId("event-panel").locator(".panel-title")).toHaveValue("Monday thing");
});

// (a cache keyed per day must still see an overnight event end on the next day)
test("an overnight event's earlier segment fades when the event ends", async ({ page }) => {
  const cal = { id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" };
  const ev = { id: "late", calendar_id: "primary", etag: null, summary: "Late shift", description: null, location: null,
    start: "2026-10-15T23:40:00-04:00", end: "2026-10-16T00:40:00-04:00", all_day: false, timezone: null, status: "confirmed",
    recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {} };
  await page.clock.install({ time: new Date("2026-10-16T00:20:00-04:00") });
  await page.addInitScript((fx) => ((globalThis as any).__calFixture = fx), { calendars: [cal], events: [ev] });
  await page.goto("/");
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const thu = page.locator('[data-testid="day-col-4"] [data-ek*="late"]');
  const fri = page.locator('[data-testid="day-col-5"] [data-ek*="late"]');
  await expect(thu).not.toHaveClass(/\bpast\b/);
  await page.clock.runFor(21 * 60_000);
  await expect(fri).toHaveClass(/\bpast\b/);
  await expect(thu).toHaveClass(/\bpast\b/);
  await expect(thu).toHaveClass(/\bunsettled\b/);
});
