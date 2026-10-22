// Overlapping events start at their start time: found by the 2026-10-19 run 4
// overlap audit (each failed before its fix). Week view, now = Wed 2026-10-14.
import { expect, test, type Page } from "@playwright/test";
import { packDayWithSleeves } from "../src/lib/layout";

const m = (h: number, min = 0) => h * 60 + min;
const at = (r: { top: number }, startMin: number, px: number) => r.top - startMin * px;

const cal = (id: string, color: string) => ({ id, summary: id, color, is_primary: id === "p", hidden: false, access_role: "owner" });
const ev = (id: string, summary: string, start: string, end: string, calendar_id = "p") => ({
  id, calendar_id, etag: null, summary, description: null, location: null,
  start: `${start}:00-04:00`, end: `${end}:00-04:00`, all_day: false, timezone: null, status: "confirmed",
  recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {},
});
/** the realistic Friday afternoon (Fri 2026-10-16) */
const FRIDAY = [
  ev("f1", "Team sync", "2026-10-16T14:00", "2026-10-16T15:20"),
  ev("f2", "1:1 with Priya", "2026-10-16T14:15", "2026-10-16T15:00", "w"),
  ev("f3", "Reading group: scaling laws for neural language models and what they mean for us", "2026-10-16T14:30", "2026-10-16T15:30", "r"),
  ev("f4", "Design review", "2026-10-16T15:00", "2026-10-16T16:00"),
  ev("f5", "Deep work block", "2026-10-16T15:30", "2026-10-16T17:00", "w"),
  ev("f6", "Happy hour", "2026-10-16T16:30", "2026-10-16T17:30", "r"),
];

/** zoom: ⇧⌘. steps (+) or ⇧⌘, steps (-) from 48px/h */
async function open(page: Page, events: unknown[], zoom = 0) {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, {
    calendars: [cal("p", "#4986e7"), cal("w", "#2fbf71"), cal("r", "#d06b64")], events,
  });
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T08:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner"); if (await s.count()) await s.locator(".toast-close").click();
  for (let i = 0; i < Math.abs(zoom); i++) await page.keyboard.press(zoom > 0 ? "ControlOrMeta+Shift+." : "ControlOrMeta+Shift+,");
  await page.waitForTimeout(150);
}
/** a chip's box in its day column's own px (0 = midnight) */
async function box(page: Page, col: number, id: string) {
  const r = await page.getByTestId(`day-col-${col}`).evaluate((c, id) => {
    const el = [...c.querySelectorAll<HTMLElement>(".chip-timed")].find((e) => (e.dataset.ek ?? "").endsWith(`/${id}`))!;
    const cr = c.getBoundingClientRect(), b = el.getBoundingClientRect();
    return { top: b.top - cr.top, bottom: b.bottom - cr.top };
  }, id);
  return r;
}

// ---------------------------------------------------------------------------
// [P2] A C-shape's low title band pushes the event that overlaps it down
// ---------------------------------------------------------------------------
test("layout: a C-shape's low title band never lands below an overlapping event's start", () => {
  // the Friday afternoon at 60px/h (⇧⌘. once): the 1:1 starts 15px into Team
  // sync, inside its 17px title row, so the title band moves below the 1:1
  // (3:00-3:17) although the reading group has been running since 2:30
  const px = 60 / 60;
  const items = [
    { item: "team", startMin: m(14), endMin: m(15, 20) },
    { item: "priya", startMin: m(14, 15), endMin: m(15) },
    { item: "reading", startMin: m(14, 30), endMin: m(15, 30) },
    { item: "design", startMin: m(15), endMin: m(16) },
    { item: "deep", startMin: m(15, 30), endMin: m(17) },
  ];
  const p = packDayWithSleeves(items, px);
  const reading = p.regular.find((r) => r.item === "reading")!;
  const team = p.containers.find((c) => c.item === "team")!;
  // got: 917 (3:17 PM; +47px past 2:30), and design +46, deep work +33
  expect(reading.top, "the 2:30 reading group starts before 3 PM").toBeLessThan(m(15) * px);
  // got: 929 (Team sync 2-3:20 drawn to 3:29)
  expect(team.top + team.height, "Team sync ends by 3:20").toBeLessThanOrEqual(m(15, 20) * px + 1);
});

