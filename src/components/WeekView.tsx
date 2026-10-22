// Week / Day time grid: Notion-style dense grid, drag-create on empty space,
// drag-move chips across time and days, bottom-edge resize, esc cancels drags,
// selection ring, right-click context menu, full-width now line + gutter pill,
// faded past events, persistent draft chip while creating.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  LOCALE,
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
import { prefsVersion, usePrefs } from "../lib/settings";
import { FOCUS, deepCalendars, focusScore, fmtClock, fmtH, type FocusScore } from "../lib/insights";
import { starKey, starState, subscribeStars, toggleStar } from "../lib/stars";
import { isCanceled, markOf, reconExempt, reconKey, reconSince, reconState, setRecon, subscribeRecon, toggleCanceled } from "../lib/recon";
import { rsvpClass } from "../lib/rsvp";
import { colorOf } from "../lib/useBackend";
import { MarginNotes } from "./MarginNotes";
import { CopyTargets } from "./CopyTargets";
import { calendarEditable } from "../lib/types";
import type { Backend, Calendar, CalendarEvent, EventInput } from "../lib/types";
import type { EventActions } from "./App";
import { splitDrill } from "../lib/drill";

const DEFAULT_HOUR_PX = 48;
const SNAP_MIN = 15;
const DAY_MIN = 24 * 60;
const MAX_INDEXED_ALL_DAY_DAYS = 31;
const MAX_INDEXED_TIMED_DAYS = 31;
/** Days rendered beyond each edge of the view. A horizontal trackpad swipe
 *  is scrolled natively by the browser through these real days, exactly
 *  like a vertical scroll (off the main thread: in the app's WKWebView the
 *  calendar's own per-packet path ran at ~30 fps where native runs at 60).
 *  The days are re-centred only once the swipe and its momentum have come
 *  to rest (PAN_SETTLE_MS): in WebKit a scroll position set from script
 *  stops a native scroll and its momentum, so re-centring mid-swipe made the
 *  week snap from day to day, and during momentum WebKit's scrolling thread
 *  can overwrite the script's position (the week jumped by the rebase).
 *  Two weeks each side cover a hard fling; one that reaches the edge stops
 *  there like any scroller, and re-centres when it rests. */
const PAN_OVERSCAN_DAYS = 14;
/** how long the strip must be still before the days are re-centred */
const PAN_SETTLE_MS = 150;
/** The app's WKWebView. WebKit already scrolls the rest of a gesture
 *  asynchronously once its first wheel event isn't cancelled, and
 *  re-registering the wheel listener as passive mid-gesture there costs a
 *  long frame at the start of every swipe (measured with real trackpad
 *  swipes), so the listener stays as it is. */
const MAC_WEBKIT =
  typeof navigator !== "undefined" &&
  /Macintosh/.test(navigator.userAgent) && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent);

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
  /** move: where the pointer went down, and how many days the drag has
   *  switched so far (day switching goes by sideways travel, with slack) */
  grabX?: number;
  grabY?: number;
  dayShift?: number;
}

/** A moved event switches day only after the pointer has travelled this far
 *  past the halfway point of a column, sideways from where it was grabbed
 *  (0.2: 70% of a column), and switches back only past the same margin.
 *  Switching by the column under the pointer made a vertical drag of an
 *  event grabbed near its edge hop to the next day on a few px of drift. */
const DAY_SWITCH_SLACK = 0.2;

function profileRenderStage<T>(id: string, render: () => T): T {
  if (typeof window === "undefined") return render();
  const sink = (window as any).__weekRenderStages;
  if (!Array.isArray(sink)) return render();
  const started = performance.now();
  const result = render();
  sink.push({ id, duration: performance.now() - started });
  return result;
}

