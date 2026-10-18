// Dragging an event that runs past midnight (WeekView dragGhost /
// ghostPieces): the preview of where it lands is drawn on every day it
// touches, the part after midnight starting on the 12 AM line. It used to be
// drawn only in the column under the pointer, from the event's start, so
// grabbing the part after midnight showed a preview almost entirely above
// the day (off screen), and the part before midnight lost its tail.
import { expect, test, type Page } from "@playwright/test";

async function open(page: Page) {
  // The app browser is pinned to Eastern; don't build these fixture instants
  // in the Linux runner's Pacific timezone.
  const at = (d: number, h: number, m = 0) =>
    new Date(`2026-10-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-04:00`).toISOString();
  const fixture = {
    calendars: [{ id: "p", summary: "Learning and Research", color: "#9fe1e7", is_primary: true, hidden: false, access_role: "owner" }],
    events: [{
      id: "late", calendar_id: "p", etag: null, summary: "Read paper", description: null, location: null,
      start: at(16, 23), end: at(17, 0, 15), all_day: false, timezone: null, status: "confirmed",
      recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {},
    }],
  };
  await page.addInitScript((fx) => {
    (globalThis as unknown as { __calFixture: unknown }).__calFixture = fx;
  }, fixture);
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  // 10 PM to 1 AM-ish in view: the strip scrolls one day at a time, so look
  // at Friday's evening; Saturday's top is checked by its column's offset
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 21.5 * 48));
}

/** ghost pieces per column: [column, top px within it, height px] */
const ghosts = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".chip-ghost:not(.chip-draft)")].map((g) => {
      const col = g.closest("[data-testid^=day-col-]") as HTMLElement;
      return [col.dataset.testid, Math.round(g.offsetTop), Math.round(g.offsetHeight), g.textContent] as const;
    }),
  );

const fri = (page: Page) => page.getByTestId("day-col-5").locator(".chip-timed", { hasText: "Read paper" });

test("overnight drag: grabbing the part before midnight previews both days", async ({ page }) => {
  await open(page);
  const b = (await fri(page).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 10);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 10 + 24, { steps: 6 }); // half an hour later
  const g = await ghosts(page);
  await page.mouse.up();
  const byCol = Object.fromEntries(g.map(([c, top, h]) => [c, { top, h }]));
  expect(byCol["day-col-5"], "Friday: 11:30 PM to midnight").toEqual({ top: Math.round(23.5 * 48), h: 24 });
  expect(byCol["day-col-6"], "Saturday: midnight to 12:45 AM").toEqual({ top: 0, h: 36 });
  // the piece tall enough for a time shows the whole landing range
  expect(g.find(([c]) => c === "day-col-6")![3]).toContain("11:30 PM – 12:45 AM");
});

test("overnight drag: grabbing the part after midnight previews it from the 12 AM line", async ({ page }) => {
  await open(page);
  const sat = page.getByTestId("day-col-6").locator(".chip-timed", { hasText: "Read paper" });
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 0));
  const b = (await sat.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 4);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 4 + 24, { steps: 6 }); // half an hour later
  const g = await ghosts(page);
  await page.mouse.up();
  const byCol = Object.fromEntries(g.map(([c, top, h]) => [c, { top, h }]));
  // 11:30 PM to 12:45 AM: from the 12 AM line on Saturday, and its start on Friday
  expect(byCol["day-col-6"]).toEqual({ top: 0, h: 36 });
  expect(byCol["day-col-5"]).toEqual({ top: Math.round(23.5 * 48), h: 24 });
});

test("overnight resize: stretching the part after midnight previews from the 12 AM line", async ({ page }) => {
  await open(page);
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 0));
  const sat = page.getByTestId("day-col-6").locator(".chip-timed", { hasText: "Read paper" });
  const b = (await sat.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height - 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 48, { steps: 6 }); // to 1 AM
  const g = await ghosts(page);
  await page.mouse.up();
  const byCol = Object.fromEntries(g.map(([c, top, h]) => [c, { top, h }]));
  expect(byCol["day-col-6"]).toEqual({ top: 0, h: 48 });
  expect(byCol["day-col-5"]).toEqual({ top: 23 * 48, h: 48 });
});
