// Undo across operations: found by the 2026-10-21 run 5 bug-finder (each
// failed before its fix).
import { expect, test, type Page } from "@playwright/test";

const PRIMARY = { id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" };
const TEAM = { id: "team", summary: "Team (shared)", color: "#888888", is_primary: false, hidden: false, access_role: "reader" };
const evt = (id: string, cal: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, calendar_id: cal, etag: null, summary, description: null, location: null, start, end, all_day: false,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {}, ...extra,
});
async function open(page: Page, fx: unknown, stars: Record<string, unknown> | null = null, now = "2026-10-14T09:00:00") {
  await page.addInitScript(([f, st]) => {
    (globalThis as any).__calFixture = f;
    if (st && !sessionStorage.getItem("w8a-seeded")) {
      localStorage.setItem("goal-stars", JSON.stringify(st));
      sessionStorage.setItem("w8a-seeded", "1");
    }
  }, [fx, stars] as const);
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
}
const rows = (page: Page) => page.evaluate(async () =>
  await (window as any).__mockBackend.listEvents("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z"));
const chip = (page: Page, t: string) => page.locator(".chip-timed", { hasText: t }).first();
const ms = (s: string) => new Date(s).getTime();

// [P2] HEAD: both m1 rows end on "team" in the mock ([["team",10:00],["team",10:00]]): your Standup vanished from Personal.
// Native: the undo patches the read-only calendar's row (Google 403, reverted) and your event stays at 12:00.
test("[P2] group-move undo restores your event, not a same-id read-only copy", async ({ page }) => {
  await open(page, { calendars: [PRIMARY, TEAM], events: [
    evt("m1", "primary", "Standup", "2026-10-14T10:00:00-04:00", "2026-10-14T11:00:00-04:00"),
    // a colleague's calendar you can read holds your meeting under the same id
    evt("m1", "team", "Standup", "2026-10-14T10:00:00-04:00", "2026-10-14T11:00:00-04:00"),
    evt("b", "primary", "Bravo", "2026-10-14T13:00:00-04:00", "2026-10-14T14:00:00-04:00"),
  ] });
  const mine = page.locator('.chip-timed[data-ek="primary/m1"]');
  await mine.click({ modifiers: ["Shift"] });
  await chip(page, "Bravo").click({ modifiers: ["Shift"] });
  const b = (await mine.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 10);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 10 + 96, { steps: 10 }); // +2h
  await page.mouse.up();
  await expect.poll(async () => ms((await rows(page)).find((r: any) => r.id === "m1" && r.calendar_id === "primary")?.start))
    .toBe(ms("2026-10-14T12:00:00-04:00"));
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("toast")).toContainText("Undid");
  await page.waitForTimeout(300);
  const r = await rows(page);
  console.log("w8a-T1", JSON.stringify(r.filter((x: any) => x.id === "m1").map((x: any) => [x.calendar_id, x.start])));
  const back = r.find((x: any) => x.id === "m1" && x.calendar_id === "primary");
  expect(back && ms(back.start)).toBe(ms("2026-10-14T10:00:00-04:00"));
});

