// Recurring series editing, second pass (the run 5 final self-review of
// b0c58f6e; each failed before its fix).
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
async function moveAll(page: Page, id: string, date: string) {
  await chip(page, id).click();
  const panel = page.getByTestId("event-panel");
  await panel.locator(".panel-date-pretty").click();
  await panel.locator('input[type="date"]:not(.allday-end)').fill(date);
  await panel.locator('input[type="date"]:not(.allday-end)').blur();
  await panel.getByRole("button", { name: /Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect(page.getByTestId("toast")).toContainText("Updated all");
  const patch = (await calls(page)).find((c) => c.name === "updateSeriesMaster")!.args[2];
  return patch.recurrence?.find((r: string) => r.startsWith("RRULE")) ?? "(unchanged)";
}

// [rv-1] HEAD got: EXDATE:20261021T130000Z (the slot's 9:00) while the new series starts Tue 14:00,
// so Google generates Wed Oct 21 at 14:00 (18:00Z): the EXDATE matches nothing and the slot comes back.
test("rv-1: following on an occurrence moved to another day AND time excludes the slot at the new series' time", async ({ page }) => {
  const rules = ["RRULE:FREQ=WEEKLY;BYDAY=WE"];
  await open(page, [
    occ("oo", "1:1", "2026-10-14", rules),
    occ("oo", "1:1", "2026-10-20", rules, { hour: 14, slot: "2026-10-21T09:00:00-04:00" }), // Wed 9:00 moved to Tue 14:00
    occ("oo", "1:1", "2026-10-28", rules),
  ], "2026-10-19T08:00:00");
  await chip(page, "oo_20261021T130000Z").click();
  const panel = page.getByTestId("event-panel");
  await panel.locator(".panel-title").fill("1:1 (new room)");
  await panel.getByRole("button", { name: /^Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-following").click();
  await expect(page.getByTestId("toast")).toContainText("and following");
  const input = (await calls(page)).find((c) => c.name === "splitSeries")!.args[3];
  expect(new Date(input.start).toISOString()).toBe("2026-10-20T18:00:00.000Z"); // the new series runs at 14:00
  const excluded = input.recurrence.filter((r: string) => r.startsWith("EXDATE")).join(" ");
  expect(excluded, `recurrence sent: ${input.recurrence.join(" | ")}`).toMatch(/20261021T180000Z/);
});

// [rv-2a] HEAD got: BYDAY=2TH. The user moved Oct 14 (2nd Wed) to Thu Oct 15 (the 3rd Thursday: Oct 1 is a
// Thursday); the ordinal is taken from the master's shifted date (Sep 10, a 2nd Thursday), so the
// occurrence they dropped on Oct 15 goes to Oct 8 and every later month is a week early.
// (before b0c58f6e: BYDAY=2TH too, but the ordinal recompute exists to land the dropped day; from the master it does)
test("rv-2a: all events: a 2nd-Wednesday series moved a day later from a later occurrence stays where it was dropped", async ({ page }) => {
  const rules = ["RRULE:FREQ=MONTHLY;BYDAY=2WE"];
  await open(page, [occ("mo", "Board review", "2026-09-09", rules), occ("mo", "Board review", "2026-10-14", rules)], "2026-10-13T08:00:00");
  const rule = await moveAll(page, "mo_20261014T130000Z", "2026-10-15");
  expect(rule, `Oct 15 is the 3rd Thursday; rule sent: ${rule}`).toContain("BYDAY=3TH");
});

// [rv-2a'] HEAD got: BYDAY=3TH (before b0c58f6e: BYDAY=2TH, right). Nov 11 (2nd Wed) moved to Thu Nov 12, the
// 2nd Thursday; the master's shifted date Oct 15 is a 3rd Thursday, so the dropped occurrence goes to Nov 19.
// (the fixture's -04:00 in November makes the slot 13:00Z; the date is still Nov 11 in New York)
test("rv-2a': all events: moving November's 2nd Wednesday to Thursday keeps it on the 2nd Thursday", async ({ page }) => {
  const rules = ["RRULE:FREQ=MONTHLY;BYDAY=2WE"];
  await open(page, [occ("mo", "Board review", "2026-10-14", rules), occ("mo", "Board review", "2026-11-11", rules)], "2026-11-10T08:00:00");
  const rule = await moveAll(page, "mo_20261111T130000Z", "2026-11-12");
  expect(rule, `Nov 12 is the 2nd Thursday; rule sent: ${rule}`).toContain("BYDAY=2TH");
});

// [rv-2b] HEAD got: BYDAY=1TU,1TU (one ordinal overwrites every entry: the 3rd-Monday occurrences are gone).
// (before b0c58f6e: BYDAY=1TU,3TU)
test("rv-2b: all events: a 1st-and-3rd-Monday series moved a day later keeps both ordinals", async ({ page }) => {
  const rules = ["RRULE:FREQ=MONTHLY;BYDAY=1MO,3MO"];
  await open(page, [occ("fm", "Club", "2026-10-05", rules), occ("fm", "Club", "2026-10-19", rules)], "2026-10-05T08:00:00");
  const rule = await moveAll(page, "fm_20261005T130000Z", "2026-10-06");
  expect(rule, `rule sent: ${rule}`).toContain("BYDAY=1TU,3TU");
});

// [rv-3] HEAD got: badge gone. Deleting series "tb" marks every key starting "tb_", which includes
// Google web's split-off series "tb_R20261015T130000" (its own, still existing, event).
test("rv-3: deleting a series keeps the stars of Google's split-off _R series", async ({ page }) => {
  const rules = ["RRULE:FREQ=DAILY;UNTIL=20261015T035959Z"];
  const rRules = ["RRULE:FREQ=DAILY;UNTIL=20261031T000000Z"];
  const r = "tb_R20261015T130000";
  await open(page, [
    ...[13, 14].map((d) => occ("tb", "Thesis block", `2026-10-${d}`, rules)),
    ...[15, 16].map((d) => occ(r, "Thesis block", `2026-10-${d}`, rRules)),
  ], "2026-10-14T08:00:00", { [`${r}_20261016T130000Z`]: { goal: "Write the thesis" } });
  const badge = page.getByTestId("goal-row").filter({ hasText: "Write the thesis" }).locator(".goal-star-count");
  await expect(badge).toHaveText("★ 1");
  await chip(page, "tb_20261014T130000Z").click();
  await page.getByTestId("event-panel").getByRole("button", { name: /Delete/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect(page.getByTestId("toast")).toContainText("Deleted series");
  await expect(chip(page, "tb_20261014T130000Z")).toHaveCount(0);
  await expect(chip(page, `${r}_20261016T130000Z`)).toHaveCount(1); // the _R series is its own event: it stays
  await expect(badge, "the split-off series' star stopped counting").toHaveText("★ 1");
});
