// Text placement inside the OBSERVABLE shape of each overlapped event.
//
// Overlaps never split the column: joints (rabbet / scarf) and C-shapes
// tile it instead, so the part of an event you can actually see is often not
// a rectangle — a joint leaves a half-width step at one end, a C-shape leaves
// a top band, a narrow spine beside what it encloses, and open space below
// it. This module computes that visible region exactly (own shape minus
// every box painted above it) as a set of rectangles, then fits the title
// and the time into it:
//
// The text is ONE left-aligned block — title lines, time, location
// note — at the box's own left padding, so every line of every event in a
// column starts at the same indent:
//   1. title: the topmost spot on the box's left edge; it wraps down while
//      the region stays open beneath it;
//   2. time, in the block: its own row under the whole title (Notion's
//      tall-event form), else right after the title's last word (on one
//      row: title + time inline); a title that can't be shown whole keeps
//      the time on a row under its clamped lines.
//      Last resorts when the block can't hold it: sideways in a C-shape's
//      spine, inline after a shortened title; else the time is left out;
//   3. location under the block, or in the next open area
//      at the same indent (e.g. below what a C-shape encloses).
// The view lays a day out again with taller label bands for events whose
// block didn't fit (WeekView layoutDay), so last resorts stay rare.
//
// Everything placed lies inside the visible region, so no text is ever
// drawn under another event or outside its own shape.

import { textPx, wrapLines, SIZES, SIZES_XS, type TextSizes } from "./chipText";
import { fmtChipRange, fmtTimeShort } from "./dates";

export interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export type SeamStyle = "rabbet" | "scarf" | "overlay";

export interface ShapeBox<K> {
  key: K;
  /** paint order: higher paints above */
  z: number;
  left: number;
  width: number;
  top: number;
  height: number;
  seamTop: number;
  seamBottom: number;
  /** width the joint clip path is drawn at (the notch sits at its middle) */
  clipWidth: number;
  /** background-colored ring painted around the box */
  ring: number;
}

const EPS = 0.01;

/** the box's drawn shape, in column coordinates. A scarf's diagonal ends
 *  are left out of the box's OWN shape (no text goes there) but count in
 *  full when the box covers others (asOccluder). */
export function shapeRects(b: ShapeBox<unknown>, style: SeamStyle, asOccluder = false): Rect[] {
  const x0 = b.left;
  const x1 = b.left + b.width;
  const y0 = b.top;
  const y1 = b.top + b.height;
  const st = style === "overlay" ? 0 : b.seamTop;
  const sb = style === "overlay" ? 0 : b.seamBottom;
  if (st <= 0 && sb <= 0) return [{ x0, x1, y0, y1 }];
  if (style === "scarf") {
    return asOccluder ? [{ x0, x1, y0, y1 }] : [{ x0, x1, y0: y0 + st, y1: y1 - sb }];
  }
  const mid = x0 + Math.round(b.clipWidth / 2);
  const out: Rect[] = [];
  if (st > 0) out.push({ x0: mid, x1, y0, y1: y0 + st });
  out.push({ x0, x1, y0: y0 + st, y1: y1 - sb });
  if (sb > 0) out.push({ x0, x1: mid, y0: y1 - sb, y1 });
  return out.filter((r) => r.y1 - r.y0 > EPS && r.x1 - r.x0 > EPS);
}

function subtractOne(r: Rect, c: Rect): Rect[] {
  if (c.x1 <= r.x0 + EPS || c.x0 >= r.x1 - EPS || c.y1 <= r.y0 + EPS || c.y0 >= r.y1 - EPS) return [r];
  const out: Rect[] = [];
  if (c.y0 > r.y0) out.push({ ...r, y1: c.y0 });
  if (c.y1 < r.y1) out.push({ ...r, y0: c.y1 });
  const y0 = Math.max(r.y0, c.y0);
  const y1 = Math.min(r.y1, c.y1);
  if (c.x0 > r.x0) out.push({ x0: r.x0, x1: c.x0, y0, y1 });
  if (c.x1 < r.x1) out.push({ x0: c.x1, x1: r.x1, y0, y1 });
  return out.filter((q) => q.y1 - q.y0 > 0.25 && q.x1 - q.x0 > 0.25);
}

export function subtract(rs: Rect[], cuts: Rect[]): Rect[] {
  let cur = rs;
  for (const c of cuts) cur = cur.flatMap((r) => subtractOne(r, c));
  return cur;
}

