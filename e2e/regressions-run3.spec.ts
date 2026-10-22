// Regressions in run 3's diff, found by the 2026-10-19 run 4 review (each
// failed before its fix).
import { expect, test, type Page } from "@playwright/test";
import { packDayWithSleeves } from "../src/lib/layout";
import { parseQuickCreate } from "../src/lib/nlp";

const cal = (id: string, summary: string, color = "#4986e7") => ({ id, summary, color, is_primary: id === "p", hidden: false, access_role: "owner" });
const ev = (id: string, summary: string, start: string, end: string, calendar_id = "p") => ({ id, calendar_id, etag: null, summary, description: null, location: null, start, end, all_day: false, timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {} });
async function open(page: Page, now: string, events: unknown[], calendars: unknown[] = [cal("p", "Personal")], init?: () => void) {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, { calendars, events });
  if (init) await page.addInitScript(init);
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner"); if (await s.count()) await s.locator(".toast-close").click();
}
const stored = (page: Page, id: string) => page.evaluate(async (id) => (await (window as any).__mockBackend.listEvents("2026-01-01T00:00:00Z", "2027-12-31T00:00:00Z")).find((r: any) => r.id === id), id);
const local = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
const clock = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).replace(":00", "");
const chip = (page: Page, t: string) => page.locator(".chip-timed", { hasText: t });
const scrollTo = (page: Page, px: number) => page.getByTestId("week-grid").evaluate((el, px) => { el.scrollTop = px; }, px);
async function dragHandle(page: Page, title: string, grabY: (b: { y: number; height: number }) => number, dy: number) {
  const hb = (await chip(page, title).locator(".chip-resize").boundingBox())!;
  await page.mouse.move(hb.x + 20, grabY(hb)); await page.mouse.down(); await page.mouse.move(hb.x + 20, grabY(hb) + dy, { steps: 4 });
}

test("resize: the drop lands where the ghost shows", async ({ page }) => {
  await open(page, "2026-10-14T07:00:00", [ev("a", "Focus", "2026-10-14T09:00:00-04:00", "2026-10-14T10:00:00-04:00")]);
  await scrollTo(page, 8 * 48);
  await dragHandle(page, "Focus", (b) => b.y + 1, 7); // top of the 6px handle
  const shown = (await page.locator(".chip-ghost .chip-time").first().textContent())!.split("–").pop()!.trim();
  await page.mouse.up(); await page.waitForTimeout(300);
  expect(clock((await stored(page, "a")).end)).toBe(shown); // was: ghost "10 AM", saved "10:15 AM"
});

test("layout: back-to-back after a 15-min event meet edge to edge, no joint", () => {
  for (const px of [48 / 60, 24 / 60]) {
    const p = packDayWithSleeves([{ item: "s", startMin: 540, endMin: 555 }, { item: "r", startMin: 555, endMin: 600 }], px, 17, true);
    const s = p.regular.find((x) => x.item === "s")!, r = p.regular.find((x) => x.item === "r")!;
    expect(r.seamTopPx).toBe(0); expect(s.seamBottomPx).toBe(0); // was: 5 at 48px/h, 11 at 24px/h
    expect(r.top).toBeCloseTo(540 * px + 17, 0);
  }
});

test("quick create: a weekday then a date is that date, not an hour", () => {
  const ref = new Date(2026, 9, 19, 9, 0);
  const a = parseQuickCreate("Concert Saturday 7 November", ref)!;
  expect([a.allDay, a.start.toDateString()]).toEqual([true, new Date(2026, 10, 7).toDateString()]);
  expect(parseQuickCreate("dentist thursday 12 november", ref)!.start.toDateString()).toBe(new Date(2026, 10, 12).toDateString());
  const c = parseQuickCreate("oil change sat 9.30", ref)!;
  expect([c.start.getHours(), c.start.getMinutes(), c.title]).toEqual([9, 30, "oil change"]);
  const d = parseQuickCreate("lunch tue 3 nov 1pm", ref)!;
  expect([d.start.toDateString(), d.start.getHours()]).toEqual([new Date(2026, 10, 3).toDateString(), 13]);
  const e = parseQuickCreate("exam wednesday 4 dec", ref)!;
  expect(e.start.toDateString()).toBe(new Date(2026, 11, 4).toDateString());
  expect(parseQuickCreate("tomorrow 3 hours of hw", ref)!.allDay).toBe(true);
});

