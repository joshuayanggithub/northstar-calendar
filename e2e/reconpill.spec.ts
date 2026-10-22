// The review card (App.tsx: R / Review): the title on one line however long,
// the three answers side by side, all inside the window.
import { expect, test, type Page } from "@playwright/test";

const NOW = "2026-10-14T09:00:00";

async function open(page: Page) {
  await page.goto(`/?now=${encodeURIComponent(NOW)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
}

/** how many lines an element's text runs to */
const lines = (el: Element) => {
  const tops = new Set<number>();
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const r = document.createRange();
    r.selectNodeContents(n);
    for (const q of r.getClientRects()) if (q.width > 0) tops.add(Math.round(q.top));
  }
  return tops.size;
};

test("review card: the event's title stays on one line and the three answers on one row", async ({ page }) => {
  await open(page);
  await page.getByTestId("event-chip").first().waitFor();
  await page.keyboard.press("r");
  const pill = page.getByTestId("recon-pill");
  await expect(pill).toBeVisible();
  for (let i = 0; i < 30 && (await pill.count()) > 0; i++) {
    const title = pill.locator(".review-title");
    const text = (await title.textContent())!;
    expect(await title.evaluate(lines), `"${text}" wraps`).toBe(1);
    // the answers side by side, the card inside the window
    const row = await pill.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const tops = [...el.querySelectorAll(".review-answers button")].map((b) => Math.round(b.getBoundingClientRect().top));
      return { left: r.left, right: r.right, bottom: r.bottom, rows: new Set(tops).size };
    });
    expect(row.rows).toBe(1);
    expect(row.left).toBeGreaterThanOrEqual(0);
    expect(row.right).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(row.bottom).toBeLessThanOrEqual(page.viewportSize()!.height);
    await page.keyboard.press("s");
  }
});

test("review card: a long title is cut with an ellipsis, not wrapped", async ({ page }) => {
  await open(page);
  await page.getByTestId("event-chip").first().waitFor();
  await page.keyboard.press("r");
  const pill = page.getByTestId("recon-pill");
  await expect(pill).toBeVisible();
  // the longest title the queue could bring
  const title = pill.locator(".review-title");
  await title.evaluate((b) => (b.textContent = "Interview: ferry captain about the winter timetable and the new pier"));
  expect(await title.evaluate(lines)).toBe(1);
  const cut = await title.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === "ellipsis");
  expect(cut).toBe(true);
  // the day and time stay readable beside it
  expect(await pill.locator(".review-when").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});
