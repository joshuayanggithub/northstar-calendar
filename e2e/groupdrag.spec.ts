// Dragging several selected events at once (WeekView group drag + App
// moveSelected): shift-click (or shift-drag) a few events, drag any one of
// them, and all of them move by the same wall-clock shift, with a ghost for
// each at its landing spot while the drag is on.
import { expect, test, type Page } from "@playwright/test";
import { shiftWallClock, wallShiftBetween } from "../src/lib/dates";

const NOW = "2026-10-14T08:00:00"; // a Wednesday; the week runs Sun 11 – Sat 17

async function open(page: Page) {
  const cal = (id: string, summary: string, access_role = "owner") => ({
    id, summary, color: "#4986e7", is_primary: id === "p", hidden: false, access_role,
  });
  const at = (d: number, h: number) => new Date(2026, 9, d, h).toISOString();
  let n = 0;
  const ev = (calendar_id: string, summary: string, d: number, h0: number, h1: number) => ({
    id: `g${++n}`, calendar_id, etag: null, summary, description: null, location: null,
    start: at(d, h0), end: at(d, h1), all_day: false, timezone: null, status: "confirmed",
    recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {},
  });
  const fixture = {
    calendars: [cal("p", "Personal"), cal("team", "Team (view only)", "reader")],
    events: [
      ev("p", "Alpha", 13, 9, 10),
      ev("p", "Beta", 14, 11, 12),
      ev("p", "Gamma", 15, 14, 15),
      ev("team", "Standup (theirs)", 13, 12, 13),
    ],
  };
  await page.addInitScript((fx) => {
    (globalThis as unknown as { __calFixture: unknown }).__calFixture = fx;
  }, fixture);
  await page.goto(`/?now=${encodeURIComponent(NOW)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 8 * 48));
}

const chip = (page: Page, t: string) => page.locator(".chip-timed", { hasText: t });
const timeOf = async (page: Page, t: string) => (await chip(page, t).locator(".chip-time").first().textContent())?.trim();

/** drag `t` by whole day columns and hours, checking the others mid-drag */
async function dragBy(page: Page, t: string, cols: number, hours: number, during?: () => Promise<void>) {
  const box = (await chip(page, t).boundingBox())!;
  const col = (await page.getByTestId("day-col-0").boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 10;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + cols * col.width, y + hours * 48, { steps: 8 });
  if (during) await during();
  await page.mouse.up();
}

test("group drag: every selected event moves together, with a ghost each, and stays selected", async ({ page }) => {
  await open(page);
  await chip(page, "Alpha").click({ modifiers: ["Shift"] });
  await chip(page, "Beta").click({ modifiers: ["Shift"] });
  await expect(page.locator(".chip-timed.selected")).toHaveCount(2);

  // one day later, one hour later
  await dragBy(page, "Alpha", 1, 1, async () => {
    const ghost = page.getByTestId("group-ghost");
    await expect(ghost, "the other selected event shows where it lands").toHaveCount(1);
    await expect(ghost).toContainText("Beta");
    await expect(ghost).toContainText("12 – 1 PM");
    // it lands in Thursday's column
    const g = (await ghost.boundingBox())!;
    const thu = (await page.getByTestId("day-col-4").boundingBox())!;
    expect(g.x).toBeGreaterThanOrEqual(thu.x - 1);
    expect(g.x).toBeLessThan(thu.x + thu.width);
    await expect(chip(page, "Beta")).toHaveClass(/dragging/);
    await expect(chip(page, "Gamma")).not.toHaveClass(/dragging/);
  });

  await expect(page.getByTestId("day-col-3").locator(".chip-timed", { hasText: "Alpha" })).toHaveCount(1);
  await expect(page.getByTestId("day-col-4").locator(".chip-timed", { hasText: "Beta" })).toHaveCount(1);
  expect(await timeOf(page, "Alpha")).toBe("10 – 11 AM");
  expect(await timeOf(page, "Beta")).toBe("12 – 1 PM");
  expect(await timeOf(page, "Gamma")).toBe("2 – 3 PM");
  await expect(page.locator(".chip-timed.selected"), "the group stays selected").toHaveCount(2);

  // drag the same group again: it moves from where it is now
  await dragBy(page, "Beta", 0, 1);
  expect(await timeOf(page, "Alpha")).toBe("11 AM – 12 PM");
  expect(await timeOf(page, "Beta")).toBe("1 – 2 PM");

  // one undo per group move
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => timeOf(page, "Beta")).toBe("12 – 1 PM");
  expect(await timeOf(page, "Alpha")).toBe("10 – 11 AM");
});

test("group drag: an event from a view-only calendar stays where it is", async ({ page }) => {
  await open(page);
  await chip(page, "Alpha").click({ modifiers: ["Shift"] });
  await chip(page, "Standup (theirs)").click({ modifiers: ["Shift"] });
  await dragBy(page, "Alpha", 0, 2, async () => {
    await expect(page.getByTestId("group-ghost"), "no ghost for what can't move").toHaveCount(0);
  });
  expect(await timeOf(page, "Alpha")).toBe("11 AM – 12 PM");
  expect(await timeOf(page, "Standup (theirs)")).toBe("12 – 1 PM");
  await expect(page.getByTestId("toast")).toContainText("stayed");
});

test("wall-clock shift: 9:00 stays 9:00 on the new day across the end of daylight saving", () => {
  process.env.TZ = "America/New_York";
  // Sat Oct 31 2026 9:00 EDT, dragged to Sunday: Nov 1 is 25 hours long
  const from = new Date(2026, 9, 31, 9, 0);
  const to = new Date(2026, 10, 1, 9, 0);
  const shift = wallShiftBetween(from, to);
  expect(shift).toEqual({ days: 1, minutes: 0 });
  // another selected event, 14:30 that Saturday, lands at 14:30 on Sunday
  const other = shiftWallClock(new Date(2026, 9, 31, 14, 30), shift);
  expect([other.getDate(), other.getHours(), other.getMinutes()]).toEqual([1, 14, 30]);
  // minutes past midnight roll into the next day
  const late = shiftWallClock(new Date(2026, 9, 31, 23, 30), { days: 0, minutes: 60 });
  expect([late.getMonth(), late.getDate(), late.getHours(), late.getMinutes()]).toEqual([10, 1, 0, 30]);
});
