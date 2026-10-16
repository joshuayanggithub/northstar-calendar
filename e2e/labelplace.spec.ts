// Geometry tests for lib/labelPlace.ts (pure functions, no page): visible
// regions of overlapped shapes, and where title / time land inside them.
import { expect, test } from "@playwright/test";
import {
  planText,
  runs,
  shapeRects,
  visibleRegions,
  type PlacedText,
  type Rect,
  type ShapeBox,
  type TextSpec,
} from "../src/lib/labelPlace";

const box = (key: string, o: Partial<ShapeBox<string>>): ShapeBox<string> => ({
  key,
  z: 1,
  left: 0,
  width: 138,
  clipWidth: 138,
  top: 0,
  height: 48,
  seamTop: 0,
  seamBottom: 0,
  ring: 0,
  ...o,
});

const spec = (title: string, h: number, m: number, endH: number, endM: number, o: Partial<TextSpec> = {}): TextSpec => ({
  title,
  start: new Date(2026, 9, 12, h, m),
  end: new Date(2026, 9, 12, endH, endM),
  padL: 6,
  ...o,
});

const inside = (R: Rect[], x0: number, x1: number, y0: number, y1: number) =>
  runs(R, y0, y1).some((r) => r.a <= x0 + 0.01 && r.b >= x1 - 0.01);

/** every placed piece lies inside the visible region (lh: the title's line
 *  height, 11 for a compact xs box) */
function allInside(R: Rect[], p: PlacedText, lh = 15): string[] {
  const bad: string[] = [];
  const { title, time, loc } = p;
  if (!inside(R, title.x, title.x + title.w, title.y, title.y + title.lines * lh - 1)) bad.push("title");
  if (time?.mode === "row" && !inside(R, time.x, time.x + time.w, time.y, time.y + 11)) bad.push("time");
  if (time?.mode === "vertical" && !inside(R, time.x, time.x + 12, time.y, time.y + time.w)) bad.push("time-v");
  if (loc && !inside(R, loc.x, loc.x + loc.w, loc.y, loc.y + 13)) bad.push("loc");
  return bad;
}

test("shape: a rabbet joint keeps a right-half step on top and a left-half tail below", () => {
  const rs = shapeRects(box("a", { top: 100, height: 60, seamTop: 12, seamBottom: 12 }), "rabbet");
  expect(rs).toEqual([
    { x0: 69, x1: 138, y0: 100, y1: 112 },
    { x0: 0, x1: 138, y0: 112, y1: 148 },
    { x0: 0, x1: 69, y0: 148, y1: 160 },
  ]);
  expect(shapeRects(box("a", { seamTop: 12 }), "overlay")).toEqual([{ x0: 0, x1: 138, y0: 0, y1: 48 }]);
});

test("visible region: a box painted above (and its 1px ring) is cut out", () => {
  const slab = box("slab", { z: 1, height: 96 });
  const kid = box("kid", { z: 2, left: 20, width: 118, top: 17, height: 24, ring: 1 });
  const vis = visibleRegions([slab, kid], "rabbet").get("slab")!;
  // band above the kid, spine beside it, open area below it
  expect(runs(vis, 0, 15)).toEqual([{ a: 0, b: 138 }]);
  expect(runs(vis, 20, 38)).toEqual([{ a: 0, b: 19 }]);
  expect(runs(vis, 43, 96)).toEqual([{ a: 0, b: 138 }]);
  // the kid itself is unaffected by the slab under it
  expect(visibleRegions([slab, kid], "rabbet").get("kid")).toEqual([{ x0: 0, x1: 118, y0: 0, y1: 24 }]);
});

test("placement: a tall plain box stacks the time under the title (Notion)", () => {
  const p = planText([{ x0: 0, x1: 138, y0: 0, y1: 48 }], spec("Morning run", 7, 0, 8, 0));
  expect(p.rule).toBe("stack");
  expect(p.time).toMatchObject({ mode: "row", x: 6, y: 17 });
});

