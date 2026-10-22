// Recurring series editing: found by the 2026-10-21 run 5 bug-finder (each
// failed before its fix).
import { expect, test, type Page } from "@playwright/test";
const CAL = [{ id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" },
  { id: "work", summary: "Work", color: "#2fbf71", is_primary: false, hidden: false, access_role: "owner" }];
const GOALS = { goals: [{ id: "g1", text: "Write the thesis", horizon: "long" }], checks: {}, thoughts: [] };
function occ(m: string, summary: string, date: string, rules: string[], o: { hour?: number; slot?: string; raw?: any; description?: string } = {}) {
  const hh = (h: number) => String(h).padStart(2, "0");
  const h = o.hour ?? 9;
  const start = `${date}T${hh(h)}:00:00-04:00`;
  const slot = o.slot ?? start;
  const id = `${m}_${new Date(slot).toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
  return { id, calendar_id: "primary", etag: null, summary, description: o.description ?? null,
    location: null, start, end: `${date}T${hh(h + 1)}:00:00-04:00`, all_day: false, timezone: "America/New_York",
    status: "confirmed", recurrence: null, recurring_event_id: m, conference_url: null, updated: null,
    raw: { masterRecurrence: rules, originalStartTime: { dateTime: slot }, ...(o.raw ?? {}) } };
}
async function open(page: Page, events: unknown[], now: string, stars: Record<string, unknown> | null = null) {
  await page.addInitScript(([fx, st]) => {
    (globalThis as any).__calFixture = fx;
    if (st) localStorage.setItem("goal-stars", JSON.stringify(st));
  }, [{ calendars: CAL, events, goals: GOALS }, stars] as const);
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
  await page.evaluate(() => {
    const be = (window as any).__mockBackend; (window as any).__calls = [];
    for (const name of ["updateSeriesMaster", "splitSeries", "updateEvent", "deleteEvent"]) {
      const orig = be[name].bind(be);
      be[name] = (...args: any[]) => { (window as any).__calls.push({ name, args: JSON.parse(JSON.stringify(args)) }); return orig(...args); };
    }
  });
}
const chip = (page: Page, id: string) => page.locator(`[data-testid="event-chip"][data-ek="primary/${id}"]`);
const calls = (page: Page) => page.evaluate(() => (window as any).__calls as { name: string; args: any[] }[]);
const rows = (page: Page) => page.evaluate(async () => (await (window as any).__mockBackend.listEvents("2026-10-01", "2026-11-30")));
const reminderSelect = (page: Page) => page.getByTestId("event-panel").locator("select.panel-cal").filter({ has: page.locator("option", { hasText: "No reminder" }) });

// [P2] got: updateSeriesMaster patch {} (no reminders); toast "Updated all", every occurrence keeps 10 min.
// App.tsx applyScope "all" reads only input.reminder_minutes; "No reminder" arrives as input.reminders.
test("series 5b: all events: switching a series to No reminder reaches the master", async ({ page }) => {
  const rules = ["RRULE:FREQ=DAILY;UNTIL=20261031T000000Z"];
  const raw = { reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] } };
  await open(page, [13, 14, 15].map((d) => occ("rm", "Standup", `2026-10-${d}`, rules, { raw })), "2026-10-14T08:00:00");
  await chip(page, "rm_20261014T130000Z").click();
  await reminderSelect(page).selectOption({ label: "No reminder" });
  await page.getByTestId("event-panel").getByRole("button", { name: /^Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect(page.getByTestId("toast")).toContainText("Updated all");
  const patch = (await calls(page)).find((c) => c.name === "updateSeriesMaster")!.args[2];
  expect(patch.reminders, `patch sent: ${JSON.stringify(patch)}`).toEqual({ useDefault: false, overrides: [] });
});

// [P2] got: patch {} - previousReminder maps "no overrides" to null, so Default (null) looks unchanged.
test("series 5b: all events: No reminder back to Default reaches the master", async ({ page }) => {
  const rules = ["RRULE:FREQ=DAILY;UNTIL=20261031T000000Z"];
  const raw = { reminders: { useDefault: false, overrides: [] } };
  await open(page, [13, 14, 15].map((d) => occ("rm", "Standup", `2026-10-${d}`, rules, { raw })), "2026-10-14T08:00:00");
  await chip(page, "rm_20261014T130000Z").click();
  await expect(reminderSelect(page)).toHaveValue("-1");
  await reminderSelect(page).selectOption({ label: "Default reminder" });
  await page.getByTestId("event-panel").getByRole("button", { name: /^Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect(page.getByTestId("toast")).toContainText("Updated all");
  const patch = (await calls(page)).find((c) => c.name === "updateSeriesMaster")!.args[2];
  expect(patch.reminders, `patch sent: ${JSON.stringify(patch)}`).toEqual({ useDefault: true });
});

// [P2] got: start 2026-10-20T09:00 (TU) with RRULE:FREQ=WEEKLY;BYDAY=WE; old half UNTIL=20261021T125959Z.
// Google counts DTSTART: the new series has Tue Oct 20 AND Wed Oct 21 (the slot the user moved away from).
// (The series keeps its Wednesdays, as a time-only edit does since 90726f63;
// the moved-away slot is excluded from the new half instead.)
test("series 5b: following on a moved occurrence: its old slot doesn't come back in the new series", async ({ page }) => {
  const rules = ["RRULE:FREQ=WEEKLY;BYDAY=WE"];
  await open(page, [
    occ("oo", "1:1", "2026-10-14", rules),
    occ("oo", "1:1", "2026-10-20", rules, { slot: "2026-10-21T09:00:00-04:00" }), // Wed moved to Tue
    occ("oo", "1:1", "2026-10-28", rules),
  ], "2026-10-19T08:00:00");
  await chip(page, "oo_20261021T130000Z").click();
  const panel = page.getByTestId("event-panel");
  await panel.locator(".panel-title").fill("1:1 (new room)");
  await panel.getByRole("button", { name: /^Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-following").click();
  await expect(page.getByTestId("toast")).toContainText("and following");
  const call = (await calls(page)).find((c) => c.name === "splitSeries")!;
  const input = call.args[3];
  const rule = input.recurrence.find((r: string) => r.startsWith("RRULE"));
  const day = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][new Date(input.start).getDay()];
  expect(day, `new series starts ${input.start}`).toBe("TU");
  expect(rule).toBe("RRULE:FREQ=WEEKLY;BYDAY=WE");
  const excluded = input.recurrence.filter((r: string) => r.startsWith("EXDATE")).join(" ");
  expect(excluded, `recurrence sent: ${input.recurrence.join(" | ")}`).toMatch(/20261021T130000Z/);
});

// [P3] got: badge stays "★ 1" for the deleted Oct 15 occurrence ("All events" and the context menu's Delete series skip markStarDeleted too, by reading).
test("series 5b: a goal's star count drops when the starred occurrence's series is deleted", async ({ page }) => {
  const rules = ["RRULE:FREQ=DAILY;UNTIL=20261031T000000Z"];
  await open(page, [13, 14, 15].map((d) => occ("tb", "Thesis block", `2026-10-${d}`, rules)), "2026-10-14T08:00:00",
    { tb_20261015T130000Z: { goal: "Write the thesis" } });
  const badge = page.getByTestId("goal-row").filter({ hasText: "Write the thesis" }).locator(".goal-star-count");
  await expect(badge).toHaveText("★ 1");
  await chip(page, "tb_20261014T130000Z").click();
  await page.getByTestId("event-panel").getByRole("button", { name: /Delete/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-following").click();
  await expect(page.locator(".chip-timed", { hasText: "Thesis block" })).toHaveCount(1);
  await expect(badge, "the deleted Oct 15 occurrence still counts").toHaveCount(0);
});

// [P3] got: patch.start 2026-10-21 but no recurrence: the rule stays BYDAY=2WE, so from November it
// repeats on the 2nd Wednesday again (and the native projection shows Nov 18 until the pull says Nov 11).
test("series 5b: all events: a monthly 2nd-Wednesday series moved a week later repeats on the 3rd Wednesday", async ({ page }) => {
  const rules = ["RRULE:FREQ=MONTHLY;BYDAY=2WE"];
  await open(page, [occ("mo", "Board review", "2026-10-14", rules), occ("mo", "Board review", "2026-11-11", rules)], "2026-10-12T08:00:00");
  await chip(page, "mo_20261014T130000Z").click();
  const panel = page.getByTestId("event-panel");
  await panel.locator(".panel-date-pretty").click();
  await panel.locator('input[type="date"]:not(.allday-end)').fill("2026-10-21");
  await panel.locator('input[type="date"]:not(.allday-end)').blur();
  await panel.getByRole("button", { name: /Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect(page.getByTestId("toast")).toContainText("Updated all");
  const patch = (await calls(page)).find((c) => c.name === "updateSeriesMaster")!.args[2];
  expect(patch.start.dateTime.slice(0, 10)).toBe("2026-10-21");
  const rule = patch.recurrence?.find((r: string) => r.startsWith("RRULE")) ?? "(unchanged: RRULE:FREQ=MONTHLY;BYDAY=2WE)";
  expect(rule, `start moved to the 3rd Wednesday; rule sent: ${rule}`).toContain("BYDAY=3WE");
});