test("week: Friday afternoon at 60px/h: the 2:30 reading group is not drawn after 3 PM", async ({ page }) => {
  await open(page, FRIDAY, 1); // ⇧⌘. once
  const px = 60 / 60;
  const reading = await box(page, 5, "f3");
  const team = await box(page, 5, "f1");
  // got: reading group top at 3:17 PM (+47px past its 2:30 line), Design
  // review at 3:45 (+45), Deep work at 4:03 (+33); same in Stepped, Angled
  // and Stacked, week and day view
  expect(reading.top, "2:30 reading group starts before 3 PM").toBeLessThan(m(15) * px);
  // got: Team sync (2-3:20) drawn to 3:29, an empty title strip at 3:00-3:17
  expect(team.bottom, "Team sync ends by 3:20").toBeLessThanOrEqual(m(15, 20) * px + 1);
});

// ---------------------------------------------------------------------------
// [P3] The event after a C-shape is pushed to its nested event's end
// ---------------------------------------------------------------------------
test("layout: an event overlapping a C-shape and its nested event starts at its start time", () => {
  const items = [
    { item: "host", startMin: m(18), endMin: m(20) },
    { item: "nested", startMin: m(18, 30), endMin: m(19, 30) },
    { item: "both", startMin: m(19), endMin: m(20, 30) },
  ];
  for (const hp of [48, 60, 72]) {
    const px = hp / 60;
    const both = packDayWithSleeves(items, px).regular.find((r) => r.item === "both")!;
    // got: +12 / +18 / +24px (7 PM drawn at 7:15 at every zoom: the top is
    // put at nested.end - joint step, no title band above it)
    expect(at(both, m(19), px), `at ${hp}px/h`).toBeLessThan(8);
  }
});

test("week: Friday afternoon at 72px/h: the 2:30 and 3 PM events start on their lines", async ({ page }) => {
  await open(page, FRIDAY, 2); // ⇧⌘. twice
  const px = 72 / 60;
  // got: +24px (2:30 drawn at 2:50; 1:1 with Priya's title ends at 2:29, so
  // nothing but the nested 1:1's end forces it)
  expect(at(await box(page, 5, "f3"), m(14, 30), px), "reading group").toBeLessThan(8);
  // got: +24px (3:00 drawn at 3:20, under the displaced reading group's band)
  expect(at(await box(page, 5, "f4"), m(15), px), "design review").toBeLessThan(8);
});

// ---------------------------------------------------------------------------
// [P3] A chain of half-hour starts drifts further down with every link
// ---------------------------------------------------------------------------
test("week: a chain of half-hour classes keeps every start on its line (48px/h)", async ({ page }) => {
  await open(page, [
    ev("m4", "Algorithms", "2026-10-12T13:00", "2026-10-12T14:00"),
    ev("m5", "Databases", "2026-10-12T13:30", "2026-10-12T14:30", "w"),
    ev("m6", "Networks", "2026-10-12T14:00", "2026-10-12T15:00", "r"),
    ev("m7", "Compilers", "2026-10-12T14:30", "2026-10-12T15:30"),
    ev("m8", "ML seminar", "2026-10-12T15:00", "2026-10-12T16:30", "w"),
  ]);
  const px = 48 / 60;
  // got: Networks +5, Compilers +10, ML seminar +15px (3 PM drawn at 3:19,
  // while a 3 PM on any other day sits on the line): 5px more per link
  expect(at(await box(page, 1, "m7"), m(14, 30), px), "Compilers").toBeLessThan(8);
  expect(at(await box(page, 1, "m8"), m(15), px), "ML seminar").toBeLessThan(8);
});

test("layout: a chain of half-hour starts doesn't accumulate drift (36px/h)", () => {
  const px = 36 / 60;
  const items = ["a", "b", "c", "d"].map((x, i) => ({ item: x, startMin: m(13) + 30 * i, endMin: m(14) + 30 * i }));
  items.push({ item: "sem", startMin: m(15), endMin: m(16, 30) });
  const p = packDayWithSleeves(items, px);
  const top = (k: string) => at(p.regular.find((r) => r.item === k)!, items.find((i) => i.item === k)!.startMin, px);
  // got: c +11, d +22, sem +21px (d, the 2:30 class, drawn at 3:07)
  expect(top("c")).toBeLessThan(8);
  expect(top("d")).toBeLessThan(8);
  expect(top("sem")).toBeLessThan(8);
});
