// Your red-pen notes as margin annotations over the week.
// This layer reads where the chips and their text actually landed, hands
// that to lib/marginNotes.ts to place every note in the free space around
// them, and draws the arrows. A note can be dragged to adjust it, its box
// sized by its edges (width, height), and the whole note scaled — writing
// and box together — by its corner (or −/+ while it has focus); all of it is
// remembered relative to its event (lib/notePins.ts). Double-clicking a
// moved note gives it back to the placer.

import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { cleanDrill, splitDrill } from "../lib/drill";
import { rgbToOklab } from "../lib/color";
import {
  leaderGeom,
  lineH,
  NOTE_PADX,
  noteWords,
  pinnedShape,
  placeNotes,
  type Field,
  type NotePlace,
  type NoteSpec,
  type Rect,
  type Shape,
} from "../lib/marginNotes";
import { notePin, setNotePin, subscribeNotePins, type NotePin } from "../lib/notePins";
import PlaceWorker from "../lib/marginNotes.worker?worker";
import type { CalendarEvent } from "../lib/types";

/** the note hand; keep in step with .margin-note in app.css */
const FONT = '12px "Bradley Hand", "Marker Felt", "Segoe Print", cursive';
let ctx: CanvasRenderingContext2D | null = null;
const widths = new Map<string, number>();
function measure(s: string): number {
  let w = widths.get(s);
  if (w === undefined) {
    ctx ??= document.createElement("canvas").getContext("2d");
    if (!ctx) return s.length * 6;
    ctx.font = FONT;
    w = ctx.measureText(s).width;
    widths.set(s, w);
  }
  return w;
}

/** "rgb(…)" / "color(srgb …)" → 0–1 channels */
function parseColor(c: string): [number, number, number] | null {
  const n = c.match(/-?[\d.]+/g)?.map(Number);
  if (!n || n.length < 3) return null;
  return c.startsWith("color(") ? [n[0], n[1], n[2]] : [n[0] / 255, n[1] / 255, n[2] / 255];
}

/** a minus everything in cut (all axis-aligned) */
function subtract(a: Rect[], cut: Rect): Rect[] {
  const out: Rect[] = [];
  for (const r of a) {
    if (cut.x1 <= r.x0 || cut.x0 >= r.x1 || cut.y1 <= r.y0 || cut.y0 >= r.y1) {
      out.push(r);
      continue;
    }
    if (cut.y0 > r.y0) out.push({ ...r, y1: cut.y0 });
    if (cut.y1 < r.y1) out.push({ ...r, y0: cut.y1 });
    const y0 = Math.max(r.y0, cut.y0);
    const y1 = Math.min(r.y1, cut.y1);
    if (cut.x0 > r.x0) out.push({ x0: r.x0, x1: cut.x0, y0, y1 });
    if (cut.x1 < r.x1) out.push({ x0: cut.x1, x1: r.x1, y0, y1 });
  }
  return out;
}

const union = (rs: Rect[]): Rect | null =>
  rs.length
    ? {
        x0: Math.min(...rs.map((r) => r.x0)),
        y0: Math.min(...rs.map((r) => r.y0)),
        x1: Math.max(...rs.map((r) => r.x1)),
        y1: Math.max(...rs.map((r) => r.y1)),
      }
    : null;

/** chipX: each noted event's left edge when placed, so a swipe can carry the
 *  note along with its event (followChips) */
type Placed = { places: NotePlace[]; anchors: Map<string, Rect>; colW: number; chipX: Map<string, number> };
const EMPTY: Placed = { places: [], anchors: new Map(), colW: 1, chipX: new Map() };
/** how long the strip must rest after a swipe step before notes re-place */
const PAN_SETTLE_MS = 160;
/** the sizes −/+ step through (1 = 12px); the placer's own crowded sizes
 *  (lib/marginNotes NOTE_SCALES) are among them. The corner scales freely
 *  between the ends. */
const FONT_STEPS = [0.6, 0.72, 0.85, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.4];
const MIN_SCALE = FONT_STEPS[0];
const MAX_SCALE = FONT_STEPS[FONT_STEPS.length - 1];
/** a dragged-out box ending this close under its text fits the text again */
const FIT_SNAP_PX = 3;

