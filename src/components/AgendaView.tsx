// List (agenda) view: the Phase-1 screen the user liked, restyled on tokens.

import { useMemo } from "react";
import { addDays, eventDates, isSameDay, now, startOfDay } from "../lib/dates";
import { colorOf } from "../lib/useBackend";
import { chipStyle } from "./WeekView";
import type { Calendar, CalendarEvent } from "../lib/types";

function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function dayLabel(d: Date): string {
  const today = startOfDay(now());
  const diff = Math.round((startOfDay(d).getTime() - today.getTime()) / 86400000);
  const name = d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  if (diff === 0) return `Today · ${name}`;
  if (diff === 1) return `Tomorrow · ${name}`;
  return name;
}

export function AgendaView(props: {
  anchor: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  onOpenEvent: (e: CalendarEvent, anchor?: { x: number; y: number }) => void;
}) {
  const byDay = useMemo(() => {
    const groups = new Map<string, { day: Date; list: CalendarEvent[] }>();
    for (const e of props.events) {
      const { start, end } = eventDates(e);
      // show multi-day/all-day events on each covered day within the window
      for (
        let d = startOfDay(start);
        d < end || isSameDay(d, start);
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
          a.all_day === b.all_day ? a.start.localeCompare(b.start) : a.all_day ? -1 : 1,
        ),
      }));
  }, [props.events]);

  return (
    <div className="agendaview" data-testid="agenda-list">
      {byDay.map(({ day, list }) => (
        <section key={day.toISOString()}>
          <h3 className="agenda-day">{dayLabel(day)}</h3>
          <ul>
            {list.map((e) => {
              const { start, end } = eventDates(e);
              return (
                <li key={`${e.calendar_id}/${e.id}/${day.getDate()}`}>
                  <button
                    className="agenda-row"
                    style={chipStyle(colorOf(props.calendars, e.calendar_id))}
                    onClick={(ce) => props.onOpenEvent(e, { x: ce.clientX, y: ce.clientY })}
                  >
                    <span className="agenda-bar" />
                    <span className="agenda-time">
                      {e.all_day ? "all day" : `${fmtTime(start)} – ${fmtTime(end)}`}
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
