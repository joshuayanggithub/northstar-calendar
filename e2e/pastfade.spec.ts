// Past events read as past at a glance: every event that has ended is a
// little faded next to the ones still ahead, in every Google Calendar color
// and both themes, but never so far that its calendar's color is lost.
// Measured in OKLab on the computed colors (WeekView.tsx + app.css .past).
import { expect, test, type Page } from "@playwright/test";
import { GCAL_DISPLAY, rgbToOklab } from "../src/lib/color";

const NOW = "2026-10-16T12:00:00"; // a Friday; the week runs Sun 11 – Sat 17
const LEGACY = Object.keys(GCAL_DISPLAY); // the 24 colors the API reports

const at = (day: number, min: number) => {
  const d = new Date(2026, 9, day, 0, 0, 0, 0);
  d.setMinutes(min);
  return d.toISOString();
};
const pad = (i: number) => String(i).padStart(2, "0");

function fixture() {
  const calendars = LEGACY.map((color, i) => ({
    id: `c${i}`,
    summary: `Color ${pad(i)}`,
    color,
    is_primary: i === 0,
    hidden: false,
    access_role: "owner",
  }));
  calendars.push({ id: "sleep", summary: "Sleep", color: "#16a765", is_primary: false, hidden: false, access_role: "owner" });
  const ev = (cal: string, summary: string, start: string, end: string, all_day = false) => ({
    id: `${cal}-${summary.replace(/\W+/g, "-")}`,
    calendar_id: cal,
    etag: null,
    summary,
    description: null,
    location: null,
    start,
    end,
    all_day,
    timezone: null,
    status: "confirmed",
    recurrence: null,
    recurring_event_id: null,
    conference_url: null,
    updated: null,
    raw: {},
  });
  const events = LEGACY.flatMap((_, i) => [
    // Monday: ended four days ago, so already confirmed (past the 48h review window)
    ev(`c${i}`, `Past ${pad(i)}`, at(12, i * 30), at(12, i * 30 + 30)),
    // Saturday: still ahead
    ev(`c${i}`, `Next ${pad(i)}`, at(17, i * 30), at(17, i * 30 + 30)),
  ]);
  // a C-shape (a long block with a short event inside), one ended and one ahead
  for (const day of [12, 17]) {
    events.push(ev("c7", `Long block ${day}`, at(day, 13 * 60), at(day, 16 * 60)));
    events.push(ev("c8", `Inside ${day}`, at(day, 14 * 60), at(day, 14 * 60 + 30)));
  }
  // a burst of quick overlapping tasks, one ended (Monday) and one ahead (Saturday)
  for (const day of [12, 17]) {
    for (const [i, t] of ["Email", "Invoice", "Call landlord"].entries()) {
      events.push(ev("c15", `${t} ${day}`, at(day, 20 * 60 + i * 5), at(day, 20 * 60 + i * 5 + 15)));
    }
  }
  events.push(
    // ended yesterday and not reviewed yet: dotted, and past all the same
    ev("c3", "Ended, not reviewed", at(15, 14 * 60), at(15, 15 * 60)),
    ev("sleep", "Sleep", at(15, 30), at(15, 7 * 60)),
    ev("c5", "Ended all-day", "2026-10-14", "2026-10-15", true),
    ev("c5", "Ahead all-day", "2026-10-17", "2026-10-18", true),
  );
  return { calendars, events };
}