test("placement: the lower half of a narrow joint keeps one aligned block, never text off to the side", () => {
  // 80px column: the step is the right half of the top 12px
  const b = box("b", { width: 78, clipWidth: 78, height: 44, seamTop: 12 });
  const R = visibleRegions([b], "rabbet").get("b")!;
  const p = planText(R, spec("J half-hour B", 9, 0, 10, 0));
  expect(p.title.x).toBe(6); // the box's own left padding, below the step
  expect(p.title.y).toBeGreaterThanOrEqual(12);
  expect(p.time).not.toBeNull();
  expect(p.time!.x).toBe(p.title.x);
  expect(p.time!.y).toBeGreaterThanOrEqual(p.title.y);
  expect(allInside(R, p)).toEqual([]);
});

test("placement: a wrapped title carries its time after the last word when that fits", () => {
  const R = [{ x0: 0, x1: 86, y0: 0, y1: 34 }];
  const p = planText(R, spec("Back-to-back host", 14, 0, 16, 0));
  expect(p.rule).toBe("trailing");
  expect(p.title.lines).toBe(2);
  expect(p.titleWhole).toBe(true);
  expect(allInside(R, p)).toEqual([]);
});

test("placement: a C-shape turns its time sideways into the spine beside what it encloses", () => {
  const slab = box("slab", { z: 1, height: 96 });
  const kid = box("kid", { z: 2, left: 20, width: 118, top: 17, height: 60, ring: 1 });
  const R = visibleRegions([slab, kid], "rabbet").get("slab")!;
  const p = planText(R, spec("Container with a deliberately long title", 13, 0, 15, 0));
  expect(p.rule).toBe("spine");
  expect(p.time).toMatchObject({ mode: "vertical" });
  expect(p.time!.x + 12).toBeLessThanOrEqual(19);
  expect(allInside(R, p)).toEqual([]);
});

test("placement: a box too narrow for both keeps its title and drops the time", () => {
  const R = [{ x0: 0, x1: 40, y0: 0, y1: 17 }];
  const p = planText(R, spec("Deep work", 9, 0, 9, 20));
  expect(p.rule).toBe("none");
  expect(p.time).toBeNull();
  expect(p.title.w).toBeGreaterThan(20);
});

test("placement property: over random overlapped columns, every piece of text stays inside its visible shape", () => {
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const titles = ["Read", "Deep work block", "admin / reading", "x", "Distraction: TikTok and YouTube"];
  let checked = 0;
  for (let col = 0; col < 300; col++) {
    const W = 60 + Math.floor(rand() * 280);
    const boxes: ShapeBox<string>[] = [];
    const n = 2 + Math.floor(rand() * 6);
    for (let i = 0; i < n; i++) {
      const inset = Math.floor(rand() * 3) * 20;
      const height = 13 + Math.floor(rand() * 150);
      boxes.push(
        box(`b${i}`, {
          z: i + 1,
          left: inset,
          width: W - inset - 2,
          clipWidth: W - inset - 1,
          top: Math.floor(rand() * 200),
          height,
          seamTop: rand() < 0.3 ? Math.min(12, height / 3) : 0,
          seamBottom: rand() < 0.3 ? Math.min(12, height / 3) : 0,
          ring: rand() < 0.5 ? 1 : 0,
        }),
      );
    }
    const style = (["rabbet", "scarf", "overlay"] as const)[col % 3];
    const vis = visibleRegions(boxes, style);
    for (const b of boxes) {
      const R = vis.get(b.key)!;
      if (!R.length) continue;
      const p = planText(
        R,
        spec(titles[Math.floor(rand() * titles.length)], 9, 15, 10, 45, {
          location: rand() < 0.3 ? "Gates 104" : null,
          xs: b.height < 16,
        }),
      );
      // a region with no row tall and wide enough for a title line (an
      // xs line is 11px, a title needs 44px) has nothing to check
      const lh = b.height < 16 ? 11 : 14;
      if (!runs(R, p.title.y, p.title.y + lh).some((r) => r.b - r.a >= 44)) continue;
      expect(allInside(R, p, b.height < 16 ? 11 : 15), `col ${col} ${b.key} ${style}`).toEqual([]);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(500);
});
