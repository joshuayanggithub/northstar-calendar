// In-memory backend for running the UI in a plain browser (and for Playwright).
// Mirrors the Tauri backend's observable behavior closely enough for UI work.

import type { Backend, Calendar, CalendarEvent, EventInput } from "./types";
import { addDays, now, toDateOnly } from "./dates";
import { joinDrill, splitDrill } from "./drill";
import { periodOf, type Goal, type GoalsFile, type Horizon } from "./goals";

const calendars: Calendar[] = [
  { id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" },
  { id: "work", summary: "Work", color: "#2fbf71", is_primary: false, hidden: false, access_role: "owner" },
  { id: "holidays", summary: "US Holidays", color: "#e8a13c", is_primary: false, hidden: false, access_role: "reader" },
  { id: "graphite", summary: "Learning and Research", color: "#616161", is_primary: false, hidden: false, access_role: "owner" },
  { id: "cocoa", summary: "Chores", color: "#795548", is_primary: false, hidden: false, access_role: "owner" },
];

function iso(d: Date): string {
  return d.toISOString();
}

function at(dayOffset: number, hour: number, minutes = 0): Date {
  const d = now();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minutes, 0, 0);
  return d;
}

let idCounter = 1;
const events: CalendarEvent[] = [
  mk("primary", "Morning run", at(0, 7), at(0, 8)),
  mk("work", "Standup", at(0, 10), at(0, 10, 15), "https://meet.google.com/mock-link"),
  mk("work", "1:1 with manager", at(1, 14), at(1, 14, 30), "https://meet.google.com/mock-11"),
  (() => {
    const e = mk("primary", "Swim", at(2, 18), at(2, 20));
    e.location = "Community pool";
    return e;
  })(),
  (() => {
    const e = mk("primary", "Distraction: TikTok", at(-2, 21), at(-2, 21, 45));
    e.description = "[DRILL] Forty minutes of scrolling. Phone stays in the other room.";
    return e;
  })(),
  mk("primary", "Dentist", at(5, 9), at(5, 10)),
  mk("holidays", "Columbus Day Seminar", at(1, 11), at(1, 12)),
  mk("work", "Client prep", at(1, 9, 30), at(1, 10, 30)),
  mk("work", "Reading group", at(-3, 15), at(-3, 16)),
  mk("primary", "Paper skim", at(-3, 15), at(-3, 16)),
  mk("work", "errand run", at(3, 17), at(3, 18, 15)),
  mk("primary", "grocery pickup", at(3, 18), at(3, 19, 15)),
  mk("chores", "meal prep", at(3, 19), at(3, 20, 30)),
  mk("cocoa", "Distraction: shopping", at(1, 21), at(1, 21, 25)),
  mk("work", "Browsing furniture", at(1, 21, 20), at(1, 21, 45)),
  mk("primary", "Distraction: reddit", at(1, 21, 40), at(1, 22, 5)),
  mk("primary", "betting odds rabbit hole", at(1, 22), at(1, 22, 20)),
  mk("cocoa", "Distraction: news alerts", at(1, 22, 15), at(1, 22, 40)),
  mk("cocoa", "Distraction: shopping app", at(-2, 18), at(-2, 18, 20)),
  mk("primary", "group chat spiral", at(-2, 18, 15), at(-2, 18, 40)),
  mk("work", "inbox skim", at(-2, 18, 35), at(-2, 19)),
  mk("cocoa", "Distraction: video clips", at(-2, 18, 55), at(-2, 19, 20)),
  // --- repro: user screenshots 2026-10-15 (joint radius / blank bands / hidden text) ---
  // image 4: chip tail-overlapping a slab's top (Fri Sleep is a slab)
  mk("cocoa", "Distraction: late forum lurking", at(2, 3, 18), at(2, 4, 10)),
  // image 4 (fg-vs-fg joint): same shape against Saturday's childless Sleep
  mk("cocoa", "Distraction: late scrolling", at(3, 3, 18), at(3, 4, 10)),
  // image 5: earlier short chip swallowed as a gapless background
  mk("work", "buy paint brushes", at(3, 16, 30), at(3, 17)),
  mk("primary", "Sort the bookshelf", at(3, 16, 31), at(3, 18, 1)),
  // image 6: three-deep nest, text visibility
  mk("cocoa", "Distraction: comment threads", at(3, 13, 15), at(3, 15)),
  mk("work", "planning + scheduling calls", at(3, 13, 20), at(3, 14, 40)),
  mk("primary", "Client portal", at(3, 13, 37), at(3, 14, 7)),
  mk("graphite", "Study hall", at(-3, 10), at(-3, 13)),
  mk("primary", "quiz review", at(-3, 10), at(-3, 10, 30)),
  mk("work", "problem set", at(-3, 10, 50), at(-3, 11, 40)),
  mk("primary", "Gym", at(-1, 17), at(-1, 18, 30)),
  mk("work", "Call home", at(-1, 18), at(-1, 18, 45)),
  mk("graphite", "afternoon admin", at(1, 14), at(1, 17)),
  mk("graphite", "Deep work block", at(0, 15), at(0, 17)),
  mk("primary", "snack break", at(0, 15, 30), at(0, 16)),
  mk("cocoa", "Laundry + dishes", at(0, 17), at(0, 18)),
  // trailing-week data for insights
  mk("primary", "Asleep (7.5h)", at(-1, 0, 30), at(-1, 8)),
  mk("primary", "Asleep (8h)", at(-2, 1), at(-2, 9)),
  mk("primary", "Distraction: YouTube and Twitch", at(-1, 20), at(-1, 22)),
  mk("work", "Read style guide", at(-1, 10), at(-1, 12)),
  mk("work", "Admin block", at(-2, 10), at(-2, 12)),
  mk("primary", "emails", at(-2, 10), at(-2, 10, 45)),
  mk("primary", "forms", at(-2, 10, 45), at(-2, 11, 30)),
  mk("primary", "follow-ups", at(-2, 11, 30), at(-2, 12)),
  mk("primary", "LUNCH", at(-1, 13, 30), at(-1, 14)),
  mk("primary", "LUNCH", at(-2, 13, 30), at(-2, 14)),
  mk("primary", "morning walk", at(-1, 9), at(-1, 9, 15)),
  mk("primary", "morning walk", at(-2, 9, 30), at(-2, 9, 45)),
  (() => {
    const e = mk("work", "Offsite", at(1, 0), at(3, 0));
    e.all_day = true;
    e.start = at(1, 0).toISOString().slice(0, 10);
    e.end = at(3, 0).toISOString().slice(0, 10);
    return e;
  })(),
  // dense-overlap stress cluster (mirrors real calendars with long + short
  // events stacked): a 9h block with several short events inside it
  (() => {
    const e = mk("primary", "Sleep", at(2, 4), at(2, 13));
    e.recurring_event_id = "sleep-master";
    return e;
  })(),
  (() => {
    const e = mk("primary", "Sleep", at(3, 4), at(3, 13));
    e.recurring_event_id = "sleep-master";
    return e;
  })(),
  mk("primary", "morning walk", at(2, 8, 15), at(2, 8, 45)),
  mk("work", "admin / reading", at(2, 9), at(2, 10)),
  mk("primary", "breakfast", at(2, 10), at(2, 10, 30)),
  mk("work", "buy monitor", at(2, 10, 30), at(2, 11)),
  mk("primary", "Workshop", at(2, 12), at(2, 13, 45)),
];