/** visible region of every box, in each box's own coordinates */
export function visibleRegions<K>(boxes: ShapeBox<K>[], style: SeamStyle): Map<K, Rect[]> {
  const shapes = boxes.map((b) => shapeRects(b, style));
  const occluders = boxes.map((b) => shapeRects(b, style, true));
  const out = new Map<K, Rect[]>();
  boxes.forEach((b, i) => {
    const cuts: Rect[] = [];
    boxes.forEach((q, j) => {
      if (j === i || q.z <= b.z) return;
      if (q.top >= b.top + b.height || q.top + q.height <= b.top) return;
      for (const r of occluders[j]) {
        cuts.push({ x0: r.x0 - q.ring, x1: r.x1 + q.ring, y0: r.y0 - q.ring, y1: r.y1 + q.ring });
      }
    });
    const vis = subtract(shapes[i], cuts);
    out.set(
      b.key,
      vis.map((r) => ({ x0: r.x0 - b.left, x1: r.x1 - b.left, y0: r.y0 - b.top, y1: r.y1 - b.top })),
    );
  });
  return out;
}

interface Run {
  a: number;
  b: number;
}

/** x-intervals that are visible for EVERY y in [y0, y1] */
export function runs(R: Rect[], y0: number, y1: number): Run[] {
  const ys = new Set<number>([y0, y1]);
  for (const r of R) {
    if (r.y0 > y0 && r.y0 < y1) ys.add(r.y0);
    if (r.y1 > y0 && r.y1 < y1) ys.add(r.y1);
  }
  const cuts = [...ys].sort((a, b) => a - b);
  let acc: Run[] | null = null;
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    if (b - a < 1e-6) continue;
    const xs = R.filter((r) => r.y0 <= a + EPS && r.y1 >= b - EPS)
      .map((r) => ({ a: r.x0, b: r.x1 }))
      .sort((p, q) => p.a - q.a);
    const u: Run[] = [];
    for (const x of xs) {
      const l = u[u.length - 1];
      if (l && x.a <= l.b + EPS) l.b = Math.max(l.b, x.b);
      else u.push({ ...x });
    }
    if (acc === null) acc = u;
    else {
      const next: Run[] = [];
      for (const p of acc) {
        for (const q of u) {
          const lo = Math.max(p.a, q.a);
          const hi = Math.min(p.b, q.b);
          if (hi - lo > EPS) next.push({ a: lo, b: hi });
        }
      }
      acc = next;
    }
    if (!acc.length) return [];
  }
  return acc ?? [];
}

function covers(R: Rect[], x0: number, x1: number, y0: number, y1: number): boolean {
  return runs(R, y0, y1).some((r) => r.a <= x0 + EPS && r.b >= x1 - EPS);
}

export interface TextSpec {
  title: string;
  start: Date;
  end: Date;
  /** confirmed goal work: the title renders bold */
  bold?: boolean;
  location?: string | null;
  /** left padding at the box's own left edge */
  padL: number;
  /** tiny box: compact single-row type */
  xs?: boolean;
  /** a video-call link wants a small "Join" pocket */
  join?: boolean;
}

export interface PlacedText {
  title: { x: number; y: number; w: number; lines: number };
  /** inline: rides on a one-row title; trailing: follows the last word of
   *  a wrapped title; row: its own row under the title; vertical: turned
   *  sideways, reading bottom-to-top, w is its length along y */
  time: { text: string; x: number; y: number; w: number; mode: "inline" | "trailing" | "row" | "vertical" } | null;
  loc: { x: number; y: number; w: number } | null;
  join: { x: number; y: number } | null;
  /** which rule placed the time (for tests and debugging) */
  rule: "stack" | "inline" | "trailing" | "inline-short" | "spine" | "none";
  /** the whole title shows (not clamped or shortened) */
  titleWhole: boolean;
  /** the title starts on the box's first row (not pushed down its shape) */
  titleAtTop: boolean;
}

const PAD_R = 4;
const POCKET_PAD = 5;
const GAP = 5;
const SLACK = 2;
const MIN_TITLE_PX = 44;
const TIME_ROW = 11;
const LOC_ROW = 13;
const V_W = 12; // sideways time: line box thickness

const pad2 = (n: number) => String(n).padStart(2, "0");
const bare = (d: Date) => `${d.getHours() % 12 || 12}:${pad2(d.getMinutes())}`;

