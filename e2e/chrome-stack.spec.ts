// Stacking and sizing seen in the real window: header gap, note stacking,
// hint wrap, panel vs top bar (found by the 2026-10-19 bug-finder pass).
import { expect, test, type Page } from "@playwright/test";

const P = { id: "p", summary: "Personal", color: "#4986e7", is_primary: true, hidden: false, access_role: "owner" };
const ev = (id: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, calendar_id: "p", etag: null, summary, description: null, location: null, start, end, all_day: false,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {}, ...extra });
const EVENTS = [
  ...[12, 13, 14, 15, 16, 17, 18].map((d) => ev(`e${d}`, "Early block", `2026-10-${d}T00:30:00-04:00`, `2026-10-${d}T02:30:00-04:00`,
    d === 15 ? { description: "[DRILL] start with the hard one" } : {})), // (not today: its red date badge isn't ink)
  ev("mid", "Midday", "2026-10-14T10:00:00-04:00", "2026-10-14T11:00:00-04:00"),
];
async function open(page: Page) {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, { calendars: [P], events: EVENTS });
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner"); if (await s.count()) await s.locator(".toast-close").click();
  await page.keyboard.press("w"); await expect(page.getByTestId("week-grid")).toBeVisible();
}

test("narrow window: the all-day row sits flush under the day headers", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 }); await open(page);
  await page.getByTestId("week-grid").evaluate((g) => { g.scrollTop = 300; }); await page.waitForTimeout(200);
  const r = await page.getByTestId("week-grid").evaluate((g) => {
    const hd = g.querySelector(".day-headers")!.getBoundingClientRect(), ad = g.querySelector(".allday-row")!.getBoundingClientRect();
    const cols = [...g.querySelectorAll("[data-testid^=day-col-]")].map((c) => c.getBoundingClientRect()).filter((c) => c.left >= hd.left && c.right <= hd.right + 1);
    const hits = cols.map((c) => document.elementFromPoint(c.left + c.width / 2, (hd.bottom + ad.top) / 2)?.className?.toString() ?? "");
    return { headersH: hd.height, gap: ad.top - hd.bottom, chipHits: hits.filter((h) => h.includes("chip")).length };
  });
  expect(r.gap, `all-day row starts ${r.gap}px below the ${r.headersH}px day headers`).toBeLessThanOrEqual(0);
  expect(r.chipHits, "timed chips hit-testable between the sticky rows").toBe(0);
});

test("a margin note scrolled above the grid stays under the sticky day headers", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 }); await open(page);
  await expect(page.locator(".margin-note").first()).toBeVisible();
  await page.getByTestId("week-grid").evaluate((g) => {
    const hd = g.querySelector(".day-headers")!.getBoundingClientRect(), n = document.querySelector(".margin-note")!.getBoundingClientRect();
    g.scrollTop += n.top - hd.top + 8; });
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => { const g = document.querySelector("[data-testid=week-grid]")!;
    const hd = g.querySelector(".day-headers")!.getBoundingClientRect(), ad = g.querySelector(".allday-row")!.getBoundingClientRect(), n = document.querySelector(".margin-note")!.getBoundingClientRect();
    return { band: [hd.top, ad.bottom], note: [n.left, n.right], overlaps: n.top < ad.bottom && n.bottom > hd.top }; });
  test.skip(!r.overlaps, "note not in the header band at this geometry");
  const shot = await page.screenshot({ clip: { x: r.note[0], y: r.band[0], width: Math.max(1, r.note[1] - r.note[0]), height: r.band[1] - r.band[0] } });
  const red = await page.evaluate(async (b64) => { const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const ctx = c.getContext("2d")!; ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 120 && d[i + 2] < 120) n++; return n; }, shot.toString("base64"));
  expect(red, "note ink painted over the sticky header band").toBe(0);
});

test("the add-calendar hint fits its column", async ({ page }) => {
  await open(page); await page.getByRole("button", { name: "Add calendar" }).click();
  const r = await page.getByTestId("cal-add-form").locator(".cal-add-hint").evaluate((h) => ({ sw: h.scrollWidth, cw: h.clientWidth }));
  expect(r.sw, "hint text wider than its column").toBeLessThanOrEqual(r.cw);
});

test("the open event panel leaves the top bar's Today / view controls clickable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 }); await open(page);
  const b = (await page.locator(".chip-timed").filter({ hasText: "Midday" }).first().boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + 8); await expect(page.getByTestId("event-panel")).toBeVisible();
  const t = (await page.locator(".topbar button", { hasText: "Today" }).boundingBox())!;
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("button")?.textContent?.trim() ?? document.elementFromPoint(x, y)?.className?.toString(), [t.x + t.width / 2, t.y + t.height / 2]);
  expect(hit, "what a click at the Today button's centre reaches").toBe("Today");
});

test("menu bar: Join Next Meeting says so when there is nothing to join", async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window as any).__menu("join"));
  await expect(page.getByTestId("toast")).toContainText(/No upcoming meeting/);
});
