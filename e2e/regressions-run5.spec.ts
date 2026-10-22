// Regressions in run 5's own changes, found by its midpoint review (each failed
// before its fix).
import { expect, test, type Page } from "@playwright/test";
import { probe } from "./textprobe";

const CAL = { id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" };
const timed = (id: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, calendar_id: "primary", etag: null, summary, description: null, location: null, start, end, all_day: false,
  timezone: "America/New_York", status: "confirmed", recurrence: null, recurring_event_id: null,
  conference_url: null, updated: null, raw: null, ...extra,
});
const at = (h: number, m = 0) => `2026-10-14T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-04:00`;
async function open(page: Page, events: unknown[], init: Record<string, unknown> = {}, stars: Record<string, unknown> | null = null) {
  await page.addInitScript(([fx, st]) => {
    (globalThis as any).__calFixture = fx;
    if (st && !sessionStorage.getItem("rev7-seeded")) {
      localStorage.setItem("goal-stars", JSON.stringify(st));
      sessionStorage.setItem("rev7-seeded", "1");
    }
  }, [{ calendars: [CAL], events, ...init }, stars] as const);
  await page.goto("/?now=2026-10-14T09:00:00");
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner");
  if (await s.count()) await s.locator(".toast-close").click();
}

// [P3] layout.ts: a cluster wrapped by a later-starting slab whose title band
// drops low (lowBand) is exempt from constraint (a) (aboveBand), so it keeps
// its natural top but takes the slab's inset: a 20px empty strip on its left
// from the cluster's start down to the slab's start.
test("layout: a cluster wrapped by a long event that starts after it leaves no blank strip", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1600 });
  // five overlapping 15-minute items 12:00–12:35, a 12:30–4 PM block with a
  // 12:35 meeting inside it
  const events = [0, 5, 10, 15, 20].map((o, i) => timed(`s${i}`, `s${i}`, at(12, o), at(12, o + 15)));
  events.push(timed("blk", "Block", at(12, 30), at(16)), timed("mtg", "Meeting", at(12, 35), at(13, 30)));
  await open(page, events);
  const r = await probe(page);
  // got: ["day-col-3 y=582 x=6", … "y=597 x=6"]: the list drawn from 12:00
  // at inset 20px, the Block it is inset under starting at 12:30
  expect(r.blank, "blank space inside overlapping events").toEqual([]);
});

// [P2] drill.ts: the plain-line pass tests bare(line), which strips the <br>
// too, so a one-line HTML description whose note comes first reads the whole
// line as the note.
test("notes: a note in a <span> followed by more description doesn't swallow the rest", async ({ page }) => {
  const HTML = "<span>[DRILL] check the slides</span><br>Agenda: budget review";
  await open(page, [timed("e1", "Planning", at(13), at(14), { description: HTML })]);
  const drill = await page.evaluate(async (d) => (await import("/src/lib/drill.ts")).splitDrill(d).drill, HTML);
  // got: "check the slidesAgenda: budget review" (body "")
  expect(drill ?? "").not.toContain("Agenda");
  await page.locator(".chip-timed", { hasText: "Planning" }).click({ position: { x: 8, y: 6 } });
  // got: "" — the editor shows no description; Remove note then writes null
  await expect(page.getByTestId("event-panel").locator(".panel-desc")).toHaveValue(/Agenda: budget review/);
});

// [P3] App.tsx bulkRemove / removeOccurrence mark the star deleted, but their
// undo restores a recurring occurrence under the SAME id without unmarking it.
test("stars: ⌘Z of a multi-select delete gives a starred occurrence its goal count back", async ({ page }) => {
  const series = [12, 14, 15, 16, 17].map((d) => {
    const start = `2026-10-${d}T10:00:00-04:00`;
    return timed(`ts_202610${d}T140000Z`, "Thesis block", start, `2026-10-${d}T11:00:00-04:00`, {
      recurring_event_id: "ts", raw: { masterRecurrence: ["RRULE:FREQ=DAILY;UNTIL=20261031T000000Z"], originalStartTime: { dateTime: start } },
    });
  });
  const goals = { goals: [{ id: "g1", text: "Write the thesis", horizon: "long" }], checks: {}, thoughts: [] };
  await open(page, [...series, timed("a2", "Edit chapter", "2026-10-15T13:00:00-04:00", "2026-10-15T14:00:00-04:00")], { goals },
    { ts_20261015T140000Z: { goal: "Write the thesis" } });
  const badge = page.getByTestId("goal-row").filter({ hasText: "Write the thesis" }).locator(".goal-star-count");
  await expect(badge).toHaveText("★ 1");
  await page.locator(".chip-timed", { hasText: "Thesis block" }).nth(2).click({ modifiers: ["Shift"] }); // Oct 15
  await page.locator(".chip-timed", { hasText: "Edit chapter" }).click({ modifiers: ["Shift"] });
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("toast")).toContainText("Deleted 2 events");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".chip-timed", { hasText: "Thesis block" })).toHaveCount(5);
  await expect(page.locator(".chip-timed", { hasText: "Thesis block" }).nth(2)).toHaveClass(/\bstarred\b/);
  // got: no badge at all (★ 0): the restored occurrence's entry keeps deleted:true
  await expect(badge).toHaveText("★ 1");
});
