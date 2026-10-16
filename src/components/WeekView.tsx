// Week / Day time grid: Notion-style dense grid, drag-create on empty space,
// drag-move chips across time and days, bottom-edge resize, esc cancels drags,
// selection ring, right-click context menu, full-width now line + gutter pill,
// faded past events, persistent draft chip while creating.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  addDays,
  eventDates,
  fmtChipRange,
  fmtTimeShort,
  isSameDay,
  minutesOfDay,
  now,
  shiftWallClock,
  startOfDay,
  toLocalISO,
  format,
  wallShiftBetween,
  type WallShift,
} from "../lib/dates";
import { jointClipPath, jointPathD, packDayWithSleeves, SLEEVE_LANE_WIDTH } from "../lib/layout";
import { blockBandPx } from "../lib/chipText";
import { planText, visibleRegions, type PlacedText, type ShapeBox, type TextSpec } from "../lib/labelPlace";
import { FOCUS, DEEP_CALENDARS, focusScore, fmtClock, fmtH, type FocusScore } from "../lib/insights";
import { starKey, starState, subscribeStars, toggleStar } from "../lib/stars";
import { reconKey, reconOf, reconSince, reconState, setRecon, subscribeRecon } from "../lib/recon";
import { colorOf } from "../lib/useBackend";
import { MarginNotes } from "./MarginNotes";
import { calendarEditable } from "../lib/types";
import type { Backend, Calendar, CalendarEvent } from "../lib/types";
import type { EventActions } from "./App";

const DEFAULT_HOUR_PX = 48;
const SNAP_MIN = 15;
const DAY_MIN = 24 * 60;

export interface DraftEvent {
  start: Date;
  end: Date;
  allDay: boolean;
}

interface DragState {
  kind: "create" | "move" | "resize";
  /** option-drag: drop creates a copy instead of moving (Notion) */
  duplicate?: boolean;
  event?: CalendarEvent;
  dayIndex: number;
  anchorMin: number;
  grabOffsetMin?: number;
  durationMin?: number;
  curDayIndex: number;
  curMin: number;
  moved: boolean;
  clientX: number;
  clientY: number;
  /** while moving: pointer is over the all-day lane of this day index */
  allDayDropDay?: number | null;
}

interface CtxMenu {
  x: number;
  y: number;
  event: CalendarEvent;
}

function snap(min: number): number {
  return Math.round(min / SNAP_MIN) * SNAP_MIN;
}

/** Day + wall-clock minutes -> Date. setHours is DST-aware, unlike adding ms
 *  to midnight (which lands an hour off on 23/25-hour days). */
function atWallClock(day: Date, minutes: number): Date {
  const d = startOfDay(day);
  const h = Math.floor(minutes / 60);
  d.setHours(h, minutes - h * 60, 0, 0); // floor-mod keeps negatives correct
  return d;
}

function keyOf(e: { calendar_id: string; id: string }): string {
  return `${e.calendar_id}/${e.id}`;
}

/** over, whether reviewed yet or not: past events read faded (app.css .past) */
function ended(e: CalendarEvent, now: Date): boolean {
  return eventDates(e).end.getTime() <= now.getTime();
}