interface CtxMenu {
  x: number;
  y: number;
  event: CalendarEvent;
  /** showing the calendars to copy a read-only event into */
  copying?: boolean;
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

/** column widths measured, by day count | gutter | window width */
const lastColPx = new Map<string, number>();

/** the minutes the grid spans from start to end (wall clock: across a DST
 *  change that isn't the elapsed time) */
function wallMinutes(start: Date, end: Date): number {
  const days = Math.round((startOfDay(end).getTime() - startOfDay(start).getTime()) / 86400000);
  return minutesOfDay(end) + days * 1440 - minutesOfDay(start);
}

/** a resize's new end, in wall-clock minutes from the grabbed day's
 *  midnight: the real end moved by the pointer's travel (a box drawn past its
 *  end, by a joint or a tiny last child, resizes from where it was drawn).
 *  One rule for the ghost and the drop: the drop used the real end, the ghost
 *  the pointer, and a grab high on the handle saved 15 minutes past the
 *  ghost; elapsed time (not the wall clock) put a DST day's end an hour off. */
function resizedEndMin(d: { event?: CalendarEvent | null; curMin: number; anchorMin: number }, day: Date): number {
  if (!d.event) return snap(d.curMin);
  return snap(wallMinutes(startOfDay(day), eventDates(d.event).end) + d.curMin - d.anchorMin);
}

export function WeekView(props: {
  backend: Backend | null;
  days: Date[];
  events: CalendarEvent[];
  calendars: Calendar[];
  selected: CalendarEvent[];
  draft: DraftEvent | null;
  /** the calendar a new event files on when not the primary (isolated) */
  draftCalendarId?: string | null;
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
  // notes hidden (A / ⇧⌘M / Settings) stay laid out, just unseen: a
  // remounted notes layer didn't place its notes again
  const showNotes = usePrefs().showNotes;
  useEffect(() => {
    document.body.classList.toggle("notes-hidden", !showNotes);
    return () => document.body.classList.remove("notes-hidden");
  }, [showNotes]);
  const { days, events, calendars } = props;
  // the calendar a new event files on: the isolated one when it can be
  // written, else the primary (a draft in an isolated Work wore Personal's
  // colour while the panel said Work)
  const newEventCalendarId =
    (props.draftCalendarId && calendars.find((c) => c.id === props.draftCalendarId && calendarEditable(c))?.id) ||
    (calendars.find((c) => c.is_primary) ?? calendars[0])?.id || "";
  // Development-only React Profiler callbacks are unavailable in the
  // production build used for frame-budget measurements. Let an opt-in E2E
  // sink time this component through its layout-effect commit instead; the
  // normal app does no clock reads or allocations.
  const hasRenderSink = typeof window !== "undefined" && (
    Array.isArray((window as any).__weekViewRenderDurations) ||
    Array.isArray((window as any).__weekViewRenderMarks)
  );
  const componentRenderStartedAt = hasRenderSink ? performance.now() : null;
  const propsRef = useRef(props);
  propsRef.current = props;
  // leaving the grid (another view) is leaving the hovered chip too: its
  // pointerleave never fires, and x in month view selected that event
  useEffect(() => () => propsRef.current.onHover?.(null), []);
  // the event a hovered margin note refers to is lit like a selected one
  // (only a click showed which event a note was about). Set on the chips
  // directly: the columns are memoized, and a hover shouldn't re-lay out
  // the grid.
  const lightNoteEvent = (e: CalendarEvent | null) => {
    const strip = colsStripRef.current;
    if (!strip) return;
    strip.querySelectorAll(".chip.note-hover").forEach((el) => el.classList.remove("note-hover"));
    if (e) strip.querySelectorAll(`.chip-timed[data-ek="${CSS.escape(keyOf(e))}"]`).forEach((el) => el.classList.add("note-hover"));
  };
  useLayoutEffect(() => {
    if (componentRenderStartedAt === null) return;
    const commitTime = performance.now();
    const duration = commitTime - componentRenderStartedAt;
    const durations = (window as any).__weekViewRenderDurations;
    if (Array.isArray(durations)) durations.push(duration);
    const marks = (window as any).__weekViewRenderMarks;
    if (Array.isArray(marks)) marks.push({
      startTime: componentRenderStartedAt,
      commitTime,
      actualDuration: duration,
    });
  });
  const dayIndexByDateRef = useRef(new Map<number, number>());
  dayIndexByDateRef.current = new Map(days.map((day, index) => [startOfDay(day).getTime(), index]));
  const adjacentDay = (day: Date, direction: -1 | 1): Date => {
    let next = addDays(day, direction);
    if (props.hideWeekends) {
      while (next.getDay() === 0 || next.getDay() === 6) next = addDays(next, direction);
    }
    return next;
  };
  const beforeDays = Array.from({ length: PAN_OVERSCAN_DAYS }, (_, index) => {
    let day = days[0];
    for (let count = index; count < PAN_OVERSCAN_DAYS; count++) day = adjacentDay(day, -1);
    return day;
  });
  const afterDays = Array.from({ length: PAN_OVERSCAN_DAYS }, (_, index) => {
    let day = days[days.length - 1];
    for (let count = 0; count <= index; count++) day = adjacentDay(day, 1);
    return day;
  });
  const pxPerMin = (props.hourPx ?? DEFAULT_HOUR_PX) / 60;
  const gutterW = props.secondaryTz ? 92 : 46;
  // the gutters label the days on screen: from a day that isn't a DST
  // change (the fall-back Sunday, first in its week, gave the whole week its
  // pre-change hours), the middle one shown unless that one is
  const labelDay = (() => {
    const isChange = (d: Date) => startOfDay(addDays(d, 1)).getTime() - startOfDay(d).getTime() !== 86400000;
    const mid = days[Math.floor(days.length / 2)] ?? now();
    return isChange(mid) ? (days.find((d) => !isChange(d)) ?? mid) : mid;
  })();
  const tzLabel = (h: number): string => {
    try {
      // (with its minutes: India, Newfoundland, Nepal sit off the hour)
      return new Intl.DateTimeFormat(LOCALE, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: props.secondaryTz!,
      }).format(atWallClock(labelDay, h * 60)).replace(":00", "");
    } catch {
      return "";
    }
  };
  const gridRef = useRef<HTMLDivElement>(null);
  // Dense clusters can contain hundreds of rows per day. Keep their full
  // height and order, but only mount buttons near the vertical viewport;
  // otherwise WebKit lays out and paints thousands of offscreen descendants
  // on every horizontal scroll frame.
  const [rowWindow, setRowWindow] = useState<{ top: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    let lastVerticalScroll = Number.NaN;
    const measure = () => {
      const scrollTop = grid.scrollTop;
      // Horizontal pans fire scroll events too. They must not measure layout
      // or schedule React work just to keep a vertical row window unchanged.
      if (scrollTop === lastVerticalScroll) return;
      lastVerticalScroll = scrollTop;
      const body = grid.querySelector<HTMLElement>(".grid-body");
      if (!body) return;
      const top = scrollTop - body.offsetTop;
      const bottom = top + grid.clientHeight;
      setRowWindow((current) => {
        if (current && top >= current.top + 120 && bottom <= current.bottom - 120) return current;
        return { top: top - 240, bottom: bottom + 240 };
      });
    };
    measure();
    grid.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(() => {
      lastVerticalScroll = Number.NaN;
      measure();
    });
    observer.observe(grid);
    // (the all-day row too: it opening or closing moves the grid body by
    // more than the window's margin without a scroll, and the rows on
    // screen stayed unmounted in WebKit, which doesn't anchor scroll)
    const allDay = grid.querySelector(".allday-row");
    if (allDay) observer.observe(allDay);
    return () => {
      grid.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, []);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  /** the all-day row showing every event, not three a day ("+N more") */
  const [allDayOpen, setAllDayOpen] = useState(false);
  // Escape closes the right-click menu (and only that: the selection and the
  // open event stay)
  useEffect(() => {
    if (!ctx) return;
    const onKey = (e: KeyboardEvent) => {
      // another layer opening over the menu (⌘K, Settings, Help) closes it:
      // left under ⌘K it took ⌘K's Escape
      if ((e.metaKey || e.ctrlKey) && [",", "k", "/"].includes(e.key.toLowerCase())) {
        setCtx(null);
        return;
      }
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setCtx(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ctx]);
  /** the focus-score explanation being hovered: its day and badge position */
  const [scorePop, setScorePop] = useState<{ day: Date; x: number; y: number } | null>(null);
  const [nowTick, forceTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const [starTick, bumpStar] = useState(0);
  useEffect(() => subscribeStars(() => bumpStar((n) => n + 1)), []);
  const [reconTick, bumpRecon] = useState(0);
  useEffect(() => subscribeRecon(() => bumpRecon((n) => n + 1)), []);

  // Notion: a horizontal two-finger swipe slides the day columns under the
  // pointer, pixel for pixel. The shared weekview scroll surface moves the
  // header, all-day row, and body together. Crossing a column width requests
  // a day shift without forcing a React render inside the wheel handler; later
  // scroll deltas resume from the preserved partial-column offset.
  const dayClipRef = useRef<HTMLDivElement | null>(null);
  // Seeded with the width last measured for this day count, window width
  // and gutter: coming back to the week (from month or list) laid every
  // day out at width 0, measured, then laid them all out again.
  const colPxKey = `${days.length}|${gutterW}|${typeof window === "undefined" ? 0 : window.innerWidth}`;
  const [colPx, setColPx] = useState(() => lastColPx.get(colPxKey) ?? 0);
  const colPxRef = useRef(colPx || 1);
  const measuredColPxRef = useRef(0);
  // Measured off the scroll container, not the day clip: the clip is sized
  // from colPx (see rowW below).
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      const width = Math.max(1, (el.clientWidth - gutterW) / Math.max(1, days.length));
      colPxRef.current = width;
      lastColPx.set(`${days.length}|${gutterW}|${window.innerWidth}`, width);
      setColPx(width);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [days.length, gutterW]);
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
  const colsStripRef = useRef<HTMLDivElement | null>(null);
  // acc: px the content has been swiped past the RENDERED days[0].
  // pending: day steps already requested from onPan but not rendered yet.
  // The outer weekview scroll surface moves all three strips together; acc
  // carries any distance past the one-column overscan while React shifts days.
  // Record pending before calling onPan: a synchronous React commit reads it
  // in the firstDay layout effect to distinguish a swipe from navigation.
  const panRef = useRef({ acc: 0, pending: 0 });
  const programmaticScrollLeftRef = useRef<number | null>(null);
  const observedScrollLeftRef = useRef<number | null>(null);
  const nativePanRef = useRef(false);
  const extN = days.length + PAN_OVERSCAN_DAYS * 2;
  // The header, all-day and body rows span the whole scroll width, so their
  // sticky time gutter stays put however far into the runway the week rests
  // (a viewport-wide row scrolled its gutter away past one screen); the day
  // clip inside stays the width of the visible days.
  const clipW = colPx > 0 ? colPx * days.length : undefined;
  const rowW = colPx > 0 ? gutterW + colPx * extN : undefined;
  const rowCols = clipW ? `${gutterW}px ${clipW}px` : `${gutterW}px 1fr`;
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
      const grid = gridRef.current;
      if (grid) {
        const base = colPxRef.current;
        const room = (PAN_OVERSCAN_DAYS - 1) * base;
        grid.scrollLeft = PAN_OVERSCAN_DAYS * base + Math.max(-room, Math.min(room, pan.acc));
        observedScrollLeftRef.current = grid.scrollLeft;
        programmaticScrollLeftRef.current = grid.scrollLeft;
      }
    } else {
      // moved by navigation (Today, arrows, mini-calendar), not the swipe
      pan.acc = 0;
      pan.pending = 0;
      const grid = gridRef.current;
      if (grid) {
        grid.scrollLeft = PAN_OVERSCAN_DAYS * colPxRef.current;
        pan.acc = grid.scrollLeft - PAN_OVERSCAN_DAYS * colPxRef.current;
        observedScrollLeftRef.current = grid.scrollLeft;
        programmaticScrollLeftRef.current = grid.scrollLeft;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstDay]);
  useLayoutEffect(() => {
    panRef.current.acc = 0;
    panRef.current.pending = 0;
    const grid = gridRef.current;
    if (grid) {
      const base = PAN_OVERSCAN_DAYS * colPxRef.current;
      grid.scrollLeft = base;
      panRef.current.acc = grid.scrollLeft - base;
      observedScrollLeftRef.current = grid.scrollLeft;
      programmaticScrollLeftRef.current = grid.scrollLeft;
    }
  }, [days.length, props.hideWeekends]);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || colPx <= 0) return;
    const previous = measuredColPxRef.current;
    const pan = panRef.current;
    if (previous <= 0) {
      grid.scrollLeft = PAN_OVERSCAN_DAYS * colPx;
      pan.acc = grid.scrollLeft - PAN_OVERSCAN_DAYS * colPx;
    } else {
      const nextBase = PAN_OVERSCAN_DAYS * colPx;
      const residual = pan.acc * (colPx / previous);
      grid.scrollLeft = nextBase + residual;
      pan.acc = residual;
    }
    observedScrollLeftRef.current = grid.scrollLeft;
    programmaticScrollLeftRef.current = grid.scrollLeft;
    measuredColPxRef.current = colPx;
  }, [colPx]);
  useEffect(() => {
    const el = gridRef.current;
    const onPan = props.onPan;
    if (!el || !onPan) return;
    observedScrollLeftRef.current = el.scrollLeft;
    let horizontalLocked = false;
    let lastWheelAt = 0;
    let pendingDx = 0;
    let pendingDxStartedAt = 0;
    let leadInExpired = false;
    let wheelListenerPassive = false;
    let nativePanTimer: number | null = null;
    let setWheelPassiveMode: (passive: boolean) => void = () => {};
    let resetNativePanTimer: () => void = () => {};
    const onWheel = (e: WheelEvent) => {
      const now = performance.now();
      if (now - lastWheelAt > 180) {
        horizontalLocked = false;
        pendingDx = 0;
        pendingDxStartedAt = 0;
        leadInExpired = false;
        nativePanRef.current = false;
        setWheelPassiveMode(false);
      }
      lastWheelAt = now;
      if (e.isTrusted && nativePanRef.current) {
        // Keep the remainder of a horizontal trackpad stream on the browser's
        // native scroller, including small cross-axis jitter. The idle timer
        // restores axis filtering for a later gesture.
        resetNativePanTimer();
        return;
      }
      const unitX = e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? el.clientWidth
          : 1;
      const unitY = e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? el.clientHeight
          : 1;
      let deltaX = e.deltaX * unitX;
      if (!horizontalLocked) {
        // Preserve X movement from ambiguous lead-in packets. Once a
        // horizontally dominant sample establishes intent, replay that X
        // displacement and keep the axis locked through later cross-axis noise.
        // Do not let a prolonged vertical/diagonal stream accumulate that X
        // indefinitely and turn a later horizontal gesture into a jump.
        if (pendingDxStartedAt === 0) pendingDxStartedAt = now;
        if (!leadInExpired && now - pendingDxStartedAt <= 100) {
          pendingDx += deltaX;
        } else {
          pendingDx = 0;
          leadInExpired = true;
        }
        if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) {
          // Preserve vertical intent when a mixed packet is still ambiguous;
          // don't let small X noise become a horizontal jump.
          if (e.deltaX !== 0) {
            e.preventDefault();
            el.scrollTop += e.deltaY * unitY;
          }
          return;
        }
        horizontalLocked = true;
        if (!leadInExpired) deltaX = pendingDx;
        pendingDx = 0;
      }
      const pan = panRef.current;
      const base = colPxRef.current;
      if (e.isTrusted && Math.abs(deltaX) > 2 * Math.abs(e.deltaY * unitY)) {
        // A horizontal trackpad stream: carry buffered lead-in X once, then
        // let every packet scroll natively (no cancelable listener on the hot
        // path); the days re-centre when it settles (onScroll).
        const currentDeltaX = e.deltaX * unitX;
        const carry = deltaX - currentDeltaX;
        if (carry !== 0) {
          el.scrollLeft += carry;
          pan.acc += carry;
          observedScrollLeftRef.current = el.scrollLeft;
          programmaticScrollLeftRef.current = el.scrollLeft;
          scheduleSettle();
        }
        nativePanRef.current = true;
        resetNativePanTimer();
        setWheelPassiveMode(true);
        return;
      }
      e.preventDefault(); // keep WebKit from treating the custom path as history navigation
      if (nativePanRef.current) {
        // Account for coalesced native scroll before returning to custom
        // handling, so no pixels are replayed or dropped at the transition.
        const observed = observedScrollLeftRef.current ?? el.scrollLeft;
        pan.acc += el.scrollLeft - observed;
        observedScrollLeftRef.current = el.scrollLeft;
        nativePanRef.current = false;
        setWheelPassiveMode(false);
      }
      pan.acc += deltaX;
      const want = Math.trunc(pan.acc / colPxRef.current);
      if (want !== pan.pending) {
        const steps = want - pan.pending;
        pan.pending = want;
        onPan(steps);
      }
      // the position on the days still shown until the re-centre renders
      const room = PAN_OVERSCAN_DAYS * base;
      el.scrollLeft = room + Math.max(-room, Math.min(room, pan.acc));
      observedScrollLeftRef.current = el.scrollLeft;
      programmaticScrollLeftRef.current = el.scrollLeft;
    };
    setWheelPassiveMode = (passive) => {
      if (MAC_WEBKIT || wheelListenerPassive === passive) return;
      el.removeEventListener("wheel", onWheel);
      el.addEventListener("wheel", onWheel, { passive });
      wheelListenerPassive = passive;
    };
    resetNativePanTimer = () => {
      if (nativePanTimer != null) window.clearTimeout(nativePanTimer);
      nativePanTimer = window.setTimeout(() => {
        nativePanTimer = null;
        nativePanRef.current = false;
        setWheelPassiveMode(false);
      }, 180);
    };
    // re-centre the days once the strip has been still for a moment
    let settleTimer: number | null = null;
    const commitPan = () => {
      const pan = panRef.current;
      const want = Math.round(pan.acc / colPxRef.current);
      if (want === pan.pending) return;
      const steps = want - pan.pending;
      pan.pending = want;
      onPan(steps);
    };
    // While a re-centre is pending the swiped-in runway days are on screen:
    // they take presses then (the press re-centres first, below, and the
    // handlers look their day up at press time), not only after the timer.
    const scheduleSettle = () => {
      if (settleTimer != null) window.clearTimeout(settleTimer);
      el.classList.add("pan-settling");
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        el.classList.remove("pan-settling");
        commitPan();
      }, PAN_SETTLE_MS);
    };
    // Anything the user does next acts on the days as drawn: a press or key
    // re-centres right away (window capture runs first; React renders the
    // update in the microtask before the calendar's own handlers), so a drag,
    // marquee or "t" never straddles a re-centre or works from stale days.
    const flushSettle = () => {
      if (settleTimer == null) return;
      window.clearTimeout(settleTimer);
      settleTimer = null;
      el.classList.remove("pan-settling");
      commitPan();
    };
    const onScroll = () => {
      const actual = el.scrollLeft;
      const expected = programmaticScrollLeftRef.current;
      if (expected != null && Math.abs(actual - expected) < 0.01) {
        programmaticScrollLeftRef.current = null;
        observedScrollLeftRef.current = actual;
        return;
      }
      programmaticScrollLeftRef.current = null;
      const pan = panRef.current;
      const observed = observedScrollLeftRef.current ?? actual;
      if (actual === observed) return; // a vertical scroll
      // Add only user-driven scroll deltas. Rebuilding acc from scrollLeft
      // loses the fractional remainder whenever the browser quantizes a
      // programmatic rebase to an integer offset.
      pan.acc += actual - observed;
      observedScrollLeftRef.current = actual;
      // A native scroll keeps going: re-centre only once it rests.
      scheduleSettle();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pointerdown", flushSettle, true);
    window.addEventListener("keydown", flushSettle, true);
    return () => {
      window.removeEventListener("pointerdown", flushSettle, true);
      window.removeEventListener("keydown", flushSettle, true);
      if (nativePanTimer != null) window.clearTimeout(nativePanTimer);
      if (settleTimer != null) window.clearTimeout(settleTimer);
      el.classList.remove("pan-settling");
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", onScroll);
    };
  }, [props.onPan]);

  const nowDate = now();
  const todayIdx = days.findIndex((d) => isSameDay(d, nowDate));

  // Auto-scroll: center-ish on now when today is visible, else 7am — but only
  // when ENTERING the view (mount: month, list and Insights unmount this).
  // Navigation, a pinch, a day-count change and weekends off keep the scroll
  // position, like Notion (keyed on the day count, every pinch step jumped
  // the hours under your fingers to 6:30 AM).
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const targetMin = todayIdx >= 0 ? Math.max(0, minutesOfDay(nowDate) - 150) : 7 * 60 - 40;
    el.scrollTop = targetMin * pxPerMin;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // zooming hours (⇧⌘. / ⇧⌘,) keeps the time at the top in view
  const prevPxRef = useRef(pxPerMin);
  useLayoutEffect(() => {
    const el = gridRef.current;
    const prev = prevPxRef.current;
    prevPxRef.current = pxPerMin;
    if (!el || prev === pxPerMin) return;
    el.scrollTop = (el.scrollTop / prev) * pxPerMin;
  }, [pxPerMin]);

  const timed = useMemo(
    () => events.filter((e) => !e.all_day && e.start && e.end),
    [events],
  );

  // Index once per event snapshot instead of scanning the whole fetched
  // window each time panning exposes a new day. This matters when a 3-week
  // prefetch contains thousands of events but the visible day has only a few.
  const dayItemsIndex = useMemo(() => profileRenderStage("day-items-index", () => {
    const byDay = new Map<number, Array<{ item: CalendarEvent; startMin: number; endMin: number }>>();
    const longEvents: Array<{ item: CalendarEvent; start: Date; end: Date }> = [];
    const order = new Map<CalendarEvent, number>();
    for (let position = 0; position < timed.length; position++) {
      const e = timed[position];
      const { start, end } = eventDates(e);
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) continue;
      const firstDay = startOfDay(start);
      const lastDay = end > start
        ? startOfDay(new Date(end.getTime() - 1))
        : end.getTime() === start.getTime() && start.getTime() !== firstDay.getTime()
          ? firstDay
          : null;
      if (!lastDay) continue;
      order.set(e, position);
      if (end.getTime() - start.getTime() > (MAX_INDEXED_TIMED_DAYS + 1) * DAY_MIN * 60_000) {
        // Keep malformed or unusually long timed events from allocating one
        // index entry per day; check these rare spans only for rendered days.
        longEvents.push({ item: e, start, end });
        continue;
      }
      for (let day = firstDay; day <= lastDay; day = addDays(day, 1)) {
        const key = day.getTime();
        const dayEnd = addDays(day, 1);
        if (end <= day || start >= dayEnd) continue;
        const items = byDay.get(key) ?? [];
        items.push({
          item: e,
          startMin: key === firstDay.getTime() ? minutesOfDay(start) : 0,
          endMin: key === lastDay.getTime() && end < dayEnd
            ? Math.max(minutesOfDay(end), 1)
            : DAY_MIN,
        });
        byDay.set(key, items);
      }
    }
    return { byDay, longEvents, order };
  }), [timed]);

  // Per-day layout + header-score caches: swiping shifts the visible window
  // but a given day's packing doesn't change, so cache by day as long as the
  // inputs (events identity, zoom, star version via forceTick) are unchanged.
  const layoutCacheRef = useRef<{
    deps: unknown[];
    dayItems: Map<number, Array<{ item: CalendarEvent; startMin: number; endMin: number }>>;
    pack: Map<number, ReturnType<typeof packDayWithSleeves<CalendarEvent>>>;
    text: Map<number, Map<CalendarEvent, PlacedText> | null>;
    clusters: Map<number, { deps: unknown[]; nodes: React.ReactNode[] }>;
    clusterTimes: Map<number, {
      deps: unknown[];
      signature: string;
      states: Map<string, { past: boolean; recon: ReturnType<typeof reconState> }>;
    }>;
    chips: Map<number, { deps: unknown[]; containers: React.ReactNode[]; regular: React.ReactNode[] }>;
    score: Map<number, FocusScore>;
    minute: number;
  }>({ deps: [], dayItems: new Map(), pack: new Map(), text: new Map(), clusters: new Map(), clusterTimes: new Map(), chips: new Map(), score: new Map(), minute: 0 });
  {
    const c = layoutCacheRef.current;
    const minute = Math.floor(nowDate.getTime() / 60000);
    if (c.minute !== minute) {
      c.minute = minute;
      // Focus score is time-sensitive; event layout and row DOM are not.
      c.score.clear();
    }
    // (prefsVersion: the deep-work calendars score the day; the header kept
    // the old score until the next minute after a Settings change)
    const deps = [pxPerMin, calendars, reconTick, props.seamStyle, colPx, starTick, prefsVersion()];
    if (deps.some((d, i) => d !== c.deps[i])) {
      c.deps = deps;
      c.dayItems.clear();
      c.pack.clear();
      c.text.clear();
      c.clusters.clear();
      c.clusterTimes.clear();
      c.chips.clear();
      c.score.clear();
    }
    // Keep only the dates this strip can render (visible days + two runway
    // days on each side). Caches no longer need the periodic clock tick to
    // bound their lifetime as the user pans through the calendar.
    const retainedDays = new Set(
      [...days, ...beforeDays, ...afterDays].map((day) => startOfDay(day).getTime()),
    );
    for (const cache of [c.dayItems, c.pack, c.text, c.clusters, c.clusterTimes, c.chips, c.score]) {
      for (const key of cache.keys()) if (!retainedDays.has(key)) cache.delete(key);
    }
  }
  const allDay = useMemo(() => events.filter((e) => e.all_day), [events]);
  const allDayByDay = useMemo(() => profileRenderStage("all-day-items-index", () => {
    const byDay = new Map<number, CalendarEvent[]>();
    const longEvents: CalendarEvent[] = [];
    const order = new Map<CalendarEvent, number>();
    for (const [position, event] of allDay.entries()) {
      const { start, end } = eventDates(event);
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) continue;
      order.set(event, position);
      const spanDays = (Date.parse(event.end) - Date.parse(event.start)) / 86_400_000;
      if (spanDays > MAX_INDEXED_ALL_DAY_DAYS) {
        // Avoid allocating one map entry per day for malformed or unusually
        // long spans; these rare rows are checked only against rendered days.
        longEvents.push(event);
        continue;
      }
      for (let day = startOfDay(start); day < end; day = addDays(day, 1)) {
        const key = day.getTime();
        const items = byDay.get(key) ?? [];
        items.push(event);
        byDay.set(key, items);
      }
    }
    return { byDay, longEvents, order };
  }), [allDay]);
  /** a new value whenever the chips may have moved, other than by a swipe
   *  (MarginNotes gets the first day separately and carries notes along) */
  const notesLayoutKey = useMemo(
    () => ({}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timed, pxPerMin, calendars, reconTick, starTick, props.seamStyle, colPx, days.length, props.hideWeekends],
  );

  const colWidth = useCallback(() => {
    const clip = dayClipRef.current?.clientWidth;
    const grid = gridRef.current?.getBoundingClientRect().width ?? 0;
    return (clip && clip > 0 ? clip : grid - gutterW) / days.length;
  }, [days.length, gutterW]);
  const locate = useCallback(
    (clientX: number, clientY: number): { dayIndex: number; min: number } | null => {
      const el = gridRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left;
      const bodyTop = (el.querySelector(".grid-body") as HTMLElement)?.offsetTop ?? 0;
      const yy = clientY - rect.top + el.scrollTop - bodyTop;
      const gutter = gutterW;
      // columns as drawn: the day area's own width (not the grid's, which
      // counts the scrollbar), shifted by a partial swipe (acc px past days[0])
      const colW = colWidth();
      const dayIndex = Math.max(0, Math.min(days.length - 1, Math.floor((x - gutter + panRef.current.acc) / colW)));
      const min = Math.max(0, Math.min(DAY_MIN, yy / pxPerMin));
      return { dayIndex, min };
    },
    [days.length, gutterW, colWidth],
  );

  const commitDrag = useCallback(
    (d: DragState) => {
      // ⌥-drag copies wherever it drops (the all-day lane too), else moves
      const writeDrag = (ev: CalendarEvent, input: EventInput, label: string) =>
        // (a copy leaves the red-pen note on the original, as ⌘D does)
        d.duplicate
          ? props.actions.create({ ...input, description: splitDrill(input.description ?? null).body || null })
          : props.actions.update(ev, input, label);
      if (d.kind === "create") {
        // (a click in the day's last minutes snaps to midnight: keep it in
        // this day, or it drafted on the next)
        const a = Math.min(snap(Math.min(d.anchorMin, d.curMin)), DAY_MIN - SNAP_MIN);
        const b = snap(Math.max(d.anchorMin, d.curMin));
        const startMin = a;
        const endMin = Math.min(b - a < SNAP_MIN ? a + 30 : b, DAY_MIN);
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
          // moved along the lane: shift the whole span by the days the
          // grabbed chip moved (a multi-day event can be grabbed on any of
          // its days; starting the span on the pointer's day jumped it)
          const spanDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000));
          // (in calendar days between the two columns' dates: with weekends
          // hidden, neighbouring columns can be three days apart)
          const shift = Math.round(
            (startOfDay(days[d.allDayDropDay]).getTime() - startOfDay(days[d.dayIndex]).getTime()) / 86400000);
          const day = startOfDay(start);
          day.setDate(day.getDate() + shift);
          const newEnd = new Date(day);
          newEnd.setDate(newEnd.getDate() + spanDays);
          if (!isSameDay(day, start)) {
            writeDrag(
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
          // (clamped to the day's last slot, as the ghost is: a drop at the
          // very bottom stored it at midnight on the next day)
          const startMin = Math.min(snap(d.curMin), DAY_MIN - SNAP_MIN);
          const newStart = atWallClock(day, startMin);
          writeDrag(
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
        writeDrag(
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
        // (no later than the day's last slot: grabbed near its top and pulled
        // to the bottom, a late event moved into tomorrow, off a 1-day view)
        const newStartMin = Math.min(snap(d.curMin - (d.grabOffsetMin ?? 0)), DAY_MIN - SNAP_MIN);
        const day = days[d.curDayIndex];
        const newStart = atWallClock(day, newStartMin);
        if (d.duplicate) {
          const dur = d.durationMin ?? 60;
          const newEnd = new Date(newStart.getTime() + dur * 60000);
          props.actions.create({
            calendar_id: d.event.calendar_id,
            summary: d.event.summary,
            description: splitDrill(d.event.description).body || null, // (the note stays on the original)
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
        const endMin = Math.max(resizedEndMin(d, day), minEnd);
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
        let dayIndex = loc.dayIndex;
        let dayShift = d.dayShift;
        if (d.kind === "move" && d.grabX != null) {
          // sideways travel from the grab point, with slack both ways
          const raw = (ev.clientX - d.grabX) / colWidth();
          let k = d.dayShift ?? 0;
          while (raw > k + 0.5 + DAY_SWITCH_SLACK) k++;
          while (raw < k - 0.5 - DAY_SWITCH_SLACK) k--;
          k = Math.max(-d.dayIndex, Math.min(days.length - 1 - d.dayIndex, k));
          dayShift = k;
          dayIndex = d.dayIndex + k;
        }
        let allDayDropDay: number | null = null;
        if (d.kind === "move") {
          const lane = gridRef.current?.querySelector(".allday-row");
          if (lane) {
            const r = lane.getBoundingClientRect();
            // (an all-day chip stays in the lane above it too: drifting onto
            // the date header made it a timed event under the sticky header)
            if ((d.event?.all_day || ev.clientY >= r.top) && ev.clientY <= r.bottom) allDayDropDay = dayIndex;
          }
        }
        const next: DragState = {
          ...d,
          curDayIndex: dayIndex,
          dayShift,
          curMin: loc.min,
          clientX: ev.clientX,
          clientY: ev.clientY,
          allDayDropDay,
          // (in the lane, an all-day chip moves only when its day changes: a
          // click with a little jitter is still a click)
          // a chip moves once the pointer has travelled 4px (a click's
          // wobble of 3 minutes, 2.4px, snapped 9:05 to 9:15); creating a
          // new event still goes by minutes
          moved: d.moved || dayIndex !== d.dayIndex || (allDayDropDay != null && !d.event?.all_day) ||
            (d.kind === "move" && d.event?.all_day
              // an all-day chip in its lane moves only by changing day (a
              // 5px wobble was a "move" that wrote nothing and opened nothing)
              ? allDayDropDay == null
              : d.grabY != null
                ? Math.hypot(ev.clientX - (d.grabX ?? ev.clientX), ev.clientY - d.grabY) >= 4
                : Math.abs(loc.min - d.anchorMin) > 3),
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
    [locate, commitDrag, props, colWidth],
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
      // every column an event covers counts (the after-midnight part of
      // an overnight event was out of reach)
      const hits = timed.filter((ev) => {
        const { start, end } = eventDates(ev);
        for (let idx = box.d0; idx <= box.d1; idx++) {
          const dd = days[idx];
          if (!dd) continue;
          const d0 = startOfDay(dd).getTime();
          const d1 = d0 + DAY_MIN * 60000;
          if (end.getTime() <= d0 || start.getTime() >= d1) continue;
          const sMin = start.getTime() <= d0 ? 0 : minutesOfDay(start);
          const eMin = end.getTime() >= d1 ? DAY_MIN : minutesOfDay(end);
          if (eMin > box.m0 && sMin < box.m1) return true;
        }
        return false;
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
    // a runway day (off the visible days): not a drag origin
    if (e.button !== 0 || dayIndex < 0) return;
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
      const target = e.currentTarget as HTMLElement;
      const pointerId = e.pointerId;
      const origin = { x: e.clientX, y: e.clientY };
      let moved = false;
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
      };
      const onMove = (move: PointerEvent) => {
        if (move.pointerId === pointerId && Math.hypot(move.clientX - origin.x, move.clientY - origin.y) >= 4) {
          moved = true;
        }
      };
      const onUp = (up: PointerEvent) => {
        if (up.pointerId !== pointerId) return;
        cleanup();
        if (!moved && up.target instanceof Node && target.contains(up.target)) {
          propsRef.current.onSelect(ev);
          propsRef.current.onOpenEvent(ev, origin);
        }
      };
      const onCancel = (cancel: PointerEvent) => {
        if (cancel.pointerId === pointerId) cleanup();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
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
    // (wall-clock minutes, as the pointer's and the drop's are: elapsed
    // minutes put every move on a DST Sunday an hour off)
    const startMinInGrabDay = wallMinutes(startOfDay(days[dayIndex]), start);
    beginDrag({
      kind: isResize ? "resize" : "move",
      duplicate: !isResize && e.altKey,
      event: ev,
      dayIndex,
      anchorMin: loc.min,
      grabOffsetMin: ev.all_day ? 0 : loc.min - startMinInGrabDay,
      // (as it is: a zero-length event stays one, as Google keeps it; the
      // ghost has its own minimum height)
      durationMin: ev.all_day ? 60 : (end.getTime() - start.getTime()) / 60000,
      curDayIndex: dayIndex,
      curMin: loc.min,
      clientX: e.clientX,
      clientY: e.clientY,
      grabX: e.clientX,
      grabY: e.clientY,
      dayShift: 0,
      moved: false,
    });
  };

  const startChipDragRef = useRef(startChipDrag);
  startChipDragRef.current = startChipDrag;

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
    const landing = atWallClock(days[d.curDayIndex], Math.min(snap(d.curMin - (d.grabOffsetMin ?? 0)), DAY_MIN - SNAP_MIN));
    const shift = wallShiftBetween(start, landing);
    // weekends hidden: the days moved are weekdays (Fri + 1 is Mon), counted
    // from the start's day to the landing's (not columns: an overnight
    // event's after-midnight piece is a column past its start)
    if (props.hideWeekends) {
      const x = startOfDay(start), y = startOfDay(landing);
      const dir = y > x ? 1 : -1;
      let n = 0;
      while (!isSameDay(x, y)) {
        x.setDate(x.getDate() + dir);
        if (x.getDay() % 6 !== 0) n += dir;
      }
      return { ...shift, days: n, business: true };
    }
    return shift;
  }
  /** while a group is dragged: the others' landing spots (ghosts, by day
   *  column) and which events are on the move (dimmed in place) */
  const groupDrag = useMemo(() => {
    const shift = groupShiftOf(drag);
    if (!shift || !drag?.event) return null;
    const moving = new Set<string>();
    const ghosts = new Map<
      number,
      { key: string; title: string; color: string; startMin: number; endMin: number; full: { startMin: number; endMin: number } }[]
    >();
    for (const sel of props.selected) {
      const k = keyOf(sel);
      if (k === keyOf(drag.event)) continue;
      const e = timed.find((x) => keyOf(x) === k) ?? sel; // the current copy
      if (e.all_day || !editableCal(e.calendar_id)) continue;
      moving.add(k);
      const { start, end } = eventDates(e);
      const s = shiftWallClock(start, shift);
      // its day counted from the first column (it may land off screen and
      // still run into it past midnight)
      const day = Math.round((startOfDay(s).getTime() - startOfDay(days[0]).getTime()) / 86400000);
      const startMin = minutesOfDay(s);
      const endMin = startMin + Math.max(15, (end.getTime() - start.getTime()) / 60000);
      for (const p of ghostPieces(day, startMin, endMin, days.length)) {
        if (!ghosts.has(p.di)) ghosts.set(p.di, []);
        ghosts.get(p.di)!.push({
          key: k,
          title: e.summary,
          color: colorOf(calendars, e.calendar_id),
          startMin: p.startMin,
          endMin: p.endMin,
          full: { startMin, endMin },
        });
      }
    }
    return { moving, ghosts };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, props.selected, timed, days, calendars]);
  const selectedKey = props.selected.length === 1 ? keyOf(props.selected[0]) : null;

  /** where the dragged event lands: minutes from day `day`'s midnight (either
   *  end may run into the next or previous day), cut into a piece per column */
  const dragGhost = (() => {
    if (!drag || !drag.moved) return null;
    let day = drag.curDayIndex;
    let startMin: number;
    let endMin: number;
    if (drag.kind === "create") {
      day = drag.dayIndex;
      // the commit's rule (commitDrag): a 15-minute drag makes 15 minutes
      startMin = Math.min(snap(Math.min(drag.anchorMin, drag.curMin)), DAY_MIN - SNAP_MIN);
      const b = snap(Math.max(drag.anchorMin, drag.curMin));
      endMin = Math.min(b - startMin < SNAP_MIN ? startMin + 30 : b, DAY_MIN);
    } else if (drag.kind === "move") {
      startMin = Math.min(snap(drag.curMin - (drag.grabOffsetMin ?? 0)), DAY_MIN - SNAP_MIN);
      endMin = startMin + Math.max(SNAP_MIN, drag.durationMin ?? 60);
    } else {
      // resize keeps the start and moves the end on the day it was grabbed
      // (endDrag); the start may be on the day before
      day = drag.dayIndex;
      startMin = drag.event && days[day] ? wallMinutes(startOfDay(days[day]), eventDates(drag.event).start) : 0;
      endMin = days[day] ? Math.max(resizedEndMin(drag, days[day]), Math.max(startMin, 0) + SNAP_MIN) : snap(drag.curMin);
    }
    const pieces = new Map<number, { startMin: number; endMin: number }>();
    for (const p of ghostPieces(day, startMin, endMin, days.length)) pieces.set(p.di, p);
    const color = colorOf(calendars, drag.event?.calendar_id ?? newEventCalendarId);
    return { pieces, full: { startMin, endMin }, title: drag.event?.summary ?? "New event", color };
  })();

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
      <div className="day-headers" style={{ gridTemplateColumns: rowCols, width: rowW }}>
        <div className="gutter-tz" title={Intl.DateTimeFormat().resolvedOptions().timeZone}>
          {/* (of the week shown: a December week is EST, whatever today is) */}
          {new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
            .formatToParts(atWallClock(labelDay, 12 * 60))
            .find((p) => p.type === "timeZoneName")?.value ?? ""}
        </div>
        <div className="pan-clip">
          <div
            className="pan-strip"
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${extN}, minmax(0, 1fr))`,
              width: `${(extN / days.length) * 100}%`,
            }}
          >
            {[
              ...days.map((d, di) => [d, di + PAN_OVERSCAN_DAYS + 1, true] as const),
              ...beforeDays.map((d, index) => [d, index + 1, false] as const),
              ...afterDays.map((d, index) => [d, days.length + PAN_OVERSCAN_DAYS + index + 1, false] as const),
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
                recon: (e) => markOf(e),
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
              data-day={format(d, "yyyy-MM-dd")}
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
          style={{ gridTemplateColumns: rowCols, width: rowW }}
        >
          <div className="allday-label">all-day</div>
          <div className="pan-clip">
            <div
              className="pan-strip"
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${extN}, minmax(0, 1fr))`,
                width: `${(extN / days.length) * 100}%`,
              }}
            >
              {[
                ...days.map((d, idx) => [d, idx + PAN_OVERSCAN_DAYS + 1, true] as const),
                ...beforeDays.map((d, idx) => [d, idx + 1, false] as const),
                ...afterDays.map((d, idx) => [d, days.length + PAN_OVERSCAN_DAYS + idx + 1, false] as const),
              ].map(([d, gridCol, live]) => {
                const renderCell = () => {
            const dayAll = profileRenderStage("all-day-items", () => {
              const indexed = allDayByDay.byDay.get(startOfDay(d).getTime()) ?? [];
              if (allDayByDay.longEvents.length === 0) return indexed;
              const spanning = allDayByDay.longEvents.filter((event) => {
                const { start, end } = eventDates(event);
                return d >= startOfDay(start) && d < end;
              });
              if (spanning.length === 0) return indexed;
              return [...indexed, ...spanning].sort((a, b) => allDayByDay.order.get(a)! - allDayByDay.order.get(b)!);
            });
            // every day the dropped event will cover (a 3-day event lit one)
            // (the event's own days moved by the drag's day shift, as the drop
            // computes it: grabbed on its last day, it lit the days after it)
            const dropTarget = (() => {
              if (drag?.kind !== "move" || drag.allDayDropDay == null || !drag.event) return false;
              if (!drag.event.all_day) return days.indexOf(d) === drag.allDayDropDay;
              const { start, end } = eventDates(drag.event);
              const shift = Math.round((startOfDay(days[drag.allDayDropDay]).getTime() - startOfDay(days[drag.dayIndex]).getTime()) / 86400000);
              const span = Math.max(1, Math.round((startOfDay(end).getTime() - startOfDay(start).getTime()) / 86400000));
              const from = addDays(startOfDay(start), shift);
              return d >= from && d < addDays(from, span);
            })();
            return (
            <div
              key={d.toISOString()}
              className={"allday-cell" + (dropTarget ? " drop" : "")}
              onPointerDown={(pe) => {
                // Notion: click drafts an all-day event; dragging across the
                // lane spans it over the covered days
                if (pe.button !== 0 || (pe.target as HTMLElement).closest(".chip, .allday-more")) return;
                // the click that dismisses an open editor doesn't also create
                // (as on the time grid: startCreate)
                if (props.panelOpen) return;
                if (document.body.dataset.panelDismiss === String(pe.nativeEvent.timeStamp)) {
                  delete document.body.dataset.panelDismiss;
                  return;
                }
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
                .slice(0, allDayOpen ? undefined : 3)
                .map((e) => (
                  <button
                    key={keyOf(e)}
                    className={
                      "chip chip-allday" +
                      (ended(e, nowDate) ? " past" : "") +
                      rsvpClass(e) +
                      (isCanceled(e) ? " canceled" : "") +
                      (selectedKeys.has(keyOf(e)) ? " selected" : "") +
                      ((st0) => (st0 ? (st0.kind === "manual" ? " starred" : " starred-auto") : ""))(starState(starKey(e)))
                    }
                    style={chipStyle(colorOf(calendars, e.calendar_id))}
                    title={e.summary}
                    onPointerDown={(pe) => startChipDrag(pe, e, days.indexOf(d))}
                    onPointerEnter={() => propsRef.current.onHover?.(e)}
                    onPointerLeave={() => propsRef.current.onHover?.(null)}
                    onContextMenu={(ce) => {
                      ce.preventDefault();
                      propsRef.current.onSelect(e);
                      setCtx({ x: ce.clientX, y: ce.clientY, event: e });
                    }}
                  >
                    {e.summary}
                  </button>
                ))}
              {/* the row opens to show every day's all-day events (it was a
                  label: a click drafted a new event, the 4th unreachable) */}
              {dayAll.length > 3 && (
                <button
                  className="allday-more"
                  onClick={() => setAllDayOpen((o) => !o)}
                  title={allDayOpen ? "Show fewer" : "Show all all-day events"}
                >
                  {allDayOpen ? "Show less" : `+${dayAll.length - 3} more`}
                </button>
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
      <div className="grid-body" style={{ height: DAY_MIN * pxPerMin, width: rowW }}>
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
              {/* (the gutter's hour labels carry AM/PM: "12:59PM" didn't fit it) */}
              {format(nowDate, "h:mm")}
            </div>
          )}
        </div>
        <div className="gridlines" style={{ left: gutterW, right: "auto", width: colPx * extN }}>
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="hline" style={{ top: h * 60 * pxPerMin }} />
          ))}
          {todayIdx >= 0 && (
            <div className="now-line-global" style={{ top: nowMin * pxPerMin }} />
          )}
        </div>
        <div className="day-clip" ref={dayClipRef} style={clipW ? { flex: "none", width: clipW } : undefined}>
          {marquee && (
            <div
              className="marquee"
              data-testid="marquee"
              style={{
                left: `${((marquee.d0 + PAN_OVERSCAN_DAYS) / days.length) * 100}%`,
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
            // Keep DOM order chronological. A day step then drops the first
            // runway column and appends one, instead of moving populated
            // columns through the dense body on every step.
            ...beforeDays.map((day, index) => [day, -1, index + 1, false] as const),
            ...days.map((day, index) => [day, index, index + PAN_OVERSCAN_DAYS + 1, true] as const),
            ...afterDays.map((day, index) => [day, -1, days.length + PAN_OVERSCAN_DAYS + index + 1, false] as const),
          ].map(([day, di, gridCol, live]) => {
            const dayStart = startOfDay(day);
            const cacheKey = dayStart.getTime();
            const cachedDayItems = layoutCacheRef.current.dayItems.get(cacheKey);
            const nextDayItems = profileRenderStage("day-items", () => {
              const indexed = dayItemsIndex.byDay.get(cacheKey) ?? [];
              if (dayItemsIndex.longEvents.length === 0) return indexed;
              const dayEnd = addDays(dayStart, 1);
              const spanning = dayItemsIndex.longEvents.filter(({ start, end }) => end > dayStart && start < dayEnd);
              if (spanning.length === 0) return indexed;
              const items = [...indexed, ...spanning.map(({ item, start, end }) => ({
                item,
                startMin: isSameDay(start, day) ? minutesOfDay(start) : 0,
                endMin: isSameDay(end, day) ? Math.max(minutesOfDay(end), 1) : DAY_MIN,
              }))];
              return items.sort((a, b) => dayItemsIndex.order.get(a.item)! - dayItemsIndex.order.get(b.item)!);
            });
            const sameDayItems = !!cachedDayItems && cachedDayItems.length === nextDayItems.length &&
              cachedDayItems.every((item, index) => item.item === nextDayItems[index].item &&
                item.startMin === nextDayItems[index].startMin && item.endMin === nextDayItems[index].endMin);
            const dayItems = sameDayItems ? cachedDayItems! : nextDayItems;
            if (!sameDayItems) {
              layoutCacheRef.current.dayItems.set(cacheKey, dayItems);
              layoutCacheRef.current.pack.delete(cacheKey);
              layoutCacheRef.current.text.delete(cacheKey);
              layoutCacheRef.current.clusters.delete(cacheKey);
              layoutCacheRef.current.clusterTimes.delete(cacheKey);
              layoutCacheRef.current.chips.delete(cacheKey);
              layoutCacheRef.current.score.delete(cacheKey);
            }
            let packed = layoutCacheRef.current.pack.get(cacheKey);
            let placedText = layoutCacheRef.current.text.get(cacheKey);
            if (!packed || placedText === undefined) {
              ({ packed, placed: placedText } = profileRenderStage("day-layout", () => layoutDay(dayItems)));
              layoutCacheRef.current.pack.set(cacheKey, packed);
              layoutCacheRef.current.text.set(cacheKey, placedText);
            }
            const { containers, regular, clusters } = packed;
            const ghostHere = live ? dragGhost?.pieces.get(di) : undefined;
            const draftHere =
              live && props.draft && !props.draft.allDay && isSameDay(props.draft.start, day) && !drag;
            // Refresh time-sensitive row status on the clock tick, but keep
            // the cached row DOM unless a visible event actually crossed a
            // past/reconciliation boundary. At high density, rebuilding every
            // cluster button every 30 seconds is a needless rendering spike.
            const clusterTimeDeps = [clusters, calendars, nowTick, reconTick];
            let cachedClusterTime = layoutCacheRef.current.clusterTimes.get(cacheKey);
            if (!cachedClusterTime || clusterTimeDeps.some((dep, index) =>
              !Object.is(dep, cachedClusterTime!.deps[index]),
            )) {
              const states = new Map<string, { past: boolean; recon: ReturnType<typeof reconState> }>();
              const signature: string[] = [];
              for (const cluster of clusters) {
                for (const { item } of cluster.items) {
                  const past = ended(item, nowDate);
                  const recon = reconState(item, calendars, nowDate);
                  states.set(keyOf(item), { past, recon });
                  signature.push(`${past ? 1 : 0}${recon ?? "-"}`);
                }
              }
              cachedClusterTime = {
                deps: clusterTimeDeps,
                signature: signature.join("\u0000"),
                states,
              };
              layoutCacheRef.current.clusterTimes.set(cacheKey, cachedClusterTime);
            }
            // Per-day signatures, not the global values: selecting, dragging,
            // a group drag or the 30-second clock rebuilt all 35 rendered
            // days' chips (every pointermove of a drag, ~450 chips), where
            // only the days holding the affected events change.
            const clusterSelSig = selectedKeys.size
              ? clusters.flatMap((cl) => cl.items.map(({ item }) => keyOf(item))).filter((k) => selectedKeys.has(k)).join(",")
              : "";
            // rows lifted by a drag (one moved row, or a group's): dimmed like chips
            const movingRow = (k: string) =>
              !!groupDrag?.moving.has(k) ||
              (drag?.kind !== "create" && !!drag?.event && keyOf(drag.event) === k && !!drag.moved && !drag.duplicate);
            const clusterMoveSig = drag
              ? clusters.flatMap((cl) => cl.items.map(({ item }) => keyOf(item))).filter(movingRow).join(",")
              : "";
            const clusterDeps = [clusters, calendars, cachedClusterTime.signature, clusterSelSig, clusterMoveSig, reconTick, starTick, rowWindow];
            let cachedClusters = layoutCacheRef.current.clusters.get(cacheKey);
            if (!cachedClusters || clusterDeps.some((dep, index) => !Object.is(dep, cachedClusters!.deps[index]))) {
              const nodes = profileRenderStage("clusters", () => clusters.map((cl) => {
                const first = rowWindow ? Math.min(cl.items.length, Math.max(0, Math.floor((rowWindow.top - cl.top - 3) / 15))) : 0;
                const end = rowWindow ? Math.max(0, Math.min(cl.items.length, Math.ceil((rowWindow.bottom - cl.top - 3) / 15))) : cl.items.length;
                return (
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
                  data-row-count={cl.items.length}
                  onPointerDown={(pe) => pe.stopPropagation()}
                  title={`${cl.items.length} short events, ${fmtChipRange(
                    atWallClock(day, cl.startMin),
                    atWallClock(day, cl.endMin),
                  )}`}
                >
                  {first > 0 && <div className="cluster-row-spacer" style={{ height: first * 15 }} aria-hidden="true" />}
                  {cl.items.slice(first, Math.max(first, end)).map(({ item: e }) => {
                    const { start } = eventDates(e);
                    const rowState = cachedClusterTime!.states.get(keyOf(e))!;
                    return (
                      <button
                        key={keyOf(e)}
                        data-ek={keyOf(e)}
                        style={{ "--cluster-dot-color": colorOf(calendars, e.calendar_id) } as CSSProperties}
                        title={e.summary + " (" + fmtChipRange(start, eventDates(e).end) + ")"}
                        className={
                          "cluster-row" +
                          (rowState.past ? " past" : "") +
                          ((st0) => (st0 ? (st0.kind === "manual" ? " starred" : " starred-auto") : ""))(starState(starKey(e))) +
                          (selectedKeys.has(keyOf(e)) ? " selected" : "") +
                          (movingRow(keyOf(e)) ? " dragging" : "") +
                          rsvpClass(e) +
                          (rowState.recon ? ` ${rowState.recon}` : "")
                        }
                        onPointerDown={(pe) => startChipDragRef.current(pe, e, dayIndexByDateRef.current.get(cacheKey) ?? -1)}
                        onPointerEnter={() => propsRef.current.onHover?.(e)}
                        onPointerLeave={() => propsRef.current.onHover?.(null)}
                        onContextMenu={(ce) => {
                          ce.preventDefault();
                          ce.stopPropagation();
                          propsRef.current.onSelect(e);
                          setCtx({ x: ce.clientX, y: ce.clientY, event: e });
                        }}
                      >
                        <span className="cluster-title">{e.summary}</span>
                        {rowState.recon === "unsettled" && (
                          <span className="row-recon">
                            <span
                              role="button"
                              tabIndex={-1}
                              className="rr-yes"
                              title="It happened"
                              data-testid="row-recon-yes"
                              onPointerDown={(pe) => pe.stopPropagation()}
                              onClick={(ce) => {
                                ce.stopPropagation();
                                setRecon(reconKey(e), "done");
                              }}
                            >✓</span>
                            <span
                              role="button"
                              tabIndex={-1}
                              className="rr-no"
                              title="Didn't happen: removes it (⌘Z undoes)"
                              data-testid="row-recon-no"
                              onPointerDown={(pe) => pe.stopPropagation()}
                              onClick={(ce) => {
                                ce.stopPropagation();
                                void propsRef.current.actions.removeOccurrence(e);
                              }}
                            >✕</span>
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {end < cl.items.length && <div className="cluster-row-spacer" style={{ height: (cl.items.length - Math.max(first, end)) * 15 }} aria-hidden="true" />}
                </div>
                );
              }));
              cachedClusters = { deps: clusterDeps, nodes };
              layoutCacheRef.current.clusters.set(cacheKey, cachedClusters);
            }
            // Chip elements and their event handlers depend on the layout and
            // visible state, not on the parent App's day-window render. Reuse
            // the unchanged day's subtree during a horizontal pan.
            const dayKeys = [...containers.map((c) => keyOf(c.item)), ...regular.map((r) => keyOf(r.item))];
            const selSig = selectedKeys.size ? dayKeys.filter((k) => selectedKeys.has(k)).join(",") : "";
            const dragSig = drag?.event && dayKeys.includes(keyOf(drag.event))
              ? `${drag.kind}|${drag.moved}|${drag.duplicate}`
              : "";
            const groupSig = groupDrag ? dayKeys.filter((k) => groupDrag.moving.has(k)).join(",") : "";
            // the time state the chips show (past, awaiting review): an
            // overnight event's earlier segment goes past when the event
            // ends, on another day's column
            const clockSig = [...containers, ...regular]
              .map(({ item }) => `${ended(item, nowDate) ? 1 : 0}${reconState(item, calendars, nowDate) ?? "-"}`)
              .join("");
            const chipDeps = [containers, regular, placedText, calendars, clockSig, selSig, reconTick, starTick, dragSig, groupSig, seamMode];
            let cachedChips = layoutCacheRef.current.chips.get(cacheKey);
            if (!cachedChips || chipDeps.some((dep, index) => !Object.is(dep, cachedChips!.deps[index]))) {
              const containerNodes = profileRenderStage("containers", () => containers.map(({ item: e, lane, top, height, seamTopPx, seamBottomPx, seamTopStepPx, seamBottomStepPx, z }) => {
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
                  rsvpClass(e) +
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
                    onPointerDown={(pe) => startChipDragRef.current(pe, e, dayIndexByDateRef.current.get(cacheKey) ?? -1)}
                    onPointerEnter={() => propsRef.current.onHover?.(e)}
                    onPointerLeave={() => propsRef.current.onHover?.(null)}
                    onContextMenu={(ce) => {
                      ce.preventDefault();
                      ce.stopPropagation();
                      propsRef.current.onSelect(e);
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
              }));
              const regularNodes = profileRenderStage("regular", () => regular.map(({ item: e, top, height, leftPct, widthPct, insetPx, seamTopPx, seamBottomPx, seamTopStepPx, seamBottomStepPx, z }) => {
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
                      rsvpClass(e) +
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
                    onPointerEnter={() => propsRef.current.onHover?.(e)}
                    onPointerLeave={() => propsRef.current.onHover?.(null)}
                    onPointerDown={(pe) => startChipDragRef.current(pe, e, dayIndexByDateRef.current.get(cacheKey) ?? -1)}
                    onContextMenu={(ce) => {
                      ce.preventDefault();
                      ce.stopPropagation();
                      propsRef.current.onSelect(e);
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
                          title="It happened"
                          aria-label="It happened"
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
                          title="Didn't happen: removes it (⌘Z undoes)"
                          aria-label="Didn't happen"
                          data-testid="recon-no"
                          onPointerDown={(pe) => pe.stopPropagation()}
                          onClick={(ce) => {
                            ce.stopPropagation();
                            void propsRef.current.actions.removeOccurrence(e);
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
              }));
              cachedChips = { deps: chipDeps, containers: containerNodes, regular: regularNodes };
              layoutCacheRef.current.chips.set(cacheKey, cachedChips);
            }
            return (
              <div
                key={day.toISOString()}
                className={"day-col" + (isSameDay(day, nowDate) ? " today" : "") + (day.getDay() === 0 || day.getDay() === 6 ? " weekend" : "")}
                style={{ gridColumn: gridCol, gridRow: 1, pointerEvents: live ? undefined : "none" }}
                onPointerDown={live ? (e) => startCreate(e, di) : undefined}
                data-testid={live ? `day-col-${di}` : undefined}
              >
                {cachedChips.containers}
                {cachedClusters.nodes}
                {cachedChips.regular}

                {live &&
                  groupDrag?.ghosts.get(di)?.map((g) => (
                    <GhostPiece
                      key={"group-" + g.key}
                      title={g.title}
                      color={g.color}
                      piece={g}
                      full={g.full}
                      pxPerMin={pxPerMin}
                      testId="group-ghost"
                      ek={g.key}
                    />
                  ))}
                {ghostHere && dragGhost && (
                  <GhostPiece
                    title={dragGhost.title}
                    color={dragGhost.color}
                    piece={ghostHere}
                    full={dragGhost.full}
                    pxPerMin={pxPerMin}
                  />
                )}

                {draftHere && props.draft && (
                  <div
                    className="chip chip-ghost chip-draft"
                    data-testid="draft-chip"
                    style={{
                      ...chipStyle(colorOf(calendars, newEventCalendarId)),
                      top: minutesOfDay(props.draft.start) * pxPerMin,
                      // wall-clock minutes, as the grid draws them (on the
                      // fall-back day 1–3 AM is three elapsed hours)
                      height: Math.max(wallMinutes(props.draft.start, props.draft.end) * pxPerMin, 17),
                      left: 0,
                      width: "calc(100% - 2px)",
                    }}
                  >
                    <span className="chip-title">(New event)</span>
                    {wallMinutes(props.draft.start, props.draft.end) * pxPerMin >= 28 && (
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
            panSteps={panRef.current.pending !== 0 ? panRef.current.pending : null}
            pxPerMin={pxPerMin}
            keyOf={keyOf}
            onSelect={(e) => props.onSelect(e)}
            onHover={lightNoteEvent}
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
            // kept on screen by its measured height (a fixed reserve let
            // a 9-item menu run off the bottom)
            ref={(el) => {
              if (!el) return;
              const r = el.getBoundingClientRect();
              if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`;
            }}
            style={{
              left: Math.min(ctx.x, window.innerWidth - 200),
              top: Math.max(8, Math.min(ctx.y, window.innerHeight - (ctx.copying ? 340 : 140))),
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {ctx.copying ? (
              <CopyTargets
                calendars={calendars}
                recurring={!!ctx.event.recurring_event_id}
                onPick={(id, series) => {
                  void props.actions.copyTo(ctx.event, id, series);
                  setCtx(null);
                }}
              />
            ) : (
            <>
            <button
              onClick={() => {
                props.onOpenEvent(ctx.event, { x: ctx.x, y: ctx.y });
                setCtx(null);
              }}
            >
              Open
            </button>
            {editableCal(ctx.event.calendar_id) ? (
              <button
                onClick={() => {
                  props.actions.duplicate(ctx.event);
                  setCtx(null);
                }}
              >
                Duplicate <kbd>⌘D</kbd>
              </button>
            ) : (
              <button data-testid="ctx-copy-to" onClick={() => setCtx({ ...ctx, copying: true })}>
                Copy to my calendar… <kbd>›</kbd>
              </button>
            )}
            {/* upcoming (or a calendar not reviewed): cancel, kept struck through */}
            {!(eventDates(ctx.event).end.getTime() < nowDate.getTime() && !reconExempt(ctx.event, calendars)) && (
              <button
                data-testid="ctx-cancel"
                onClick={() => {
                  toggleCanceled(ctx.event);
                  setCtx(null);
                }}
              >
                {isCanceled(ctx.event) ? "Restore event" : "Cancel event"} <kbd>⊘</kbd>
              </button>
            )}
            {eventDates(ctx.event).end.getTime() < nowDate.getTime() && !reconExempt(ctx.event, calendars) && (
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
                    setRecon(reconKey(ctx.event), reconState(ctx.event, calendars, nowDate) === "canceled" ? null : "canceled", ctx.event);
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
            {editableCal(ctx.event.calendar_id) && (
              <button
                onClick={() => {
                  toggleStar(starKey(ctx.event));
                  setCtx(null);
                }}
              >
                {starState(starKey(ctx.event))?.kind === "manual" ? "Unstar" : "Star as goal work"} <kbd>★</kbd>
              </button>
            )}
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
            </>
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
        100 × deep<sup>0.5</sup> × restraint<sup>0.3</sup> × sleep<sup>0.3</sup>. Deep = {deepCalendars().join(", ")}:
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

/** A ghost (where a dragged event will land) cut into one piece per day
 *  column it touches: an event running past midnight shows on both days,
 *  and its part on the next day starts on the 12 AM line. `startMin` and
 *  `endMin` are minutes from day `day`'s midnight and may run off either
 *  end of it. */
function ghostPieces(
  day: number,
  startMin: number,
  endMin: number,
  nDays: number,
): { di: number; startMin: number; endMin: number }[] {
  const a = day * DAY_MIN + startMin;
  const b = day * DAY_MIN + endMin;
  const out: { di: number; startMin: number; endMin: number }[] = [];
  for (let di = Math.max(0, Math.floor(a / DAY_MIN)); di < nDays && di * DAY_MIN < b; di++) {
    const s0 = Math.max(a, di * DAY_MIN) - di * DAY_MIN;
    const e0 = Math.min(b, (di + 1) * DAY_MIN) - di * DAY_MIN;
    if (e0 > s0) out.push({ di, startMin: s0, endMin: e0 });
  }
  return out;
}

/** clock text for minutes from a midnight (any day: wraps) */
const clockOf = (min: number) => {
  const m = ((Math.round(min) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return new Date(2000, 0, 1, Math.floor(m / 60), m % 60);
};

function GhostPiece({
  title,
  color,
  piece,
  full,
  pxPerMin,
  testId,
  ek,
}: {
  title: string;
  color: string;
  piece: { startMin: number; endMin: number };
  /** the whole event, for the time it shows */
  full: { startMin: number; endMin: number };
  pxPerMin: number;
  testId?: string;
  ek?: string;
}) {
  const heightPx = Math.max((piece.endMin - piece.startMin) * pxPerMin, 17);
  return (
    <div
      className="chip chip-ghost"
      data-testid={testId}
      data-ek={ek}
      style={{
        ...chipStyle(color),
        top: piece.startMin * pxPerMin,
        height: heightPx,
        left: 0,
        width: "calc(100% - 2px)",
      }}
    >
      <span className="chip-title">{title}</span>
      {heightPx >= 28 && <span className="chip-time">{fmtChipRange(clockOf(full.startMin), clockOf(full.endMin))}</span>}
    </div>
  );
}

export function chipStyle(color: string): React.CSSProperties {
  return {
    "--cal": color,
  } as React.CSSProperties;
}
