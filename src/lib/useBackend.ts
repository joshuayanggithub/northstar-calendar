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
    let latestRequest = 0;
    // Query strings: timed events are RFC3339, all-day are YYYY-MM-DD; both
    // compare lexicographically within kind. Pad the window by a day each side
    // so all-day and cross-midnight events at the edges are included.
    const s = toLocalISO(addDays(new Date(startKey), -1));
    const e = toLocalISO(addDays(new Date(endKey), 1));
    const load = () => {
      const request = ++latestRequest;
      void backend.listEvents(s, e).then((next) => {
        // Panning can change the range while an earlier DB query is still in
        // flight. A late response must not replace events for the newer view;
        // the same guard also orders overlapping db-changed refreshes.
        if (request === latestRequest) setEvents((previous) => reuseUnchangedEvents(previous, next));
      });
    };
    load();
    const unsubscribe = backend.onDbChanged(() => load());
    return () => {
      latestRequest++;
      unsubscribe();
    };
  }, [backend, startKey, endKey]);
  return events;
}

function reuseUnchangedEvents(previous: CalendarEvent[], next: CalendarEvent[]): CalendarEvent[] {
  if (previous.length === 0) return next;
  const previousByKey = new Map(previous.map((event) => [`${event.calendar_id}/${event.id}`, event]));
  let unchanged = previous.length === next.length;
  const stable = next.map((event, index) => {
    const old = previousByKey.get(`${event.calendar_id}/${event.id}`);
    if (!old || !sameEventSnapshot(old, event)) {
      unchanged = false;
      return event;
    }
    if (old !== previous[index]) unchanged = false;
    return old;
  });
  return unchanged ? previous : stable;
}

function sameEventSnapshot(a: CalendarEvent, b: CalendarEvent): boolean {
  if (a === b) return true;
  const sameRecurrence = a.recurrence === b.recurrence || (
    a.recurrence != null && b.recurrence != null &&
    a.recurrence.length === b.recurrence.length &&
    a.recurrence.every((rule, index) => rule === b.recurrence![index])
  );
  let sameRaw = a.raw === b.raw;
  if (!sameRaw) {
    try {
      sameRaw = JSON.stringify(a.raw) === JSON.stringify(b.raw);
    } catch {
      sameRaw = false;
    }
  }
  return a.id === b.id && a.calendar_id === b.calendar_id && a.etag === b.etag &&
    a.summary === b.summary && a.description === b.description && a.location === b.location &&
    a.start === b.start && a.end === b.end && a.all_day === b.all_day &&
    a.timezone === b.timezone && a.status === b.status && sameRecurrence &&
    a.recurring_event_id === b.recurring_event_id && a.conference_url === b.conference_url &&
    a.updated === b.updated && sameRaw;
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
