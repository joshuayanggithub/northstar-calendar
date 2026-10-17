// Pinch on the trackpad zooms how many days are shown (App: the pinch
// effect): spreading the fingers shows fewer days, squeezing shows more, 1
// to 9, in proportion to the pinch, and the day under the fingers stays put.
// Chromium reports a pinch as ctrl+wheel; WebKit (the app's webview) as
// gesturestart/gesturechange with a scale — both are driven here.
import { expect, test, type Page } from "@playwright/test";

async function open(page: Page) {
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`); // Wed; week Sun 11 – Sat 17
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
}

/** the visible day headers, e.g. ["Mon 12", "Tue 13"] */
const shown = (page: Page) =>
  page.locator(".day-head").evaluateAll((els) =>
    els.map((e) => `${e.querySelector(".dow")!.textContent} ${e.querySelector(".dnum")!.textContent}`),
  );

/** the middle of a day column, by its header */
async function at(page: Page, label: string) {
  const h = page.locator(".day-head", { hasText: label.split(" ")[1] }).filter({ hasText: label.split(" ")[0] });
  const b = (await h.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + 300 };
}

/** the day whose column is under x */
const dayAt = (page: Page, x: number) =>
  page.locator(".day-head").evaluateAll((els, x) => {
    const h = els.find((e) => {
      const r = e.getBoundingClientRect();
      return x >= r.left && x < r.right;
    });
    return h ? `${h.querySelector(".dow")!.textContent} ${h.querySelector(".dnum")!.textContent}` : null;
  }, x);

/** a Chromium-style pinch: `n` ctrl+wheel packets of `dy` each */
async function wheelPinch(page: Page, p: { x: number; y: number }, dy: number, n: number) {
  await page.evaluate(
    ({ p, dy, n }) => {
      const el = document.elementFromPoint(p.x, p.y)!;
      for (let i = 0; i < n; i++) {
        el.dispatchEvent(
          new WheelEvent("wheel", { deltaY: dy, ctrlKey: true, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true }),
        );
      }
    },
    { p, dy, n },
  );
}

/** a WebKit-style pinch: gesturestart, gesturechange to `scale`, gestureend */
async function gesturePinch(page: Page, p: { x: number; y: number }, scale: number) {
  await page.evaluate(
    ({ p, scale }) => {
      const el = document.elementFromPoint(p.x, p.y)!;
      const fire = (type: string, sc: number) => {
        const e = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(e, "scale", { value: sc });
        Object.defineProperty(e, "clientX", { value: p.x });
        el.dispatchEvent(e);
        return e.defaultPrevented;
      };
      const prevented = fire("gesturestart", 1);
      fire("gesturechange", scale);
      fire("gestureend", scale);
      (window as unknown as { __pinchPrevented: boolean }).__pinchPrevented = prevented;
    },
    { p, scale },
  );
}

test("pinch (ctrl+wheel): spreading shows fewer days around the one under the fingers, squeezing more", async ({ page }) => {
  await open(page);
  expect(await shown(page)).toHaveLength(7);
  const wed = await at(page, "Wed 14");
  // a little spread: 7 → 4 days, Wednesday still under the fingers
  await wheelPinch(page, wed, -10, 5);
  await expect.poll(() => shown(page)).toHaveLength(4);
  expect(await dayAt(page, wed.x)).toBe("Wed 14");
  // keep spreading in the same pinch: down to the one day under the fingers
  await wheelPinch(page, wed, -10, 15);
  await expect.poll(() => shown(page)).toEqual(["Wed 14"]);

  // squeeze (a new pinch): more days, never past nine
  await page.waitForTimeout(350);
  const one = await at(page, "Wed 14");
  await wheelPinch(page, one, 25, 4); // scale e^-1: 1 day → 3
  await expect.poll(() => shown(page)).toHaveLength(3);
  expect(await shown(page)).toContain("Wed 14");
  await wheelPinch(page, one, 40, 10);
  await expect.poll(() => shown(page)).toHaveLength(9);
});

test("pinch (WebKit gesture events): the scale sets the day count; the page itself never zooms", async ({ page }) => {
  await open(page);
  const thu = await at(page, "Thu 15");
  await gesturePinch(page, thu, 7 / 3); // 7 days → 3
  await expect.poll(() => shown(page)).toHaveLength(3);
  expect(await dayAt(page, thu.x)).toBe("Thu 15");
  expect(await page.evaluate(() => (window as unknown as { __pinchPrevented: boolean }).__pinchPrevented)).toBe(true);
  // a plain (non-pinch) wheel still scrolls/pans and leaves the count alone
  await page.mouse.move(thu.x, thu.y);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(150);
  expect(await shown(page)).toHaveLength(3);
});
