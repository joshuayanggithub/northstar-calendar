// Visual review captures: 2x crops of every day column for the overlap
// scenario weeks (and the real week when its local fixture exists), so text
// placement inside joints and C-shapes can be inspected by eye. Opt-in:
//   CAPTURE=1 npm run test:e2e -- e2e/capture.spec.ts --project=chromium
// PNGs land in test-results/captures/ (or $CAPTURE_DIR).
import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { canonicalWeek, randomWeek, type ScEvent } from "./scenarios";

test.skip(!process.env.CAPTURE, "visual captures are opt-in (CAPTURE=1)");
test.use({ deviceScaleFactor: 2 });
const OUT = process.env.CAPTURE_DIR ?? "test-results/captures";

const CALS = [
  { id: "c-blue", summary: "Personal", color: "#4285f4", is_primary: true, hidden: false, access_role: "owner" },
  { id: "c-green", summary: "Work", color: "#0b8043", is_primary: false, hidden: false, access_role: "owner" },
  { id: "c-brown", summary: "Distractions", color: "#795548", is_primary: false, hidden: false, access_role: "owner" },
  { id: "c-gray", summary: "Deep Focus", color: "#616161", is_primary: false, hidden: false, access_role: "owner" },
  { id: "c-red", summary: "Learning", color: "#d50000", is_primary: false, hidden: false, access_role: "owner" },
];

async function load(page: Page, events: ScEvent[], width: number, keys: string[] = []) {
  const evs = events.map((e, i) => ({
    id: `fx-${i}`, calendar_id: e.cal, etag: null, summary: e.title,
    description: e.drill ? `[DRILL] ${e.drill}` : null, location: e.location ?? null,
    start: e.start.toISOString(), end: e.end.toISOString(), all_day: false, timezone: null,
    status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: null,
  }));
  await page.addInitScript((fx) => {
    (globalThis as unknown as { __calFixture: unknown }).__calFixture = fx;
  }, { calendars: CALS, events: evs });
  await page.setViewportSize({ width, height: 1400 });
  await page.goto("/?now=" + encodeURIComponent("2026-10-11T06:00:00"));
  await expect(page.locator(".mock-badge")).toBeVisible();
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
  for (const k of keys) await page.keyboard.press(k);
  await page.waitForTimeout(150);
}

/** one PNG per day column per scroll window, at 2x */
async function columns(page: Page, name: string) {
  mkdirSync(OUT, { recursive: true });
  const grid = page.locator("[data-testid=week-grid]");
  const { sh, ch } = await grid.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  const step = ch - 120;
  for (let st = 0, k = 0; ; st += step, k++) {
    await grid.evaluate((el, s) => (el.scrollTop = s), st);
    await page.waitForTimeout(80);
    const gb = (await grid.boundingBox())!;
    const head = (await page.locator(".allday-row").boundingBox())!;
    const n = await page.locator("[data-testid^=day-col-]").count();
    for (let d = 0; d < n; d++) {
      const cb = (await page.getByTestId(`day-col-${d}`).boundingBox())!;
      const top = head.y + head.height;
      await page.screenshot({
        path: `${OUT}/${name}-d${d}-${k}.png`,
        clip: { x: cb.x - 4, y: top, width: cb.width + 8, height: gb.y + gb.height - top },
      });
    }
    if (st + ch >= sh) break;
  }
}

const RUNS: [string, number, () => ScEvent[], string[]][] = [
  ["cw", 1280, () => canonicalWeek(7), []],
  ["cn", 900, () => canonicalWeek(7), []],
  ["cz", 1280, () => canonicalWeek(7), ["ControlOrMeta+Shift+,", "ControlOrMeta+Shift+,"]],
  ["r11", 1280, () => randomWeek(11), []],
  ["scarf", 1280, () => canonicalWeek(7), []],
  ["overlay", 1280, () => canonicalWeek(7), []],
];
for (const [name, width, gen, keys] of RUNS) {
  test(`shots ${name}`, async ({ page }) => {
    if (name === "scarf" || name === "overlay") {
      await page.addInitScript((seam) => localStorage.setItem("overlapSeam", seam), name);
    }
    await load(page, gen(), width, keys);
    await columns(page, name);
  });
}

// goal work: manual ★ on a container, a joint half, a cluster row and a
// nested chip; ☆ suggestions on others; both themes
for (const scheme of ["dark", "light"] as const) {
  test(`shots goals-${scheme}`, async ({ page }) => {
    const evs = canonicalWeek(7);
    const idOf = (t: string) => `fx-${evs.findIndex((e) => e.title === t)}`;
    const calOf = (t: string) => evs.find((e) => e.title === t)!.cal;
    const key = (t: string) => `${calOf(t)}/${idOf(t)}`;
    const manual = ["Study block", "J 45-minute B", "cluster b", "second child", "Slab B (partial over A)", "Hour"];
    const auto = ["J long A", "Parent with jointed kids", "jointed kid 2", "Depth 1", "Twin B"];
    await page.addInitScript((m) => localStorage.setItem("goal-stars", JSON.stringify(m)), Object.fromEntries(manual.map((t) => [key(t), { goal: "Finish the novel manuscript" }])));
    await page.emulateMedia({ colorScheme: scheme });
    await load(page, evs, 1280);
    await page.evaluate(async (a) => {
      const s = await import("/src/lib/stars.ts");
      s.setAutoGoals(a);
    }, Object.fromEntries(auto.map((t) => [key(t), "Ship one research artifact"])));
    await page.waitForTimeout(150);
    await columns(page, `goals-${scheme}`);
    await page.screenshot({ path: `${OUT}/goals-${scheme}-full.png` });
  });
}

for (const [name, width] of [["real", 1280], ["realn", 900]] as const) {
  test(`shots ${name}`, async ({ page }) => {
    test.skip(!existsSync("e2e/fixtures/realweek.local.json"), "no real-data fixture on this machine");
    const rows = JSON.parse(readFileSync("e2e/fixtures/realweek.local.json", "utf8"));
    const cals = JSON.parse(readFileSync("e2e/fixtures/realcals.local.json", "utf8"));
    await page.addInitScript((fx) => ((globalThis as unknown as { __calFixture: unknown }).__calFixture = fx), {
      calendars: cals.map((c: Record<string, unknown>) => ({ ...c, is_primary: !!c.is_primary, hidden: !!c.hidden })),
      events: rows.map((r: Record<string, unknown>) => ({
        id: r.id, calendar_id: r.calendar_id, etag: null, summary: r.summary, description: r.description ?? null,
        location: r.location ?? null, start: r.start, end: r.end, all_day: !!r.all_day, timezone: null, status: "confirmed",
        recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: null,
      })),
    });
    await page.setViewportSize({ width, height: 1400 });
    await page.goto("/?now=" + encodeURIComponent("2026-10-15T01:30:00"));
    await expect(page.locator(".mock-badge")).toBeVisible();
    const sweep = page.getByTestId("sweep-banner");
    if (await sweep.count()) await sweep.locator(".toast-close").click();
    await page.waitForTimeout(150);
    await columns(page, name);
  });
}
