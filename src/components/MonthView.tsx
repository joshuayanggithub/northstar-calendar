import { useEffect, useMemo, useRef, useState } from "react";
import {
  LOCALE,
  addDays,
  eventDates,
  fmtChipTime,
  isSameDay,
  isSameMonth,
  monthGrid,
  now,
  startOfDay,
} from "../lib/dates";
import { colorOf } from "../lib/useBackend";
import { chipStyle } from "./WeekView";
import { rsvpClass } from "../lib/rsvp";
import { isCanceled } from "../lib/recon";
import { starKey, starState, subscribeStars } from "../lib/stars";
import type { Calendar, CalendarEvent } from "../lib/types";

const MAX_PER_DAY = 4; // until the cells are measured
const BAR_H = 17; // px per spanning-bar lane
const BAR_GAP = 6; // below the last bar: the first chip's top clear of it
const CHIP_H = 17; // a chip row with its gap
const MORE_H = 14; // the "N more" line
const DNUM_H = 21; // the date number with the cell's padding
const MAX_LANES = 2;

interface Segment {
  event: CalendarEvent;
  startCol: number;
  endCol: number; // inclusive
  isStart: boolean; // event begins in this week (show rounded left + title)
  isEnd: boolean;
  lane: number;
}

/** by when they start, not by the stored text: calendars store their own
 *  offsets, so "…T13:00Z" (9 AM here) sorted after "…T10:00-04:00" */
const byStart = (a: CalendarEvent, b: CalendarEvent) =>
  eventDates(a).start.getTime() - eventDates(b).start.getTime();

const starClass = (e: CalendarEvent) =>
  ((st) => (st ? (st.kind === "manual" ? " starred" : " starred-auto") : ""))(starState(starKey(e)));

/** Multi-day all-day events render as Google-style bars spanning week rows. */
function isSpanning(e: CalendarEvent): boolean {
  if (!e.all_day) return false;
  const { start, end } = eventDates(e);
  // calendar days, not 24h: the fall-back day is 25h long
  const next = startOfDay(start);
  next.setDate(next.getDate() + 1);
  return end > next;
}

