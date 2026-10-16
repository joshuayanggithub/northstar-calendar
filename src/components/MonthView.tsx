import { useMemo } from "react";
import {
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
import type { Calendar, CalendarEvent } from "../lib/types";

const MAX_PER_DAY = 4;
const BAR_H = 17; // px per spanning-bar lane
const MAX_LANES = 2;

interface Segment {
  event: CalendarEvent;
  startCol: number;
  endCol: number; // inclusive
  isStart: boolean; // event begins in this week (show rounded left + title)
  isEnd: boolean;
  lane: number;
}

/** Multi-day all-day events render as Google-style bars spanning week rows. */
function isSpanning(e: CalendarEvent): boolean {
  if (!e.all_day) return false;
  const { start, end } = eventDates(e);
  return end.getTime() - start.getTime() > 86400000;
}

export function MonthView(props: {
  anchor: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  onOpenEvent: (e: CalendarEvent, anchor?: { x: number; y: number }) => void;
  onOpenDay: (d: Date) => void;
  onDraftDay: (d: Date) => void;
}) {
  const weeks = useMemo(() => monthGrid(props.anchor), [props.anchor]);
  const today = now();

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
        d = new Date(d.getTime() + 86400000);
      } while (d < lastExclusive);
    }
    for (const list of m.values()) {
      list.sort((a, b) => (a.all_day === b.all_day ? a.start.localeCompare(b.start) : a.all_day ? -1 : 1));
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
      const sorted = [...spanning].sort((a, b) => a.start.localeCompare(b.start));
      for (const e of sorted) {
        const { start, end } = eventDates(e);
        if (end <= weekStart || start >= weekEndEx) continue;
        const s = start < weekStart ? 0 : Math.round((startOfDay(start).getTime() - weekStart.getTime()) / 86400000);
        const eIncl = end >= weekEndEx ? 6 : Math.round((startOfDay(new Date(end.getTime() - 1)).getTime() - weekStart.getTime()) / 86400000);
        let lane = laneEnds.findIndex((le) => le < s);
        if (lane === -1) {
          if (laneEnds.length >= MAX_LANES) continue; // overflow: dropped from bars
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
      return { segs, lanes: laneEnds.length };
    });
  }, [weeks, spanning]);

  return (
    <div className="monthview" data-testid="month-grid">
      <div className="month-dow-row">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="month-weeks" style={{ gridTemplateRows: `repeat(${weeks.length}, 1fr)` }}>
        {weeks.map((week, wi) => {
          const { segs, lanes } = weekSegments[wi];
          return (
            <div key={wi} className="month-week">
              {segs.map((seg) => (
                <button
                  key={`${seg.event.calendar_id}/${seg.event.id}/${seg.lane}`}
                  className={
                    "month-bar" +
                    (seg.isStart ? "" : " cont-left") +
                    (seg.isEnd ? "" : " cont-right")
                  }
                  data-testid="month-bar"
                  style={{
                    ...chipStyle(colorOf(props.calendars, seg.event.calendar_id)),
                    left: `calc(${(seg.startCol / 7) * 100}% + 2px)`,
                    width: `calc(${((seg.endCol - seg.startCol + 1) / 7) * 100}% - 4px)`,
                    top: 24 + seg.lane * BAR_H,
                  }}
                  title={seg.event.summary}
                  onClick={(ce) => props.onOpenEvent(seg.event, { x: ce.clientX, y: ce.clientY })}
                >
                  {seg.isStart || seg.startCol === 0 ? seg.event.summary : ""}
                </button>
              ))}
              {week.map((day) => {
                const list = byDay.get(day.toDateString()) ?? [];
                const extra = list.length - MAX_PER_DAY;
                return (
                  <div
                    key={day.toISOString()}
                    className={
                      "month-cell" +
                      (isSameMonth(day, props.anchor) ? "" : " out") +
                      (isSameDay(day, today) ? " today" : "") +
                      (day.getDay() === 0 || day.getDay() === 6 ? " weekend" : "")
                    }
                    onDoubleClick={() => props.onDraftDay(day)}
                  >
                    <button className="month-dnum" onClick={() => props.onOpenDay(day)}>
                      {day.getDate() === 1 ? `${day.toLocaleString([], { month: "short" })} 1` : day.getDate()}
                    </button>
                    <div className="month-chips" style={{ marginTop: lanes * BAR_H }}>
                      {list.slice(0, MAX_PER_DAY).map((e) => {
                        const { start } = eventDates(e);
                        return (
                          <button
                            key={`${e.calendar_id}/${e.id}`}
                            className={"mchip" + (e.all_day ? " mchip-allday" : "")}
                            style={chipStyle(colorOf(props.calendars, e.calendar_id))}
                            onClick={(ce) => props.onOpenEvent(e, { x: ce.clientX, y: ce.clientY })}
                            title={e.summary}
                          >
                            {!e.all_day && <span className="mchip-time">{fmtChipTime(start)}</span>}
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
