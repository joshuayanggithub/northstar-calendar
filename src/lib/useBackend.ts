// Data layer: backend access + reactive calendars/events for a date range.

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { backendPromise } from "./backend";
import type { Backend, Calendar, CalendarEvent, EventInput } from "./types";
import { addDays, toLocalISO } from "./dates";
import { normalizeCalendarColor } from "./color";

export const BackendContext = createContext<Backend | null>(null);

export function useBackend(): Backend | null {
  return useContext(BackendContext);
}

export function useBackendInit(): Backend | null {
  const [backend, setBackend] = useState<Backend | null>(null);
  useEffect(() => {
    backendPromise.then(setBackend);
  }, []);
  return backend;
}

export function useAuth(backend: Backend | null): boolean | null {
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    if (!backend) return;
    backend.authStatus().then(setAuthed);
    return backend.onAuthChanged(setAuthed);
  }, [backend]);
  return authed;
}

export function useCalendars(backend: Backend | null): {
  calendars: Calendar[];
  refresh: () => void;
} {
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  useEffect(() => {
    if (!backend) return;
    const load = () => backend.listCalendars().then(setCalendars);
    load();
    return backend.onDbChanged(load);
  }, [backend]);
  return {
    calendars,
    refresh: () => backend?.listCalendars().then(setCalendars),
  };
}

/** Events overlapping [rangeStart, rangeEnd), re-fetched on any db change. */
export function useEvents(
  backend: Backend | null,
  rangeStart: Date,
  rangeEnd: Date,
): CalendarEvent[] {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const startKey = rangeStart.getTime();
  const endKey = rangeEnd.getTime();
  useEffect(() => {
    if (!backend) return;
    // Query strings: timed events are RFC3339, all-day are YYYY-MM-DD; both
    // compare lexicographically within kind. Pad the window by a day each side
    // so all-day and cross-midnight events at the edges are included.
    const s = toLocalISO(addDays(new Date(startKey), -1));
    const e = toLocalISO(addDays(new Date(endKey), 1));
    const load = () => backend.listEvents(s, e).then(setEvents);
    load();
    return backend.onDbChanged(load);
  }, [backend, startKey, endKey]);
  return events;
}

export function useVisibleEvents(events: CalendarEvent[], calendars: Calendar[]): CalendarEvent[] {
  return useMemo(() => {
    const hidden = new Set(calendars.filter((c) => c.hidden).map((c) => c.id));
    return events.filter((e) => !hidden.has(e.calendar_id));
  }, [events, calendars]);
}

export function colorOf(calendars: Calendar[], calendarId: string): string {
  return normalizeCalendarColor(calendars.find((c) => c.id === calendarId)?.color);
}

export type { Backend, Calendar, CalendarEvent, EventInput };
