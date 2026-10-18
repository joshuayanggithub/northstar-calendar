// The week scrolls sideways under the sticky day-header and all-day rows,
// and their day strips run wider than the rows' own boxes. An event scrolled
// up under them (a long sleep block from the night before) must never show
// through: every header and all-day cell is backed by the page colour, rule
// included, all the way across.
import { expect, test } from "@playwright/test";

test("day headers and the all-day row cover what scrolls beneath them, every column", async ({ page }) => {
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
  // Friday/Saturday have events running up past the top of the view
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 8 * 48));
  await page.waitForTimeout(300);
  const leaks = await page.evaluate(() => {
    const out: string[] = [];
    const firstOpaque = (x: number, y: number) =>
      document.elementsFromPoint(x, y).find((e) => {
        const bg = getComputedStyle(e).backgroundColor;
        return bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
      }) as HTMLElement | undefined;
    const rowBottom = (document.querySelector(".day-headers") as HTMLElement).getBoundingClientRect().bottom;
    for (const h of document.querySelectorAll<HTMLElement>(".day-head")) {
      const r = h.getBoundingClientRect();
      for (const [what, y] of [["header", r.top + r.height / 2], ["rule", rowBottom - 0.5]] as const) {
        const e = firstOpaque(r.left + r.width - 12, y);
        if (e?.closest(".chip, .cluster-block")) out.push(`${h.textContent?.trim().slice(0, 6)} ${what}: ${e.className}`);
      }
    }
    return out;
  });
  expect(leaks, "an event shows through the sticky header rows").toEqual([]);
});
