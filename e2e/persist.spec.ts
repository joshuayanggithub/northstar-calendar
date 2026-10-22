// What survives a relaunch, and a new day while the app stays open: found by
// the 2026-10-18 bug-finder pass, run 2.
import { expect, test, type Page } from "@playwright/test";

const PRIMARY = { id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" };
const WORK = { id: "work", summary: "Work", color: "#2fbf71", is_primary: false, hidden: false, access_role: "owner" };
const gym = {
  id: "g", calendar_id: "primary", etag: null, summary: "Gym", description: "[DRILL] legs day", location: null,
  start: "2026-10-14T17:00:00-04:00", end: "2026-10-14T18:30:00-04:00", all_day: false, timezone: null, status: "confirmed",
  recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {},
};
async function dismissSweep(page: Page) {
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
}

test("persist: a goal star and a placed note stay with an event moved to another calendar", async ({ page }) => {
  await page.addInitScript((fx) => {
    (globalThis as any).__calFixture = fx;
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("goal-stars", JSON.stringify({ "primary/g": { goal: "3 gym sessions" } }));
      localStorage.setItem("note-pins", JSON.stringify({ "primary/g": { dxCol: 1, dyMin: -60, w: 120, angle: 0 } }));
      sessionStorage.setItem("seeded", "1");
    }
  }, { calendars: [PRIMARY, WORK], events: [gym] });
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`);
  await dismissSweep(page);
  const chip = page.locator(".chip-timed", { hasText: "Gym" }).first();
  await expect(chip).toHaveClass(/\bstarred\b/);
  await expect(page.locator(".margin-note").first()).toHaveClass(/\bpinned\b/);
  await chip.click();
  const p = page.getByTestId("event-panel");
  await p.getByTestId("panel-cal-trigger").click();
  await p.getByTestId("panel-cal-options").getByRole("option", { name: "Work" }).click();
  await p.getByRole("button", { name: /^Save/ }).click();
  await expect(chip).toHaveAttribute("data-ek", "work/g");
  await page.keyboard.press("Escape");
  await expect(chip, "still starred").toHaveClass(/\bstarred\b/);
  await expect(page.locator(".margin-note").first(), "still pinned").toHaveClass(/\bpinned\b/);
});

test("persist: the sidebar's today moves at midnight with the app left open", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-14T23:58:00") });
  await page.goto("/");
  await expect(page.locator(".mini-day.today")).toHaveText("14");
  await page.clock.runFor(4 * 60_000);
  await expect(page.locator(".day-head.today")).toContainText("15");
  await expect(page.locator(".mini-day.today")).toHaveText("15");
});

test("persist: the event panel fits a window that narrowed", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.addInitScript(() => localStorage.setItem("pane-w-panel", "760"));
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`);
  await dismissSweep(page);
  await page.locator(".chip-timed", { hasText: "Swim" }).click();
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect.poll(() => page.locator(".event-panel").evaluate((e) => e.getBoundingClientRect().width)).toBeLessThanOrEqual(600);
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect.poll(() => page.locator(".event-panel").evaluate((e) => e.getBoundingClientRect().width)).toBe(760);
});

test("persist: view, day count and zoom come back after a relaunch", async ({ page }) => {
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`);
  await dismissSweep(page);
  await page.keyboard.press("3");
  await page.keyboard.press("ControlOrMeta+Shift+.");
  await expect(page.locator(".day-head")).toHaveCount(3);
  await page.reload();
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await expect(page.locator(".day-head")).toHaveCount(3);
  expect(await page.evaluate(() => localStorage.getItem("hour-px"))).toBe("60");
});
