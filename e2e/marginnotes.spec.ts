// Margin notes (lib/marginNotes.ts + lib/drill.ts cleanDrill, pure).
import { expect, test } from "@playwright/test";
import { cleanDrill } from "../src/lib/drill";
import { existsSync, readFileSync } from "node:fs";
import {
  leaderGeom,
  noteWords,
  placeNotes,
  rectDist,
  type Field,
  type NotePlace,
  type NoteSpec,
  type Rect,
} from "../src/lib/marginNotes";

// The notes are your own now (the drill-sergeant model and its notes are
// gone): they read exactly as written, whitespace collapsed. The model-era
// cleanup cut a note that began with the title ("Gymnastics…" under "Gym").
test("drill text: your note reads as you wrote it", () => {
  const cases: [string, string, string | null][] = [
    ["Gym", "Gymnastics class next door was loud", "Gymnastics class next door was loud"],
    ["Asleep (8.0h)", "slept   late\n again", "slept late again"],
    ["Read an essay", "*good* work", "*good* work"],
    ["Read", "...", "..."],
    ["Read", "   ", null],
    // (the old model's stage directions still come off)
    ["Read Chapter 4", "**[Red Marker Scribble in Margin Next to  Read Chapter 4 ]**  You *will* understand it.", "You *will* understand it."],
  ];
  for (const [title, raw, want] of cases) expect(cleanDrill(raw, title), title).toBe(want);
});

test("drill text: a lone * is text, not the start of an underline", () => {
  const w = noteWords("5 * 3 sets felt heavy");
  expect(w.map((x) => x.t).join(" ")).toBe("5 * 3 sets felt heavy");
  expect(w.filter((x) => x.em)).toHaveLength(0);
});

// ---------------------------------------------------------------- placement

const mono = (s: string) => s.length * 6;
const meets = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/** the laws every placement must keep */
function lawBreaks(field: Field, specs: NoteSpec[], out: NotePlace[]): string[] {
  const bad: string[] = [];
  out.forEach((p, i) => {
    const sp = specs[i];
    const name = `${sp.key}`;
    // whole: every word, in order
    const shown = p.lines.flat().map((w) => w.t).join(" ");
    if (shown !== sp.words.map((w) => w.t).join(" ")) bad.push(`${name} lost words`);
    if (p.forced) return;
    if (p.box.x0 < -0.01 || p.box.y0 < -0.01 || p.box.x1 > field.w + 0.01 || p.box.y1 > field.h + 0.01) bad.push(`${name} leaves the field`);
    if (!p.pinned) {
      const t = field.text.find((r) => meets(p.box, r));
      if (t) bad.push(`${name} covers text at ${Math.round(t.x0)},${Math.round(t.y0)}`);
    }
    out.forEach((q, j) => {
      if (j > i && meets(p.box, q.box)) bad.push(`${name} overlaps ${specs[j].key}`);
    });
    if (p.inside) {
      if (!sp.own.some((o) => meets(o, p.box))) bad.push(`${name} 'inside' but off its event`);
    } else {
      const g = leaderGeom(p.box, sp.anchor, p.bend);
      if (g && rectDist({ x0: g.e[0], y0: g.e[1], x1: g.e[0], y1: g.e[1] }, sp.anchor) > 4) bad.push(`${name} arrow misses its event`);
      if (!g && rectDist(p.box, sp.anchor) > 8) bad.push(`${name} has no arrow and is away from its event`);
    }
  });
  return bad;
}

/** a random week: columns of stacked events, each with a title row (text)
 *  and a body (fill); some carry notes */
function randomWeek(seed: number, cols = 7, colW = 140, H = 900) {
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const field: Field = { w: cols * colW, h: H, cols: [], text: [], fills: [], titles: [] };
  const specs: NoteSpec[] = [];
  const lines = ["You. Read. Absorb. Now.", "Streams? You're chasing dreams, not dopamine. 0230 lights out.", "good work", "Ship it or kill it. No more polishing, soldier.", "Two hours of this? Justify it."];
  for (let c = 0; c < cols; c++) {
    const x0 = c * colW;
    field.cols.push({ x0, x1: x0 + colW });
    let y = Math.floor(rand() * 60);
    let n = 0;
    while (y < H - 30) {
      const h = 18 + Math.floor(rand() * 90);
      const inset = rand() < 0.2 ? 20 : 0;
      const box = { x0: x0 + 1 + inset, y0: y, x1: x0 + colW - 2, y1: Math.min(H, y + h) };
      const key = `c${c}e${n++}`;
      const title = { x0: box.x0 + 6, y0: box.y0 + 2, x1: box.x0 + 6 + 40 + rand() * (colW - 60 - inset), y1: box.y0 + 16 };
      field.fills.push({ r: box, poor: rand() < 0.1 });
      field.text.push(title);
      field.titles.push({ key, r: title });
      if (rand() < 0.3) {
        specs.push({ key, words: noteWords(lines[Math.floor(rand() * lines.length)]), anchor: title, own: [box], col: c });
      }
      y = box.y1 + (rand() < 0.5 ? 0 : Math.floor(rand() * 50));
    }
  }
  return { field, specs };
}