export function planText(R: Rect[], spec: TextSpec): PlacedText {
  const sizes: TextSizes = spec.xs ? SIZES_XS : SIZES;
  const LH = spec.xs ? 11 : 15;
  const padT = spec.xs ? 1 : 2;
  const tWt = spec.bold ? 600 : 500;
  const titleW = textPx(spec.title, sizes.title, tWt);
  const minTitle = Math.min(titleW, MIN_TITLE_PX);
  const padLeft = (a: number) => (a <= 0.5 ? spec.padL : POCKET_PAD);
  const inner = (r: Run) => r.b - r.a - padLeft(r.a) - PAD_R;

  // ---- 1. title: the topmost spot on the box's own left edge ----
  // Every title in a column shares that indent; a spot off the left edge is
  // a last resort. A row only needs its INK clear: the last pixel of a line
  // box is leading, so a neighbour's 1px background ring there hides nothing.
  const titleText = spec.title;
  const ink = (y: number, h: number) => runs(R, y, y + h - 1);
  const tops = [...new Set(R.map((r) => r.y0))].sort((a, b) => a - b);
  let ty = padT;
  let run: Run | null = null;
  let bestCost = Infinity;
  // (flush with the row's top too, for a row too short to pad)
  for (const y0 of tops) {
    for (const y of [y0 + padT, y0]) {
      for (const r of ink(y, LH)) {
        const w = inner(r);
        if (w < 8) continue;
        const lines = spec.xs ? 1 : wrapLines(titleText, sizes.title, w, tWt);
        const cost =
          (w >= minTitle ? 0 : 1000 - w) +
          (lines - 1) * 12 +
          (y0 - tops[0]) * 0.6 +
          (r.a > 0.5 ? 400 : 0) +
          (y === y0 ? 4 : 0);
        if (cost < bestCost) {
          bestCost = cost;
          ty = y;
          run = r;
        }
      }
    }
  }
  const maxX = R.length ? Math.max(...R.map((r) => r.x1)) : 0;
  const tx = run ? run.a + padLeft(run.a) : spec.padL;
  const tw = Math.max(1, run ? inner(run) : maxX - spec.padL - PAD_R);
  const title = { x: tx, y: ty, w: tw, lines: 1 };
  const result: PlacedText = {
    title,
    time: null,
    loc: null,
    join: null,
    rule: "none",
    titleWhole: false,
    titleAtTop: false,
  };
  if (!run) return result;
  const firstRow = Math.min(...R.filter((r) => r.x0 <= 0.5).map((r) => r.y0));
  result.titleAtTop = run.a <= 0.5 && ty - padT <= firstRow + 0.5;

  // estimate at the real width: guessing low only ellipsizes (line clamp),
  // guessing high would leave a gap above the time
  const need = spec.xs ? 1 : Math.min(8, wrapLines(titleText, sizes.title, tw, tWt));
  let avail = 1;
  // whole line boxes for every line after the first (only the first row
  // may lean its leading on a neighbour's 1px ring)
  while (!spec.xs && avail < 8 && covers(R, tx, tx + tw, ty, ty + (avail + 1) * LH)) avail++;
  title.lines = Math.min(need, avail);

  const fullStart = fmtTimeShort(spec.start);
  const rowForms = [fmtChipRange(spec.start, spec.end), fullStart, bare(spec.start)];
  const inlineForms = [fullStart, bare(spec.start)];
  const tW = (s: string, inline = false) => textPx(s, inline ? sizes.inlineTime : sizes.time, inline ? 500 : 400);

  // ---- 2. time, as part of the same left-aligned block ----
  // A. its own row right under the title (Notion's tall-event form)
  let stack: { L: number; f: string } | null = null;
  if (!spec.xs) {
    for (let L = Math.min(need, avail); L >= 1 && !stack; L--) {
      const y = ty + L * LH;
      const f = rowForms.find((s) => covers(R, tx, tx + tW(s) + SLACK + PAD_R, y, y + TIME_ROW));
      if (f) stack = { L, f };
    }
  }
  // B. right after the title's last word (Notion's short-event form; on one
  //    row this is title + time inline)
  // (the form needing the fewest lines; the full one on a tie)
  let trail: { L: number; f: string } | null = null;
  for (const f of inlineForms) {
    const tail = textPx(" ", sizes.title) + tW(f, true) + 1;
    const L = spec.xs ? (titleW + tail <= tw ? 1 : Infinity) : wrapLines(titleText, sizes.title, tw, tWt, tail);
    if (L <= avail && (!trail || L < trail.L)) trail = { L, f };
  }
  if (stack && stack.L >= need) {
    title.lines = stack.L;
    result.time = { text: stack.f, x: tx, y: ty + stack.L * LH, w: tW(stack.f) + SLACK, mode: "row" };
    result.rule = "stack";
  } else if (trail) {
    title.lines = trail.L;
    result.time = { text: trail.f, x: tx, y: ty, w: tw, mode: trail.L === 1 ? "inline" : "trailing" };
    result.rule = trail.L === 1 ? "inline" : "trailing";
  } else if (stack) {
    title.lines = stack.L;
    result.time = { text: stack.f, x: tx, y: ty + stack.L * LH, w: tW(stack.f) + SLACK, mode: "row" };
    result.rule = "stack";
  }
  if (result.time) result.titleWhole = title.lines >= need;

  // ---- last resorts, when the block cannot hold the time ----
  if (!result.time && !spec.xs) {
    // sideways in a narrow strip (a C-shape's spine), below the title
    const R2 = subtract(R, [{ x0: tx - 2, x1: tx + tw + 2, y0: ty - 1, y1: ty + title.lines * LH + 1 }]);
    const tBottom = ty + title.lines * LH;
    let best: { text: string; x: number; y: number; w: number; score: number } | null = null;
    for (const y0 of new Set(R2.map((r) => r.y0))) {
      const y = y0 + 2;
      if (y < tBottom - 0.5) continue;
      rowForms.forEach((s, k) => {
        const len = tW(s) + SLACK;
        for (const r of runs(R2, y, y + len)) {
          if (r.b - r.a < V_W + 4 || r.a > 0.5) continue;
          const score = y - tBottom + k * 6;
          if (!best || score < best.score) {
            best = { text: s, x: r.a + Math.max(2, (Math.min(r.b - r.a, 20) - V_W) / 2), y, w: len, score };
          }
        }
      });
    }
    const b = best as { text: string; x: number; y: number; w: number; score: number } | null;
    if (b) {
      result.time = { text: b.text, x: b.x, y: b.y, w: b.w, mode: "vertical" };
      result.rule = "spine";
      result.titleWhole = title.lines >= need;
    }
  }
  if (!result.time) {
    // inline after a shortened (still readable) title: the full time while
    // the title keeps a dozen characters, else whichever form leaves the
    // title the most
    const shown = (x: string) => tw - GAP - tW(x, true) - SLACK;
    const ok = inlineForms.filter((x) => shown(x) >= minTitle);
    const f = ok.length && shown(ok[0]) >= Math.min(titleW, 72) ? ok[0] : ok.sort((a, b) => shown(b) - shown(a))[0];
    if (f) {
      title.lines = 1;
      result.time = { text: f, x: tx, y: ty, w: tw, mode: "inline" };
      result.rule = "inline-short";
    } else {
      result.titleWhole = title.lines >= need;
    }
  }

  // ---- 3. location under the stacked text ----
  if (!spec.xs && (spec.location || spec.join)) {
    const t = result.time;
    // exact rows (no vertical margin) so the spot right under them stays
    // one clean run
    const cuts: Rect[] = [{ x0: tx - 2, x1: tx + tw + 2, y0: ty, y1: ty + title.lines * LH }];
    if (t && t.mode !== "inline") {
      cuts.push(
        t.mode === "vertical"
          ? { x0: t.x - 1, x1: t.x + V_W + 1, y0: t.y, y1: t.y + t.w }
          : { x0: t.x - 2, x1: t.x + t.w + 2, y0: t.y, y1: t.y + TIME_ROW },
      );
    }
    let R3 = subtract(R, cuts);
    const yNext = ty + title.lines * LH + (t && t.mode === "row" && t.x === tx && t.y >= ty ? TIME_ROW : 0);
    // first open spot at or below yFrom, scanning down the visible shape:
    // directly under the text when it is open, else the next open area
    // (e.g. below what a C-shape encloses)
    const spots = (yFrom: number, h: number, minW: number) => {
      const out: { x: number; y: number; w: number }[] = [];
      const ys = [...new Set([yFrom, ...R3.map((r) => r.y0 + 1)])].filter((v) => v >= yFrom).sort((a, b) => a - b);
      for (const y of ys) {
        const rs = runs(R3, y, y + h).filter((r) => r.b - r.a - padLeft(r.a) - PAD_R >= minW);
        if (!rs.length) continue;
        // same indent as the title, or not at all
        const r = rs.find((q) => q.a <= tx - padLeft(q.a) + EPS && q.b - PAD_R - tx >= minW);
        if (r) out.push({ x: tx, y, w: r.b - PAD_R - tx });
      }
      return out;
    };
    const spotAt = (yFrom: number, h: number, minW: number) => spots(yFrom, h, minW)[0] ?? null;
    let y = yNext;
    if (spec.location) {
      const sp = spotAt(y, LOC_ROW, 30);
      if (sp) {
        result.loc = sp;
        R3 = subtract(R3, [{ x0: sp.x - 2, x1: sp.x + sp.w + 2, y0: sp.y, y1: sp.y + LOC_ROW }]);
        y = sp.y + LOC_ROW;
      }
    }
    if (spec.join) {
      const jw = textPx("Join", 10) + SLACK;
      // beside the time row, else the first open row below the text
      if (t && t.mode === "row" && covers(R3, t.x + t.w + 6, t.x + t.w + 6 + jw, t.y, t.y + TIME_ROW)) {
        result.join = { x: t.x + t.w + 6, y: t.y };
      } else {
        const sp = spotAt(y, TIME_ROW, jw);
        if (sp) result.join = { x: sp.x, y: sp.y };
      }
    }
  }
  return result;
}
