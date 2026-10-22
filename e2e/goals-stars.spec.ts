// Goals, stars and the sidebar: found by the 2026-10-21 run 5 bug-finder (each
// failed before its fix).
import { expect, test, type Page } from "@playwright/test";

const NOW = "2026-10-14T09:00:00";
const CAL = { id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" };
const GOALS = {
  goals: [
    { id: "g1", text: "Write the thesis", horizon: "long" },
    { id: "g2", text: "Run 5k", horizon: "daily" },
  ],
  checks: {},
  thoughts: [{ id: "t1", text: "alpha beta gamma" }],
};
const timed = (id: string, summary: string, day = 14, extra: Record<string, unknown> = {}) => ({
  id, calendar_id: "primary", etag: null, summary, description: null, location: null,
  start: `2026-10-${day}T13:00:00-04:00`, end: `2026-10-${day}T14:00:00-04:00`, all_day: false,
  timezone: "America/New_York", status: "confirmed", recurrence: null, recurring_event_id: null,
  conference_url: null, updated: null, raw: null, ...extra,
});
/** a daily series, Oct 12-17 at 10 AM (the fixture shape series-split.spec.ts uses) */
const series = () =>
  [12, 14, 15, 16, 17].map((d) => {
    const start = `2026-10-${d}T10:00:00-04:00`;
    return timed(`ts_202610${d}T140000Z`, "Thesis block", d, {
      start, end: `2026-10-${d}T11:00:00-04:00`, recurring_event_id: "ts",
      raw: { masterRecurrence: ["RRULE:FREQ=DAILY;UNTIL=20261031T000000Z"], originalStartTime: { dateTime: start } },
    });
  });

async function open(page: Page, events: unknown[], stars: Record<string, unknown> | null = null) {
  await page.addInitScript(([fx, st]) => {
    (globalThis as any).__calFixture = fx;
    // seed the stars once (a reload must not re-seed them)
    if (st && !sessionStorage.getItem("w2b-seeded")) {
      localStorage.setItem("goal-stars", JSON.stringify(st));
      sessionStorage.setItem("w2b-seeded", "1");
    }
  }, [{ calendars: [CAL], events, goals: GOALS }, stars] as const);
  await page.goto(`/?now=${encodeURIComponent(NOW)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
}
const badge = (page: Page, goal: string) =>
  page.getByTestId("goal-row").filter({ hasText: goal }).locator(".goal-star-count");

// [P2] got: the new "Thesis block v2" chip has class "chip chip-timed" (no
// star), localStorage still holds only the old id ts_20261015T140000Z, and
// the goal's badge keeps counting that old id. Its review mark and note pin
// do move (App.tsx carryRecon/setNotePin); the star doesn't.
test("a starred occurrence edited 'this and following' stays starred", async ({ page }) => {
  await open(page, series(), { ts_20261015T140000Z: { goal: "Write the thesis" } });
  const chip = page.locator(".chip-timed", { hasText: "Thesis block" }).nth(2); // Oct 15
  await expect(chip).toHaveClass(/starred/);
  await chip.click();
  const p = page.getByTestId("event-panel");
  await p.locator(".panel-title").fill("Thesis block v2");
  await p.getByRole("button", { name: /^Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-following").click();
  await expect(page.getByTestId("toast")).toContainText("and following");
  const v2 = page.locator(".chip-timed", { hasText: "Thesis block v2" }).first();
  await expect(v2).toBeVisible();
  await expect(v2).toHaveClass(/\bstarred\b/);
});

// [P2] got: the pasted "Draft chapter" is unstarred (class "chip chip-timed")
// and the star stays on the deleted original's id; the badge still reads ★ 1
// for an event that no longer exists. App.tsx calls a cut "a move: everything
// comes along", but carryStar runs only on an undone delete.
test("cut and paste moves an event's star with it", async ({ page }) => {
  await open(page, [timed("a1", "Draft chapter")], { a1: { goal: "Write the thesis" } });
  const chip = page.locator(".chip-timed", { hasText: "Draft chapter" });
  await expect(chip).toHaveClass(/starred/);
  await chip.click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+x");
  await expect(chip).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+v");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveClass(/\bstarred\b/);
});

// [P3] got: aria-pressed="true" on the ★ button, yet the unstarred
// "Groceries" stays at opacity 1 in Month (.mchip) and List (.agenda-row):
// app.css's .spotlight-goals rules only cover week/day classes.
test("the G spotlight dims non-goal events in Month and List too", async ({ page }) => {
  await open(page, [timed("a1", "Draft chapter"), timed("a2", "Groceries", 15)], { a1: { goal: "Write the thesis" } });
  await page.keyboard.press("m");
  const mchip = page.locator(".mchip", { hasText: "Groceries" }).first();
  await expect(mchip).toBeVisible();
  await page.keyboard.press("g");
  await expect(page.getByTestId("spotlight-btn")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => mchip.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThan(0.5);
  await page.keyboard.press("l");
  const row = page.locator(".agenda-row", { hasText: "Groceries" }).first();
  await expect(row).toBeVisible();
  await expect.poll(() => row.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThan(0.5);
});

// [P3] got: badge "★ 2" with tooltip "★ Edit chapter" after "Draft chapter"
// was deleted: starsForGoal counts every star entry, including deleted events'.
test("a goal's ★ count drops when a starred event is deleted", async ({ page }) => {
  await open(page, [timed("a1", "Draft chapter"), timed("a2", "Edit chapter", 15)], {
    a1: { goal: "Write the thesis" }, a2: { goal: "Write the thesis" },
  });
  await expect(badge(page, "Write the thesis")).toHaveText("★ 2");
  await page.locator(".chip-timed", { hasText: "Draft chapter" }).click({ button: "right" });
  await page.getByTestId("ctx-menu").getByRole("button", { name: "Delete", exact: false }).first().click();
  await expect(page.locator(".chip-timed", { hasText: "Draft chapter" })).toHaveCount(0);
  await expect(badge(page, "Write the thesis")).toHaveText("★ 1");
});

// [P3] got: addCalendar called 2 times, two "Side projects" rows (in the
// native app, two new Google calendars). submitAdd has no in-flight guard.
test("a second Enter while a new calendar is being created doesn't create it twice", async ({ page }) => {
  await open(page, []);
  await page.evaluate(() => {
    const be = (window as any).__mockBackend;
    const orig = be.addCalendar.bind(be);
    (window as any).__adds = 0;
    // Google answers in a few hundred ms
    be.addCalendar = async (...a: any[]) => {
      (window as any).__adds++;
      await new Promise((r) => setTimeout(r, 600));
      return orig(...a);
    };
  });
  await page.getByRole("button", { name: "Add calendar" }).click();
  const input = page.getByTestId("cal-add-form").locator("input");
  await input.fill("Side projects");
  await input.press("Enter");
  await page.waitForTimeout(150);
  await input.press("Enter");
  await expect(page.getByTestId("cal-row").filter({ hasText: "Side projects" })).toHaveCount(1);
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => (window as any).__adds)).toBe(1);
  await expect(page.getByTestId("cal-row").filter({ hasText: "Side projects" })).toHaveCount(1);
});

// [P3] got: the caret lands at 0, so "delta" is prepended:
// "deltaalpha beta gamma". (A goal's rename input puts it at the end.)
test("editing a thought puts the caret at the end, so typing appends", async ({ page }) => {
  await open(page, []);
  await page.getByTestId("thought-row").first().locator(".thought-text").dblclick();
  const ed = page.locator(".thought-edit");
  await expect(ed).toBeFocused();
  await page.keyboard.type(" delta");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("thought-row").first()).toContainText("alpha beta gamma delta");
});

test("the add-calendar form says Creating… while the request runs", async ({ page }) => {
  await open(page, []);
  await page.evaluate(() => {
    const be = (window as any).__mockBackend;
    const orig = be.addCalendar.bind(be);
    be.addCalendar = async (...a: any[]) => { await new Promise((r) => setTimeout(r, 800)); return orig(...a); };
  });
  await page.getByRole("button", { name: "Add calendar" }).click();
  const input = page.getByTestId("cal-add-form").locator("input");
  await input.fill("Side projects");
  await input.press("Enter");
  await expect(page.getByTestId("cal-add-form").locator(".cal-add-hint")).toHaveText("Creating…"); // got: "↵ create new calendar"
  await expect(page.getByTestId("cal-row").filter({ hasText: "Side projects" })).toHaveCount(1);
});
