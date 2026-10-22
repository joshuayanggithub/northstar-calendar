// Notes, copies, isolate mode and calendars: found by the 2026-10-21 run 5
// bug-finder (each failed before its fix).
import { expect, test, type Page } from "@playwright/test";

const cal = (id: string, summary: string, color: string, extra: Record<string, unknown> = {}) =>
  ({ id, summary, color, is_primary: id === "p", hidden: false, access_role: "owner", ...extra });
const ev = (id: string, summary: string, start: string, end: string, calendar_id = "p", description: string | null = null) => ({
  id, calendar_id, etag: null, summary, description, location: null,
  start: `${start}:00-04:00`, end: `${end}:00-04:00`,
  all_day: false, timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {},
});
const TWO = [cal("p", "Personal", "#4986e7"), cal("w", "Work", "#16a765")];
async function open(page: Page, events: unknown[], calendars: unknown[] = TWO) {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, { calendars, events });
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T08:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner"); if (await s.count()) await s.locator(".toast-close").click();
  await page.getByTestId("week-grid").evaluate((el) => { el.scrollTop = 8 * 48; });
}
const all = (page: Page) => page.evaluate(async () =>
  (await (window as any).__mockBackend.listEvents("2026-01-01T00:00:00Z", "2027-12-31T00:00:00Z"))
    .map((r: any) => ({ id: r.id, summary: r.summary, calendar_id: r.calendar_id, description: r.description })));
const chip = (page: Page, t: string) => page.locator(".chip-timed", { hasText: t });
const isolate = async (page: Page, name: string) => {
  await page.getByTestId("cal-row").filter({ hasText: name }).click({ button: "right" });
  await page.getByTestId("cal-menu").getByRole("button", { name: "Isolate calendar" }).click();
  await expect(page.getByTestId("isolate-pill")).toHaveCount(1);
};

// [P2] drill.ts:37 `bare` strips anything between < and > from a PLAIN-text note
// (native classify.rs:297 does the same), and setEventNote's "previous" is read through it.
// got: margin note "keep it 10 pages read"; after Delete + ⌘Z the stored description is
// "[DRILL] keep it 10 pages read" — "< 30 min, >" is gone for good (and synced to Google).
test("P2 notes: a plain-text note with < and > reads whole, and Delete + Undo gives it back intact", async ({ page }) => {
  const NOTE = "[DRILL] keep it < 30 min, > 10 pages read";
  await open(page, [ev("a", "Reading", "2026-10-14T10:00", "2026-10-14T11:00", "p", NOTE)]);
  const note = page.getByTestId("margin-note");
  await expect(note).toHaveCount(1);
  await expect.soft(note).toContainText("30 min");
  await note.click();
  await page.keyboard.press("Delete");
  await expect(note).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await all(page))[0].description).not.toBeNull();
  expect((await all(page))[0].description).toBe(NOTE);
});

// [P3] App.tsx:240 leanCopy keeps the [DRILL] line; a cut whose original is back (⌘Z) or a
// second ⌘V of a cut pastes a COPY via leanCopy, unlike ⌘C/⌘D (copyInputOf strips the note).
// got: both events stored with "[DRILL] my reflection"; two margin notes drawn.
test("P3 cut, undo, paste: the pasted copy doesn't carry the original's note", async ({ page }) => {
  await open(page, [ev("a", "Reading", "2026-10-14T10:00", "2026-10-14T11:00", "p", "[DRILL] my reflection")]);
  await chip(page, "Reading").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+x");
  await expect.poll(async () => (await all(page)).length).toBe(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await all(page)).length).toBe(1);
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(async () => (await all(page)).length).toBe(2);
  const noted = (await all(page)).filter((r) => (r.description ?? "").includes("[DRILL]"));
  expect(noted.length).toBe(1);
});