let fixtureGoals: GoalsFile | null = null;

// Test-only: a real-data fixture (exported read-only from the user's DB and
// kept out of git) can replace the mock week, so layout laws are checked
// against real calendars, not just synthetic ones.
{
  const fx = (globalThis as unknown as {
    __calFixture?: { calendars: Calendar[]; events: CalendarEvent[]; goals?: GoalsFile };
  }).__calFixture;
  if (fx) {
    calendars.splice(0, calendars.length, ...fx.calendars);
    events.splice(0, events.length, ...fx.events);
    if (fx.goals) fixtureGoals = fx.goals;
  }
}

function mk(
  calendarId: string,
  summary: string,
  start: Date,
  end: Date,
  conference: string | null = null,
): CalendarEvent {
  return {
    id: `mock-${idCounter++}`,
    calendar_id: calendarId,
    etag: `"${idCounter}"`,
    summary,
    description: null,
    location: null,
    start: iso(start),
    end: iso(end),
    all_day: false,
    timezone: null,
    status: "confirmed",
    recurrence: null,
    recurring_event_id: null,
    conference_url: conference,
    updated: null,
  };
}

let authed = true;
const dbListeners = new Set<() => void>();
const authListeners = new Set<(a: boolean) => void>();
const notifyDb = () => dbListeners.forEach((cb) => cb());

