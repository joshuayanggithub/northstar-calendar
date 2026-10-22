// Week-grid gestures and time arithmetic: found by the 2026-10-21 run 5
// bug-finder (each failed before its fix).
import { expect, test, type Page } from "@playwright/test";

const cal = (id: string, summary: string, color: string, extra: Record<string, unknown> = {}) =>
  ({ id, summary, color, is_primary: id === "p", hidden: false, access_role: "owner", ...extra });
const ev = (id: string, summary: string, start: string, end: string, calendar_id = "p") => ({
  id, calendar_id, etag: null, summary, description: null, location: null,
  start: start.length === 10 ? start : `${start}:00-04:00`, end: end.length === 10 ? end : `${end}:00-04:00`,
  all_day: start.length === 10, timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {},
});
async function open(page: Page, now: string, events: unknown[], calendars: unknown[] = [cal("p", "Personal", "#4986e7")], init?: () => void) {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, { calendars, events });
  if (init) await page.addInitScript(init);
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner"); if (await s.count()) await s.locator(".toast-close").click();
}
const stored = (page: Page, id: string) => page.evaluate(async (id) => {
  const r = (await (window as any).__mockBackend.listEvents("2026-01-01T00:00:00Z", "2027-12-31T00:00:00Z")).find((r: any) => r.id === id);
  return r && { start: r.start, end: r.end, all_day: r.all_day };
}, id);
const evo = (id: string, summary: string, start: string, end: string) => ({
  id, calendar_id: "p", etag: null, summary, description: null, location: null, start, end,
  all_day: false, timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {},
});
const local = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
const chip = (page: Page, t: string) => page.locator(".chip-timed", { hasText: t });
const scrollTo = (page: Page, px: number) => page.getByTestId("week-grid").evaluate((el, px) => { el.scrollTop = px; }, px);

for (const [label, now, start, end] of [
  ["fall-back Sun Nov 1", "2026-11-01T08:00:00", "2026-11-01T10:00:00-05:00", "2026-11-01T11:00:00-05:00"],
  ["spring-forward Sun Mar 8", "2026-03-08T08:00:00", "2026-03-08T10:00:00-04:00", "2026-03-08T11:00:00-04:00"],
]) {
  test(`D ${label}: a 10 AM event dragged straight right one column stays at 10 AM`, async ({ page }) => {
    await open(page, now, [evo("d", "Brunch", start, end)]);
    await scrollTo(page, 8 * 48);
    const c = chip(page, "Brunch");
    const b = (await c.boundingBox())!, w = (await page.getByTestId("day-col-0").boundingBox())!.width;
    console.log(label, "chip top in col", b.y - (await page.getByTestId("day-col-0").boundingBox())!.y);
    await page.mouse.move(b.x + b.width / 2, b.y + 10); await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + w, b.y + 10, { steps: 8 });
    console.log(label, "ghost", JSON.stringify(await page.locator(".chip-ghost").allTextContents()));
    await page.mouse.up();
    await expect.poll(async () => (await stored(page, "d")).start).not.toBe(start);
    const s = await stored(page, "d");
    console.log(label, JSON.stringify(s));
    expect(local(s.start)).toBe("Mon 10:00 AM");
  });
}

test("A group drag weekends hidden: overnight Thu event moved one column keeps its 2h", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", [
    ev("late", "Late shift", "2026-10-15T23:00", "2026-10-16T01:00"),
    ev("o", "Other", "2026-10-14T21:00", "2026-10-14T22:00"),
  ], undefined, () => localStorage.setItem("hideWeekends", "1"));
  await scrollTo(page, 18 * 48);
  await chip(page, "Other").click({ modifiers: ["Shift"] });
  const piece = page.getByTestId("day-col-3").locator(".chip-timed", { hasText: "Late shift" });
  await piece.click({ modifiers: ["Shift"], position: { x: 30, y: 10 } });
  const b = (await piece.boundingBox())!, w = (await page.getByTestId("day-col-0").boundingBox())!.width;
  await page.mouse.move(b.x + 30, b.y + 10); await page.mouse.down();
  await page.mouse.move(b.x + 30 + w, b.y + 10, { steps: 8 });
  const ghost = await page.locator(".chip-ghost").allTextContents();
  console.log("ghosts", JSON.stringify(ghost));
  await page.mouse.up();
  await expect.poll(async () => local((await stored(page, "late")).start)).toBe("Fri 11:00 PM");
  const s = await stored(page, "late");
  console.log("late", JSON.stringify(s), JSON.stringify(await stored(page, "o")));
  expect(local(s.end)).toBe("Sat 1:00 AM");
});

test("B zero-length event dragged down an hour stays zero-length", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", [ev("z", "Deadline", "2026-10-14T10:00", "2026-10-14T10:00")]);
  await scrollTo(page, 8 * 48);
  const b = (await chip(page, "Deadline").boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 5); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 5 + 48, { steps: 6 }); await page.mouse.up();
  await expect.poll(async () => local((await stored(page, "z")).start)).toBe("Wed 11:00 AM");
  const s = await stored(page, "z");
  console.log("zero", JSON.stringify(s));
  expect(local(s.end)).toBe("Wed 11:00 AM");
});

test("C all-day chip dropped at the very bottom of the grid lands where its ghost showed", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", [ev("a", "Errand", "2026-10-14", "2026-10-15")]);
  await scrollTo(page, 100000);
  const lane = page.locator(".allday-row .chip, .allday-row [class*=chip]").filter({ hasText: "Errand" }).first();
  const b = (await lane.boundingBox())!;
  const grid = (await page.getByTestId("week-grid").boundingBox())!;
  const col = (await page.getByTestId("day-col-3").boundingBox())!;
  const bottom = col.y + col.height; // the column's bottom = 24:00
  console.log("grid", JSON.stringify(grid), "col", JSON.stringify(col));
  await page.mouse.move(b.x + 10, b.y + 5); await page.mouse.down();
  await page.mouse.move(b.x + 10, bottom - 40, { steps: 6 });
  await page.mouse.move(b.x + 10, Math.min(bottom - 2, grid.y + grid.height - 2), { steps: 3 });
  const ghost = await page.locator(".chip-ghost").allTextContents();
  console.log("ghost", JSON.stringify(ghost));
  await page.mouse.up();
  await expect.poll(async () => (await stored(page, "a")).all_day).toBe(false);
  const s = await stored(page, "a");
  console.log("allday->timed", JSON.stringify(s));
  expect(local(s.start)).toBe("Wed 11:45 PM");
});