test("margin notes: over random crowded weeks every note is whole, off the text, apart, and tied to its event", () => {
  let notes = 0;
  for (let s = 1; s <= 40; s++) {
    const { field, specs } = randomWeek(s * 7919);
    const out = placeNotes(field, specs, mono);
    expect(lawBreaks(field, specs, out), `week ${s}`).toEqual([]);
    expect(out.filter((p) => p.forced), `week ${s} forced`).toEqual([]);
    notes += out.length;
  }
  expect(notes).toBeGreaterThan(200);
});

test("margin notes: the same page lays out the same way", () => {
  const { field, specs } = randomWeek(424242);
  const a = placeNotes(field, specs, mono);
  const b = placeNotes(field, specs, mono);
  expect(b).toEqual(a);
});

test("margin notes: a note that fits on its own event's empty body sits there, without an arrow", () => {
  const anchor = { x0: 6, y0: 2, x1: 90, y1: 16 };
  const field: Field = {
    w: 280,
    h: 400,
    cols: [{ x0: 0, x1: 140 }, { x0: 140, x1: 280 }],
    text: [anchor],
    fills: [{ r: { x0: 1, y0: 0, x1: 138, y1: 200 }, poor: false }],
    titles: [{ key: "a", r: anchor }],
  };
  const [p] = placeNotes(field, [{ key: "a", words: noteWords("Three hours and one paper. Read faster."), anchor, own: [{ x0: 1, y0: 0, x1: 138, y1: 200 }], col: 0 }], mono);
  expect(p.inside).toBe(true);
  expect(p.box.y0).toBeGreaterThanOrEqual(anchor.y1);
});

test("margin notes: with no room on its event a note goes outside and its arrow ends at the title", () => {
  const anchor = { x0: 146, y0: 102, x1: 270, y1: 116 };
  const field: Field = {
    w: 420,
    h: 400,
    cols: [0, 1, 2].map((i) => ({ x0: i * 140, x1: i * 140 + 140 })),
    // a short event, its title filling it
    text: [anchor],
    fills: [{ r: { x0: 141, y0: 100, x1: 278, y1: 118 }, poor: false }],
    titles: [{ key: "a", r: anchor }],
  };
  const spec = { key: "a", words: noteWords("Scrolling? You're chasing dreams, not likes."), anchor, own: [{ x0: 141, y0: 100, x1: 278, y1: 118 }], col: 1 };
  const [p] = placeNotes(field, [spec], mono);
  expect(p.inside).toBe(false);
  expect(lawBreaks(field, [spec], [p])).toEqual([]);
  expect(rectDist(p.box, anchor)).toBeLessThan(30);
});

test("margin notes: a note the person moved stays exactly there, and the others keep clear of it", () => {
  const { field, specs } = randomWeek(99);
  const pinned = { ...specs[0], pin: { x: 300, y: 300, w: 120, angle: 0 } };
  const out = placeNotes(field, [pinned, ...specs.slice(1)], mono);
  expect(out[0].pinned).toBe(true);
  expect(out[0].x).toBeCloseTo(300, 5);
  expect(out[0].y).toBeCloseTo(300, 5);
  for (const q of out.slice(1)) expect(meets(out[0].box, q.box)).toBe(false);
});

test("margin notes: a crowded page writes smaller before it gives up a note", () => {
  // one free band 28px tall under the event, text-dense rows below: the
  // full hand needs ~32px with its clearances, the smallest fits
  const anchor = { x0: 6, y0: 2, x1: 130, y1: 16 };
  const text: Rect[] = [anchor];
  for (let y = 44; y < 300; y += 18) text.push({ x0: 0, y0: y, x1: 140, y1: y + 14 });
  const field: Field = { w: 140, h: 300, cols: [{ x0: 0, x1: 140 }], text, fills: [], titles: [{ key: "a", r: anchor }] };
  const [p] = placeNotes(field, [{ key: "a", words: noteWords("Now earn it."), anchor, own: [], col: 0 }], mono);
  expect(p.forced).toBe(false);
  expect(p.scale).toBeLessThan(1);
  expect(lawBreaks(field, [{ key: "a", words: noteWords("Now earn it."), anchor, own: [], col: 0 }], [p])).toEqual([]);
});

// pages captured from the real app (gitignored: real notes)
for (const f of ["margin-field.local.json", "margin-field-zoomout.local.json"]) {
  const path = `e2e/fixtures/${f}`;
  test(`margin notes on a captured real page (${f}): the laws hold`, () => {
    test.skip(!existsSync(path), "no captured page");
    const d = JSON.parse(readFileSync(path, "utf8"));
    const measure = (s: string) => d.widths[s] ?? s.length * 6;
    const t0 = performance.now();
    const out = placeNotes(d.field, d.specs, measure);
    console.log(`[${f}] ${out.length} notes in ${Math.round(performance.now() - t0)} ms; arrows ${out.map((p, i) => (p.inside ? "in" : Math.round(rectDist(p.box, d.specs[i].anchor)))).join(",")}`);
    expect(lawBreaks(d.field, d.specs, out)).toEqual([]);
    expect(out.filter((p) => p.forced)).toEqual([]);
  });
}
