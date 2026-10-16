export interface Calendar {
  id: string;
  summary: string;
  color: string | null;
  is_primary: boolean;
  hidden: boolean;
  /** Google accessRole: owner | writer | reader | freeBusyReader */
  access_role: string;
}

export function calendarEditable(c: Calendar | undefined): boolean {
  return !!c && (c.access_role === "owner" || c.access_role === "writer");
}

export interface CalendarEvent {
  id: string;
  calendar_id: string;
  etag: string | null;
  summary: string;
  description: string | null;
  location: string | null;
  /** RFC3339 for timed events, YYYY-MM-DD for all-day */
  start: string;
  end: string;
  all_day: boolean;
  timezone: string | null;
  status: string;
  recurrence: string[] | null;
  recurring_event_id: string | null;
  conference_url: string | null;
  updated: string | null;
  /** full Google resource (attendees, transparency, visibility, reminders…) */
  raw?: any;
}

export interface EventInput {
  calendar_id: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  start: string;
  end: string;
  all_day: boolean;
  with_meet?: boolean;
  /** RRULE lines, e.g. ["RRULE:FREQ=DAILY"] */
  recurrence?: string[] | null;
  /** attendee emails */
  attendees?: string[] | null;
  /** "opaque" (busy) | "transparent" (free) */
  transparency?: string | null;
  /** "default" | "public" | "private" */
  visibility?: string | null;
  /** popup reminder minutes before start; null = calendar default */
  reminder_minutes?: number | null;
}

export interface SyncReport {
  pushed: number;
  pulled: number;
  conflicts: number;
  errors: string[];
}

/** The backend surface the UI is written against (Tauri or browser mock). */
export interface Backend {
  authStatus(): Promise<boolean>;
  connectGoogle(): Promise<boolean>;
  disconnectGoogle(): Promise<void>;
  syncNow(): Promise<void>;
  listCalendars(): Promise<Calendar[]>;
  setCalendarHidden(calendarId: string, hidden: boolean): Promise<void>;
  /** Create a new calendar (subscribe=false) or subscribe to an existing id. */
  addCalendar(nameOrId: string, subscribe: boolean): Promise<void>;
  /** Raw Google resource of a recurring series master (live call). */
  getSeriesMaster(calendarId: string, masterId: string): Promise<any>;
  /** Expanded Google instances, including cancellations, for COUNT splits. */
  getSeriesInstances(calendarId: string, masterId: string): Promise<any[]>;
  /** PATCH a series master and, with destinationId, move it to that
   *  calendar: one step, applied to the local instances right away. */
  updateSeriesMaster(calendarId: string, masterId: string, patch: any, destinationId?: string): Promise<void>;
  /** "This and following": end the series before this occurrence (the
   *  truncated recurrence) and start a new series from `input`, as one step.
   *  Resolves to the new series' id. */
  splitSeries(calendarId: string, masterId: string, recurrence: string[], input: EventInput): Promise<string>;
  /** Move a recurring master and its instances to another calendar. */
  moveSeriesMaster(calendarId: string, masterId: string, destinationId: string): Promise<void>;
  /** Goals (daily / weekly / long-term), kept by the app: lib/goals.ts */
  goalsRead(): Promise<import("./goals").GoalsFile>;
  goalsWrite(file: import("./goals").GoalsFile): Promise<void>;
  onGoalsChanged(cb: () => void): () => void;
  /** Obsidian bridge for the journal ("journal"). CAS write via mtime. */
  mdRead(which: string): Promise<{ content: string; mtime_ms: number; exists: boolean }>;
  mdWrite(which: string, content: string, expectedMtimeMs: number): Promise<number>;
  onMdChanged(cb: (which: string) => void): () => void;
  /** key `${calendar_id}/${id}` -> goal text, from the local classifier */
  getGoalClassifications(): Promise<Record<string, string>>;
  onGoalClassChanged(cb: () => void): () => void;
  listEvents(start: string, end: string): Promise<CalendarEvent[]>;
  createEvent(input: EventInput): Promise<string>;
  updateEvent(eventId: string, input: EventInput, prevCalendarId?: string): Promise<void>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
  /** Set (null clears) one event's red-pen note, read-modify-write on the
   *  stored description; only the description changes. Resolves to the
   *  note it replaced. */
  setEventNote(calendarId: string, eventId: string, note: string | null): Promise<string | null>;
  /** Subscribe to data-changed notifications; returns unsubscribe. */
  onDbChanged(cb: () => void): () => void;
  onAuthChanged(cb: (authed: boolean) => void): () => void;
}
