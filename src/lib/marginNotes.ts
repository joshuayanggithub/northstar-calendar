// Margin notes: the supervisor's red-pen notes, placed the way a person
// annotates a printed week. A note goes wherever there is room (empty grid,
// the solid body of an event, across a day line), tilted a hair or turned
// sideways, with a hand-drawn arrow back to its event. It is never written
// over printed text, and it is always shown whole.
//
// This is label placement with leaders, the map-labeling problem (Christensen,
// Marks & Shieber 1995; boundary labeling, Bekos et al. 2007):
//   1. the field: every piece of event text is a hard obstacle (padded).
//      Event bodies are allowed but cost more than empty grid; bodies the
//      red pen can't be read on cost a lot more.
//   2. candidates: each note wrapped at several widths (all of its words,
//      every time), tilted a little or turned sideways, at every free spot
//      within reach of its event. Summed-area tables make each test O(1);
//      a coarse sweep is refined around its best spots.
//   3. cost: arrow length; sitting on its own event (then no arrow at all);
//      covering someone else's event; an unreadable background; the arrow
//      crossing text, another note or another arrow; sitting nearer another
//      event's title than its own; turning sideways; many lines; leaving its
//      own day.
//   4. global: the most constrained notes go first, then rip-up-and-replace
//      sweeps (each note re-placed with the others fixed) until nothing
//      improves. Notes the person moved by hand are fixed obstacles.

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** a word of the note; `em` = written with emphasis (*word* in the text) */
export interface Word {
  t: string;
  em: boolean;
}

/** where the person put a note by hand: the box's top-left, the text width
 *  they had, and the angle */
export interface Pin {
  x: number;
  y: number;
  w: number;
  angle: number;
  scale?: number;
}

export interface NoteSpec {
  key: string;
  words: Word[];
  /** the event's title block: what the arrow points at */
  anchor: Rect;
  /** the visible part of the event's body */
  own: Rect[];
  /** the event's day column */
  col: number;
  pin?: Pin | null;
}

export interface Field {
  w: number;
  h: number;
  cols: { x0: number; x1: number }[];
  /** ink of every piece of event text */
  text: Rect[];
  /** event bodies; `poor` = the red pen can't be read on it */
  fills: { r: Rect; poor: boolean }[];
  /** every event's title block, for "which event is this nearest" */
  titles: { key: string; r: Rect }[];
}

export interface NotePlace {
  key: string;
  /** the text box before rotation (rotated about its centre) */
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
  lines: Word[][];
  /** axis-aligned footprint of the rotated box */
  box: Rect;
  /** sits on its own event: no arrow */
  inside: boolean;
  pinned: boolean;
  /** no free spot existed anywhere: the least-bad spot */
  forced: boolean;
  /** which way the arrow bows (-1, 0, 1): the side that crosses least */
  bend: number;
  /** the hand's size (1 = 12px) */
  scale: number;
  cost: number;
}

export const NOTE_LH = 14; // line height, px (12px hand)
export const NOTE_PADX = 3;
/** the hand's glyphs (ascenders, descenders) overhang a line box by up to
 *  ~1/5 em: reserve that above and below */
export const NOTE_PADY = 3;
const CELL = 2;
const TEXT_PAD = 2; // clearance from printed text
const NOTE_GAP = 4; // clearance between notes
const TILTS = [-1.8, -0.8, 1.2];

// ---------------------------------------------------------------- text