for (const [day, off] of [["2026-11-01", "-05:00"], ["2027-03-14", "-04:00"]]) {
  test(`resize on DST day ${day}: 15 min down ends 15 min later`, async ({ page }) => {
    await open(page, `${day}T07:00:00`, [ev("n", "Nap", `${day}T09:00:00${off}`, `${day}T10:00:00${off}`)]);
    await scrollTo(page, 8 * 48);
    await dragHandle(page, "Nap", (b) => b.y + b.height - 2, 12); await page.mouse.up();
    await expect.poll(async () => local((await stored(page, "n")).end)).not.toBe("Sun 10:00 AM");
    expect(local((await stored(page, "n")).end)).toBe("Sun 10:15 AM"); // was: 11:15 / 9:15
  });
}

test("panel: typing an end on a 12h overnight event keeps it overnight", async ({ page }) => {
  await open(page, "2026-10-12T07:00:00", [ev("n", "Night shift", "2026-10-13T19:00:00-04:00", "2026-10-14T07:00:00-04:00")]);
  await chip(page, "Night shift").first().click({ position: { x: 8, y: 8 } });
  const panel = page.getByTestId("event-panel");
  await panel.getByTestId("time-end").fill("07:30");
  await panel.locator(".panel-title").click(); await page.keyboard.press("Enter");
  await expect(panel).toHaveCount(0);
  expect(local((await stored(page, "n")).end)).toBe("Wed 7:30 AM"); // was: "Tue 7:30 PM"
});

test("group drag, weekends hidden: an overnight event's tail dragged 2h down moves +2h", async ({ page }) => {
  await open(page, "2026-10-12T08:00:00", [ev("late", "Late shift", "2026-10-12T23:00:00-04:00", "2026-10-13T01:00:00-04:00"), ev("o", "Other", "2026-10-14T10:00:00-04:00", "2026-10-14T11:00:00-04:00")], undefined, () => localStorage.setItem("hideWeekends", "1"));
  await chip(page, "Other").scrollIntoViewIfNeeded(); await chip(page, "Other").click({ modifiers: ["Shift"] });
  await scrollTo(page, 0);
  const piece = page.getByTestId("day-col-1").locator(".chip-timed", { hasText: "Late shift" });
  await piece.click({ modifiers: ["Shift"], position: { x: 30, y: 10 } });
  const b = (await piece.boundingBox())!;
  await page.mouse.move(b.x + 30, b.y + 10); await page.mouse.down(); await page.mouse.move(b.x + 30, b.y + 106, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => local((await stored(page, "late")).start)).not.toBe("Mon 11:00 PM");
  expect(local((await stored(page, "late")).start)).toBe("Tue 1:00 AM"); // was: Mon 1:00 AM
  expect(local((await stored(page, "o")).start)).toBe("Wed 12:00 PM");  // was: Tue 12:00 PM
});

test("isolate: Show all on the pill keeps the open editor's unsaved title", async ({ page }) => {
  await open(page, "2026-10-14T08:00:00", [ev("w", "Standup", "2026-10-14T10:00:00-04:00", "2026-10-14T11:00:00-04:00", "work")], [cal("p", "Personal"), cal("work", "Work", "#2fbf71")]);
  await page.getByTestId("cal-row").filter({ hasText: "Work" }).click({ button: "right" });
  await page.getByTestId("cal-menu").getByRole("button", { name: "Isolate calendar" }).click();
  await chip(page, "Standup").first().click({ position: { x: 8, y: 8 } });
  const panel = page.getByTestId("event-panel");
  await panel.locator(".panel-title").fill("Standup moved to Zoom");
  await page.getByTestId("isolate-pill").getByRole("button", { name: /Show all/ }).click();
  await page.waitForTimeout(300);
  await expect(panel.locator(".panel-title")).toHaveValue("Standup moved to Zoom"); // was: "Standup"
});

test("cancel then ⌘Z keeps an earlier 'Happened' mark", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("recon-since", String(Date.parse("2026-10-01T12:00:00-04:00")));
    localStorage.setItem("recon", JSON.stringify({ m: { s: "done", at: Date.parse("2026-10-14T12:00:00-04:00") } }));
  });
  await open(page, "2026-10-14T15:00:00", [ev("m", "Team sync", "2026-10-14T10:00:00-04:00", "2026-10-14T11:00:00-04:00")]);
  await chip(page, "Team sync").first().click({ position: { x: 6, y: 6 } });
  const panel = page.getByTestId("event-panel");
  await panel.getByRole("button", { name: "More actions" }).click(); await panel.getByTestId("panel-cancel").click();
  await page.keyboard.press("Escape"); await page.keyboard.press("ControlOrMeta+z");
  await expect(chip(page, "Team sync").first()).not.toHaveClass(/canceled/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("recon") ?? "{}").m?.s ?? null)).toBe("done"); // was: null
});