// demo goals (made up: the mock never shows anyone's real goals); a
// fixture may bring its own (fixtureGoals, above)
let goalsFile: GoalsFile | null = null;
const goalsListeners = new Set<() => void>();
function demoGoals(): GoalsFile {
  const g = (id: string, horizon: Horizon, text: string): Goal => ({ id, horizon, text });
  return {
    goals: [
      g("d1", "daily", "2h deep work before noon"),
      g("d2", "daily", "No social media before 6pm"),
      g("d3", "daily", "Stretch for 10 minutes"),
      g("w1", "weekly", "Ship one feature"),
      g("w2", "weekly", "3 gym sessions"),
      g("w3", "weekly", "Read one paper deeply"),
      g("l1", "long", "Publish a research paper"),
      g("l2", "long", "Run a half marathon"),
      g("l3", "long", "Learn Spanish to B2"),
    ],
    checks: { d2: periodOf("daily"), w3: periodOf("weekly") },
  };
}

/** A series-master PATCH applied to the mock's expanded instances. */
async function applySeriesPatch(masterId: string, patch: any) {
  const insts = events.filter((e) => e.recurring_event_id === masterId);
  const first = [...insts].sort((a, b) => a.start.localeCompare(b.start))[0];
  const firstDate = first && (first.all_day ? first.start : toDateOnly(new Date(first.start)));
  // UNTIL truncation: drop instances starting after the boundary
  const rr: string | undefined = patch.recurrence?.[0];
  const until = rr?.match(/UNTIL=(\d{8}(?:T\d{6}Z)?)/)?.[1];
  if (until) {
    const date = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`;
    const u = until.length === 8
      ? new Date(`${date}T23:59:59Z`)
      : new Date(`${date}T${until.slice(9, 11)}:${until.slice(11, 13)}:${until.slice(13, 15)}Z`);
    for (let j = events.length - 1; j >= 0; j--) {
      if (events[j].recurring_event_id === masterId && new Date(events[j].start) > u) {
        events.splice(j, 1);
      }
    }
  }
  for (const e of insts.filter((e) => events.includes(e))) {
    if (patch.summary != null) e.summary = patch.summary;
    if (patch.description !== undefined) e.description = patch.description;
    if (patch.location !== undefined) e.location = patch.location;
    if (patch.transparency !== undefined || patch.visibility !== undefined ||
        patch.reminders !== undefined || patch.attendees !== undefined) {
      e.raw = {
        ...(e.raw ?? {}),
        ...(patch.transparency !== undefined ? { transparency: patch.transparency } : {}),
        ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
        ...(patch.reminders !== undefined ? { reminders: patch.reminders } : {}),
        ...(patch.attendees !== undefined ? { attendees: patch.attendees } : {}),
      };
    }
    if (patch.start?.dateTime && patch.end?.dateTime && firstDate) {
      const oldDate = e.all_day ? e.start : toDateOnly(new Date(e.start));
      const dayOffset = Math.round((Date.parse(`${oldDate}T00:00:00Z`) -
        Date.parse(`${firstDate}T00:00:00Z`)) / 86_400_000);
      const t = new Date(patch.start.dateTime);
      const te = new Date(patch.end.dateTime);
      const dur = te.getTime() - t.getTime();
      const d = addDays(t, dayOffset);
      e.start = d.toISOString();
      e.end = new Date(d.getTime() + dur).toISOString();
      e.all_day = false;
    } else if (patch.start?.date && patch.end?.date && firstDate) {
      const oldDate = e.all_day ? e.start : toDateOnly(new Date(e.start));
      const dayOffset = Math.round((Date.parse(`${oldDate}T00:00:00Z`) -
        Date.parse(`${firstDate}T00:00:00Z`)) / 86_400_000);
      const durationDays = Math.max(1, Math.round((Date.parse(`${patch.end.date}T00:00:00Z`) -
        Date.parse(`${patch.start.date}T00:00:00Z`)) / 86_400_000));
      const shifted = addDays(new Date(`${patch.start.date}T00:00:00`), dayOffset);
      e.start = toDateOnly(shifted);
      e.end = toDateOnly(addDays(shifted, durationDays));
      e.all_day = true;
    }
  }
  notifyDb();
}

export const mockBackend: Backend = {
  async authStatus() {
    return authed;
  },
  async connectGoogle() {
    authed = true;
    authListeners.forEach((cb) => cb(true));
    return true;
  },
  async disconnectGoogle() {
    authed = false;
    authListeners.forEach((cb) => cb(false));
  },
  async syncNow() {},
  async listCalendars() {
    return [...calendars];
  },
  async setCalendarHidden(calendarId, hidden) {
    const c = calendars.find((c) => c.id === calendarId);
    if (c) c.hidden = hidden;
    notifyDb();
  },
  async addCalendar(nameOrId, subscribe) {
    calendars.push({
      id: subscribe ? nameOrId : `local-${Date.now()}`,
      summary: subscribe ? nameOrId : nameOrId,
      color: "#b68cff",
      is_primary: false,
      hidden: false,
      access_role: subscribe ? "reader" : "owner",
    });
    notifyDb();
  },
  async getSeriesMaster(_calendarId, masterId) {
    const insts = events
      .filter((e) => e.recurring_event_id === masterId)
      .sort((a, b) => a.start.localeCompare(b.start));
    if (insts.length === 0) throw new Error("series not found");
    return {
      id: masterId,
      summary: insts[0].summary,
      recurrence: insts[0].raw?.masterRecurrence ?? ["RRULE:FREQ=DAILY"],
      start: insts[0].all_day ? { date: insts[0].start } : { dateTime: insts[0].start },
      end: insts[0].all_day ? { date: insts[0].end } : { dateTime: insts[0].end },
    };
  },
  async getSeriesInstances(_calendarId, masterId) {
    return events.filter((e) => e.recurring_event_id === masterId).map((e) => ({
      id: e.id,
      originalStartTime: e.raw?.originalStartTime ??
        (e.all_day ? { date: e.start } : { dateTime: e.start }),
      status: e.status,
    }));
  },
  async updateSeriesMaster(calendarId, masterId, patch, destinationId) {
    await applySeriesPatch(masterId, patch);
    if (destinationId && destinationId !== calendarId) {
      await mockBackend.moveSeriesMaster(calendarId, masterId, destinationId);
    }
  },
  async splitSeries(_calendarId, masterId, recurrence, input) {
    await applySeriesPatch(masterId, { recurrence });
    return mockBackend.createEvent(input);
  },
  async setEventNote(calendarId, eventId, note) {
    const index = events.findIndex((e) => e.id === eventId && e.calendar_id === calendarId);
    if (index < 0) throw new Error("event not found");
    const ev = events[index];
    const { body, drill: previous } = splitDrill(ev.description);
    const clean = note?.split(/\s+/).join(" ").trim() || null;
    const description = joinDrill(body, clean) || null;
    if (description === (ev.description ?? null)) return previous;
    // a fresh snapshot, like the native store
    events.splice(index, 1, { ...ev, description });
    notifyDb();
    return previous;
  },
  async moveSeriesMaster(_calendarId, masterId, destinationId) {
    for (const event of events.filter((e) => e.recurring_event_id === masterId)) {
      event.calendar_id = destinationId;
    }
    notifyDb();
  },
  async listEvents(start, end) {
    return events
      .filter((e) => e.status !== "cancelled" && e.end >= start && e.start < end)
      .sort((a, b) => a.start.localeCompare(b.start));
  },
  async createEvent(input: EventInput) {
    const ev = mk(
      input.calendar_id,
      input.summary,
      new Date(input.start),
      new Date(input.end),
      input.with_meet ? "https://meet.google.com/mock-new" : null,
    );
    ev.all_day = input.all_day;
    if (input.all_day) {
      ev.start = input.start;
      ev.end = input.end;
    }
    ev.description = input.description ?? null;
    ev.location = input.location ?? null;
    ev.recurrence = input.recurrence ?? null;
    ev.raw = {
      attendees: (input.attendees ?? []).map((email) => ({ email, responseStatus: "needsAction" })),
      transparency: input.transparency ?? "opaque",
      visibility: input.visibility ?? "default",
      reminders: input.reminder_minutes != null
        ? { useDefault: false, overrides: [{ method: "popup", minutes: input.reminder_minutes }] }
        : { useDefault: true },
    };
    events.push(ev);
    notifyDb();
    return ev.id;
  },
  async updateEvent(eventId, input) {
    const index = events.findIndex((e) => e.id === eventId);
    if (index < 0) throw new Error("event not found");
    const ev = events[index];
    const updated: CalendarEvent = {
      ...ev,
      calendar_id: input.calendar_id,
      summary: input.summary,
      description: input.description ?? null,
      location: input.location ?? null,
      start: input.start,
      end: input.end,
      all_day: input.all_day,
      raw: {
      ...(ev.raw ?? {}),
      attendees: (input.attendees ?? ev.raw?.attendees?.map((a: any) => a.email) ?? []).map(
        (e: any) => (typeof e === "string" ? { email: e, responseStatus: "needsAction" } : e),
      ),
      transparency: input.transparency ?? ev.raw?.transparency ?? "opaque",
      visibility: input.visibility ?? ev.raw?.visibility ?? "default",
      reminders:
        input.reminder_minutes != null
          ? { useDefault: false, overrides: [{ method: "popup", minutes: input.reminder_minutes }] }
          : (ev.raw?.reminders ?? { useDefault: true }),
      },
    };
    // Match the native backend: a db change returns fresh event snapshots.
    // Mutating the old object masked stale editor-state bugs in browser E2E.
    events.splice(index, 1, updated);
    notifyDb();
  },
  async deleteEvent(_calendarId, eventId) {
    const i = events.findIndex((e) => e.id === eventId);
    if (i >= 0) {
      events.splice(i, 1);
    } else {
      // Google semantics: deleting a recurring master cancels every instance
      for (let j = events.length - 1; j >= 0; j--) {
        if (events[j].recurring_event_id === eventId) events.splice(j, 1);
      }
    }
    notifyDb();
  },
  async goalsRead() {
    goalsFile ??= fixtureGoals ? structuredClone(fixtureGoals) : demoGoals();
    return structuredClone(goalsFile);
  },
  async goalsWrite(file) {
    goalsFile = structuredClone(file);
    goalsListeners.forEach((cb) => cb());
  },
  onGoalsChanged(cb) {
    goalsListeners.add(cb);
    return () => goalsListeners.delete(cb);
  },
  async getGoalClassifications() {
    // fixture: the classifier would tag research reading as goal work
    const tagged: Record<string, string> = {};
    for (const e of events) {
      if (e.summary === "Read style guide") {
        tagged[`${e.calendar_id}/${e.id}`] = "Publish a research paper";
      }
    }
    return tagged;
  },
  onGoalClassChanged() {
    return () => {};
  },
  onDbChanged(cb) {
    dbListeners.add(cb);
    return () => dbListeners.delete(cb);
  },
  onAuthChanged(cb) {
    authListeners.add(cb);
    return () => authListeners.delete(cb);
  },
};

// E2E handle (dev server only): lets a test arrange data the UI can't reach
// directly, e.g. a note on one occurrence of a recurring series.
if (import.meta.env.DEV) (window as unknown as { __mockBackend?: Backend }).__mockBackend = mockBackend;
