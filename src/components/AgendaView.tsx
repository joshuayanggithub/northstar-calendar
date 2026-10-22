// List (agenda) view: the Phase-1 screen the user liked, restyled on tokens.

import { useEffect, useMemo, useRef, useState } from "react";
import { LOCALE, addDays, eventDates, isSameDay, now, startOfDay } from "../lib/dates";
import { colorOf } from "../lib/useBackend";
import { chipStyle } from "./WeekView";
import type { Calendar, CalendarEvent } from "../lib/types";
import { rsvpClass } from "../lib/rsvp";
import { isCanceled } from "../lib/recon";
import { starKey, starState, subscribeStars } from "../lib/stars";

/** one formatter (toLocaleTimeString builds one per call, twice a row) */
const TIME_FMT = new Intl.DateTimeFormat(LOCALE, { hour: "numeric", minute: "2-digit" });
function fmtTime(d: Date): string {
  return TIME_FMT.format(d);
}

/** "6:00 PM – 2:00 PM", or "6:00 PM – Sun 2:00 PM" when it ends on a later day */
function timeRange(start: Date, end: Date, day: Date): string {
  const sameDay = isSameDay(start, new Date(end.getTime() - 1));
  const endDay = sameDay ? "" : `${end.toLocaleDateString(LOCALE, { weekday: "short" })} `;
  // (one that began on an earlier day says so: last night's sleep read
  // "11:00 PM – Mon 7:00 AM" under Monday, like tonight's)
  const startDay = start < startOfDay(day) ? `${start.toLocaleDateString(LOCALE, { weekday: "short" })} ` : "";
  return `${startDay}${fmtTime(start)} – ${endDay}${fmtTime(end)}`;
}

function dayLabel(d: Date): string {
  const today = startOfDay(now());
  const diff = Math.round((startOfDay(d).getTime() - today.getTime()) / 86400000);
  const name = d.toLocaleDateString(LOCALE, { weekday: "long", month: "short", day: "numeric" });
  if (diff === 0) return `Today · ${name}`;
  if (diff === 1) return `Tomorrow · ${name}`;
  return name;
}

export function AgendaView(props: {
  anchor: Date;
  /** the period listed: [start, end) */
  start: Date;
  end: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  onOpenEvent: (e: CalendarEvent, anchor?: { x: number; y: number }) => void;
}) {
  // goal stars show here too (the gold bar)
  const [, bumpStar] = useState(0);
  useEffect(() => subscribeStars(() => bumpStar((n) => n + 1)), []);
  // a new period (Next, Previous, Today) opens at its first day: the list's
  // scroller kept its place, landing two weeks into the next period
  const scroller = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scroller.current?.scrollTo(0, 0);
  }, [props.anchor]);
  const byDay = useMemo(() => {
    const groups = new Map<string, { day: Date; list: CalendarEvent[] }>();
    for (const e of props.events) {
      const { start, end } = eventDates(e);
      // only the period's events (the app fetches weeks around it)
      if (end <= props.start || start >= props.end) continue;
      // show multi-day/all-day events on each covered day within the window
      for (
        let d = startOfDay(start < props.start ? props.start : start);
        (d < end || isSameDay(d, start)) && d < props.end;
        d = addDays(d, 1)
      ) {
        const key = d.toDateString();
        if (!groups.has(key)) groups.set(key, { day: new Date(d), list: [] });
        groups.get(key)!.list.push(e);
        if (e.all_day ? addDays(d, 1) >= end : true) break;
      }
    }
    return [...groups.values()]
      .sort((a, b) => a.day.getTime() - b.day.getTime())
      .map((g) => ({
        ...g,
        list: g.list.sort((a, b) =>
          a.all_day === b.all_day
            // by time, not by string: stored offsets differ (Z, -07:00…)
            ? eventDates(a).start.getTime() - eventDates(b).start.getTime()
            : a.all_day ? -1 : 1,
        ),
      }));
  }, [props.events, props.start, props.end]);

  return (
    <div ref={scroller} className="agendaview" data-testid="agenda-list">
      {byDay.map(({ day, list }) => (
        <section key={day.toISOString()}>
          <h3 className="agenda-day">{dayLabel(day)}</h3>
          <ul>
            {list.map((e) => {
              const { start, end } = eventDates(e);
              return (
                <li key={`${e.calendar_id}/${e.id}/${day.getDate()}`}>
                  <button
                    className={
                      "agenda-row" +
                      rsvpClass(e) +
                      (isCanceled(e) ? " canceled" : "") +
                      ((st) => (st ? (st.kind === "manual" ? " starred" : " starred-auto") : ""))(starState(starKey(e)))
                    }
                    style={chipStyle(colorOf(props.calendars, e.calendar_id))}
                    onClick={(ce) => props.onOpenEvent(e, { x: ce.clientX, y: ce.clientY })}
                  >
                    <span className="agenda-bar" />
                    <span className="agenda-time">
                      {e.all_day ? "all day" : timeRange(start, end, day)}
                    </span>
                    <span className="agenda-title">{e.summary}</span>
                    {e.location && (
                      <span className="agenda-loc" title={e.location}>
                        {e.location}
                      </span>
                    )}
                    {e.conference_url && (
                      <a
                        className="agenda-join"
                        href={e.conference_url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        Join
                      </a>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {byDay.length === 0 && <p className="agenda-empty">Nothing in this period.</p>}
    </div>
  );
}
