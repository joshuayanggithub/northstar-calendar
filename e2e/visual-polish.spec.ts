// Visual review: found by the 2026-10-19 run 4 visual audit (each failed before
// its fix).
import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, w: number, h: number, theme: "light" | "dark") {
  await page.setViewportSize({ width: w, height: h });
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
}
const box = (page: Page, sel: string) =>
  page.locator(sel).first().evaluate((e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; });

for (const theme of ["light", "dark"] as const) {
  // [P2] got: at 800x600 the banner (z 120, centered on the window) overlaps the panel (z 60) by
  // 130x43px over the reminder row; scrolled to the bottom, the panel's Delete button is under it
  // (elementFromPoint at Delete = sweep-banner).
  test(`visual: the morning banner never covers the event panel (${theme}, 800x600)`, async ({ page }) => {
    await open(page, 800, 600, theme);
    await expect(page.getByTestId("sweep-banner")).toBeVisible();
    await page.locator(".chip-timed", { hasText: "Client prep" }).first().click();
    const panel = page.getByTestId("event-panel");
    await expect(panel).toBeVisible();
    await panel.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const del = (await panel.getByRole("button", { name: "Delete" }).boundingBox())!;
    const onTop = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-testid="event-panel"]'), [del.x + del.width / 2, del.y + del.height / 2]);
    expect(onTop, "Delete is under the morning banner").toBe(true);
    // (the banner steps aside while an event is open, and comes back after)
    if (await page.getByTestId("sweep-banner").count()) {
      const p = await box(page, '[data-testid="event-panel"]');
      const s = await box(page, '[data-testid="sweep-banner"]');
      const overlapW = Math.max(0, Math.min(p.r, s.r) - Math.max(p.l, s.l));
      const overlapH = Math.max(0, Math.min(p.b, s.b) - Math.max(p.t, s.t));
      expect(overlapW * overlapH, "banner/panel overlap area (px²)").toBe(0);
    }
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId("sweep-banner")).toBeVisible();
  });
}

for (const [w, h] of [[800, 600], [1440, 900]] as const) {
  // [P3] got: pill "9:00AM" is 48px wide, right:3px in a 46px gutter → left edge 226.97 vs gutter 232;
  // .weekview (overflow:auto) clips its left padding and rounded corners, the 9 touches the edge.
  // "10:00AM"–"12:59PM" are wider still.
  test(`visual: the now pill fits inside the time gutter (${w}x${h})`, async ({ page }) => {
    await open(page, w, h, "light");
    const pill = await box(page, '[data-testid="now-pill"]');
    const gutter = await page.getByTestId("now-pill").evaluate((e) => e.parentElement!.getBoundingClientRect().left);
    expect(pill.l, "now pill left edge vs gutter left edge").toBeGreaterThanOrEqual(gutter - 0.5);
  });
}

// [P3] got: .set-content keeps General's scrollTop; Notifications opens scrolled to its bottom
// (got scrollTop 109, not 0), its "Event alerts" heading above the fold.
test("visual: a settings tab opens at its top (800x600)", async ({ page }) => {
  await open(page, 800, 600, "light");
  await page.keyboard.press("ControlOrMeta+,");
  const content = page.locator(".set-content");
  await content.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.getByTestId("settings").getByRole("tab", { name: "Notifications" }).click();
  await expect.poll(() => content.evaluate((el) => el.scrollTop), { timeout: 1000 }).toBe(0);
});

// [P3] got: .set-close is position:absolute inside the scrolling .set-content, so scrolling
// General scrolls the ✕ out of the window (got top -562 vs the content's top 32).
test("visual: the settings close button stays on screen while the page scrolls (800x600)", async ({ page }) => {
  await open(page, 800, 600, "light");
  await page.keyboard.press("ControlOrMeta+,");
  await page.locator(".set-content").evaluate((el) => (el.scrollTop = el.scrollHeight));
  const c = await box(page, ".set-content");
  const x = await box(page, ".set-close");
  expect(x.t, "close button top vs content top").toBeGreaterThanOrEqual(c.t);
});

for (const theme of ["light", "dark"] as const) {
  // [P3] got: the goals sidebar's "☆ 1" badge is gold #b8962f at opacity .7: 1.86:1 in light, 2.89:1 in dark.
  test(`visual: the goal auto-star badge is readable (${theme})`, async ({ page }) => {
    await open(page, 1440, 900, theme);
    const badge = page.locator(".goal-star-auto").first();
    await expect(badge).toBeVisible();
    const ratio = await badge.evaluate((el) => {
      const parse = (s: string) => {
        const m = s.match(/rgba?\(([^)]+)\)/);
        if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
        const c = s.match(/color\(srgb ([^)]+)\)/);
        if (c) { const p = c[1].split(/[ /]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1]; }
        return [0, 0, 0, 0];
      };
      const mix = (a: number[], b: number[], t: number) => [0, 1, 2].map((i) => a[i] * (1 - t) + b[i] * t);
      const lum = (c: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
      const chain: Element[] = []; for (let a: Element | null = el; a; a = a.parentElement) chain.unshift(a);
      let bg = [255, 255, 255], op = 1;
      for (const c of chain) { const s = getComputedStyle(c); op *= Number(s.opacity); const b = parse(s.backgroundColor); if (b[3] > 0) bg = mix(bg, b, b[3] * op); }
      const fc = parse(getComputedStyle(el).color); const fg = mix(bg, fc, fc[3] * op);
      const x = lum(fg), y = lum(bg); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    });
    expect(ratio, "☆ badge contrast").toBeGreaterThanOrEqual(3);
  });
}
