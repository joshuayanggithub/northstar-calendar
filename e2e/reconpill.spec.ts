// The floating reconcile pills (App.tsx: the morning sweep banner and the
// R / Review triage pill): one line, however long the event's title.
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

test("recon pill: the event's title stays on one line beside the buttons, cut short if it must", async ({ page }) => {
  await open(page);
  await page.getByTestId("event-chip").first().waitFor();
  await page.keyboard.press("r");
  const pill = page.getByTestId("recon-pill");
  await expect(pill).toBeVisible();
  for (let i = 0; i < 30 && (await pill.count()) > 0; i++) {
    const title = (await pill.locator("b").textContent())!;
    const label = pill.locator("> span").first();
    expect(await label.evaluate(lines), `"${title}" wraps`).toBe(1);
    // every button on the pill's one row, inside the window
    const row = await pill.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const tops = [...el.querySelectorAll("button")].map((b) => Math.round(b.getBoundingClientRect().top));
      return { left: r.left, right: r.right, rows: new Set(tops).size };
    });
    expect(row.rows).toBe(1);
    expect(row.left).toBeGreaterThanOrEqual(0);
    expect(row.right).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.keyboard.press("s");
  }
});

test("recon pill: a long title is cut with an ellipsis, not wrapped", async ({ page }) => {
  await open(page);
  await page.getByTestId("event-chip").first().waitFor();
  await page.keyboard.press("r");
  const pill = page.getByTestId("recon-pill");
  await expect(pill).toBeVisible();
  // the longest title the queue could bring
  await pill.locator("b").evaluate((b) => (b.textContent = "Interview: ferry captain about the winter timetable and the new pier"));
  const label = pill.locator("> span").first();
  expect(await label.evaluate(lines)).toBe(1);
  const cut = await label.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === "ellipsis");
  expect(cut).toBe(true);
});