test("P3 cut, paste, paste: the second paste is a copy without the note", async ({ page }) => {
  await open(page, [ev("a", "Reading", "2026-10-14T10:00", "2026-10-14T11:00", "p", "[DRILL] my reflection")]);
  await chip(page, "Reading").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+x");
  await expect.poll(async () => (await all(page)).length).toBe(0);
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(async () => (await all(page)).length).toBe(1);
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(async () => (await all(page)).length).toBe(2);
  // got: 2 (both carry "[DRILL] my reflection")
  expect((await all(page)).filter((r) => (r.description ?? "").includes("[DRILL]")).length).toBe(1);
});

// [P3] App.tsx:1926 moved() carries the star and review mark from the cut id to the pasted
// id, but not the note pin (aliasRestored, App.tsx:131, does carry it).
// got: note-pins still {"a": …}; nothing under the pasted id → the hand-placed note snaps back.
test("P3 ⌘X ⌘V keeps a hand-placed note where it was put", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("note-pins", JSON.stringify({ a: { dxCol: 1, dyMin: -60, w: 120, angle: 0 } }));
    }
  });
  await open(page, [ev("a", "Reading", "2026-10-14T10:00", "2026-10-14T11:00", "p", "[DRILL] my reflection")]);
  await chip(page, "Reading").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+x");
  await expect.poll(async () => (await all(page)).length).toBe(0);
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(async () => (await all(page)).length).toBe(1);
  const id = (await all(page))[0].id;
  await expect.poll(async () => page.evaluate((id) => !!JSON.parse(localStorage.getItem("note-pins") ?? "{}")[id], id)).toBe(true);
  await expect(page.getByTestId("margin-note")).toHaveClass(/pinned/);
});

// [P3] WeekView.tsx:1487 and :2202 colour the drag-create ghost and the draft chip with the
// primary calendar, but the new event goes to the isolated calendar (EventPanel.tsx:396).
// got: draft --cal #6a83ec (Personal blue) while the panel says "Work" (#3fa363) and Save
// files it on Work.
test("P3 isolate: a drag-created draft wears the isolated calendar's color", async ({ page }) => {
  await open(page, [ev("a", "Reading", "2026-10-14T10:00", "2026-10-14T11:00", "w")]);
  await isolate(page, "Work");
  const box = (await page.getByTestId("day-col-4").boundingBox())!;
  const g = (await page.getByTestId("week-grid").boundingBox())!;
  const x = box.x + box.width / 2, y0 = g.y + 200;
  await page.mouse.move(x, y0); await page.mouse.down();
  await page.mouse.move(x, y0 + 90, { steps: 6 }); await page.mouse.up();
  await expect(page.getByTestId("draft-chip")).toHaveCount(1);
  await expect(page.getByTestId("panel-cal-trigger")).toContainText("Work");
  const cssCal = (l: ReturnType<Page["locator"]>) => l.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--cal"));
  expect(await cssCal(page.getByTestId("draft-chip"))).toBe(await cssCal(chip(page, "Reading")));
});

// [P3] ⌘D of a read-only event files the copy on your primary (App.tsx duplicate) but, unlike
// ⌘V (App.tsx:1925), leaves the read-only calendar isolated, so the copy can't be seen.
// got: copy stored on "p"; isolate pill still up; only school/lec drawn. Repeating ⌘D piles up
// invisible duplicates.
test("P3 isolate: ⌘D of a read-only calendar's event shows the copy", async ({ page }) => {
  await open(page, [ev("lec", "Lecture", "2026-10-14T10:00", "2026-10-14T11:00", "school")],
    [cal("p", "Personal", "#4986e7"), cal("school", "School", "#16a765", { access_role: "reader" })]);
  await isolate(page, "School");
  await chip(page, "Lecture").click({ modifiers: ["Shift"] });
  await page.keyboard.press("ControlOrMeta+d");
  await expect.poll(async () => (await all(page)).length).toBe(2);
  const copy = (await all(page)).find((r) => r.calendar_id === "p")!;
  await expect(page.locator(`.chip-timed[data-ek="p/${copy.id}"]`)).toBeVisible();
});
