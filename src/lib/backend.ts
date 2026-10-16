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
    syncNow: () => invoke("sync_now"),
    listCalendars: () => invoke<Calendar[]>("list_calendars"),
    setCalendarHidden: (calendarId, hidden) =>
      invoke("set_calendar_hidden", { calendarId, hidden }),
    addCalendar: (nameOrId, subscribe) => invoke("add_calendar", { nameOrId, subscribe }),
    getSeriesMaster: (calendarId, masterId) =>
      invoke("get_series_master", { calendarId, masterId }),
    getSeriesInstances: (calendarId, masterId) =>
      invoke<any[]>("get_series_instances", { calendarId, masterId }),
    updateSeriesMaster: (calendarId, masterId, patch) =>
      invoke("update_series_master", { calendarId, masterId, patch }),
    moveSeriesMaster: (calendarId, masterId, destinationId) =>
      invoke("move_series_master", { calendarId, masterId, destinationId }),
    mdRead: (which) => invoke("md_read", { which }),
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
    mdWrite: (which, content, expectedMtimeMs) =>
      invoke("md_write", { which, content, expectedMtimeMs }),
    onMdChanged(cb) {
      const un = listen<string>("md-changed", (e) => cb(e.payload));
      return () => {
        un.then((f) => f());
      };
    },
    listEvents: (start, end) => invoke<CalendarEvent[]>("list_events", { start, end }),
    createEvent: (input: EventInput) => invoke<string>("create_event", { input }),
    updateEvent: (eventId, input, prevCalendarId) =>
      invoke("update_event", { eventId, input, prevCalendarId: prevCalendarId ?? null }),
    deleteEvent: (calendarId, eventId) => invoke("delete_event", { calendarId, eventId }),
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
