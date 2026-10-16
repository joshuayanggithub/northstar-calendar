// Margin notes in the UI (components/MarginNotes.tsx): the red-pen notes
// sit in free space with an arrow to their event, and the person can drag
// one to adjust it.
import { expect, test, type Page } from "@playwright/test";

const NOW = "2026-10-14T09:00:00";

async function open(page: Page) {
  await page.goto(`/?now=${encodeURIComponent(NOW)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 19 * 48));
  await expect(page.locator("[data-testid=margin-notes][data-pending='0']")).toHaveCount(1);
}

const tikTok = (page: Page) => page.getByTestId("margin-note").filter({ hasText: "Forty minutes of scrolling" });

/** where the note's arrow ends, relative to its event's box */
async function arrowEnd(page: Page, key: string) {
  return page.evaluate((k) => {
    const g = document.querySelector(`[data-testid=margin-leader][data-ek="${CSS.escape(k)}"] path`) as SVGPathElement | null;
    const chip = document.querySelector(`.chip-timed[data-ek="${CSS.escape(k)}"]`)!.getBoundingClientRect();
    if (!g) return null;
    const p = g.getPointAtLength(g.getTotalLength());
    const svg = g.ownerSVGElement!.getBoundingClientRect();
    return { dx: svg.left + p.x - chip.left, dy: svg.top + p.y - chip.top, w: chip.width, h: chip.height };
  }, key);
}

test("margin notes: drag one to adjust it; the arrow follows, the spot survives a reload, double-click gives it back", async ({ page }) => {
  await open(page);
  const note = tikTok(page);
  await expect(note).toHaveCount(1);
  const key = (await note.getAttribute("data-ek"))!;
  const before = (await note.boundingBox())!;

  // drag it 70px right and 40px down
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 35, before.y + before.height / 2 + 20, { steps: 4 });
  await page.mouse.move(before.x + before.width / 2 + 70, before.y + before.height / 2 + 40, { steps: 4 });
  // mid-drag the arrow is already re-routed to the event
  const mid = await arrowEnd(page, key);
  expect(mid).not.toBeNull();
  await page.mouse.up();

  const after = (await note.boundingBox())!;
  expect(after.x - before.x).toBeCloseTo(70, 0);
  expect(after.y - before.y).toBeCloseTo(40, 0);
  await expect(note).toHaveClass(/pinned/);
  const end = (await arrowEnd(page, key))!;
  expect(end.dx).toBeGreaterThan(-6);
  expect(end.dx).toBeLessThan(end.w + 6);
  expect(end.dy).toBeGreaterThan(-6);
  expect(end.dy).toBeLessThan(end.h + 6);
  const pins = await page.evaluate(() => JSON.parse(localStorage.getItem("note-pins") ?? "{}"));
  expect(Object.keys(pins)).toContain(key);

  // remembered where it was put
  await page.reload();
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 19 * 48));
  await expect(page.locator("[data-testid=margin-notes][data-pending='0']")).toHaveCount(1);
  const reloaded = (await tikTok(page).boundingBox())!;
  expect(Math.abs(reloaded.x - after.x)).toBeLessThan(2);
  expect(Math.abs(reloaded.y - after.y)).toBeLessThan(2);

  // double-click: the placer takes it back
  await tikTok(page).dblclick();
  await expect(tikTok(page)).not.toHaveClass(/pinned/);
  await expect(page.locator("[data-testid=margin-notes][data-pending='0']")).toHaveCount(1);
  const back = (await tikTok(page).boundingBox())!;
  expect(Math.abs(back.x - before.x)).toBeLessThan(2);
  expect(Math.abs(back.y - before.y)).toBeLessThan(2);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("note-pins") ?? "{}"))).toEqual({});
});

test("margin notes: a click (no drag) selects the note's event, and dragging a note never starts an event drag", async ({ page }) => {
  await open(page);
  const note = tikTok(page);
  const key = (await note.getAttribute("data-ek"))!;
  const chip = page.locator(`.chip-timed[data-ek="${key}"]`);
  const chipBefore = (await chip.boundingBox())!;
  await note.click();
  await expect(chip).toHaveClass(/selected/);
  // a drag over the note moves only the note
  const b = (await note.boundingBox())!;
  await page.mouse.move(b.x + 5, b.y + 5);
  await page.mouse.down();
  await page.mouse.move(b.x + 5, b.y + 60, { steps: 5 });
  await page.mouse.up();
  const chipAfter = (await chip.boundingBox())!;
  expect(chipAfter.y).toBeCloseTo(chipBefore.y, 0);
  await expect(page.getByTestId("draft-chip")).toHaveCount(0);
});

test("margin notes: Delete removes the focused annotation, never its event", async ({ page }) => {
  await open(page);
  const note = tikTok(page);
  const key = (await note.getAttribute("data-ek"))!;
  const chip = page.locator(`.chip-timed[data-ek="${key}"]`);

  await note.click();
  await page.keyboard.press("Delete");

  await expect(note).toHaveCount(0);
  await expect(chip).toHaveCount(1);
});

test("margin notes: deleting a note re-renders no events (no flash), and a second Backspace keeps the event", async ({ page }) => {
  await open(page);
  const note = tikTok(page);
  const key = (await note.getAttribute("data-ek"))!;
  await page.evaluate(() => {
    (window as any).__torn = 0;
    new MutationObserver((rs) => {
      for (const r of rs) for (const n of r.removedNodes) {
        if (n.nodeType === 1 && ((n as Element).matches(".chip-timed") || (n as Element).querySelector(".chip-timed"))) (window as any).__torn++;
      }
    }).observe(document.querySelector("[data-testid=week-grid]")!, { childList: true, subtree: true });
  });
  await note.click();
  await page.keyboard.press("Delete");
  await expect(note).toHaveCount(0);
  await page.keyboard.press("Backspace"); // a double press / key repeat
  await page.waitForTimeout(300);
  await expect(page.locator(`.chip-timed[data-ek="${key}"]`)).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__torn)).toBe(0);
});

test("margin notes: a note travels with its event during a swipe, never blinking out", async ({ page }) => {
  await open(page);
  const key = (await tikTok(page).getAttribute("data-ek"))!;
  await page.evaluate((k) => {
    const w = window as any;
    w.__follow = { seen: 0, missing: 0, offsets: new Set<number>() };
    const clip = document.querySelector(".day-clip")!;
    new MutationObserver(() => {
      const chip = document.querySelector(`.chip-timed[data-ek="${CSS.escape(k)}"]`);
      if (!chip) return;
      const c = chip.getBoundingClientRect();
      const v = clip.getBoundingClientRect();
      if (c.left < v.left || c.right > v.right) return;
      w.__follow.seen++;
      const n = document.querySelector(`.margin-note[data-ek="${CSS.escape(k)}"]`);
      if (!n) w.__follow.missing++;
      else w.__follow.offsets.add(Math.round(n.getBoundingClientRect().left - c.left));
    }).observe(document.querySelector("[data-testid=week-grid]")!, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
  }, key);
  const box = (await page.getByTestId("week-grid").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(-14, 0); // backwards: the noted Monday stays on screen
    await page.waitForTimeout(8);
  }
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => {
    const f = (window as any).__follow;
    return { seen: f.seen, missing: f.missing, offsets: [...f.offsets] as number[] };
  });
  expect(r.seen).toBeGreaterThan(10);
  expect(r.missing).toBe(0);
  expect(r.offsets, `note/chip offsets: ${r.offsets.join(", ")}`).toHaveLength(1); // rigidly attached
});

test("margin notes: the note's text is written in full, emphasis underlined, no stage directions", async ({ page }) => {
  await open(page);
  const note = tikTok(page);
  // every line laid out whole (pre-wrapped by the placer, never clipped)
  const clipped = await note.evaluate((n) =>
    [...n.querySelectorAll<HTMLElement>(".mn-line")].some((l) => l.scrollWidth > l.clientWidth + 1 && getComputedStyle(l).overflow !== "visible"),
  );
  expect(clipped).toBe(false);
  await expect(note).not.toContainText("*");
});