/** `q` drawn in another shape, from the same top-left */
function reshaped(q: NotePlace, s: Shape): NotePlace {
  return { ...q, w: s.w, h: s.h, lines: s.lines, scale: s.scale, box: { x0: q.x, y0: q.y, x1: q.x + s.w, y1: q.y + s.h } };
}

/** one placement worker for the app; null where workers aren't available */
let worker: Worker | null | undefined;
function placer(): Worker | null {
  if (worker === undefined) {
    try {
      worker = new PlaceWorker();
    } catch {
      worker = null;
    }
  }
  return worker;
}

export function MarginNotes(props: {
  /** the strip holding the day columns (lib: WeekView .day-cols) */
  stripRef: React.RefObject<HTMLDivElement | null>;
  days: number;
  /** columns in the strip, overscan included */
  extN: number;
  events: CalendarEvent[];
  /** changes whenever the chips may have moved, except by a swipe */
  layoutKey: unknown;
  /** the first visible day; changing alone means the strip was swiped */
  firstDay: number;
  /** pending visible-column shift for a wheel pan; null for other navigation */
  panSteps: number | null;
  pxPerMin: number;
  keyOf: (e: CalendarEvent) => string;
  onSelect: (e: CalendarEvent) => void;
  onDelete: (e: CalendarEvent) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<Placed>(EMPTY);
  /** the measured page last sent off, and the latest request number */
  const lastRef = useRef<{ page: string; notes: string; seq: number }>({ page: "", notes: "", seq: 0 });
  const [drag, setDrag] = useState<{ key: string; dx: number; dy: number } | null>(null);
  /** the box being sized, as it is under the pointer */
  const [sizing, setSizing] = useState<{ key: string; shape: Shape } | null>(null);
  const [pinTick, bumpPins] = useState(0);
  useLayoutEffect(() => subscribeNotePins(() => bumpPins((n) => n + 1)), []);
  const [fontTick, bumpFont] = useState(0);
  useLayoutEffect(() => {
    let live = true;
    document.fonts?.ready.then(() => {
      if (!live) return;
      widths.clear();
      bumpFont((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, []);

  const notesOf = new Map<string, { e: CalendarEvent; text: string }>();
  for (const e of props.events) {
    const t = cleanDrill(splitDrill(e.description).drill, e.summary);
    if (t) notesOf.set(props.keyOf(e), { e, text: t });
  }
  const noteSig = [...notesOf].map(([k, v]) => k + "\u0001" + v.text).join("\u0002");

  /** A swipe step re-renders the strip one column over. Carry each placed
   *  note by exactly as far as its event's chip moved, in the same commit,
   *  instead of clearing every note and re-measuring the whole week (which
   *  blanked the notes for most of a swipe and cost a full layout read per
   *  day). Notes whose event left the strip go; the full placement runs once
   *  the strip comes to rest. */
  const followChips = () => {
    const layer = layerRef.current;
    const strip = props.stripRef.current;
    if (!layer || !strip || !placed.places.length) return;
    const dxOf = new Map<string, number>();
    const chipX = new Map<string, number>();
    if (props.panSteps != null && placed.colW > 0) {
      // All three calendar strips move by the same cached column width. Notes
      // follow that exact transform without querying chip geometry (which
      // forced WebKit to lay out the dense grid after every day boundary).
      const dx = -props.panSteps * placed.colW;
      for (const p of placed.places) {
        const was = placed.chipX.get(p.key);
        if (was === undefined) continue;
        dxOf.set(p.key, dx);
        chipX.set(p.key, was + dx);
      }
    } else {
      // Non-pan navigation can jump an arbitrary distance, so measure once
      // and preserve the existing behavior for Today/arrows/mini-calendar.
      const L = layer.getBoundingClientRect();
      for (const p of placed.places) {
        const was = placed.chipX.get(p.key);
        const el = strip.querySelector<HTMLElement>(`.chip-timed[data-ek="${CSS.escape(p.key)}"], .cluster-block [data-ek="${CSS.escape(p.key)}"]`);
        if (was === undefined || !el) continue;
        const x = el.getBoundingClientRect().left - L.left;
        dxOf.set(p.key, x - was);
        chipX.set(p.key, x);
      }
    }
    const shift = (r: Rect, dx: number): Rect => ({ x0: r.x0 + dx, y0: r.y0, x1: r.x1 + dx, y1: r.y1 });
    const anchors = new Map<string, Rect>();
    for (const [k, a] of placed.anchors) if (dxOf.has(k)) anchors.set(k, shift(a, dxOf.get(k)!));
    setPlaced({
      ...placed,
      anchors,
      chipX,
      places: placed.places
        .filter((p) => dxOf.has(p.key))
        .map((p) => {
          const dx = dxOf.get(p.key)!;
          return dx ? { ...p, x: p.x + dx, box: shift(p.box, dx) } : p;
        }),
    });
  };

  /** measure the page and place every note (off-thread when possible).
   *  keepShown: the notes on screen already point at the right events (they
   *  followed a swipe), so leave them up until the new spots are in. */
  const place = (keepShown: boolean) => {
    const layer = layerRef.current;
    const strip = props.stripRef.current;
    if (!layer || !strip) return;
    const L = layer.getBoundingClientRect();
    if (L.width < 10 || L.height < 10 || !notesOf.size) {
      lastRef.current.page = "";
      if (placed.places.length) setPlaced(EMPTY);
      return;
    }
    const rel = (r: DOMRect | Rect): Rect =>
      "left" in r
        ? { x0: r.left - L.left, y0: r.top - L.top, x1: r.right - L.left, y1: r.bottom - L.top }
        : r;
    const colEls = [...strip.querySelectorAll<HTMLElement>("[data-testid^=day-col-]")];
    const cols = colEls
      .map((el) => ({ el, ...rel(el.getBoundingClientRect()) }))
      .sort((a, b) => a.x0 - b.x0);
    const colW = cols.length ? (cols[cols.length - 1].x1 - cols[0].x0) / cols.length : L.width;
    const ink = getComputedStyle(layer).color;
    const inkLab = (() => {
      const c = parseColor(ink);
      return c ? rgbToOklab(...c) : null;
    })();

    const text: Rect[] = [];
    const fills: Field["fills"] = [];
    const titles: Field["titles"] = [];
    const chips: { key: string; col: number; z: number; r: Rect; el: HTMLElement }[] = [];
    /** visible ink of a text element: its line boxes, inside the element */
    const inkOf = (el: HTMLElement): Rect[] => {
      const box = el.getBoundingClientRect();
      const rg = document.createRange();
      rg.selectNodeContents(el);
      const out: Rect[] = [];
      for (const r of rg.getClientRects()) {
        const x0 = Math.max(r.left, box.left);
        const x1 = Math.min(r.right, box.right);
        const y0 = Math.max(r.top, box.top);
        const y1 = Math.min(r.bottom, box.bottom);
        if (x1 - x0 > 0.5 && y1 - y0 > 0.5) out.push({ x0: x0 - L.left, y0: y0 - L.top, x1: x1 - L.left, y1: y1 - L.top });
      }
      return out;
    };
    cols.forEach((c, ci) => {
      for (const el of c.el.querySelectorAll<HTMLElement>(".chip-timed, .cluster-block")) {
        const r = rel(el.getBoundingClientRect());
        const z = Number(el.style.zIndex) || 0;
        const bg = parseColor(getComputedStyle(el).backgroundColor);
        let poorFill = false;
        if (bg && inkLab) {
          const b = rgbToOklab(...bg);
          poorFill = Math.hypot(b[0] - inkLab[0], b[1] - inkLab[1], b[2] - inkLab[2]) < 0.22;
        }
        fills.push({ r, poor: poorFill });
        if (el.classList.contains("cluster-block")) {
          text.push(r);
          for (const row of el.querySelectorAll<HTMLElement>("[data-ek]")) {
            const rr = rel(row.getBoundingClientRect());
            chips.push({ key: row.dataset.ek!, col: ci, z: z + 0.5, r: rr, el: row });
            titles.push({ key: row.dataset.ek!, r: rr });
          }
          continue;
        }
        for (const t of el.querySelectorAll<HTMLElement>(".chip-abs, .chip-join, .chip-title")) text.push(...inkOf(t));
        const key = el.dataset.ek;
        if (!key) continue;
        chips.push({ key, col: ci, z, r, el });
        const head = union(
          [...el.querySelectorAll<HTMLElement>(".chip-title, .chip-line, .chip-time")].flatMap((t) => inkOf(t)),
        );
        titles.push({ key, r: head ?? r });
      }
    });

    const anchors = new Map<string, Rect>();
    const chipX = new Map<string, number>();
    const specs: NoteSpec[] = [];
    for (const [key, { text: note }] of notesOf) {
      const chip = chips.find((c) => c.key === key && titles.some((t) => t.key === key));
      if (!chip) continue;
      const anchor = titles.find((t) => t.key === key && t.r.x0 >= chip.r.x0 - 1 && t.r.x1 <= chip.r.x1 + 1)?.r ?? chip.r;
      // the part of the event no later-painted event covers
      let own: Rect[] = [chip.r];
      for (const o of chips) if (o.col === chip.col && o.z > chip.z && o.key !== key) own = subtract(own, o.r);
      const pin = notePin(key);
      anchors.set(key, anchor);
      chipX.set(key, chip.el.getBoundingClientRect().left - L.left);
      specs.push({
        key,
        words: noteWords(note),
        anchor,
        own,
        col: chip.col,
        pin: pin && {
          x: anchor.x0 + pin.dxCol * colW,
          y: anchor.y0 + pin.dyMin * props.pxPerMin,
          w: pin.w,
          angle: pin.angle,
          scale: pin.scale ?? 1,
          h: pin.h,
        },
      });
    }
    const field: Field = {
      w: L.width,
      h: L.height,
      cols: cols.map((c) => ({ x0: c.x0, x1: c.x1 })),
      text,
      fills,
      titles,
    };
    // nothing moved: keep what is on the page
    const r1 = (r: Rect) => `${Math.round(r.x0)},${Math.round(r.y0)},${Math.round(r.x1)},${Math.round(r.y1)}`;
    const page = `${Math.round(field.w)}x${Math.round(field.h)}|${text.map(r1).join(";")}|${fills.map((f) => r1(f.r) + (f.poor ? "!" : "")).join(";")}`;
    const notesSig = JSON.stringify(specs.map((sp) => [sp.key, r1(sp.anchor), sp.words, sp.pin]));
    const last = lastRef.current;
    if (page === last.page && notesSig === last.notes) return;
    // the page itself changed (another week, a zoom): old notes would point
    // at the wrong things, so they go until the new spots are in
    if (!keepShown && page !== last.page && placed.places.length) setPlaced(EMPTY);
    last.page = page;
    last.notes = notesSig;
    const seq = ++last.seq;
    layer.dataset.pending = "1";
    const w: Record<string, number> = { " ": measure(" ") };
    for (const sp of specs) for (const wd of sp.words) w[wd.t] = measure(wd.t);
    if (import.meta.env.DEV) {
      (window as unknown as { __marginInput?: unknown }).__marginInput = { field, specs, widths: w };
    }
    const done = (places: NotePlace[], ms: number) => {
      if (seq !== lastRef.current.seq) return; // a newer page is on its way
      if (layerRef.current) layerRef.current.dataset.pending = "0";
      (window as unknown as { __marginMs?: number }).__marginMs = ms;
      setPlaced((cur) => {
        if (!keepShown) return { places, anchors, colW, chipX };
        // A swipe has already carried every visible note by exactly the
        // distance its chip moved. The settled placement is still needed to
        // add notes entering the viewport and discard notes that left, but
        // replacing surviving notes with its newly chosen positions makes
        // them snap after the user's fingers stop (often by a whole column).
        // Keep each survivor's event-relative position; use fresh placement
        // only for newly visible notes.
        const surviving = new Map(cur.places.map((p) => [p.key, p]));
        return {
          places: places.map((p) => surviving.get(p.key) ?? p),
          anchors,
          colW,
          chipX,
        };
      });
    };
    const wk = placer();
    if (wk) {
      const t0 = performance.now();
      const onMsg = (ev: MessageEvent<{ seq: number; places: NotePlace[] }>) => {
        if (ev.data.seq !== seq) return;
        wk.removeEventListener("message", onMsg);
        done(ev.data.places, performance.now() - t0);
      };
      wk.addEventListener("message", onMsg);
      wk.postMessage({ seq, field, specs, widths: w });
    } else {
      const t0 = performance.now();
      done(placeNotes(field, specs, (x) => w[x] ?? measure(x)), performance.now() - t0);
    }
  };
  // the settle timer calls the newest render's place()
  const placeRef = useRef(place);
  placeRef.current = place;
  const settleRef = useRef<number | null>(null);
  const depsRef = useRef<unknown[] | null>(null);
  useLayoutEffect(() => {
    const deps = [props.layoutKey, props.days, props.pxPerMin, noteSig, pinTick, fontTick];
    const prev = depsRef.current;
    depsRef.current = deps;
    if (settleRef.current != null) {
      clearTimeout(settleRef.current);
      settleRef.current = null;
    }
    if (prev && deps.every((d, i) => d === prev[i])) {
      // only firstDay moved: a swipe step
      followChips();
      settleRef.current = window.setTimeout(() => {
        settleRef.current = null;
        placeRef.current(true);
      }, PAN_SETTLE_MS);
      return;
    }
    place(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.layoutKey, props.days, props.pxPerMin, noteSig, pinTick, fontTick, props.firstDay]);
  useLayoutEffect(
    () => () => {
      if (settleRef.current != null) clearTimeout(settleRef.current);
    },
    [],
  );

  const startDrag = (pe: React.PointerEvent<HTMLDivElement>, p: NotePlace) => {
    if (pe.button !== 0) return;
    pe.stopPropagation();
    pe.preventDefault();
    const el = pe.currentTarget;
    el.setPointerCapture(pe.pointerId);
    const sx = pe.clientX;
    const sy = pe.clientY;
    let moved = false;
    const move = (e: PointerEvent) => {
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      setDrag({ key: p.key, dx, dy });
    };
    const end = (e: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      setDrag(null);
      if (e.type === "pointercancel") return;
      const a = placed.anchors.get(p.key);
      if (moved && a) {
        const dx = e.clientX - sx;
        const dy = e.clientY - sy;
        setPlaced((cur) => ({
          ...cur,
          places: cur.places.map((q) =>
            q.key === p.key
              ? {
                  ...q,
                  x: q.x + dx,
                  y: q.y + dy,
                  box: { x0: q.box.x0 + dx, y0: q.box.y0 + dy, x1: q.box.x1 + dx, y1: q.box.y1 + dy },
                  inside: false,
                  pinned: true,
                }
              : q,
          ),
        }));
        setNotePin(p.key, pinOf({ ...p, x: p.x + dx, y: p.y + dy }));
      } else if (!moved) {
        const n = notesOf.get(p.key);
        if (n) {
          // pointerdown is prevented so a drag cannot start an event drag;
          // restore focus explicitly so Delete belongs to the annotation.
          el.focus({ preventScroll: true });
          props.onSelect(n.e);
        }
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  /** the pin holding `p` where it is now, keeping what the person set */
  const pinOf = (p: NotePlace): NotePin | null => {
    const a = placed.anchors.get(p.key);
    if (!a) return null;
    const was = notePin(p.key);
    return {
      dxCol: (p.x - a.x0) / placed.colW,
      dyMin: (p.y - a.y0) / props.pxPerMin,
      w: was?.w ?? p.w - 1 - 2 * NOTE_PADX,
      angle: p.angle,
      scale: was?.scale ?? p.scale,
      ...(was?.h != null ? { h: was.h } : {}),
    };
  };

  /** pin `key` as `pin` and draw it that way now, not when the placer is back */
  const commitShape = (key: string, pin: NotePin) => {
    const words = noteWords(notesOf.get(key)?.text ?? "");
    const shape = pinnedShape(words, pin, measure);
    setPlaced((cur) => ({
      ...cur,
      places: cur.places.map((q) => (q.key === key ? { ...reshaped(q, shape), pinned: true } : q)),
    }));
    setNotePin(key, pin);
  };

  /** Size the box from an edge: the text re-wraps to the width live; the
   *  height can't go under the text, and stopping just short of it fits the
   *  box to the text again. Or scale the whole note from its corner: the
   *  writing and the box grow or shrink together along the box's diagonal,
   *  so the lines break where they did. */
  const startSize = (pe: React.PointerEvent<HTMLDivElement>, p: NotePlace, axes: "x" | "y" | "xy") => {
    if (pe.button !== 0) return;
    pe.stopPropagation();
    pe.preventDefault();
    const handle = pe.currentTarget;
    const noteEl = handle.closest<HTMLElement>(".margin-note");
    handle.setPointerCapture(pe.pointerId);
    const base = pinOf(p);
    const text = notesOf.get(p.key)?.text;
    if (!base || !text) return;
    const words = noteWords(text);
    const sx = pe.clientX;
    const sy = pe.clientY;
    // the box is turned a little: measure along its own sides
    const t = (p.angle * Math.PI) / 180;
    const w0 = p.w - 1 - 2 * NOTE_PADX;
    const h0 = p.h;
    const pinAt = (e: PointerEvent): NotePin => {
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (axes === "xy") {
        // the pointer's travel along the box's diagonal, as a share of it
        const dw = dx * Math.cos(t) + dy * Math.sin(t);
        const dh = -dx * Math.sin(t) + dy * Math.cos(t);
        const k0 = 1 + (dw * p.w + dh * p.h) / (p.w * p.w + p.h * p.h);
        const s0 = base.scale ?? 1;
        const s1 = Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, s0 * k0)) * 100) / 100;
        const k = s1 / s0;
        return { ...base, scale: s1, w: base.w * k, ...(base.h ? { h: base.h * k } : {}) };
      }
      const w = axes === "y" ? w0 : Math.min(800, Math.max(8, w0 + dx * Math.cos(t) + dy * Math.sin(t)));
      let h = axes === "x" ? (base.h ?? 0) : Math.max(0, h0 - dx * Math.sin(t) + dy * Math.cos(t));
      const fit = pinnedShape(words, { ...base, w, h: 0 }, measure);
      if (h <= fit.h + FIT_SNAP_PX) h = 0;
      return { ...base, w, h };
    };
    let moved = false;
    const move = (e: PointerEvent) => {
      if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 2) return;
      moved = true;
      setSizing({ key: p.key, shape: pinnedShape(words, pinAt(e), measure) });
    };
    const end = (e: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      setSizing(null);
      noteEl?.focus({ preventScroll: true });
      if (e.type === "pointercancel" || !moved) return;
      commitShape(p.key, pinAt(e));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  /** one step bigger or smaller writing; the box grows or shrinks with it,
   *  so the lines break where they did */
  const stepFont = (p: NotePlace, dir: 1 | -1) => {
    const base = pinOf(p);
    if (!base) return;
    const s0 = base.scale ?? 1;
    const s1 = dir > 0 ? FONT_STEPS.find((s) => s > s0 + 1e-3) : [...FONT_STEPS].reverse().find((s) => s < s0 - 1e-3);
    if (s1 === undefined) return;
    const k = s1 / s0;
    commitShape(p.key, { ...base, scale: s1, w: base.w * k, ...(base.h ? { h: base.h * k } : {}) });
  };

  const pct = 100 / props.extN;
  const shown = (p: NotePlace) => (sizing?.key === p.key ? reshaped(p, sizing.shape) : p);
  return (
    <div
      className="margin-notes"
      ref={layerRef}
      style={{ left: `${pct}%`, width: `${pct * props.days}%` }}
      data-testid="margin-notes"
    >
      <svg className="mn-leaders" aria-hidden>
        {placed.places.map((p0) => {
          const p = shown(p0);
          const a = placed.anchors.get(p.key);
          if (!a || p.inside) return null;
          const d = drag?.key === p.key ? drag : null;
          const box = d ? { x0: p.box.x0 + d.dx, y0: p.box.y0 + d.dy, x1: p.box.x1 + d.dx, y1: p.box.y1 + d.dy } : p.box;
          const g = leaderGeom(box, a, p.bend);
          if (!g) return null;
          const f = (q: [number, number]) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`;
          return (
            <g key={p.key} data-testid="margin-leader" data-ek={p.key} className={d ? "dragging" : undefined}>
              <path d={`M${f(g.s)} Q${f(g.c)} ${f(g.e)}`} />
              <path d={`M${f(g.head[0])} L${f(g.head[1])} L${f(g.head[2])}`} />
            </g>
          );
        })}
      </svg>
      {placed.places.map((p0) => {
        const p = shown(p0);
        const d = drag?.key === p.key ? drag : null;
        const sized = sizing?.key === p.key;
        /** the handles: no click on them is a click on the note (two quick
         *  drags are not a double-click reset) */
        const own = {
          onClick: (e: React.MouseEvent) => e.stopPropagation(),
          onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
        };
        return (
          <div
            key={p.key}
            className={
              "margin-note" +
              (p.pinned ? " pinned" : "") +
              (d ? " dragging" : "") +
              (sized ? " sizing" : "") +
              (p.forced ? " forced" : "")
            }
            data-testid="margin-note"
            data-ek={p.key}
            data-inside={p.inside ? 1 : 0}
            tabIndex={0}
            role="button"
            aria-label={`Annotation for ${notesOf.get(p.key)?.e.summary ?? "event"}`}
            title={
              "Drag to move · edges: width and height · corner: scale the writing" +
              (p.pinned ? " · double-click to let it find its own spot" : "")
            }
            style={{
              left: p.x + (d?.dx ?? 0),
              top: p.y + (d?.dy ?? 0),
              width: p.w,
              height: p.h,
              fontSize: p.scale === 1 ? undefined : `${(12 * p.scale).toFixed(2)}px`,
              lineHeight: p.scale === 1 ? undefined : `${lineH(p.scale)}px`,
              transform: p.angle ? `rotate(${p.angle}deg)` : undefined,
            }}
            onPointerDown={(pe) => startDrag(pe, p)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              const bigger = e.key === "+" || e.key === "=";
              const smaller = e.key === "-" || e.key === "_";
              if ((bigger || smaller) && !e.metaKey && !e.ctrlKey && !e.altKey) {
                e.preventDefault();
                e.stopPropagation();
                stepFont(p0, bigger ? 1 : -1);
                return;
              }
              if (e.key !== "Delete" && e.key !== "Backspace") return;
              e.preventDefault();
              e.stopPropagation();
              const n = notesOf.get(p.key);
              if (n) props.onDelete(n.e);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setNotePin(p.key, null);
            }}
          >
            {p.lines.map((ln, i) => (
              // each line exactly the height the placer reserved for it
              <div className="mn-line" key={i} style={{ height: lineH(p.scale) }}>
                {ln.map((w, j) => (
                  <Fragment key={j}>
                    {j ? " " : ""}
                    {w.em ? <u>{w.t}</u> : w.t}
                  </Fragment>
                ))}
                {/* a real space between lines, so copied text reads right */}
                {i < p.lines.length - 1 && <span className="mn-gap"> </span>}
              </div>
            ))}
            <div className="mn-size mn-size-x" data-testid="note-size-w" {...own} onPointerDown={(e) => startSize(e, p0, "x")} />
            <div className="mn-size mn-size-y" data-testid="note-size-h" {...own} onPointerDown={(e) => startSize(e, p0, "y")} />
            <div className="mn-size mn-size-xy" data-testid="note-size" {...own} onPointerDown={(e) => startSize(e, p0, "xy")} />
          </div>
        );
      })}
    </div>
  );
}
