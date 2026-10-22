// Backend adapter: in the Tauri app this talks to Rust; in a plain browser
// (vite dev server opened in Chrome, Playwright) it falls back to the mock,
// which is what makes the whole UI drivable with web tooling.

import type { Backend, Calendar, CalendarEvent, EventInput } from "./types";
import { mockBackend } from "./mockBackend";

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

async function tauriBackend(): Promise<Backend> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  // Forward frontend errors into the Rust log file for debuggability.
  window.addEventListener("error", (e) => {
    invoke("log_frontend", { level: "error", message: String(e.message) }).catch(() => {});
  });
  window.addEventListener("unhandledrejection", (e) => {
    invoke("log_frontend", { level: "error", message: `unhandled rejection: ${e.reason}` }).catch(
      () => {},
    );
  });

  return {
    authStatus: () => invoke<boolean>("auth_status"),
    connectGoogle: () => invoke<boolean>("connect_google"),
    disconnectGoogle: () => invoke("disconnect_google"),
    // sync_now only queues a pass: the promise settles on that pass's
    // report (its errors reject), so "Synced" means it did and "Syncing…"
    // lasts as long as it does
    syncNow: async () => {
      const report = new Promise<{ errors?: string[] }>((resolve, reject) => {
        let un: (() => void) | undefined;
        const timer = setTimeout(() => {
          un?.();
          reject("the sync pass didn't finish");
        }, 90_000);
        listen<{ errors?: string[] }>("sync-status", ({ payload }) => {
          clearTimeout(timer);
          un?.();
          resolve(payload ?? {});
        }).then((f) => (un = f));
      });
      await invoke("sync_now");
      const { errors = [] } = await report;
      if (errors.length) throw errors[0];
    },
    listCalendars: () => invoke<Calendar[]>("list_calendars"),
    setCalendarHidden: (calendarId, hidden) =>
      invoke("set_calendar_hidden", { calendarId, hidden }),
    addCalendar: (nameOrId, subscribe) => invoke("add_calendar", { nameOrId, subscribe }),
    getSeriesMaster: (calendarId, masterId) =>
      invoke("get_series_master", { calendarId, masterId }),
    getSeriesInstances: (calendarId, masterId) =>
      invoke<any[]>("get_series_instances", { calendarId, masterId }),
    updateSeriesMaster: (calendarId, masterId, patch, destinationId, previousStart) =>
      invoke("update_series_master", {
        calendarId,
        masterId,
        patch,
        destinationId: destinationId ?? null,
        previousStart: previousStart ?? null,
      }),
    splitSeries: (calendarId, masterId, recurrence, input, countSplit, firstNote) =>
      invoke<string>("split_series", {
        calendarId, masterId, recurrence, input, countSplit: countSplit ?? null, firstNote: firstNote ?? null,
      }),
    moveSeriesMaster: (calendarId, masterId, destinationId) =>
      invoke("move_series_master", { calendarId, masterId, destinationId }),
    goalsRead: () => invoke("goals_read"),
    goalsWrite: (file) => invoke("goals_write", { file }),
    onGoalsChanged(cb) {
      const un = listen("goals-changed", () => cb());
      return () => {
        un.then((f) => f());
      };
    },
    getGoalClassifications: () => invoke("get_goal_classifications"),
    onGoalClassChanged(cb) {
      const un = listen("goal-class-changed", () => cb());
      return () => {
        un.then((f) => f());
      };
    },
    listEvents: (start, end) => invoke<CalendarEvent[]>("list_events", { start, end }),
    createEvent: (input: EventInput) => invoke<string>("create_event", { input }),
    updateEvent: (eventId, input, prevCalendarId) =>
      invoke("update_event", { eventId, input, prevCalendarId: prevCalendarId ?? null }),
    deleteEvent: (calendarId, eventId) => invoke("delete_event", { calendarId, eventId }),
    restoreRecurringOccurrence: (event) => invoke("restore_recurring_occurrence", { event }),
    setEventNote: (calendarId, eventId, note) =>
      invoke<string | null>("set_event_note", { calendarId, eventId, note }),
    respondEvent: (calendarId, eventId, status) =>
      invoke<string>("respond_event", { calendarId, eventId, status }),
    onDbChanged(cb) {
      const un = listen("db-changed", cb);
      return () => {
        un.then((f) => f());
      };
    },
    onAuthChanged(cb) {
      const un = listen<boolean>("auth-changed", (e) => cb(e.payload));
      return () => {
        un.then((f) => f());
      };
    },
  };
}

export const backendPromise: Promise<Backend> = isTauri()
  ? tauriBackend()
  : Promise.resolve(mockBackend);

export const runningInTauri = isTauri();