export function MonthView(props: {
  anchor: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  onOpenEvent: (e: CalendarEvent, anchor?: { x: number; y: number }) => void;
  onOpenDay: (d: Date) => void;
  onDraftDay: (d: Date) => void;
  /** Mon–Fri only, as the week view with weekends off */
  hideWeekends?: boolean;
}) {
  const weeks = useMemo(() => monthGrid(props.anchor), [props.anchor]);
  const today = now();
  // the columns shown: all seven, or Mon–Fri
  const cols = props.hideWeekends ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6];
  const nCols = cols.length;
  // goal stars show here too (G spotlight, the gold title)
  const [, bumpStar] = useState(0);
  useEffect(() => subscribeStars(() => bumpStar((n) => n + 1)), []);
  // how many chips a cell holds: measured, so a short window shows fewer
  // full-height chips plus "N more" instead of squashing four
  const weeksRef = useRef<HTMLDivElement>(null);
  const [rowH, setRowH] = useState<number | null>(null);
  useEffect(() => {
    const el = weeksRef.current;
    if (!el) return;
    const measure = () => {
      const row = el.querySelector(".month-week");
      if (row) setRowH(row.getBoundingClientRect().height);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [weeks.length]);
  /** chips shown of a day's n, leaving room for "N more" when some don't
   *  fit (or bars were already left out) */
  const fit = (n: number, lanes: number, moreAnyway: boolean) => {
    if (rowH == null) return Math.min(n, MAX_PER_DAY);
    const avail = rowH - DNUM_H - (lanes ? lanes * BAR_H + BAR_GAP : 0);
    if (!moreAnyway && n * CHIP_H <= avail) return n;
    return Math.min(n, Math.max(0, Math.floor((avail - MORE_H) / CHIP_H)));
  };

  const spanning = useMemo(() => props.events.filter(isSpanning), [props.events]);
  const nonSpanning = useMemo(() => props.events.filter((e) => !isSpanning(e)), [props.events]);

  const byDay = useMemo(() => {
    const m = new Map<string, CalendarEvent[]>();
    for (const e of nonSpanning) {
      const { start, end } = eventDates(e);
      let d = startOfDay(start);
      const lastExclusive = e.all_day ? end : new Date(Math.max(end.getTime(), d.getTime() + 1));
      do {
        const key = d.toDateString();
        if (!m.has(key)) m.set(key, []);
        m.get(key)!.push(e);
        d = new Date(d);
        d.setDate(d.getDate() + 1); // the next calendar day (DST days aren't 24h)
      } while (d < lastExclusive);
    }
    for (const list of m.values()) {
      list.sort((a, b) => (a.all_day === b.all_day ? byStart(a, b) : a.all_day ? -1 : 1));
    }
    return m;
  }, [nonSpanning]);

  /** Per week row: lane-packed segments for spanning events. */
  const weekSegments = useMemo(() => {
    return weeks.map((week) => {
      const weekStart = week[0];
      const weekEndEx = addDays(week[6], 1);
      const segs: Segment[] = [];
      const laneEnds: number[] = []; // per-lane last occupied endCol
      const hidden = [0, 0, 0, 0, 0, 0, 0]; // bars that didn't fit, per day
      const sorted = [...spanning].sort(byStart);
      for (const e of sorted) {
        const { start, end } = eventDates(e);
        if (end <= weekStart || start >= weekEndEx) continue;
        let s = start < weekStart ? 0 : Math.round((startOfDay(start).getTime() - weekStart.getTime()) / 86400000);
        let eIncl = end >= weekEndEx ? 6 : Math.round((startOfDay(new Date(end.getTime() - 1)).getTime() - weekStart.getTime()) / 86400000);
        // weekends off: the bar runs over the weekdays it covers, if any
        if (props.hideWeekends) {
          const cut0 = Math.max(s, 1), cut1 = Math.min(eIncl, 5);
          if (cut0 > cut1) continue;
          s = cut0;
          eIncl = cut1;
        }
        let lane = laneEnds.findIndex((le) => le < s);
        if (lane === -1) {
          if (laneEnds.length >= MAX_LANES) {
            // overflow: no bar, but counted in each day's "N more"
            for (let c = s; c <= Math.max(s, eIncl); c++) hidden[c]++;
            continue;
          }
          lane = laneEnds.length;
          laneEnds.push(eIncl);
        } else {
          laneEnds[lane] = eIncl;
        }
        segs.push({
          event: e,
          startCol: s,
          endCol: Math.max(s, eIncl),
          isStart: start >= weekStart,
          isEnd: end <= weekEndEx,
          lane,
        });
      }
      return { segs, lanes: laneEnds.length, hidden };
    });
  }, [weeks, spanning, props.hideWeekends]);
  // a column's place among those shown
  const colOf = (c: number) => (props.hideWeekends ? c - 1 : c);

  return (
    <div className="monthview" data-testid="month-grid">
      <div className="month-dow-row" style={{ gridTemplateColumns: `repeat(${nCols}, 1fr)` }}>
        {cols.map((c) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][c]).map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div ref={weeksRef} className="month-weeks" style={{ gridTemplateRows: `repeat(${weeks.length}, 1fr)` }}>
        {weeks.map((week, wi) => {
          const { segs, lanes, hidden } = weekSegments[wi];
          return (
            <div key={wi} className="month-week" style={{ gridTemplateColumns: `repeat(${nCols}, 1fr)` }}>
              {segs.map((seg) => (
                <button
                  key={`${seg.event.calendar_id}/${seg.event.id}/${seg.lane}`}
                  className={
                    "month-bar" +
                    (seg.isStart ? "" : " cont-left") +
                    (seg.isEnd ? "" : " cont-right") +
                    rsvpClass(seg.event) +
                    (isCanceled(seg.event) ? " canceled" : "") +
                    starClass(seg.event)
                  }
                  data-testid="month-bar"
                  style={{
                    ...chipStyle(colorOf(props.calendars, seg.event.calendar_id)),
                    left: `calc(${(colOf(seg.startCol) / nCols) * 100}% + 2px)`,
                    width: `calc(${((seg.endCol - seg.startCol + 1) / nCols) * 100}% - 4px)`,
                    top: 24 + seg.lane * BAR_H,
                  }}
                  title={seg.event.summary}
                  onClick={(ce) => props.onOpenEvent(seg.event, { x: ce.clientX, y: ce.clientY })}
                >
                  {seg.isStart || colOf(seg.startCol) === 0 ? seg.event.summary : ""}
                </button>
              ))}
              {cols.map((col) => {
                const day = week[col];
                const list = byDay.get(day.toDateString()) ?? [];
                const shown = fit(list.length, lanes, hidden[col] > 0);
                const extra = Math.max(0, list.length - shown) + hidden[col];
                return (
                  <div
                    key={day.toISOString()}
                    className={
                      "month-cell" +
                      (isSameMonth(day, props.anchor) ? "" : " out") +
                      (isSameDay(day, today) ? " today" : "") +
                      (day.getDay() === 0 || day.getDay() === 6 ? " weekend" : "")
                    }
                    onDoubleClick={(e) => {
                      // a chip's second click bubbles here: not a blank draft
                      if ((e.target as Element).closest(".mchip, .mchip-more, .month-dnum")) return;
                      props.onDraftDay(day);
                    }}
                  >
                    <button className="month-dnum" onClick={() => props.onOpenDay(day)}>
                      {day.getDate() === 1 ? `${day.toLocaleString(LOCALE, { month: "short" })} 1` : day.getDate()}
                    </button>
                    <div className="month-chips" style={{ marginTop: lanes ? lanes * BAR_H + BAR_GAP : 0 }}>
                      {list.slice(0, shown).map((e) => {
                        const { start } = eventDates(e);
                        return (
                          <button
                            key={`${e.calendar_id}/${e.id}`}
                            className={"mchip" + (e.all_day ? " mchip-allday" : "") + rsvpClass(e) + (isCanceled(e) ? " canceled" : "") + starClass(e)}
                            style={chipStyle(colorOf(props.calendars, e.calendar_id))}
                            onClick={(ce) => props.onOpenEvent(e, { x: ce.clientX, y: ce.clientY })}
                            title={e.summary}
                          >
                            {/* the start time on the day it starts; a later day of a
                                multi-day event has no time of its own */}
                            {!e.all_day && isSameDay(start, day) && <span className="mchip-time">{fmtChipTime(start)}</span>}
                            <span className="mchip-title">{e.summary}</span>
                          </button>
                        );
                      })}
                      {extra > 0 && (
                        <button className="mchip-more" onClick={() => props.onOpenDay(day)}>
                          {extra} more
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
