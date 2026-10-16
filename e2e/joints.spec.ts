// Rabbet joints (lib/layout.ts packDayWithSleeves + jointPathD, drawn in
// WeekView): two events that partly overlap meet in a rounded step. Two
// rules keep a busy stretch readable:
//  - a C-shape steps at its spine, so the event after it tucks in under its
//    nested events edge to edge (not halfway across, which left a sliver of
//    the C beside the joint and a hook under the nested event);
//  - a jointed shape carries the same 1px page-color seam a plain chip has
//    (its clip-path cuts the chip's box-shadow ring off), so two events of
//    one calendar never fuse into one blob.
import { expect, test, type Page } from "@playwright/test";
import { packDayWithSleeves, SLEEVE_LANE_WIDTH, jointPathD } from "../src/lib/layout";

const PX = 48 / 60; // px per minute at the default zoom
const m = (h: number, min = 0) => h * 60 + min;

test("layout: a C-shape's joint steps at its spine; two plain chips meet halfway", () => {
  const building = { item: "building", startMin: m(11, 30), endMin: m(13, 15) };
  const shower = { item: "shower", startMin: m(12, 45), endMin: m(13) };
  const lunch = { item: "lunch", startMin: m(13), endMin: m(13, 30) };
  const p = packDayWithSleeves([building, shower, lunch], PX);
  const slab = p.containers.find((c) => c.item === "building")!;
  const low = p.regular.find((r) => r.item === "lunch")!;
  expect(slab.seamBottomPx, "the C-shape and lunch form a joint").toBeGreaterThan(0);
  expect(low.seamTopPx).toBe(slab.seamBottomPx);
  expect(slab.seamBottomStepPx).toBe(SLEEVE_LANE_WIDTH);
  expect(low.seamTopStepPx).toBe(SLEEVE_LANE_WIDTH);
  // the nested event sits right of the spine: the lunch tab lines up with it
  expect(p.regular.find((r) => r.item === "shower")!.insetPx).toBe(SLEEVE_LANE_WIDTH);

  const a = { item: "a", startMin: m(9), endMin: m(10) };
  const b = { item: "b", startMin: m(9, 40), endMin: m(10, 40) };
  const q = packDayWithSleeves([a, b], PX);
  const qa = q.regular.find((r) => r.item === "a")!;
  const qb = q.regular.find((r) => r.item === "b")!;
  expect(qb.seamTopPx).toBeGreaterThan(0);
  expect(qa.seamBottomStepPx).toBeNull();
  expect(qb.seamTopStepPx).toBeNull();
});

test("layout: both halves of a joint step at the same x, wherever the step is", () => {
  const w = 200;
  const notchX = (d: string) => [...d.matchAll(/Q(-?[\d.]+) (-?[\d.]+)/g)].map((x) => +x[1]);
  for (const step of [null, SLEEVE_LANE_WIDTH]) {
    const upper = jointPathD(w, 80, 0, 12, "rabbet", 4, null, step);
    const lower = jointPathD(w, 40, 12, 0, "rabbet", 4, step, null);
    const x = step ?? w / 2;
    expect(notchX(upper), `upper steps at ${x}`).toContain(x);
    expect(notchX(lower), `lower steps at ${x}`).toContain(x);
  }
});

// the cluster from the author's calendar: a long block with a short event
// in it and lunch running into its last quarter hour, all one calendar
async function openCluster(page: Page) {
  const cal = { id: "life", summary: "Life", color: "#c2c2c2", is_primary: true, hidden: false, access_role: "owner" };
  const at = (h: number, min: number) => new Date(2026, 9, 17, h, min).toISOString();
  let n = 0;
  const ev = (summary: string, s: [number, number], e: [number, number]) => ({
    id: `j${++n}`, calendar_id: "life", etag: null, summary, description: null, location: null,
    start: at(...s), end: at(...e), all_day: false, timezone: null, status: "confirmed",
    recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {},
  });
  const fixture = {
    calendars: [cal],
    events: [ev("Building calendar app", [11, 30], [13, 15]), ev("cold shower", [12, 45], [13, 0]), ev("LUNCH", [13, 0], [13, 30])],
  };
  await page.addInitScript((fx) => {
    (globalThis as unknown as { __calFixture: unknown }).__calFixture = fx;
  }, fixture);
  await page.goto(`/?now=${encodeURIComponent("2026-10-16T14:34:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await page.keyboard.press("3");
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 11 * 48));
}

test("joints: lunch tucks in under the nested event, edge to edge, with a seam", async ({ page }) => {
  await openCluster(page);
  const slab = page.locator(".chip-cfull", { hasText: "Building calendar app" });
  const shower = page.locator(".chip-timed", { hasText: "cold shower" });
  const lunch = page.locator(".chip-timed", { hasText: "LUNCH" });
  await expect(lunch).toHaveCount(1);
  // both jointed shapes carry the page-color seam (their clip cuts the ring)
  for (const s of [slab, lunch]) {
    const seam = s.getByTestId("joint-seam").locator("path");
    await expect(seam).toHaveCount(1);
    const stroke = await seam.evaluate((p) => getComputedStyle(p).stroke);
    const page0 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(stroke).toBe(page0);
  }
  // lunch's raised tab starts where the nested event starts (its left edge),
  // read off lunch's own outline
  const sb = (await shower.boundingBox())!;
  const lb = (await lunch.boundingBox())!;
  const tabX = await lunch.evaluate((el) => {
    const d = (el.querySelector("[data-testid=joint-seam] path") as SVGPathElement).getAttribute("d")!;
    const first = /M(-?[\d.]+) (-?[\d.]+)/.exec(d)!;
    return +first[1];
  });
  // the outline starts on the tab's left edge (just below its rounded corner)
  expect(Math.abs(lb.x + tabX - sb.x)).toBeLessThanOrEqual(1.5);
});