// [P3] HEAD: recon = {"mock-59":{"s":"done",...}} — the restored event keeps "happened" after ⌘Z of the mark.
test("[P3] ⌘Z of a review mark reaches the event re-created by an undone delete", async ({ page }) => {
  await open(page, { calendars: [PRIMARY], events: [evt("gym", "primary", "Gym", "2026-10-13T17:00:00-04:00", "2026-10-13T18:00:00-04:00")] });
  await chip(page, "Gym").click({ position: { x: 6, y: 6 } });
  await page.getByTestId("panel-recon-yes").click();
  await expect(page.getByTestId("panel-recon-yes")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await chip(page, "Gym").click({ position: { x: 6, y: 6 } });
  await page.locator("body").press("Delete");
  await expect(page.getByTestId("toast")).toContainText("Deleted");
  await page.keyboard.press("ControlOrMeta+z"); // the delete
  await expect(chip(page, "Gym")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+z"); // the "Marked as happened"
  await expect(page.getByTestId("toast")).toContainText("Undid: Marked as happened");
  const r = await rows(page);
  const id = r.find((x: any) => x.summary === "Gym").id;
  const recon = await page.evaluate(() => JSON.parse(localStorage.getItem("recon") ?? "{}"));
  console.log("w8a-T2", id, JSON.stringify(recon));
  expect(recon[id]?.s).toBeUndefined();
});

// [P3] HEAD: badge "★ 1" while the event is gone after the first ⌘Z, "★ 2" after the second (goal-stars has a1 deleted, mock-59 and mock-60 live).
test("[P3] undoing a pasted cut and the cut leaves one star counted", async ({ page }) => {
  const goals = { goals: [{ id: "g1", text: "Write the thesis", horizon: "long" }], checks: {}, thoughts: [] };
  await open(page, { calendars: [PRIMARY], events: [evt("a1", "primary", "Thesis", "2026-10-14T10:00:00-04:00", "2026-10-14T11:00:00-04:00")], goals },
    { a1: { goal: "Write the thesis" } });
  const badge = page.getByTestId("goal-row").filter({ hasText: "Write the thesis" }).locator(".goal-star-count");
  await expect(badge).toHaveText("★ 1");
  await chip(page, "Thesis").click({ modifiers: ["Shift"] });
  await page.keyboard.press("ControlOrMeta+x");
  await expect(page.locator(".chip-timed", { hasText: "Thesis" })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+v");
  await expect(page.locator(".chip-timed", { hasText: "Thesis" })).toHaveCount(1);
  await expect(badge).toHaveText("★ 1");
  await page.keyboard.press("ControlOrMeta+z"); // the paste
  await expect(page.locator(".chip-timed", { hasText: "Thesis" })).toHaveCount(0);
  const mid = await badge.count() ? await badge.textContent() : "(none)";
  await page.keyboard.press("ControlOrMeta+z"); // the cut
  await expect(page.locator(".chip-timed", { hasText: "Thesis" })).toHaveCount(1);
  console.log("w8a-T3 mid", mid, "end", await badge.textContent(), await page.evaluate(() => localStorage.getItem("goal-stars")));
  await expect(badge).toHaveText("★ 1");
});

const OWNP = { id: "p", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" };
const SCHOOL = { id: "school", summary: "School", color: "#888", is_primary: false, hidden: false, access_role: "reader" };
// [P3] HEAD: the read-only original (school/lec) is shown beside the restored copy (count 1, want 0).
test("[P3] undoing the delete of a moved copy keeps its original stepped aside", async ({ page }) => {
  const S = "2026-10-14T10:00:00-04:00", E = "2026-10-14T11:00:00-04:00";
  const link = { "school/lec": { calendar_id: "p", id: "mine", sig: `${new Date(S).getTime()}|${new Date(E).getTime()}|Lecture` } };
  await page.addInitScript(([f, l]) => {
    (globalThis as any).__calFixture = f;
    if (!sessionStorage.getItem("w8a")) { localStorage.setItem("event-copies", JSON.stringify(l)); sessionStorage.setItem("w8a", "1"); }
  }, [{ calendars: [OWNP, SCHOOL], events: [
    evt("lec", "school", "Lecture", S, E),
    // your copy, moved an hour later after copying
    evt("mine", "p", "Lecture", "2026-10-14T11:00:00-04:00", "2026-10-14T12:00:00-04:00"),
  ] }, link] as const);
  await page.goto(`/?now=2026-10-14T09:00:00`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner"); if (await sweep.count()) await sweep.locator(".toast-close").click();
  const orig = page.locator('.chip-timed[data-ek="school/lec"]');
  await expect(page.locator('.chip-timed[data-ek="p/mine"]')).toBeVisible();
  await expect(orig).toHaveCount(0); // the copy stands for it
  await page.locator('.chip-timed[data-ek="p/mine"]').click({ position: { x: 6, y: 6 } });
  await page.locator("body").press("Delete");
  await expect(orig).toHaveCount(1); // copy gone: the original is back (by design)
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator('.chip-timed[data-ek^="p/"]', { hasText: "Lecture" })).toHaveCount(1);
  await page.waitForTimeout(300);
  // got: 1 — the original sits beside the restored copy
  await expect(orig).toHaveCount(0);
});