async function open(page: Page) {
  await page.addInitScript((fx) => {
    (globalThis as unknown as { __calFixture: unknown }).__calFixture = fx;
  }, fixture());
  await page.goto(`/?now=${encodeURIComponent(NOW)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await expect(page.locator(".chip-timed", { hasText: "Next 23" })).toHaveCount(1);
  await page.mouse.move(0, 0); // nothing hovered
}

type RGB = [number, number, number];
/** a computed CSS color: rgb(…) or the color(srgb …) that color-mix() yields */
function parse(css: string): RGB {
  const m = css.match(/color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)/);
  if (m) return [+m[1], +m[2], +m[3]];
  const n = css.match(/rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/);
  if (!n) throw new Error(`unparsed color ${css}`);
  return [+n[1] / 255, +n[2] / 255, +n[3] / 255];
}
const lab = (c: RGB) => rgbToOklab(...c);
const dE = (a: RGB, b: RGB) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));
const chroma = (c: RGB) => Math.hypot(lab(c)[1], lab(c)[2]);
const hue = (c: RGB) => (Math.atan2(lab(c)[2], lab(c)[1]) * 180) / Math.PI;
const lum = (c: RGB) => {
  const l = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
};
const contrast = (a: RGB, b: RGB) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const pageBg = async (page: Page) => parse(await page.evaluate(() => getComputedStyle(document.body).backgroundColor));

async function colors(page: Page, title: string, sel = ".chip-timed") {
  const chip = page.locator(sel, { hasText: title }).first();
  const s = await chip.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, fg: cs.color, cls: el.className, outline: cs.outlineStyle };
  });
  return { bg: parse(s.bg), fg: parse(s.fg), cls: s.cls, outline: s.outline };
}

for (const scheme of ["dark", "light"] as const) {
  test.describe(`past events (${scheme})`, () => {
    test.use({ colorScheme: scheme });

    test("faded enough to tell from what's ahead, in every Google color, with the color kept", async ({ page }) => {
      await open(page);
      const page0 = await pageBg(page);
      const gaps: number[] = [];
      for (let i = 0; i < LEGACY.length; i++) {
        const past = await colors(page, `Past ${pad(i)}`);
        const next = await colors(page, `Next ${pad(i)}`);
        const name = `${LEGACY[i]} → ${GCAL_DISPLAY[LEGACY[i]]}`;
        expect(past.cls, name).toContain("past");
        expect(next.cls, name).not.toContain("past");
        // apart: the fill moves visibly toward the page
        const gap = dE(past.bg, next.bg);
        gaps.push(gap);
        expect(gap, `${name}: past and future fills too alike`).toBeGreaterThanOrEqual(0.07);
        expect(dE(past.bg, page0), `${name}: past fill faded into the page`).toBeLessThan(dE(next.bg, page0));
        // but still that calendar's color: a tinted block, same hue, over a third of its chroma
        expect(dE(past.bg, page0), `${name}: past fill vanished`).toBeGreaterThanOrEqual(0.05);
        if (chroma(next.bg) >= 0.04) {
          expect(chroma(past.bg) / chroma(next.bg), `${name}: past fill lost its color`).toBeGreaterThanOrEqual(0.35);
          expect(chroma(past.bg), `${name}: past fill gone gray`).toBeGreaterThanOrEqual(0.015);
          const turn = Math.abs(((hue(past.bg) - hue(next.bg) + 540) % 360) - 180);
          expect(turn, `${name}: past fill changed hue`).toBeLessThanOrEqual(10);
        }
        // the title fades with it and stays readable
        expect(dE(past.fg, page0), `${name}: past title not dimmed`).toBeLessThan(dE(next.fg, page0));
        expect(contrast(past.fg, past.bg), `${name}: past title unreadable`).toBeGreaterThanOrEqual(3);
      }
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      expect(mean, "past and future fills too alike on average").toBeGreaterThanOrEqual(0.12);
    });

    test("every ended event fades: not yet reviewed (still dotted), sleep, all-day, clustered", async ({ page }) => {
      await open(page);
      const unreviewed = await colors(page, "Ended, not reviewed");
      expect(unreviewed.cls).toContain("unsettled");
      expect(unreviewed.cls).toContain("past");
      expect(unreviewed.outline).toBe("dashed");
      // same fade as a confirmed event of that calendar
      expect(dE(unreviewed.bg, (await colors(page, "Past 03")).bg)).toBeLessThan(0.01);
      expect((await colors(page, "Sleep")).cls).toContain("past");
      const ended = await colors(page, "Ended all-day", ".chip-allday");
      const ahead = await colors(page, "Ahead all-day", ".chip-allday");
      expect(ended.cls).toContain("past");
      expect(ahead.cls).not.toContain("past");
      expect(dE(ended.bg, ahead.bg)).toBeGreaterThanOrEqual(0.07);
      // a C-shape's outline (light theme) fades with its fill instead of keeping
      // the calendar's full color around a faded block
      const ring = async (t: string) => {
        const c = page.locator(".chip-timed.chip-cfull", { hasText: t });
        await expect(c).toHaveCount(1);
        const sh = await c.evaluate((el) => getComputedStyle(el).boxShadow);
        const m = sh.match(/\/ ([\d.]+)\)|rgba\([^)]*,\s*([\d.]+)\)/);
        return sh === "none" ? 0 : m ? +(m[1] ?? m[2]) : 1;
      };
      const [ringPast, ringNext] = [await ring("Long block 12"), await ring("Long block 17")];
      if (ringNext > 0) expect(ringPast, "past C-shape keeps its full-color outline").toBeLessThanOrEqual(ringNext * 0.5);
      else expect(ringPast).toBe(0);
      // clustered quick tasks dim like the rest of the past
      const row = async (t: string) => {
        const r = page.locator(".cluster-row", { hasText: t });
        return { cls: (await r.getAttribute("class")) ?? "", fg: parse(await r.evaluate((el) => getComputedStyle(el).color)) };
      };
      const [rowPast, rowNext] = [await row("Invoice 12"), await row("Invoice 17")];
      expect(rowPast.cls).toContain("past");
      expect(rowNext.cls).not.toContain("past");
      const page0 = await pageBg(page);
      expect(dE(rowPast.fg, page0)).toBeLessThan(dE(rowNext.fg, page0));
    });
  });
}