/** "You *will* do it" → words with emphasis flags (asterisks dropped) */
export function noteWords(text: string): Word[] {
  const out: Word[] = [];
  let em = false;
  for (const raw of text.split(/\s+/)) {
    if (!raw) continue;
    let t = raw;
    let open = false;
    if (/^\*+/.test(t)) {
      t = t.replace(/^\*+/, "");
      open = true;
    }
    let close = false;
    if (/\*+[.,!?;:)"'’]*$/.test(t)) {
      t = t.replace(/\*+(?=[.,!?;:)"'’]*$)/, "");
      close = true;
    }
    if (open) em = true;
    if (t) out.push({ t, em });
    if (close) em = false;
  }
  return out;
}

/** greedy wrap at `maxW`; a word wider than that gets a line of its own */
export function wrapWords(
  words: Word[],
  maxW: number,
  measure: (s: string) => number,
): { lines: Word[][]; w: number } {
  const space = measure(" ");
  const lines: Word[][] = [];
  let cur: Word[] = [];
  let cw = 0;
  let mw = 0;
  for (const wd of words) {
    const ww = measure(wd.t);
    if (cur.length && cw + space + ww > maxW) {
      lines.push(cur);
      mw = Math.max(mw, cw);
      cur = [];
      cw = 0;
    }
    cw += (cur.length ? space : 0) + ww;
    cur.push(wd);
  }
  if (cur.length) {
    lines.push(cur);
    mw = Math.max(mw, cw);
  }
  return { lines, w: mw };
}

interface Shape {
  w: number;
  h: number;
  lines: Word[][];
  /** the hand's size: 1 = 12px; smaller only when the page is crowded */
  scale: number;
}

/** sizes the hand can write at, and what writing smaller costs */
export const NOTE_SCALES: [number, number][] = [
  [1, 0],
  [0.85, 50],
  [0.72, 140],
];
export const lineH = (scale: number) => Math.round(NOTE_LH * scale);

const shapeOf = (r: { lines: Word[][]; w: number }, scale: number): Shape => ({
  w: Math.ceil(r.w) + 1 + 2 * NOTE_PADX,
  h: r.lines.length * lineH(scale) + 2 * NOTE_PADY,
  lines: r.lines,
  scale,
});

/** the note wrapped to 1, 2, … 6 lines, each at its narrowest width */
function shapes(words: Word[], measure0: (s: string) => number, maxW: number, scale: number): Shape[] {
  const measure = (s: string) => measure0(s) * scale;
  const one = wrapWords(words, Infinity, measure);
  const minW = Math.max(...words.map((w) => measure(w.t)), 1);
  const out: Shape[] = [];
  const seen = new Set<number>();
  for (let k = 1; k <= Math.min(6, words.length); k++) {
    let lo = minW;
    let hi = Math.max(minW, one.w);
    for (let i = 0; i < 18 && hi - lo > 0.5; i++) {
      const mid = (lo + hi) / 2;
      if (wrapWords(words, mid, measure).lines.length <= k) hi = mid;
      else lo = mid;
    }
    const r = wrapWords(words, hi + 0.01, measure);
    if (seen.has(r.lines.length)) continue;
    seen.add(r.lines.length);
    const s = shapeOf(r, scale);
    if (s.w <= maxW || out.length === 0) out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------- geometry

const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const inter = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
export function rectDist(a: Rect, b: Rect): number {
  const dx = Math.max(0, b.x0 - a.x1, a.x0 - b.x1);
  const dy = Math.max(0, b.y0 - a.y1, a.y0 - b.y1);
  return Math.sqrt(dx * dx + dy * dy);
}
const clampTo = (x: number, y: number, r: Rect): [number, number] => [
  Math.max(r.x0, Math.min(r.x1, x)),
  Math.max(r.y0, Math.min(r.y1, y)),
];

/** the axis-aligned footprint of a w×h box at `angle`, centred on (cx, cy) */
function footprint(cx: number, cy: number, w: number, h: number, angle: number): Rect {
  const a = (Math.abs(angle) * Math.PI) / 180;
  const bw = w * Math.abs(Math.cos(a)) + h * Math.abs(Math.sin(a));
  const bh = w * Math.abs(Math.sin(a)) + h * Math.abs(Math.cos(a));
  return { x0: cx - bw / 2, y0: cy - bh / 2, x1: cx + bw / 2, y1: cy + bh / 2 };
}

/** The hand-drawn arrow from a note to its event's title: a gently bent
 *  stroke that stops just short of the title, and a two-stroke head. */
export function leaderGeom(
  box: Rect,
  anchor: Rect,
  bend: number,
): { s: [number, number]; c: [number, number]; e: [number, number]; head: [number, number][] } | null {
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const [ax, ay] = clampTo(cx, cy, anchor);
  let ux = cx - ax;
  let uy = cy - ay;
  const ul = Math.hypot(ux, uy) || 1;
  ux /= ul;
  uy /= ul;
  const e: [number, number] = [ax + ux * 3, ay + uy * 3];
  // touching its title: the note speaks for itself
  if (rectDist(box, anchor) <= 3) return null;
  const [bx, by] = clampTo(e[0], e[1], box);
  let vx = e[0] - bx;
  let vy = e[1] - by;
  const vl = Math.hypot(vx, vy);
  if (vl < 1) {
    vx = -ux;
    vy = -uy;
  } else {
    vx /= vl;
    vy /= vl;
  }
  const s: [number, number] = [bx + vx * 2, by + vy * 2];
  const len = Math.hypot(e[0] - s[0], e[1] - s[1]);
  const k = Math.min(16, len * 0.2) * bend;
  const c: [number, number] = [(s[0] + e[0]) / 2 - vy * k, (s[1] + e[1]) / 2 + vx * k];
  let tx = e[0] - c[0];
  let ty = e[1] - c[1];
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl;
  ty /= tl;
  const wing = (deg: number): [number, number] => {
    const r = (deg * Math.PI) / 180;
    const wx = tx * Math.cos(r) - ty * Math.sin(r);
    const wy = tx * Math.sin(r) + ty * Math.cos(r);
    return [e[0] - wx * 6.5, e[1] - wy * 6.5];
  };
  return { s, c, e, head: [wing(27), e, wing(-27)] };
}

/** points along the arrow's stroke, every ~4px */
function samples(g: NonNullable<ReturnType<typeof leaderGeom>>): [number, number][] {
  const len = Math.hypot(g.e[0] - g.s[0], g.e[1] - g.s[1]);
  const n = Math.max(2, Math.ceil(len / 4));
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * g.s[0] + 2 * u * t * g.c[0] + t * t * g.e[0],
      u * u * g.s[1] + 2 * u * t * g.c[1] + t * t * g.e[1],
    ]);
  }
  return out;
}

function segsCross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const o = (p: [number, number], q: [number, number], r: [number, number]) =>
    Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

function tiltFor(key: string): number {
  let h = 7;
  for (let i = 0; i < key.length; i++) h = (h * 33 + key.charCodeAt(i)) >>> 0;
  return TILTS[h % TILTS.length];
}

// ---------------------------------------------------------------- occupancy

/** a coverage grid with a summed-area table: "is anything in this box" in O(1) */
class Occ {
  readonly gw: number;
  readonly gh: number;
  private cnt: Uint16Array;
  private sat: Int32Array;
  private dirty = true;
  constructor(W: number, H: number) {
    this.gw = Math.max(1, Math.ceil(W / CELL));
    this.gh = Math.max(1, Math.ceil(H / CELL));
    this.cnt = new Uint16Array(this.gw * this.gh);
    this.sat = new Int32Array((this.gw + 1) * (this.gh + 1));
  }
  mark(r: Rect, pad: number, v: 1 | -1) {
    const cx0 = Math.max(0, Math.floor((r.x0 - pad) / CELL));
    const cy0 = Math.max(0, Math.floor((r.y0 - pad) / CELL));
    const cx1 = Math.min(this.gw, Math.ceil((r.x1 + pad) / CELL));
    const cy1 = Math.min(this.gh, Math.ceil((r.y1 + pad) / CELL));
    for (let y = cy0; y < cy1; y++) for (let x = cx0; x < cx1; x++) this.cnt[y * this.gw + x] += v;
    this.dirty = true;
  }
  private build() {
    const { gw, gh, cnt, sat } = this;
    const W1 = gw + 1;
    for (let y = 0; y < gh; y++) {
      let row = 0;
      for (let x = 0; x < gw; x++) {
        row += cnt[y * gw + x] > 0 ? 1 : 0;
        sat[(y + 1) * W1 + x + 1] = sat[y * W1 + x + 1] + row;
      }
    }
    this.dirty = false;
  }
  /** covered cells under a box (px, conservative: any touched cell) */
  count(r: Rect): number {
    return this.countXY(r.x0, r.y0, r.x1, r.y1);
  }
  countXY(x0: number, y0: number, x1: number, y1: number): number {
    if (this.dirty) this.build();
    const cx0 = Math.max(0, Math.floor(x0 / CELL));
    const cy0 = Math.max(0, Math.floor(y0 / CELL));
    const cx1 = Math.min(this.gw, Math.ceil(x1 / CELL));
    const cy1 = Math.min(this.gh, Math.ceil(y1 / CELL));
    if (cx1 <= cx0 || cy1 <= cy0) return 0;
    const W1 = this.gw + 1;
    const s = this.sat;
    return s[cy1 * W1 + cx1] - s[cy0 * W1 + cx1] - s[cy1 * W1 + cx0] + s[cy0 * W1 + cx0];
  }
  cells(r: Rect): number {
    const cx0 = Math.max(0, Math.floor(r.x0 / CELL));
    const cy0 = Math.max(0, Math.floor(r.y0 / CELL));
    const cx1 = Math.min(this.gw, Math.ceil(r.x1 / CELL));
    const cy1 = Math.min(this.gh, Math.ceil(r.y1 / CELL));
    return Math.max(1, (cx1 - cx0) * (cy1 - cy0));
  }
  at(x: number, y: number): boolean {
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    if (cx < 0 || cy < 0 || cx >= this.gw || cy >= this.gh) return false;
    return this.cnt[cy * this.gw + cx] > 0;
  }
}

// ---------------------------------------------------------------- placement

interface Cand {
  box: Rect;
  shape: Shape;
  angle: number;
  base: number;
  inside: boolean;
  d: number;
  /** share of the box over the body of another event that has a note */
  claimed: number;
}

export interface PlaceOpts {
  /** how far from its event a note looks first (px); it widens if needed */
  reachX?: number;
  reachY?: number;
}

export function placeNotes(
  field: Field,
  specs: NoteSpec[],
  measure: (s: string) => number,
  opts: PlaceOpts = {},
): NotePlace[] {
  const W = field.w;
  const H = field.h;
  const colW = field.cols.length ? (field.cols[field.cols.length - 1].x1 - field.cols[0].x0) / field.cols.length : W;
  const reachX = opts.reachX ?? Math.max(220, colW * 1.6);
  const reachY = opts.reachY ?? 200;

  const text = new Occ(W, H);
  for (const r of field.text) text.mark(r, TEXT_PAD, 1);
  const fill = new Occ(W, H);
  const poor = new Occ(W, H);
  for (const f of field.fills) {
    fill.mark(f.r, 0, 1);
    if (f.poor) poor.mark(f.r, 0, 1);
  }
  // bodies of events that have a note of their own: the first place that
  // note will look, so others keep off them when they can
  const claimed = new Occ(W, H);
  for (const sp of specs) for (const o of sp.own) claimed.mark(o, 0, 1);
  /** notes already down: their padded footprints */
  const noteBoxes = new Map<string, Rect>();
  const notesHit = (box: Rect) => {
    for (const r of noteBoxes.values()) if (box.x0 < r.x1 && box.x1 > r.x0 && box.y0 < r.y1 && box.y1 > r.y0) return true;
    return false;
  };
  const notesAt = (x: number, y: number) => {
    for (const r of noteBoxes.values()) if (x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1) return true;
    return false;
  };
  const placed = new Map<string, { p: NotePlace; spec: NoteSpec; pts: [number, number][]; bb: Rect | null }>();
  const bbOf = (pts: [number, number][]): Rect | null =>
    pts.length
      ? {
          x0: Math.min(...pts.map((q) => q[0])),
          y0: Math.min(...pts.map((q) => q[1])),
          x1: Math.max(...pts.map((q) => q[0])),
          y1: Math.max(...pts.map((q) => q[1])),
        }
      : null;
  const shapeCache = new Map<string, Shape[]>();
  const shapesOf = (spec: NoteSpec) => {
    let sh = shapeCache.get(spec.key);
    if (!sh) {
      sh = NOTE_SCALES.flatMap(([sc]) => shapes(spec.words, measure, Math.min(W, Math.max(colW * 2.2, 160)), sc));
      shapeCache.set(spec.key, sh);
    }
    return sh;
  };

  const colOf = (x: number) => {
    for (let i = 0; i < field.cols.length; i++) if (x < field.cols[i].x1) return i;
    return field.cols.length - 1;
  };

  const baseCost = (spec: NoteSpec, box: Rect, shape: Shape, angle: number): Cand => {
    const a = area(box);
    let own = 0;
    for (const o of spec.own) own += inter(box, o);
    const ownFrac = own / a;
    const d = rectDist(box, spec.anchor);
    const inside = ownFrac > 0.97 || (d <= 2 && ownFrac >= 0.6);
    const cells = fill.cells(box);
    const fillFrac = fill.count(box) / cells;
    const poorFrac = poor.count(box) / cells;
    const otherFrac = Math.max(0, fillFrac - ownFrac);
    const claimedFrac = Math.max(0, claimed.count(box) / cells - ownFrac);
    let c = inside ? 0 : 14 + d + Math.max(0, d - 50) * 2;
    c += 45 * otherFrac + 220 * poorFrac + 40 * claimedFrac;
    c += Math.abs(angle) > 45 ? (angle < 0 ? 55 : 65) : 0;
    c += 5 * (shape.lines.length - 1);
    c += NOTE_SCALES.find(([sc]) => sc === shape.scale)?.[1] ?? 0;
    c += Math.max(0, shape.w - 1.3 * colW) * 0.05;
    const ci = colOf((box.x0 + box.x1) / 2);
    if (ci !== spec.col) c += 12;
    c += 4 * Math.max(0, colOf(box.x1 - 1) - colOf(box.x0));
    if (box.y1 <= spec.anchor.y0) c += 4; // notes read after their event
    return { box, shape, angle, base: c, inside, d, claimed: claimedFrac };
  };

  /** the full cost of a candidate given the notes already down */
  /** what an arrow along these points costs: through text, through other
   *  notes, across other arrows */
  const arrowCost = (pts: [number, number][], e: [number, number]): number => {
    let cost = 0;
    let hits = 0;
    for (const [x, y] of pts) {
      if (Math.hypot(x - e[0], y - e[1]) < 8) continue;
      if (text.at(x, y)) hits++;
      if (notesAt(x, y)) cost += 40;
    }
    cost += Math.min(hits, 16) * 45;
    const bb = bbOf(pts)!;
    for (const o of placed.values()) {
      if (!o.bb || o.bb.x0 > bb.x1 || o.bb.x1 < bb.x0 || o.bb.y0 > bb.y1 || o.bb.y1 < bb.y0) continue;
      outer: for (let i = 1; i < pts.length; i += 2) {
        const p0 = pts[i - 1];
        const p1 = pts[Math.min(pts.length - 1, i + 1)];
        for (let j = 1; j < o.pts.length; j += 2) {
          if (segsCross(p0, p1, o.pts[j - 1], o.pts[Math.min(o.pts.length - 1, j + 1)])) {
            cost += 35;
            break outer;
          }
        }
      }
    }
    return cost;
  };

  const fullCost = (spec: NoteSpec, c: Cand): { cost: number; pts: [number, number][]; bend: number } => {
    let cost = c.base;
    let pts: [number, number][] = [];
    let bend = 0;
    if (!c.inside) {
      let bestArrow = Infinity;
      for (const b of [0, 1, -1]) {
        const g = leaderGeom(c.box, spec.anchor, b);
        if (!g) {
          bestArrow = 0;
          pts = [];
          bend = 0;
          break;
        }
        const ps = samples(g);
        const a = arrowCost(ps, g.e) + (b ? 0 : 3); // a hand rarely draws dead straight
        if (a < bestArrow) {
          bestArrow = a;
          pts = ps;
          bend = b;
        }
      }
      cost += bestArrow;
      // nearer another event's title than its own: the arrow has to argue
      let dOther = Infinity;
      for (const t of field.titles) if (t.key !== spec.key) dOther = Math.min(dOther, rectDist(c.box, t.r));
      if (dOther + 4 < c.d) cost += 20 + 0.4 * (c.d - dOther);
    }
    // covering another note's arrow
    for (const o of placed.values()) {
      if (!o.bb || o.bb.x0 > c.box.x1 || o.bb.x1 < c.box.x0 || o.bb.y0 > c.box.y1 || o.bb.y1 < c.box.y0) continue;
      for (const [x, y] of o.pts) {
        if (x > c.box.x0 && x < c.box.x1 && y > c.box.y0 && y < c.box.y1) {
          cost += 35;
          break;
        }
      }
    }
    return { cost, pts, bend };
  };

  interface Combo {
    shape: Shape;
    angle: number;
    bw: number;
    bh: number;
    fixed: number;
  }
  const combosOf = (spec: NoteSpec): Combo[] => {
    const out: Combo[] = [];
    for (const shape of shapesOf(spec)) {
      for (const angle of [tiltFor(spec.key), -90, 90]) {
        // sideways only reads as a margin note when it is a line or two
        if (Math.abs(angle) > 45 && shape.lines.length > 2) continue;
        const fp = footprint(0, 0, shape.w, shape.h, angle);
        out.push({
          shape,
          angle,
          bw: fp.x1 - fp.x0,
          bh: fp.y1 - fp.y0,
          fixed:
            (Math.abs(angle) > 45 ? (angle < 0 ? 55 : 65) : 0) +
            5 * (shape.lines.length - 1) +
            (NOTE_SCALES.find(([sc]) => sc === shape.scale)?.[1] ?? 0),
        });
      }
    }
    return out;
  };

  /** Spots clear of printed text, nearest first. Spots on the event's own
   *  body are tried first (they need no arrow); then rings of growing
   *  distance around its title, so the sweep stops as soon as a ring's
   *  distance alone costs more than the best spot found plus `slack`. */
  const search = (spec: NoteSpec, rx: number, ry: number, step: number, slack: number, own: boolean): Cand[] => {
    const combos = combosOf(spec);
    const out: Cand[] = [];
    let bestBase = Infinity;
    const tryAt = (x: number, y: number, c: Combo) => {
      if (x < 0 || y < 0 || x + c.bw > W || y + c.bh > H) return;
      if (text.countXY(x, y, x + c.bw, y + c.bh) !== 0) return;
      const cand = baseCost(spec, { x0: x, y0: y, x1: x + c.bw, y1: y + c.bh }, c.shape, c.angle);
      if (cand.base > bestBase + slack) return;
      out.push(cand);
      if (cand.base < bestBase) bestBase = cand.base;
    };
    for (const o of own ? spec.own : []) {
      for (const c of combos) {
        if (c.fixed > 30) continue;
        for (let y = o.y0; y + c.bh <= o.y1; y += 6) for (let x = o.x0; x + c.bw <= o.x1; x += 6) tryAt(x, y, c);
      }
    }
    const A = spec.anchor;
    const kMax = Math.ceil(Math.max(rx, ry) / step);
    for (let k = 0; k <= kMax; k++) {
      const r = k * step;
      const ringLb = 14 + r + Math.max(0, r - 50) * 2;
      let any = false;
      for (const c of combos) {
        if (c.fixed + ringLb > bestBase + slack) continue;
        any = true;
        const xa = A.x0 - r - c.bw;
        const xb = A.x1 + r;
        const ya = A.y0 - r - c.bh;
        const yb = A.y1 + r;
        if (r <= ry) {
          for (let x = xa; x <= xb; x += step) {
            tryAt(x, ya, c);
            tryAt(x, yb, c);
          }
        }
        if (r <= rx) {
          for (let y = ya + step; y < yb; y += step) {
            tryAt(xa, y, c);
            tryAt(xb, y, c);
          }
        }
      }
      if (!any) break;
    }
    return out;
  };

  // Every cost term but the arrows and the other notes is fixed by the page,
  // so each note's text-free spots are found once, sorted by that cost, and
  // re-placing a note is a scan down its list past spots other notes hold.
  // Level 0 is within reach; 1 and 2 (wider, coarser) are only built for a
  // note that finds everything near already taken.
  const LEVELS: [number, number, number, number, boolean][] = [
    [reachX, reachY, 8, 260, true],
    [reachX * 3, reachY * 3, 12, Infinity, false],
    [W, H, 16, Infinity, false],
  ];
  const statics = new Map<string, Cand[]>();
  const staticsOf = (spec: NoteSpec, level = 0) => {
    const k = spec.key + "|" + level;
    let l = statics.get(k);
    if (!l) {
      const [rx, ry, step, slack, own] = LEVELS[level];
      l = search(spec, rx, ry, step, slack, own).sort((a, b) => a.base - b.base);
      statics.set(k, l);
    }
    return l;
  };

  const pick = (spec: NoteSpec, cands: Iterable<Cand>): NotePlace | null => {
    let top: { c: Cand; cost: number; bend: number } | null = null;
    let tried = 0;
    for (const c of cands) {
      if (top && c.base >= top.cost) break; // the arrow only adds
      if (notesHit(c.box)) continue;
      const { cost, bend } = fullCost(spec, c);
      if (!top || cost < top.cost) top = { c, cost, bend };
      if (++tried >= 16) break;
    }
    return top && toPlace(spec, top.c, top.cost, false, false, top.bend);
  };

  const best = (spec: NoteSpec): NotePlace => {
    for (let level = 0; level < LEVELS.length; level++) {
      const p = pick(spec, staticsOf(spec, level));
      if (p) return p;
    }
    return forcedFor(spec);
  };

  /** nowhere free: the spot that covers the least text (still whole) */
  const forcedFor = (spec: NoteSpec): NotePlace => {
    const sh = shapesOf(spec);
    const shape = sh[sh.length - 1];
    let top: { box: Rect; v: number } | null = null;
    for (let y = 0; y + shape.h <= H; y += 8) {
      for (let x = 0; x + shape.w <= Math.max(W, shape.w); x += 8) {
        const box = { x0: x, y0: y, x1: x + shape.w, y1: y + shape.h };
        const v = text.count(box) * 1000 + (notesHit(box) ? 1e5 : 0) + rectDist(box, spec.anchor);
        if (!top || v < top.v) top = { box, v };
      }
    }
    const box = top?.box ?? { x0: 0, y0: 0, x1: shape.w, y1: shape.h };
    return toPlace(
      spec,
      { box, shape, angle: 0, base: 1e6, inside: false, d: rectDist(box, spec.anchor), claimed: 0 },
      1e6,
      false,
      true,
      1,
    );
  };

  const toPlace = (spec: NoteSpec, c: Cand, cost: number, pinned: boolean, forced: boolean, bend: number): NotePlace => {
    const cx = (c.box.x0 + c.box.x1) / 2;
    const cy = (c.box.y0 + c.box.y1) / 2;
    return {
      key: spec.key,
      x: cx - c.shape.w / 2,
      y: cy - c.shape.h / 2,
      w: c.shape.w,
      h: c.shape.h,
      angle: c.angle,
      lines: c.shape.lines,
      box: c.box,
      inside: c.inside,
      pinned,
      forced,
      bend,
      scale: c.shape.scale,
      cost,
    };
  };

  const commit = (spec: NoteSpec, p: NotePlace) => {
    noteBoxes.set(spec.key, {
      x0: p.box.x0 - NOTE_GAP,
      y0: p.box.y0 - NOTE_GAP,
      x1: p.box.x1 + NOTE_GAP,
      y1: p.box.y1 + NOTE_GAP,
    });
    let pts: [number, number][] = [];
    if (!p.inside) {
      const g = leaderGeom(p.box, spec.anchor, p.bend);
      if (g) pts = samples(g);
    }
    placed.set(spec.key, { p, spec, pts, bb: bbOf(pts) });
  };
  const lift = (key: string) => {
    const o = placed.get(key);
    if (!o) return null;
    noteBoxes.delete(key);
    placed.delete(key);
    return o;
  };

  // hand-placed notes first, exactly where the person left them
  for (const spec of specs) {
    if (!spec.pin) continue;
    const sc = spec.pin.scale ?? 1;
    const shape = shapeOf(
      wrapWords(spec.words, spec.pin.w + 0.01, (x) => measure(x) * sc),
      sc,
    );
    const fp = footprint(spec.pin.x + shape.w / 2, spec.pin.y + shape.h / 2, shape.w, shape.h, spec.pin.angle);
    const c = baseCost(spec, fp, shape, spec.pin.angle);
    commit(spec, toPlace(spec, c, c.base, true, false, fullCost(spec, c).bend));
  }

  // ---- the global step: simulated annealing over each note's shortlist ----
  // (Christensen, Marks & Shieber 1995 found it the best of the label-
  // placement searches.) Everything about a spot that the other notes can't
  // change (its own cost, its arrow through printed text, sitting nearer
  // another title) is scored once; the anneal adds what pairs of notes do
  // to each other: overlapping (forbidden), an arrow through another note,
  // arrows crossing.
  interface Opt {
    c: Cand;
    cost: number;
    bend: number;
    pts: [number, number][];
    bb: Rect | null;
    pad: Rect;
  }
  const optOf = (spec: NoteSpec, c: Cand): Opt => {
    let cost = c.base;
    let pts: [number, number][] = [];
    let bend = 0;
    if (!c.inside) {
      let bestArrow = Infinity;
      for (const b of [0, 1, -1]) {
        const g = leaderGeom(c.box, spec.anchor, b);
        if (!g) {
          bestArrow = 0;
          pts = [];
          bend = 0;
          break;
        }
        const ps = samples(g);
        let hits = 0;
        for (const [x, y] of ps) if (Math.hypot(x - g.e[0], y - g.e[1]) >= 8 && text.at(x, y)) hits++;
        const a = Math.min(hits, 16) * 45 + (b ? 0 : 3);
        if (a < bestArrow) {
          bestArrow = a;
          pts = ps;
          bend = b;
        }
      }
      cost += bestArrow;
      let dOther = Infinity;
      for (const t of field.titles) if (t.key !== spec.key) dOther = Math.min(dOther, rectDist(c.box, t.r));
      if (dOther + 4 < c.d) cost += 20 + 0.4 * (c.d - dOther);
    }
    return {
      c,
      cost,
      bend,
      pts,
      bb: bbOf(pts),
      pad: { x0: c.box.x0 - NOTE_GAP, y0: c.box.y0 - NOTE_GAP, x1: c.box.x1 + NOTE_GAP, y1: c.box.y1 + NOTE_GAP },
    };
  };
  const meets = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
  const through = (o: Opt, box: Rect) => {
    if (!o.bb || !meets(o.bb, box)) return false;
    for (const [x, y] of o.pts) if (x > box.x0 && x < box.x1 && y > box.y0 && y < box.y1) return true;
    return false;
  };
  const crosses = (a: Opt, b: Opt) => {
    if (!a.bb || !b.bb || !meets(a.bb, b.bb)) return false;
    for (let i = 1; i < a.pts.length; i += 2) {
      const p0 = a.pts[i - 1];
      const p1 = a.pts[Math.min(a.pts.length - 1, i + 1)];
      for (let j = 1; j < b.pts.length; j += 2) {
        if (segsCross(p0, p1, b.pts[j - 1], b.pts[Math.min(b.pts.length - 1, j + 1)])) return true;
      }
    }
    return false;
  };
  const CLASH = 1e4;
  const pen = (a: Opt, b: Opt) =>
    (meets(a.pad, b.c.box) ? CLASH : 0) + (through(a, b.c.box) ? 40 : 0) + (through(b, a.c.box) ? 40 : 0) + (crosses(a, b) ? 35 : 0);

  /** a note's shortlist: its best spots by everything static, spread out
   *  (no two nearly the same), reaching wider when near is scarce */
  const K = 40;
  const shortlist = (spec: NoteSpec): Opt[] => {
    const pool: Opt[] = [];
    for (let level = 0; level < LEVELS.length && pool.length < K; level++) {
      for (const c of staticsOf(spec, level).slice(0, 140)) pool.push(optOf(spec, c));
    }
    pool.sort((a, b) => a.cost - b.cost);
    const out: Opt[] = [];
    for (const o of pool) {
      if (
        out.some(
          (k) =>
            k.c.angle === o.c.angle &&
            k.c.shape === o.c.shape &&
            Math.abs(k.c.box.x0 - o.c.box.x0) < 10 &&
            Math.abs(k.c.box.y0 - o.c.box.y0) < 10,
        )
      )
        continue;
      out.push(o);
      if (out.length >= K) break;
    }
    return out;
  };

  const loose = specs.filter((s) => !s.pin);
  const fixedOpts: Opt[] = [...placed.values()].map(({ p, spec }) => {
    const c = baseCost(spec, p.box, { w: p.w, h: p.h, lines: p.lines, scale: p.scale }, p.angle);
    return { ...optOf(spec, c), bend: p.bend };
  });
  const lists = loose.map(shortlist);

  // a fixed seed from the page itself: the same week lays out the same way
  let seed = 2166136261;
  for (const s of loose) for (let i = 0; i < s.key.length; i++) seed = Math.imul(seed ^ s.key.charCodeAt(i), 16777619) >>> 0;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  // start: greedy, notes that fit on their own event first (no arrow is the
  // clearest arrow), then the most constrained
  const order = loose
    .map((_, i) => i)
    .sort((a, b) => {
      const la = lists[a];
      const lb = lists[b];
      const ha = la.some((o) => o.c.inside && o.cost < 60) ? 1 : 0;
      const hb = lb.some((o) => o.c.inside && o.cost < 60) ? 1 : 0;
      return hb - ha || (lb[0]?.cost ?? 1e9) - (la[0]?.cost ?? 1e9) || la.length - lb.length;
    });
  const sel: number[] = loose.map(() => -1);
  const chosen = (i: number) => (sel[i] >= 0 ? lists[i][sel[i]] : null);
  const penAgainst = (i: number, o: Opt) => {
    let t = 0;
    for (const f of fixedOpts) t += pen(o, f);
    for (let k = 0; k < loose.length; k++) {
      if (k === i) continue;
      const ok = chosen(k);
      if (ok) t += pen(o, ok);
    }
    return t;
  };
  for (const i of order) {
    let bestJ = -1;
    let bestV = Infinity;
    lists[i].forEach((o, j) => {
      if (o.cost >= bestV) return;
      const v = o.cost + penAgainst(i, o);
      if (v < bestV) {
        bestV = v;
        bestJ = j;
      }
    });
    sel[i] = bestJ;
  }

  // anneal
  const n = loose.length;
  if (n > 1) {
    const ITER = 500 * n;
    const T0 = 80;
    const T1 = 0.5;
    const curPen = sel.map((_, i) => (chosen(i) ? penAgainst(i, chosen(i)!) : 0));
    let total = sel.reduce((m, _, i) => m + (chosen(i)?.cost ?? 0), 0) + curPen.reduce((m, v) => m + v, 0) / 2;
    let bestTotal = total;
    let bestSel = sel.slice();
    for (let it = 0; it < ITER; it++) {
      const T = T0 * Math.pow(T1 / T0, it / ITER);
      const i = Math.floor(rand() * n);
      const L = lists[i];
      if (L.length < 2) continue;
      // nearby options more often than far ones
      const j = Math.floor(Math.pow(rand(), 1.6) * L.length);
      if (j === sel[i]) continue;
      const old = chosen(i);
      const nu = L[j];
      const pNew = penAgainst(i, nu);
      const pOld = old ? curPen[i] : 0;
      const delta = nu.cost - (old?.cost ?? 0) + pNew - pOld;
      if (delta < 0 || rand() < Math.exp(-delta / T)) {
        // the neighbours' pair terms change with it
        for (let k = 0; k < n; k++) {
          const ok = k === i ? null : chosen(k);
          if (ok) curPen[k] += pen(ok, nu) - (old ? pen(ok, old) : 0);
        }
        sel[i] = j;
        curPen[i] = pNew;
        total += delta;
        if (total < bestTotal - 1e-6) {
          bestTotal = total;
          bestSel = sel.slice();
        }
      }
    }
    for (let i = 0; i < n; i++) sel[i] = bestSel[i];
  }

  // commit, then any note still clashing (or with no shortlist) finds a spot
  // with all the others fixed, wider if it must
  const clashing: NoteSpec[] = [];
  for (let i = 0; i < n; i++) {
    const o = chosen(i);
    if (!o) {
      clashing.push(loose[i]);
      continue;
    }
    commit(loose[i], toPlace(loose[i], o.c, o.cost, false, false, o.bend));
  }
  for (let i = 0; i < n; i++) {
    const o = chosen(i);
    if (!o) continue;
    const me = lift(loose[i].key)!;
    if (notesHit(o.c.box)) clashing.push(loose[i]);
    else commit(loose[i], me.p);
  }
  for (const s of clashing) commit(s, best(s));

  return specs.map((s) => placed.get(s.key)!.p);
}
