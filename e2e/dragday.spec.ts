// Dragging an event between days (WeekView beginDrag): the day follows
// sideways TRAVEL from the grab point, with slack, not the column under the
// pointer. A vertical drag that drifts a little sideways keeps its day; a
// deliberate move of most of a column switches; coming back needs the same
// margin. Also true after a partial sideways swipe of the week.
import { expect, test, type Page } from "@playwright/test";

const NOW = "2026-10-14T08:00:00"; // Wednesday; the week runs Sun 11 – Sat 17

async function open(page: Page) {
  const at = (d: number, h: number) => new Date(2026, 9, d, h).toISOString();
  const fixture = {
    calendars: [{ id: "p", summary: "Personal", color: "#4986e7", is_primary: true, hidden: false, access_role: "owner" }],
    events: [{
      id: "mv", calendar_id: "p", etag: null, summary: "Move me", description: null, location: null,
      start: at(14, 10), end: at(14, 11), all_day: false, timezone: null, status: "confirmed",
      recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {},
    }],
  };
  await page.addInitScript((fx) => {
    (globalThis as unknown as { __calFixture: unknown }).__calFixture = fx;
  }, fixture);
  await page.goto(`/?now=${encodeURIComponent(NOW)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 8 * 48));
}

const chip = (page: Page) => page.locator(".chip-timed", { hasText: "Move me" });
const colW = async (page: Page) => (await page.getByTestId("day-col-3").boundingBox())!.width;
/** which day column the dragged event's ghost (or the event) is in */
const ghostDay = (page: Page) =>
  page.evaluate(() => {
    const g = document.querySelector(".chip-ghost") ?? document.querySelector(".chip-timed");
    return g?.closest("[data-testid^=day-col-]")?.getAttribute("data-testid") ?? null;
  });
const landedDay = (page: Page) =>
  chip(page).evaluate((el) => el.closest("[data-testid^=day-col-]")?.getAttribute("data-testid"));

test("drag: a vertical drag that drifts sideways keeps its day", async ({ page }) => {
  await open(page);
  const b = (await chip(page).boundingBox())!;
  const w = await colW(page);
  // grabbed near its right edge, where the next column is a few px away
  const x = b.x + b.width - 6;
  const y = b.y + 10;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + w * 0.35, y + 96, { steps: 10 }); // two hours down, a third of a column right
  expect(await ghostDay(page)).toBe("day-col-3");
  await page.mouse.up();
  expect(await landedDay(page)).toBe("day-col-3");
  await expect(chip(page)).toContainText("12 – 1 PM");
});

test("drag: most of a column sideways switches day, and back needs the same margin", async ({ page }) => {
  await open(page);
  const b = (await chip(page).boundingBox())!;
  const w = await colW(page);
  const x = b.x + 20;
  const y = b.y + 10;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + w * 0.8, y, { steps: 8 });
  expect(await ghostDay(page), "80% of a column: next day").toBe("day-col-4");
  await page.mouse.move(x + w * 0.45, y, { steps: 4 });
  expect(await ghostDay(page), "back to 45%: still the next day (no flicker at the line)").toBe("day-col-4");
  await page.mouse.move(x + w * 0.2, y, { steps: 4 });
  expect(await ghostDay(page), "back to 20%: the original day").toBe("day-col-3");
  await page.mouse.move(x + w * 1.8, y, { steps: 8 });
  expect(await ghostDay(page), "two columns over").toBe("day-col-5");
  await page.mouse.up();
  expect(await landedDay(page)).toBe("day-col-5");
  await expect(chip(page)).toContainText("10 – 11 AM");
});

test("drag: after a partial sideways swipe, a one-column move lands one day over", async ({ page }) => {
  await open(page);
  const grid = (await page.getByTestId("week-grid").boundingBox())!;
  await page.mouse.move(grid.x + grid.width / 2, grid.y + 200);
  await page.mouse.wheel(40, 0); // a partial swipe: the week sits part-way between days
  await page.waitForTimeout(250);
  const b = (await chip(page).boundingBox())!;
  const w = await colW(page);
  const start = await chip(page).evaluate((el) => el.closest("[data-testid^=day-col-]")!.getAttribute("data-testid")!);
  const idx = Number(start.split("-").pop());
  const x = b.x + b.width / 2;
  const y = b.y + 10;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + w, y + 48, { steps: 10 });
  await page.mouse.up();
  expect(await landedDay(page)).toBe(`day-col-${idx + 1}`);
  await expect(chip(page)).toContainText("11 AM – 12 PM");
});