export function WeekView(props: {
  backend: Backend | null;
  days: Date[];
  events: CalendarEvent[];
  calendars: Calendar[];
  selected: CalendarEvent[];
  draft: DraftEvent | null;
  onToggleSelect: (e: CalendarEvent) => void;
  onClipboard?: (e: CalendarEvent, cut: boolean) => void;
  onSelectMany: (evs: CalendarEvent[]) => void;
  onMoveSelected: (shift: WallShift) => void;
  panelOpen: boolean;
  hourPx?: number;
  secondaryTz?: string | null;
  actions: EventActions;
  onOpenEvent: (e: CalendarEvent, anchor?: { x: number; y: number }) => void;
  onSelect: (e: CalendarEvent | null) => void;
  onHover?: (e: CalendarEvent | null) => void;
  onDraft: (d: DraftEvent, anchor?: { x: number; y: number }) => void;
  onPan?: (deltaDays: number) => void;
  hideWeekends?: boolean;
  /** tail-overlap joint style; chips tile the column instead of painting over */
  seamStyle?: "scarf" | "rabbet" | "overlay";
}) {
  const { days, events, calendars } = props;
  const adjacentDay = (day: Date, direction: -1 | 1): Date => {
    let next = addDays(day, direction);
    if (props.hideWeekends) {
      while (next.getDay() === 0 || next.getDay() === 6) next = addDays(next, direction);
    }
    return next;
  };
  const beforeDay = adjacentDay(days[0], -1);
  const afterDay = adjacentDay(days[days.length - 1], 1);
  const pxPerMin = (props.hourPx ?? DEFAULT_HOUR_PX) / 60;
  const gutterW = props.secondaryTz ? 92 : 46;
  const tzLabel = (h: number): string => {
    try {
      return new Intl.DateTimeFormat([], {
        hour: "numeric",
        timeZone: props.secondaryTz!,
      }).format(atWallClock(days[0] ?? now(), h * 60));
    } catch {
      return "";
    }
  };
  const gridRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  /** the focus-score explanation being hovered: its day and badge position */
  const [scorePop, setScorePop] = useState<{ day: Date; x: number; y: number } | null>(null);
  const [, forceTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const [starTick, bumpStar] = useState(0);
  useEffect(() => subscribeStars(() => bumpStar((n) => n + 1)), []);
  const [reconTick, bumpRecon] = useState(0);
  useEffect(() => subscribeRecon(() => bumpRecon((n) => n + 1)), []);

  // Notion: a horizontal two-finger swipe slides the day columns under the
  // pointer, pixel for pixel. Three strips (headers, all-day, body) translate
  // together with one overscan column per side. Crossing a column width
  // requests a day shift without forcing a React render inside the wheel
  // handler. A later wheel event resumes from the same partial-column offset.
  const dayClipRef = useRef<HTMLDivElement | null>(null);
  const [colPx, setColPx] = useState(0);
  const colPxRef = useRef(1);
  useEffect(() => {
    const el = dayClipRef.current;
    if (!el) return;
    const measure = () => {
      const width = Math.max(1, el.clientWidth / Math.max(1, days.length));
      colPxRef.current = width;
      setColPx(width);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [days.length]);
  const seamMode = props.seamStyle ?? "rabbet";
  /** inner text width of a full-width box at this inset (border, gap and
   *  horizontal padding off); unbounded until the column is measured */
  const textWidth = (insetPx: number) => (colPx > 0 ? colPx - insetPx - 15 : 1e6);
  /** Lay out one day and place every event's text in its visible shape.
   *  First pass: no label bands beyond one title row, so enclosed events
   *  stay at their true times. Events whose text block didn't fit there —
   *  title cut short, or time pushed out of the block (sideways, beside a
   *  shortened title, or dropped) — then get a band tall enough for the
   *  whole block, pushing what they enclose down (and a joint above them
   *  up), and the day is laid out again. */
  const layoutDay = (dayItems: { item: CalendarEvent; startMin: number; endMin: number }[]) => {
    const joints = (props.seamStyle ?? "rabbet") !== "overlay";
    let packed = packDayWithSleeves(dayItems, pxPerMin, 17, joints);
    let placed = placeColumnText(packed);
    if (placed) {
      const needs = new Set<CalendarEvent>();
      for (const [e, p] of placed) {
        if (!p.titleWhole || !p.titleAtTop || p.rule === "none" || p.rule === "inline-short" || p.rule === "spine") {
          needs.add(e);
        }
      }
      if (needs.size) {
        packed = packDayWithSleeves(dayItems, pxPerMin, 17, joints, (e, insetPx) => {
          if (!needs.has(e)) return 0;
          const { start, end } = eventDates(e);
          return blockBandPx(e.summary, start, end, textWidth(insetPx), !!starState(starKey(e)));
        });
        placed = placeColumnText(packed);
      }
    }
    return { packed, placed };
  };
  /** where each event's title / time / extras go inside the part of it
   *  that is actually visible (lib/labelPlace.ts); null until measured */
  const placeColumnText = (
    packed: ReturnType<typeof packDayWithSleeves<CalendarEvent>>,
  ): Map<CalendarEvent, PlacedText> | null => {
    if (colPx <= 0) return null;
    const W = colPx - 1; // the column's padding box (1px left border)
    const boxes: ShapeBox<object>[] = [];
    const specs = new Map<CalendarEvent, TextSpec>();
    const box = (
      key: object, inset: number, top: number, height: number, st: number, sb: number, z: number, ring: number,
      stepTop: number | null = null, stepBottom: number | null = null,
    ) =>
      boxes.push({ key, z, left: inset, width: W - inset - 2, clipWidth: colPx - inset - 2, top, height, seamTop: st, seamBottom: sb, stepTop, stepBottom, ring });
    const spec = (e: CalendarEvent, padL: number, height: number, slab: boolean): TextSpec => {
      const { start, end } = eventDates(e);
      return {
        title: e.summary,
        start,
        end,
        bold: !!starState(starKey(e)),
        location: e.location,
        padL,
        xs: height < 16,
        join: !slab && !!e.conference_url && height >= 40,
      };
    };
    for (const c of packed.containers) {
      box(c.item, c.lane * SLEEVE_LANE_WIDTH, c.top, c.height, c.seamTopPx, c.seamBottomPx, c.z, 0, c.seamTopStepPx, c.seamBottomStepPx);
      specs.set(c.item, spec(c.item, 7, c.height, true));
    }
    for (const r of packed.regular) {
      // chips paint a 1px background ring around themselves (goal rings
      // are drawn inside the box)
      box(r.item, r.insetPx, r.top, r.height, r.seamTopPx, r.seamBottomPx, r.z, 1, r.seamTopStepPx, r.seamBottomStepPx);
      specs.set(r.item, spec(r.item, 6, r.height, false));
    }
    for (const cl of packed.clusters) box(cl, cl.insetPx, cl.top, cl.height, 0, 0, cl.z, 0);
    const vis = visibleRegions(boxes, seamMode);
    const out = new Map<CalendarEvent, PlacedText>();
    for (const [e, sp] of specs) out.set(e, planText(vis.get(e) ?? [], sp));
    return out;
  };
  /** width of a full-width box at this inset (column minus its 1px border
   *  and the 2px gap) */
  const boxW = (insetPx: number) => colPx - insetPx - 3;
  /** rounded joint clip for a chip/slab of the given inset, or undefined */
  const jointClip = (insetPx: number, height: number, st: number, sb: number, stepT: number | null, stepB: number | null) => {
    if (seamMode === "overlay" || (st <= 0 && sb <= 0) || colPx <= 0) return undefined;
    return jointClipPath(boxW(insetPx), height, st, sb, seamMode, 4, stepT, stepB);
  };
  /** A jointed shape's seam: plain chips are set apart by a 1px ring of page
   *  color outside them (a box-shadow), but a joint's clip-path cuts that
   *  ring off, so two interlocking events of one calendar fused into a
   *  single blob with a stray notch. The same ring, traced inside the
   *  shape's own outline (notch included); the clip keeps its inner half. */
  const jointSeam = (insetPx: number, height: number, st: number, sb: number, stepT: number | null, stepB: number | null) => {
    if (seamMode === "overlay" || (st <= 0 && sb <= 0) || colPx <= 0) return null;
    const w = boxW(insetPx);
    const d = jointPathD(w, height, st, sb, seamMode === "scarf" ? "scarf" : "rabbet", 4, stepT, stepB);
    return (
      <svg className="joint-seam" width={w} height={height} aria-hidden data-testid="joint-seam">
        <path d={d} />
      </svg>
    );
  };
  /** Goal work's shine: a short gold light that runs once around the box's
   *  own outline (a joint's notch included) at constant speed, then rests
   *  (CSS .goal-run). It is an SVG dash travelling along the outline path,
   *  centred on the edge so the box's clip keeps its inner half. Each event
   *  starts at its own point in the cycle so they don't flash together. */
  const goalRing = (
    key: string, insetPx: number, height: number, st: number, sb: number, kind: "manual" | "auto",
    stepT: number | null = null, stepB: number | null = null,
  ) => {
    if (colPx <= 0) return null;
    const w = boxW(insetPx);
    const jointed = seamMode !== "overlay" && (st > 0 || sb > 0);
    const d = jointPathD(w, height, jointed ? st : 0, jointed ? sb : 0, seamMode === "scarf" ? "scarf" : "rabbet", 4, stepT, stepB);
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    const vars = {
      "--per": `${Math.round(2 * (w + height))}px`,
      animationDelay: `-${(h % 10000) / 1000}s`,
    } as React.CSSProperties;
    return (
      <svg className={"goal-ring " + kind} width={w} height={height} aria-hidden data-testid="goal-ring">
        <path d={d} className="goal-run glow" style={vars} />
        <path d={d} className="goal-run tail" style={vars} data-testid="goal-shine" />
        <path d={d} className="goal-run core" style={vars} />
      </svg>
    );
  };
  const headStripRef = useRef<HTMLDivElement | null>(null);
  const alldayStripRef = useRef<HTMLDivElement | null>(null);
  const colsStripRef = useRef<HTMLDivElement | null>(null);
  // acc: px the content has been swiped past the RENDERED days[0].
  // pending: day steps already requested from onPan but not rendered yet.
  // acc only drops by a column in the commit that renders the shifted days
  // (below); dropping it in the wheel handler painted one frame of the old
  // days pulled back a whole column at every day boundary (the jitter).
  const panRef = useRef({ acc: 0, pending: 0 });
  const panFrameRef = useRef<number | null>(null);
  const extN = days.length + 2;
  const paintStripTransform = useCallback(
    () => {
      panFrameRef.current = null;
      // one overscan column per side: while a requested shift is still
      // rendering, hold at the overscan edge rather than show blank strip
      const w = colPxRef.current;
      const shown = Math.max(-w, Math.min(w, panRef.current.acc));
      const tx = `translate3d(calc(${(-100 / extN).toFixed(4)}% - ${shown}px), 0, 0)`;
      for (const r of [headStripRef, alldayStripRef, colsStripRef]) {
        const el = r.current;
        if (!el) continue;
        el.style.transform = tx;
      }
    },
    [extN],
  );
  const scheduleStripTransform = useCallback(() => {
    if (panFrameRef.current != null) return;
    panFrameRef.current = requestAnimationFrame(paintStripTransform);
  }, [paintStripTransform]);
  // The commit that renders a requested shift takes it out of acc, so the
  // strip's new days and its offset reach the screen in the same frame.
  const firstDay = days[0].getTime();
  const shownFirstRef = useRef(firstDay);
  useLayoutEffect(() => {
    const prev = shownFirstRef.current;
    shownFirstRef.current = firstDay;
    if (prev === firstDay) return;
    const pan = panRef.current;
    let steps = 0;
    if (pan.pending !== 0) {
      const dir = Math.sign(pan.pending) as -1 | 1;
      let d = new Date(prev);
      for (let i = 1; i <= Math.abs(pan.pending); i++) {
        d = adjacentDay(d, dir);
        if (d.getTime() === firstDay) {
          steps = i * dir;
          break;
        }
      }
    }
    if (steps) {
      pan.acc -= steps * colPxRef.current;
      pan.pending -= steps;
    } else {
      // moved by navigation (Today, arrows, mini-calendar), not the swipe
      pan.acc = 0;
      pan.pending = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstDay]);
  useLayoutEffect(() => {
    paintStripTransform();
  });
  useLayoutEffect(() => {
    panRef.current.acc = 0;
    panRef.current.pending = 0;
    paintStripTransform();
  }, [days.length, props.hideWeekends, paintStripTransform]);
  useEffect(
    () => () => {
      if (panFrameRef.current != null) cancelAnimationFrame(panFrameRef.current);
    },
    [],
  );
  useEffect(() => {
    const el = gridRef.current;
    const onPan = props.onPan;
    if (!el || !onPan) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // vertical scroll
      e.preventDefault(); // keep WebKit from treating it as history nav
      // Wheel handlers can arrive much faster than the display refresh. The
      // old path forced a layout read and wrote three transforms for every
      // packet, which is especially expensive in WebKitGTK. ResizeObserver
      // owns the cached width; visual writes are coalesced to one per frame.
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? el.clientWidth
          : 1;
      const pan = panRef.current;
      pan.acc += e.deltaX * unit;
      const want = Math.trunc(pan.acc / colPxRef.current);
      if (want !== pan.pending) {
        onPan(want - pan.pending);
        pan.pending = want;
      }
      scheduleStripTransform();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [props.onPan, scheduleStripTransform]);

  const nowDate = now();
  const todayIdx = days.findIndex((d) => isSameDay(d, nowDate));

  // Auto-scroll: center-ish on now when today is visible, else 7am — but only
  // when ENTERING the view (mount / day-count change). Week-to-week navigation
  // preserves the scroll position, like Notion.
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const targetMin = todayIdx >= 0 ? Math.max(0, minutesOfDay(nowDate) - 150) : 7 * 60 - 40;
    el.scrollTop = targetMin * pxPerMin;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days.length]);

  const timed = useMemo(
    () => events.filter((e) => !e.all_day && e.start && e.end),
    [events],
  );

  // Per-day layout + header-score caches: swiping shifts the visible window
  // but a given day's packing doesn't change, so cache by day as long as the
  // inputs (events identity, zoom, star version via forceTick) are unchanged.
  const layoutCacheRef = useRef<{
    deps: unknown[];
    pack: Map<number, ReturnType<typeof packDayWithSleeves<CalendarEvent>>>;
    text: Map<number, Map<CalendarEvent, PlacedText> | null>;
    score: Map<number, FocusScore>;
  }>({ deps: [], pack: new Map(), text: new Map(), score: new Map() });
  {
    const deps = [timed, pxPerMin, calendars, Math.floor(nowDate.getTime() / 60000), reconTick, props.seamStyle, colPx, starTick];
    const c = layoutCacheRef.current;
    if (deps.some((d, i) => d !== c.deps[i])) {
      c.deps = deps;
      c.pack.clear();
      c.text.clear();
      c.score.clear();
    }
  }
  const allDay = useMemo(() => events.filter((e) => e.all_day), [events]);
  /** a new value whenever the chips may have moved, other than by a swipe
   *  (MarginNotes gets the first day separately and carries notes along) */
  const notesLayoutKey = useMemo(
    () => ({}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timed, pxPerMin, calendars, reconTick, starTick, props.seamStyle, colPx, days.length, props.hideWeekends],
  );

  const locate = useCallback(
    (clientX: number, clientY: number): { dayIndex: number; min: number } | null => {
      const el = gridRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left;
      const bodyTop = (el.querySelector(".grid-body") as HTMLElement)?.offsetTop ?? 0;
      const yy = clientY - rect.top + el.scrollTop - bodyTop;
      const gutter = gutterW;
      const colW = (rect.width - gutter) / days.length;
      const dayIndex = Math.max(0, Math.min(days.length - 1, Math.floor((x - gutter) / colW)));
      const min = Math.max(0, Math.min(DAY_MIN, yy / pxPerMin));
      return { dayIndex, min };
    },
    [days.length, gutterW],
  );

  const commitDrag = useCallback(
    (d: DragState) => {
      if (d.kind === "create") {
        const a = snap(Math.min(d.anchorMin, d.curMin));
        const b = snap(Math.max(d.anchorMin, d.curMin));
        const startMin = a;
        const endMin = b - a < SNAP_MIN ? a + 30 : b;
        const day = days[d.dayIndex];
        const start = atWallClock(day, startMin);
        const end = atWallClock(day, endMin);
        props.onDraft({ start, end, allDay: false }, { x: d.clientX, y: d.clientY });
      } else if (d.kind === "move" && d.event?.all_day && d.moved) {
        const ev = d.event;
        const { start, end } = eventDates(ev);
        const fmt = (x: Date) =>
          `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
        if (d.allDayDropDay != null) {
          // moved along the lane: shift the whole span to start on that day
          const spanDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000));
          const day = startOfDay(days[d.allDayDropDay]);
          const newEnd = new Date(day);
          newEnd.setDate(newEnd.getDate() + spanDays);
          if (!isSameDay(day, start)) {
            props.actions.update(
              ev,
              {
                calendar_id: ev.calendar_id,
                summary: ev.summary,
                description: ev.description,
                location: ev.location,
                start: fmt(day),
                end: fmt(newEnd),
                all_day: true,
              },
              `Moved “${ev.summary}”`,
            );
          }
        } else {
          // dropped into the time grid: becomes a 1h timed event at the cursor
          const day = days[d.curDayIndex];
          const startMin = snap(d.curMin);
          const newStart = atWallClock(day, startMin);
          props.actions.update(
            ev,
            {
              calendar_id: ev.calendar_id,
              summary: ev.summary,
              description: ev.description,
              location: ev.location,
              start: toLocalISO(newStart),
              end: toLocalISO(new Date(newStart.getTime() + 3600_000)),
              all_day: false,
            },
            `Scheduled “${ev.summary}”`,
          );
        }
      } else if (
        d.kind === "move" &&
        d.event &&
        d.moved &&
        !d.duplicate &&
        d.allDayDropDay == null &&
        props.selected.length > 1 &&
        selectedKeys.has(keyOf(d.event)) &&
        !d.event.all_day
      ) {
        // group move: everyone shifts by the dragged event's wall-clock move
        const shift = groupShiftOf(d);
        if (shift && (shift.days !== 0 || shift.minutes !== 0)) props.onMoveSelected(shift);
      } else if (d.kind === "move" && d.event && d.moved && d.allDayDropDay != null) {
        // dropped on the all-day lane: convert to a one-day all-day event
        const day = startOfDay(days[d.allDayDropDay]);
        const next = new Date(day);
        next.setDate(next.getDate() + 1);
        const fmt = (x: Date) =>
          `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
        props.actions.update(
          d.event,
          {
            calendar_id: d.event.calendar_id,
            summary: d.event.summary,
            description: d.event.description,
            location: d.event.location,
            start: fmt(day),
            end: fmt(next),
            all_day: true,
          },
          `Made “${d.event.summary}” all-day`,
        );
      } else if (d.kind === "move" && d.event && d.moved) {
        const { start } = eventDates(d.event);
        const newStartMin = snap(d.curMin - (d.grabOffsetMin ?? 0));
        const day = days[d.curDayIndex];
        const newStart = atWallClock(day, newStartMin);
        if (d.duplicate) {
          const dur = d.durationMin ?? 60;
          const newEnd = new Date(newStart.getTime() + dur * 60000);
          props.actions.create({
            calendar_id: d.event.calendar_id,
            summary: d.event.summary,
            description: d.event.description,
            location: d.event.location,
            start: toLocalISO(newStart),
            end: toLocalISO(newEnd),
            all_day: false,
          });
          return;
        }
        if (newStart.getTime() !== start.getTime()) {
          const dur = d.durationMin ?? 60;
          const newEnd = new Date(newStart.getTime() + dur * 60000);
          props.actions.update(
            d.event,
            {
              calendar_id: d.event.calendar_id,
              summary: d.event.summary,
              description: d.event.description,
              location: d.event.location,
              start: toLocalISO(newStart),
              end: toLocalISO(newEnd),
              all_day: false,
            },
            `Moved “${d.event.summary}”`,
          );
        }
      } else if (d.kind === "resize" && d.event && d.moved) {
        const { start } = eventDates(d.event);
        const day = days[d.dayIndex];
        const sameDay = isSameDay(start, day);
        // resizing a continuation segment: floor is just after this day's
        // midnight, not start+15 in this day's coordinates (that'd add 24h)
        const minEnd = sameDay ? minutesOfDay(start) + SNAP_MIN : SNAP_MIN;
        const endMin = Math.max(snap(d.curMin), minEnd);
        const newEnd = atWallClock(day, endMin);
        props.actions.update(
          d.event,
          {
            calendar_id: d.event.calendar_id,
            summary: d.event.summary,
            description: d.event.description,
            location: d.event.location,
            start: d.event.start,
            end: toLocalISO(newEnd),
            all_day: false,
          },
          `Resized “${d.event.summary}”`,
        );
      }
    },
    [days, props],
  );

  // Listeners attach synchronously at drag start; Escape cancels mid-drag.
  const dragRef = useRef<DragState | null>(null);
  const beginDrag = useCallback(
    (initial: DragState) => {
      dragRef.current = initial;
      setDrag(initial);
      document.body.dataset.dragging = "1";
      const cleanup = () => {
        delete document.body.dataset.dragging;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", onKey, true);
      };
      const onMove = (ev: PointerEvent) => {
        const loc = locate(ev.clientX, ev.clientY);
        const d = dragRef.current;
        if (!loc || !d) return;
        let allDayDropDay: number | null = null;
        if (d.kind === "move") {
          const lane = gridRef.current?.querySelector(".allday-row");
          if (lane) {
            const r = lane.getBoundingClientRect();
            if (ev.clientY >= r.top && ev.clientY <= r.bottom) allDayDropDay = loc.dayIndex;
          }
        }
        const next: DragState = {
          ...d,
          curDayIndex: loc.dayIndex,
          curMin: loc.min,
          clientX: ev.clientX,
          clientY: ev.clientY,
          allDayDropDay,
          moved: d.moved || Math.abs(loc.min - d.anchorMin) > 3 || loc.dayIndex !== d.dayIndex || allDayDropDay != null,
        };
        dragRef.current = next;
        setDrag(next);
      };
      const cancel = () => {
        cleanup();
        dragRef.current = null;
        setDrag(null);
      };
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") {
          ev.stopPropagation();
          cancel();
        }
      };
      const finish = () => {
        cleanup();
        const d = dragRef.current;
        dragRef.current = null;
        setDrag(null);
        if (!d) return;
        if (d.kind === "create" || d.moved) commitDrag(d);
        else if (d.event) {
          props.onSelect(d.event);
          props.onOpenEvent(d.event, { x: d.clientX, y: d.clientY });
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", onKey, true);
    },
    [locate, commitDrag, props],
  );

  const [marquee, setMarquee] = useState<{
    d0: number;
    m0: number;
    d1: number;
    m1: number;
  } | null>(null);

  const startMarquee = (e: React.PointerEvent, dayIndex: number) => {
    const loc = locate(e.clientX, e.clientY);
    if (!loc) return;
    const anchor = { d: dayIndex, m: loc.min };
    const update = (d1: number, m1: number) => {
      const box = { d0: Math.min(anchor.d, d1), d1: Math.max(anchor.d, d1), m0: Math.min(anchor.m, m1), m1: Math.max(anchor.m, m1) };
      setMarquee(box);
      const hits = timed.filter((ev) => {
        const { start, end } = eventDates(ev);
        const di = days.findIndex((dd) => isSameDay(start, dd) || (end > startOfDay(dd) && start < dd));
        const dayIdx = days.findIndex((dd) => isSameDay(start, dd));
        const idx = dayIdx !== -1 ? dayIdx : di;
        if (idx < box.d0 || idx > box.d1) return false;
        const sMin = dayIdx !== -1 ? minutesOfDay(start) : 0;
        const eMin = isSameDay(end, days[idx] ?? start) ? minutesOfDay(end) : DAY_MIN;
        return eMin > box.m0 && sMin < box.m1;
      });
      props.onSelectMany(hits);
    };
    update(dayIndex, loc.min);
    const onMove = (ev: PointerEvent) => {
      const l = locate(ev.clientX, ev.clientY);
      if (l) update(l.dayIndex, l.min);
    };
    const done = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", done);
      setMarquee(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", done);
  };

  const startCreate = (e: React.PointerEvent, dayIndex: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setCtx(null);
    if (e.shiftKey) {
      // Notion: shift-drag selects multiple events
      startMarquee(e, dayIndex);
      return;
    }
    // Google: the click that dismisses an open editor doesn't also create.
    // (React can flush the close before this handler runs, so check both the
    // prop and the per-gesture dismissal mark.)
    if (props.panelOpen) return;
    if (document.body.dataset.panelDismiss === String(e.nativeEvent.timeStamp)) {
      delete document.body.dataset.panelDismiss;
      return;
    }
    const loc = locate(e.clientX, e.clientY);
    if (!loc) return;
    beginDrag({
      kind: "create",
      dayIndex,
      anchorMin: loc.min,
      curDayIndex: dayIndex,
      curMin: loc.min,
      clientX: e.clientX,
      clientY: e.clientY,
      moved: false,
    });
  };

  const editableCal = (calendarId: string) =>
    calendarEditable(calendars.find((c) => c.id === calendarId));

  const startChipDrag = (e: React.PointerEvent, ev: CalendarEvent, dayIndex: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    setCtx(null);
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      // Notion: shift/cmd-click adds or removes from the selection
      props.onToggleSelect(ev);
      return;
    }
    if (!editableCal(ev.calendar_id)) {
      // read-only: click opens, never drags
      const open = () => {
        window.removeEventListener("pointerup", open);
        props.onSelect(ev);
        props.onOpenEvent(ev, { x: e.clientX, y: e.clientY });
      };
      window.addEventListener("pointerup", open, { once: true });
      return;
    }
    const loc = locate(e.clientX, e.clientY);
    if (!loc) return;
    const { start, end } = eventDates(ev);
    const target = e.target as HTMLElement;
    const isResize = target.classList.contains("chip-resize");
    // start expressed in minutes relative to the grabbed day's midnight; for a
    // cross-midnight continuation segment this is negative, which keeps moves
    // of either segment anchored to the event's true start.
    const startMinInGrabDay =
      (start.getTime() - startOfDay(days[dayIndex]).getTime()) / 60000;
    beginDrag({
      kind: isResize ? "resize" : "move",
      duplicate: !isResize && e.altKey,
      event: ev,
      dayIndex,
      anchorMin: loc.min,
      grabOffsetMin: ev.all_day ? 0 : loc.min - startMinInGrabDay,
      durationMin: ev.all_day ? 60 : Math.max(15, (end.getTime() - start.getTime()) / 60000),
      curDayIndex: dayIndex,
      curMin: loc.min,
      clientX: e.clientX,
      clientY: e.clientY,
      moved: false,
    });
  };

  const selectedKeys = useMemo(
    () => new Set(props.selected.map(keyOf)),
    [props.selected],
  );

  /** A selected event dragged while others are selected moves them all: the
   *  wall-clock shift of the dragged one (null: not a group move) */
  function groupShiftOf(d: DragState | null): WallShift | null {
    if (!d || d.kind !== "move" || !d.event || !d.moved || d.duplicate || d.allDayDropDay != null) return null;
    if (d.event.all_day || props.selected.length < 2 || !selectedKeys.has(keyOf(d.event))) return null;
    const { start } = eventDates(d.event);
    return wallShiftBetween(start, atWallClock(days[d.curDayIndex], snap(d.curMin - (d.grabOffsetMin ?? 0))));
  }
  /** while a group is dragged: the others' landing spots (ghosts, by day
   *  column) and which events are on the move (dimmed in place) */
  const groupDrag = useMemo(() => {
    const shift = groupShiftOf(drag);
    if (!shift || !drag?.event) return null;
    const moving = new Set<string>();
    const ghosts = new Map<number, { key: string; title: string; color: string; startMin: number; endMin: number }[]>();
    for (const sel of props.selected) {
      const k = keyOf(sel);
      if (k === keyOf(drag.event)) continue;
      const e = timed.find((x) => keyOf(x) === k) ?? sel; // the current copy
      if (e.all_day || !editableCal(e.calendar_id)) continue;
      moving.add(k);
      const { start, end } = eventDates(e);
      const s = shiftWallClock(start, shift);
      const di = days.findIndex((dd) => isSameDay(dd, s));
      if (di < 0) continue;
      const startMin = minutesOfDay(s);
      const endMin = Math.min(DAY_MIN, startMin + Math.max(15, (end.getTime() - start.getTime()) / 60000));
      if (!ghosts.has(di)) ghosts.set(di, []);
      ghosts.get(di)!.push({ key: k, title: e.summary, color: colorOf(calendars, e.calendar_id), startMin, endMin });
    }
    return { moving, ghosts };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, props.selected, timed, days, calendars]);
  const selectedKey = props.selected.length === 1 ? keyOf(props.selected[0]) : null;

  // keep the keyboard-selected event visible (n/b cycling)
  useEffect(() => {
    const sel = props.selected.length === 1 ? props.selected[0] : null;
    const el = gridRef.current;
    if (!sel || !el || sel.all_day) return;
    const { start } = eventDates(sel);
    const idx = days.findIndex((d) => isSameDay(d, start));
    if (idx === -1) return;
    const top = minutesOfDay(start) * pxPerMin;
    const viewTop = el.scrollTop;
    const viewBottom = viewTop + el.clientHeight - 80;
    if (top < viewTop + 40 || top > viewBottom) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 3);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);
  const nowMin = minutesOfDay(nowDate);

  return (
    <div className="weekview" ref={gridRef} data-testid="week-grid">
      <div className="day-headers" style={{ gridTemplateColumns: `${gutterW}px 1fr` }}>
        <div className="gutter-tz" title={Intl.DateTimeFormat().resolvedOptions().timeZone}>
          {new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
            .formatToParts(nowDate)
            .find((p) => p.type === "timeZoneName")?.value ?? ""}
        </div>
        <div className="pan-clip">
          <div
            className="pan-strip"
            ref={headStripRef}
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${extN}, minmax(0, 1fr))`,
              width: `${(extN / days.length) * 100}%`,
            }}
          >
            {[
              ...days.map((d, di) => [d, di + 2, true] as const),
              [beforeDay, 1, false] as const,
              [afterDay, extN, false] as const,
            ].map(([d, gridCol, live]) => {
          // one list keyed by date: a header sliding between overscan and
          // live keeps its element instead of remounting on every swipe step
          if (!live) {
            return (
              <div key={d.toISOString()} className="day-head-x" style={{ gridColumn: gridCol, gridRow: 1 }}>
                <span className="dow">{format(d, "EEE")}</span>
                <span className="dnum">{d.getDate()}</span>
              </div>
            );
          }
          // focus score for elapsed days; today scores the day so far
          let score: number | null = null;
          if (startOfDay(d) <= startOfDay(nowDate)) {
            const sKey = startOfDay(d).getTime();
            let info = layoutCacheRef.current.score.get(sKey);
            if (!info) {
              info = focusScore({
                day: d,
                now: nowDate,
                events: timed,
                calendars,
                recon: (e) => reconOf(reconKey(e)),
                reconSince: reconSince(),
              });
              layoutCacheRef.current.score.set(sKey, info);
            }
            score = info.hasData ? info.score : null;
          }
          return (
            <div
              key={d.toISOString()}
              className={"day-head" + (isSameDay(d, nowDate) ? " today" : "")}
              style={{ gridColumn: gridCol, gridRow: 1 }}
            >
              <span className="dow">{format(d, "EEE")}</span>
              <span className="dnum">{d.getDate()}</span>
              {score != null && (
                <span
                  className="score-wrap"
                  onPointerEnter={(pe) => {
                    const r = (pe.currentTarget as HTMLElement).getBoundingClientRect();
                    setScorePop({ day: startOfDay(d), x: r.left + r.width / 2, y: r.bottom });
                  }}
                  onPointerLeave={() => setScorePop(null)}
                >
                  <span
                    className={
                      "day-score " + (score >= 70 ? "good" : score >= 40 ? "mid" : "low")
                    }
                    aria-label={`Focus score ${score} of 100${isSameDay(d, nowDate) ? " so far" : ""}`}
                    data-testid="day-score"
                  >
                    {score}
                  </span>
                </span>
              )}
            </div>
          );
            })}
          </div>
        </div>
      </div>

        <div
          className="allday-row"
          data-testid="allday-row"
          style={{ gridTemplateColumns: `${gutterW}px 1fr` }}
        >
          <div className="allday-label">all-day</div>
          <div className="pan-clip">
            <div
              className="pan-strip"
              ref={alldayStripRef}
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${extN}, minmax(0, 1fr))`,
                width: `${(extN / days.length) * 100}%`,
              }}
            >
              {[...days, beforeDay, afterDay].map((d, idx) => {
                const live = idx < days.length;
                const gridCol = live ? idx + 2 : idx === days.length ? 1 : extN;
                const renderCell = () => {
            const dayAll = allDay.filter((e) => {
              const { start, end } = eventDates(e);
              return d >= startOfDay(start) && d < end;
            });
            const dropTarget =
              drag?.kind === "move" && drag.allDayDropDay === days.indexOf(d);
            return (
            <div
              key={d.toISOString()}
              className={"allday-cell" + (dropTarget ? " drop" : "")}
              onPointerDown={(pe) => {
                // Notion: click drafts an all-day event; dragging across the
                // lane spans it over the covered days
                if (pe.button !== 0 || (pe.target as HTMLElement).closest(".chip")) return;
                const strip = pe.currentTarget.closest(".pan-strip")!;
                const cells = [...strip.querySelectorAll(".allday-cell")].slice(0, days.length);
                const dayAt = (x: number) => {
                  let idx = days.indexOf(d);
                  cells.forEach((c, i) => {
                    const r = c.getBoundingClientRect();
                    if (x >= r.left && x <= r.right) idx = i;
                  });
                  return idx;
                };
                const downIdx = days.indexOf(d);
                const up = (ue: PointerEvent) => {
                  window.removeEventListener("pointerup", up);
                  const upIdx = dayAt(ue.clientX);
                  if (Math.abs(ue.clientY - pe.clientY) > 30) return; // left the lane
                  const a = Math.min(downIdx, upIdx);
                  const b = Math.max(downIdx, upIdx);
                  props.onDraft(
                    { start: startOfDay(days[a]), end: addDays(startOfDay(days[b]), 1), allDay: true },
                    { x: pe.clientX, y: pe.clientY },
                  );
                };
                window.addEventListener("pointerup", up);
              }}
            >
              {dayAll
                .slice(0, 3)
                .map((e) => (
                  <button
                    key={keyOf(e)}
                    className={"chip chip-allday" + (ended(e, nowDate) ? " past" : "")}
                    style={chipStyle(colorOf(calendars, e.calendar_id))}
                    title={e.summary}
                    onPointerDown={(pe) => startChipDrag(pe, e, days.indexOf(d))}
                    onContextMenu={(ce) => {
                      ce.preventDefault();
                      setCtx({ x: ce.clientX, y: ce.clientY, event: e });
                    }}
                  >
                    {e.summary}
                  </button>
                ))}
              {dayAll.length > 3 && (
                <span className="allday-more">+{dayAll.length - 3} more</span>
              )}
            </div>
            );
                };
                const cell = renderCell();
                return (
                  <div
                    key={d.toISOString()}
                    style={{ gridColumn: gridCol, gridRow: 1, pointerEvents: live ? undefined : "none" }}
                    className="allday-slot"
                  >
                    {cell}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      <div className="grid-body" style={{ height: DAY_MIN * pxPerMin }}>
        <div className="gutter" style={{ width: gutterW }}>
          {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
            <div
              key={h}
              className="hour-label"
              style={{
                top: h * 60 * pxPerMin,
                // hide the hour label that would collide with the now pill
                visibility:
                  todayIdx >= 0 && Math.abs(h * 60 - nowMin) < 24 ? "hidden" : undefined,
              }}
            >
              {fmtTimeShort(new Date(2000, 0, 1, h))}
            </div>
          ))}
          {props.secondaryTz &&
            Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
              <div
                key={`tz2-${h}`}
                className="hour-label hour-label-2"
                style={{ top: h * 60 * pxPerMin }}
              >
                {tzLabel(h)}
              </div>
            ))}
          {todayIdx >= 0 && (
            <div className="now-pill" style={{ top: nowMin * pxPerMin }} data-testid="now-pill">
              {format(nowDate, "h:mma").replace("AM", "AM").replace("PM", "PM")}
            </div>
          )}
        </div>
        <div className="gridlines" style={{ left: gutterW }}>
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="hline" style={{ top: h * 60 * pxPerMin }} />
          ))}
          {todayIdx >= 0 && (
            <div className="now-line-global" style={{ top: nowMin * pxPerMin }} />
          )}
        </div>
        <div className="day-clip" ref={dayClipRef}>
          {marquee && (
            <div
              className="marquee"
              data-testid="marquee"
              style={{
                left: `${(marquee.d0 / days.length) * 100}%`,
                width: `${((marquee.d1 - marquee.d0 + 1) / days.length) * 100}%`,
                top: marquee.m0 * pxPerMin,
                height: Math.max((marquee.m1 - marquee.m0) * pxPerMin, 2),
              }}
            />
          )}
          <div
            className="day-cols pan-strip"
            ref={colsStripRef}
            style={{
              gridTemplateColumns: `repeat(${extN}, minmax(0, 1fr))`,
              width: `${(extN / days.length) * 100}%`,
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
            }}
          >
          {[
            ...days.map((d, i) => [d, i, i + 2, true] as const),
            [beforeDay, -1, 1, false] as const,
            [afterDay, -1, extN, false] as const,
          ].map(([day, di, gridCol, live]) => {
            const dayStart = startOfDay(day);
            const dayItems = timed
              .map((e) => ({ e, ...eventDates(e) }))
              .filter(({ start, end }) => end > dayStart && start < addDays(dayStart, 1))
              .map(({ e, start, end }) => ({
                item: e,
                startMin: isSameDay(start, day) ? minutesOfDay(start) : 0,
                endMin: isSameDay(end, day) ? Math.max(minutesOfDay(end), 1) : DAY_MIN,
              }));
            const cacheKey = dayStart.getTime();
            let packed = layoutCacheRef.current.pack.get(cacheKey);
            let placedText = layoutCacheRef.current.text.get(cacheKey);
            if (!packed || placedText === undefined) {
              ({ packed, placed: placedText } = layoutDay(dayItems));
              layoutCacheRef.current.pack.set(cacheKey, packed);
              layoutCacheRef.current.text.set(cacheKey, placedText);
            }
            const { containers, regular, clusters } = packed;
            const isDragTarget =
              live &&
              drag && drag.moved && (drag.kind === "create" ? drag.dayIndex === di : drag.curDayIndex === di);
            const draftHere =
              live && props.draft && !props.draft.allDay && isSameDay(props.draft.start, day) && !drag;
            return (
              <div
                key={day.toISOString()}
                className={"day-col" + (isSameDay(day, nowDate) ? " today" : "") + (day.getDay() === 0 || day.getDay() === 6 ? " weekend" : "")}
                style={{ gridColumn: gridCol, gridRow: 1, pointerEvents: live ? undefined : "none" }}
                onPointerDown={live ? (e) => startCreate(e, di) : undefined}
                data-testid={live ? `day-col-${di}` : undefined}
              >
                {containers.map(({ item: e, lane, top, height, seamTopPx, seamBottomPx, seamTopStepPx, seamBottomStepPx, z }) => {
                  const slabClip = jointClip(lane * SLEEVE_LANE_WIDTH, height, seamTopPx, seamBottomPx, seamTopStepPx, seamBottomStepPx);
                  const color = colorOf(calendars, e.calendar_id);
                  const { start, end } = eventDates(e);
                  const recon = reconState(e, calendars, nowDate);
                  const isPast = ended(e, nowDate);
                  const common =
                    (groupDrag?.moving.has(keyOf(e)) ? " dragging" : "") +
                    (isPast ? " past" : "") +
                    (recon === "unsettled" ? " unsettled" : "") +
                    (recon === "canceled" ? " canceled" : "") +
                    (editableCal(e.calendar_id) ? "" : " readonly") +
                    (selectedKeys.has(keyOf(e)) ? " selected" : "");
                  const rangeTitle = `${e.summary} (${fmtChipRange(start, end)})`;
                  return (
                    <div
                      key={"cont-" + keyOf(e)}
                      className={
                        "chip chip-timed chip-cfull" +
                        (slabClip ? " jointed" : "") +
                        ((st0) => (st0 ? (st0.kind === "manual" ? " starred" : " starred-auto") : ""))(starState(starKey(e))) +
                        common +
                        (height < 16 ? " chip-xs" : "")
                      }
                      style={{
                        ...chipStyle(color),
                        clipPath: slabClip,
                        zIndex: z,
                        top,
                        height,
                        left: lane * SLEEVE_LANE_WIDTH,
                        width: `calc(100% - ${lane * SLEEVE_LANE_WIDTH + 2}px)`,
                      }}
                      title={rangeTitle}
                      data-text-rule={placedText?.get(e)?.rule}
                      data-testid="cshape-seg"
                      data-ek={keyOf(e)}
                      onPointerDown={(pe) => startChipDrag(pe, e, di)}
                      onContextMenu={(ce) => {
                        ce.preventDefault();
                        ce.stopPropagation();
                        props.onSelect(e);
                        setCtx({ x: ce.clientX, y: ce.clientY, event: e });
                      }}
                    >
                      {jointSeam(lane * SLEEVE_LANE_WIDTH, height, seamTopPx, seamBottomPx, seamTopStepPx, seamBottomStepPx)}
                      {((g) => g && goalRing(keyOf(e), lane * SLEEVE_LANE_WIDTH, height, seamTopPx, seamBottomPx, g.kind, seamTopStepPx, seamBottomStepPx))(
                        starState(starKey(e)),
                      )}
                      <div className="cfull-label">
                        <ChipText e={e} p={placedText?.get(e)} />
                      </div>
                      {editableCal(e.calendar_id) && <div className="chip-resize" />}
                    </div>
                  );
                })}
                {clusters.map((cl) => (
                  <div
                    key={"cluster-" + keyOf(cl.items[0].item)}
                    className="cluster-block"
                    style={{
                      zIndex: cl.z,
                      top: cl.top,
                      height: cl.height,
                      left: cl.insetPx,
                      width: `calc(100% - ${cl.insetPx + 2}px)`,
                    }}
                    data-testid="cluster-block"
                    onPointerDown={(pe) => pe.stopPropagation()}
                    title={`${cl.items.length} short events, ${fmtChipRange(
                      atWallClock(day, cl.startMin),
                      atWallClock(day, cl.endMin),
                    )}`}
                  >
                    {cl.items.map(({ item: e }) => {
                      const { start } = eventDates(e);
                      return (
                        <button
                          key={keyOf(e)}
                          data-ek={keyOf(e)}
                          title={e.summary + " (" + fmtChipRange(start, eventDates(e).end) + ")"}
                          className={
                            "cluster-row" +
                            (ended(e, nowDate) ? " past" : "") +
                            ((st0) => (st0 ? (st0.kind === "manual" ? " starred" : " starred-auto") : ""))(starState(starKey(e))) +
                            (selectedKeys.has(keyOf(e)) ? " selected" : "") +
                            ((r) => (r === "unsettled" ? " unsettled" : r === "canceled" ? " canceled" : r === "done" ? " done" : ""))(
                              reconState(e, calendars, nowDate),
                            )
                          }
                          // same path as chips: drag pulls the event out of the
                          // cluster, a plain click opens it, shift-click selects
                          onPointerDown={(pe) => startChipDrag(pe, e, di)}
                          onContextMenu={(ce) => {
                            ce.preventDefault();
                            ce.stopPropagation();
                            props.onSelect(e);
                            setCtx({ x: ce.clientX, y: ce.clientY, event: e });
                          }}
                        >
                          <span
                            className="cluster-dot"
                            style={{ background: colorOf(calendars, e.calendar_id) }}
                          />
                          <span className="cluster-title">{e.summary}</span>
                          {reconState(e, calendars, nowDate) === "unsettled" && (
                            <span className="row-recon">
                              <span
                                role="button"
                                tabIndex={-1}
                                className="rr-yes"
                                title="Happened"
                                data-testid="row-recon-yes"
                                onPointerDown={(pe) => pe.stopPropagation()}
                                onClick={(ce) => {
                                  ce.stopPropagation();
                                  setRecon(reconKey(e), "done");
                                }}
                              >
                                ✓
                              </span>
                              <span
                                role="button"
                                tabIndex={-1}
                                className="rr-no"
                                title="Didn't happen: deletes the event (⌘Z to undo)"
                                data-testid="row-recon-no"
                                onPointerDown={(pe) => pe.stopPropagation()}
                                onClick={(ce) => {
                                  ce.stopPropagation();
                                  void props.actions.removeOccurrence(e);
                                }}
                              >
                                ✕
                              </span>
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))}
                {regular.map(({ item: e, top, height, leftPct, widthPct, insetPx, seamTopPx, seamBottomPx, seamTopStepPx, seamBottomStepPx, z }) => {
                  const st = seamMode === "overlay" ? 0 : seamTopPx;
                  const sb = seamMode === "overlay" ? 0 : seamBottomPx;
                  const clipPath = jointClip(insetPx, height, st, sb, seamTopStepPx, seamBottomStepPx);
                  const color = colorOf(calendars, e.calendar_id);
                  const beingMoved =
                    drag?.kind !== "create" && drag?.event?.id === e.id && drag.moved && !drag.duplicate;
                  const recon = reconState(e, calendars, nowDate);
                  const isPast = ended(e, nowDate);
                  return (
                    <div
                      key={keyOf(e)}
                      className={
                        "chip chip-timed" +
                        (clipPath ? " jointed" : "") +
                        ((st0) => (st0 ? (st0.kind === "manual" ? " starred" : " starred-auto") : ""))(starState(starKey(e))) +
                        (height < 16 ? " chip-xs" : "") +
                        (beingMoved || groupDrag?.moving.has(keyOf(e)) ? " dragging" : "") +
                        (isPast ? " past" : "") +
                        (recon === "unsettled" ? " unsettled" : "") +
                        (recon === "canceled" ? " canceled" : "") +
                        (editableCal(e.calendar_id) ? "" : " readonly") +
                        (selectedKeys.has(keyOf(e)) ? " selected" : "")
                      }
                      style={{
                        ...chipStyle(color),
                        clipPath,
                        zIndex: z,
                        top,
                        height,
                        left: `calc(${insetPx}px + (100% - ${insetPx}px) * ${leftPct / 100})`,
                        width: `calc((100% - ${insetPx}px) * ${widthPct / 100} - 2px)`,
                      }}
                      title={e.summary}
                      onPointerEnter={() => props.onHover?.(e)}
                      onPointerLeave={() => props.onHover?.(null)}
                      onPointerDown={(pe) => startChipDrag(pe, e, di)}
                      onContextMenu={(ce) => {
                        ce.preventDefault();
                        ce.stopPropagation();
                        props.onSelect(e);
                        setCtx({ x: ce.clientX, y: ce.clientY, event: e });
                      }}
                      data-testid="event-chip"
                      data-ek={keyOf(e)}
                      data-text-rule={placedText?.get(e)?.rule}
                    >
                      {jointSeam(insetPx, height, st, sb, seamTopStepPx, seamBottomStepPx)}
                      {((g) => g && goalRing(keyOf(e), insetPx, height, st, sb, g.kind, seamTopStepPx, seamBottomStepPx))(starState(starKey(e)))}
                      <ChipText e={e} p={placedText?.get(e)} />
                      {recon === "unsettled" && (
                        <span className="recon-actions">
                          <button
                            className="ra-yes"
                            title="Happened"
                            data-testid="recon-yes"
                            onPointerDown={(pe) => pe.stopPropagation()}
                            onClick={(ce) => {
                              ce.stopPropagation();
                              setRecon(reconKey(e), "done");
                            }}
                          >
                            ✓
                          </button>
                          <button
                            className="ra-no"
                            title="Didn't happen: deletes the event (⌘Z to undo)"
                            data-testid="recon-no"
                            onPointerDown={(pe) => pe.stopPropagation()}
                            onClick={(ce) => {
                              ce.stopPropagation();
                              void props.actions.removeOccurrence(e);
                            }}
                          >
                            ✕
                          </button>
                        </span>
                      )}
                      {e.conference_url && placedText?.get(e)?.join && (
                        <a
                          className="chip-join chip-abs"
                          style={{ left: placedText.get(e)!.join!.x, top: placedText.get(e)!.join!.y }}
                          href={e.conference_url}
                          target="_blank"
                          rel="noreferrer"
                          onPointerDown={(pe) => pe.stopPropagation()}
                        >
                          Join
                        </a>
                      )}
                      {editableCal(e.calendar_id) && <div className="chip-resize" />}
                    </div>
                  );
                })}

                {live &&
                  groupDrag?.ghosts.get(di)?.map((g) => (
                    <div
                      key={"group-" + g.key}
                      className="chip chip-ghost"
                      data-testid="group-ghost"
                      data-ek={g.key}
                      style={{
                        ...chipStyle(g.color),
                        top: g.startMin * pxPerMin,
                        height: Math.max((g.endMin - g.startMin) * pxPerMin, 17),
                        left: 0,
                        width: "calc(100% - 2px)",
                      }}
                    >
                      <span className="chip-title">{g.title}</span>
                      {(g.endMin - g.startMin) * pxPerMin >= 28 && (
                        <span className="chip-time">
                          {fmtChipRange(
                            new Date(2000, 0, 1, Math.floor(g.startMin / 60), g.startMin % 60),
                            new Date(2000, 0, 1, Math.floor(g.endMin / 60) % 24, g.endMin % 60),
                          )}
                        </span>
                      )}
                    </div>
                  ))}
                {isDragTarget && drag && (
                  <GhostChip
                    drag={drag}
                    pxPerMin={pxPerMin}
                    color={colorOf(
                      calendars,
                      drag.event?.calendar_id ??
                        (calendars.find((c) => c.is_primary) ?? calendars[0])?.id ??
                        "",
                    )}
                  />
                )}

                {draftHere && props.draft && (
                  <div
                    className="chip chip-ghost chip-draft"
                    data-testid="draft-chip"
                    style={{
                      ...chipStyle(
                        colorOf(
                          calendars,
                          (calendars.find((c) => c.is_primary) ?? calendars[0])?.id ?? "",
                        ),
                      ),
                      top: minutesOfDay(props.draft.start) * pxPerMin,
                      height: Math.max(
                        ((props.draft.end.getTime() - props.draft.start.getTime()) / 60000) *
                          pxPerMin,
                        17,
                      ),
                      left: 0,
                      width: "calc(100% - 2px)",
                    }}
                  >
                    <span className="chip-title">(New event)</span>
                    {((props.draft.end.getTime() - props.draft.start.getTime()) / 60000) *
                      pxPerMin >=
                      28 && (
                      <span className="chip-time">
                        {fmtChipRange(props.draft.start, props.draft.end)}
                      </span>
                    )}
                  </div>
                )}

                {isSameDay(day, nowDate) && (
                  <div className="now-line" style={{ top: nowMin * pxPerMin }}>
                    <span className="now-dot" />
                  </div>
                )}
              </div>
            );
          })}
          <MarginNotes
            stripRef={colsStripRef}
            days={days.length}
            extN={extN}
            events={timed}
            layoutKey={notesLayoutKey}
            firstDay={firstDay}
            pxPerMin={pxPerMin}
            keyOf={keyOf}
            onSelect={(e) => props.onSelect(e)}
            onDelete={(e) => {
              // Clicking the note selected its event. Once the note is gone,
              // that selection must go too, or the next Delete/Backspace
              // (a double press, key repeat) falls through to the global
              // handler and deletes the event itself.
              props.onSelect(null);
              void props.actions.setNote(e, null).catch(() => {
                // setNote reports the failure with a toast
              });
            }}
          />
          </div>
        </div>
      </div>

      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
        <defs>
          <filter id="goal-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.5" />
          </filter>
        </defs>
      </svg>
      {scorePop &&
        ((info) =>
          info && info.hasData ? (
            <ScorePop
              info={info}
              today={isSameDay(scorePop.day, nowDate)}
              x={scorePop.x}
              y={scorePop.y}
            />
          ) : null)(layoutCacheRef.current.score.get(scorePop.day.getTime()))}
      {ctx && (
        <div className="ctx-scrim" onPointerDown={() => setCtx(null)} onContextMenu={(e) => e.preventDefault()}>
          <div
            className="ctx-menu"
            data-testid="ctx-menu"
            style={{
              left: Math.min(ctx.x, window.innerWidth - 180),
              top: Math.min(ctx.y, window.innerHeight - 140),
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                props.onOpenEvent(ctx.event, { x: ctx.x, y: ctx.y });
                setCtx(null);
              }}
            >
              Open
            </button>
            <button
              onClick={() => {
                props.actions.duplicate(ctx.event);
                setCtx(null);
              }}
            >
              {editableCal(ctx.event.calendar_id) ? "Duplicate" : "Copy to my calendar"} <kbd>⌘D</kbd>
            </button>
            {eventDates(ctx.event).end.getTime() < nowDate.getTime() && !ctx.event.all_day && (
              <>
                <button
                  onClick={() => {
                    setRecon(reconKey(ctx.event), reconState(ctx.event, calendars, nowDate) === "done" ? null : "done");
                    setCtx(null);
                  }}
                >
                  {reconState(ctx.event, calendars, nowDate) === "done" ? "Unconfirm" : "Happened"} <kbd>✓</kbd>
                </button>
                <button
                  onClick={() => {
                    setRecon(reconKey(ctx.event), reconState(ctx.event, calendars, nowDate) === "canceled" ? null : "canceled");
                    setCtx(null);
                  }}
                >
                  {reconState(ctx.event, calendars, nowDate) === "canceled" ? "Not canceled" : "Canceled"} <kbd>⊘</kbd>
                </button>
                <button
                  onClick={() => {
                    void props.actions.removeOccurrence(ctx.event);
                    setCtx(null);
                  }}
                >
                  Didn't happen (delete) <kbd>✗</kbd>
                </button>
              </>
            )}
            <button
              onClick={() => {
                toggleStar(starKey(ctx.event));
                setCtx(null);
              }}
            >
              {starState(starKey(ctx.event))?.kind === "manual" ? "Unstar" : "Star as goal work"} <kbd>★</kbd>
            </button>
            {props.onClipboard && editableCal(ctx.event.calendar_id) && (
              <button
                onClick={() => {
                  props.onClipboard!(ctx.event, true);
                  setCtx(null);
                }}
              >
                Cut <kbd>⌘X</kbd>
              </button>
            )}
            {props.onClipboard && (
              <button
                onClick={() => {
                  props.onClipboard!(ctx.event, false);
                  setCtx(null);
                }}
              >
                Copy <kbd>⌘C</kbd>
              </button>
            )}
            {ctx.event.conference_url && (
              <button
                onClick={() => {
                  window.open(ctx.event.conference_url!, "_blank");
                  setCtx(null);
                }}
              >
                Join meeting <kbd>⌘J</kbd>
              </button>
            )}
            {editableCal(ctx.event.calendar_id) && (
            <button
              className="ctx-danger"
              onClick={() => {
                props.actions.remove(ctx.event);
                props.onSelect(null);
                setCtx(null);
              }}
            >
              Delete <kbd>⌫</kbd>
            </button>
            )}
            {editableCal(ctx.event.calendar_id) && ctx.event.recurring_event_id && (
              <button
                className="ctx-danger"
                onClick={() => {
                  props.actions.removeSeries(ctx.event);
                  setCtx(null);
                }}
              >
                Delete series
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The focus score explained: the biggest loss, the three factors with what
 *  drove each, what wasn't counted, and the formula. Fixed-position so the
 *  header strip's clip (horizontal panning) can't cut it off. */
function ScorePop({ info: f, today, x, y }: { info: FocusScore; today: boolean; x: number; y: number }) {
  const W = 268;
  const left = Math.max(8, Math.min(x - W / 2, window.innerWidth - W - 8));
  const m = (min: number) => fmtH(min / 60);
  const pct = (v: number) => Math.round(v * 100);
  const s = f.sleep;
  const parts: [string, number, string, string][] = [
    [
      "Deep work",
      f.work,
      "",
      f.deepMin > 0 || f.loggedMin > 0
        ? `${m(f.deepMin)} counted of ${m(f.loggedMin)} · longest ${m(f.longestMin)}`
        : "none logged",
    ],
    [
      "Restraint",
      f.restraint,
      "restraint",
      `distraction ${m(f.distractionMin)}` +
        (f.lateDistractionMin >= 1 ? ` (+${m(f.lateDistractionMin)} late)` : "") +
        ` · ${f.interruptions} interruption${f.interruptions === 1 ? "" : "s"}`,
    ],
    [
      "Sleep",
      f.recovery,
      "sleep",
      s
        ? `${fmtH(s.hours)} · asleep ${fmtClock(s.onset)}` + (s.drift != null ? ` · ${fmtH(s.drift)} off usual` : "")
        : "none tracked (counts 60%)",
    ],
  ];
  const notCounted = [
    f.pendingMin >= 1 && `deep work unconfirmed ${m(f.pendingMin)}`,
    f.unverifiedMin >= 1 && `never confirmed ${m(f.unverifiedMin)} (half)`,
    f.retroMin >= 1 && `logged after ${m(f.retroMin)} (${pct(FOCUS.retro)}%)`,
    f.lateDeepMin >= 1 && `after midnight ${m(f.lateDeepMin)} (half)`,
    f.otherMin >= 5 && `other ${m(f.otherMin)} (${f.otherBy.map(([c]) => c).join(", ")})`,
  ].filter(Boolean);
  return (
    <div className="score-pop" style={{ left, top: y + 6, width: W }} data-testid="score-pop">
      <div className="score-pop-title">
        Focus {f.score}
        {today ? " so far" : ""}
      </div>
      <div className="score-pop-reason" data-testid="score-reason">
        {f.reason}
      </div>
      {parts.map(([name, v, cls, note]) => (
        <div key={name} data-testid={`score-part-${cls || "deep"}`}>
          <div className="score-part">
            <span className="sp-name">{name}</span>
            <span className={"sp-bar " + cls}>
              <i style={{ width: `${pct(v)}%` }} />
            </span>
            <b>{pct(v)}%</b>
          </div>
          <div className="score-part-note">{note}</div>
        </div>
      ))}
      {notCounted.length > 0 && <div className="score-pop-row sp-meta">Not counted: {notCounted.join(" · ")}</div>}
      <div className="score-how">
        100 × deep<sup>0.5</sup> × restraint<sup>0.3</sup> × sleep<sup>0.3</sup>. Deep = {DEEP_CALENDARS.join(", ")}:
        confirmed, uninterrupted, ≥25m stretches, 90m full credit, 4h/day cap.
      </div>
    </div>
  );
}

/** a title with a line-break opportunity after each slash, so
 *  "Passing/Juggling" wraps as "Passing/" + "Juggling", not mid-word (a
 *  zero-width space, not <wbr>: WebKit's -webkit-box mis-wraps around
 *  inline elements) */
function breakable(title: string) {
  return title.replace(/\/(?=\S)/g, "/\u200B");
}

/** An event's text, each piece at the spot lib/labelPlace.ts found for it
 *  inside the event's visible shape. */
function ChipText({ e, p }: { e: CalendarEvent; p: PlacedText | null | undefined }) {
  if (!p) {
    return (
      <span className="chip-title chip-abs" style={{ left: 6, top: 2, right: 4 }}>
        {breakable(e.summary)}
      </span>
    );
  }
  const { title, time: t, loc } = p;
  return (
    <>
      {t?.mode === "inline" ? (
        <span className="chip-line chip-abs" style={{ left: title.x, top: title.y, width: title.w }}>
          <span className="chip-title">{breakable(e.summary)}</span>
          <span className="chip-time-inline">{t.text}</span>
        </span>
      ) : p.titleWhole ? (
        // shown whole: a plain block (WebKit's -webkit-box mis-wraps text
        // that has inline children), capped at the planned lines
        <span
          className="chip-title chip-abs whole"
          style={{ left: title.x, top: title.y, width: title.w, maxHeight: title.lines * 15 }}
        >
          {breakable(e.summary)}
          {t?.mode === "trailing" && (
            <>
              {" "}
              <span className="chip-time-inline">{t.text}</span>
            </>
          )}
        </span>
      ) : (
        <span
          className="chip-title chip-abs"
          style={{ left: title.x, top: title.y, width: title.w, WebkitLineClamp: title.lines }}
        >
          {breakable(e.summary)}
        </span>
      )}
      {t?.mode === "row" && (
        <span className="chip-time chip-abs" style={{ left: t.x, top: t.y, width: t.w }}>
          {t.text}
        </span>
      )}
      {t?.mode === "vertical" && (
        <span className="chip-time chip-time-v chip-abs" style={{ left: t.x, top: t.y, height: t.w }}>
          {t.text}
        </span>
      )}
      {loc && (
        <span
          className="chip-loc chip-abs"
          title={e.location ?? undefined}
          style={{ left: loc.x, top: loc.y, width: loc.w }}
        >
          {e.location}
        </span>
      )}
    </>
  );
}

function GhostChip({
  drag,
  pxPerMin,
  color,
}: {
  drag: DragState;
  pxPerMin: number;
  color: string;
}) {
  let startMin: number, endMin: number;
  if (drag.kind === "create") {
    startMin = snap(Math.min(drag.anchorMin, drag.curMin));
    endMin = Math.max(snap(Math.max(drag.anchorMin, drag.curMin)), startMin + 30);
  } else if (drag.kind === "move") {
    startMin = snap(drag.curMin - (drag.grabOffsetMin ?? 0));
    endMin = startMin + (drag.durationMin ?? 60);
  } else {
    const evStart = drag.event ? minutesOfDay(eventDates(drag.event).start) : 0;
    startMin = evStart;
    endMin = Math.max(snap(drag.curMin), evStart + SNAP_MIN);
  }
  const title = drag.event?.summary ?? "New event";
  const heightPx = Math.max((endMin - startMin) * pxPerMin, 17);
  return (
    <div
      className="chip chip-ghost"
      style={{
        ...chipStyle(color),
        top: startMin * pxPerMin,
        height: heightPx,
        left: 0,
        width: "calc(100% - 2px)",
      }}
    >
      <span className="chip-title">{title}</span>
      {heightPx >= 28 && (
        <span className="chip-time">
          {fmtChipRange(
            new Date(2000, 0, 1, Math.floor(startMin / 60), startMin % 60),
            new Date(2000, 0, 1, Math.floor(endMin / 60) % 24, endMin % 60),
          )}
        </span>
      )}
    </div>
  );
}

export function chipStyle(color: string): React.CSSProperties {
  return {
    "--cal": color,
  } as React.CSSProperties;
}
