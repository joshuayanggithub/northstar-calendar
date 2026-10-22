// First run, sync status and error surfaces: found by the 2026-10-21 run 5
// bug-finder (each failed before its fix).
import { expect, test, type Page } from "@playwright/test";

const P = { id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" };
const gym = {
  id: "g", calendar_id: "primary", etag: null, summary: "Gym", description: null, location: null,
  start: "2026-10-14T17:00:00-04:00", end: "2026-10-14T18:00:00-04:00", all_day: false, timezone: null, status: "confirmed",
  recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {},
};
const NOW = "2026-10-14T09:00:00";

/** Boot on the dev mock; `patch` (a function body over `mb`) rewires mock
 *  methods before the app first calls them; `ls` seeds localStorage. */
async function boot(page: Page, opts: { patch?: string; ls?: Record<string, string> } = {}) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(({ fx, patch, ls }) => {
    (globalThis as any).__calFixture = fx;
    localStorage.setItem("sweepDismissed", "2026-10-14");
    for (const [k, v] of Object.entries(ls ?? {})) localStorage.setItem(k, v);
    if (!patch) return;
    let mb: any;
    Object.defineProperty(window, "__mockBackend", {
      configurable: true,
      get: () => mb,
      set: (v) => { mb = v; new Function("mb", patch)(v); },
    });
  }, { fx: { calendars: [P], events: [gym] }, patch: opts.patch, ls: opts.ls });
  await page.goto(`/?now=${encodeURIComponent(NOW)}`);
  return errors;
}

/** The app as the native shell runs it: a stand-in Tauri bridge routes every
 *  backend command to the dev mock (sync_now only queues a pass and returns,
 *  as lib.rs's does), and `window.__emit(event, payload)` delivers a Rust-side
 *  event (menu, sync-status, auth-changed). */
async function bootNative(page: Page) {
  await page.addInitScript((fx) => {
    (globalThis as any).__calFixture = fx;
    localStorage.setItem("sweepDismissed", "2026-10-14");
    const cbs = new Map<number, (m: any) => void>();
    const listeners = new Map<string, number[]>();
    let next = 1;
    const emit = (event: string, payload?: unknown) => {
      for (const h of listeners.get(event) ?? []) cbs.get(h)?.({ event, id: h, payload });
    };
    (window as any).__emit = emit;
    let mb: any;
    Object.defineProperty(window, "__mockBackend", {
      configurable: true,
      get: () => mb,
      set: (v) => {
        mb = v;
        v.onDbChanged(() => emit("db-changed"));
        v.onAuthChanged((a: boolean) => emit("auth-changed", a));
        v.onGoalsChanged(() => emit("goals-changed"));
      },
    });
    const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const ARGS: Record<string, string[]> = {
      set_calendar_hidden: ["calendarId", "hidden"], add_calendar: ["nameOrId", "subscribe"],
      get_series_master: ["calendarId", "masterId"], get_series_instances: ["calendarId", "masterId"],
      update_series_master: ["calendarId", "masterId", "patch", "destinationId", "previousStart"],
      split_series: ["calendarId", "masterId", "recurrence", "input", "countSplit", "firstNote"],
      move_series_master: ["calendarId", "masterId", "destinationId"], goals_write: ["file"],
      list_events: ["start", "end"], create_event: ["input"], update_event: ["eventId", "input", "prevCalendarId"],
      delete_event: ["calendarId", "eventId"], restore_recurring_occurrence: ["event"],
      set_event_note: ["calendarId", "eventId", "note"], respond_event: ["calendarId", "eventId", "status"],
    };
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      transformCallback(cb: (m: any) => void) { const id = next++; cbs.set(id, cb); return id; },
      unregisterCallback(id: number) { cbs.delete(id); },
      convertFileSrc: (s: string) => s,
      async invoke(cmd: string, args: any = {}) {
        if (cmd === "plugin:event|listen") {
          listeners.set(args.event, [...(listeners.get(args.event) ?? []), args.handler]);
          return args.handler;
        }
        if (cmd.startsWith("plugin:") || cmd === "sync_now") return null;
        const fn = mb?.[camel(cmd)];
        return fn ? fn.apply(mb, (ARGS[cmd] ?? []).map((k) => args[k])) : null;
      },
    };
  }, { calendars: [P], events: [gym] });
  await page.goto(`/?now=${encodeURIComponent(NOW)}`);
  await expect(page.locator(".chip-timed", { hasText: "Gym" })).toBeVisible();
}

// [P2] GOT: the toast reads "Synced with Google" the instant the menu item is
// picked (sync_now only queues a pass), and still reads it after the pass
// reports it couldn't reach Google — the report's `errors` are never shown.
test("w5a: Sync now while offline does not claim it synced", async ({ page }) => {
  await bootNative(page);
  await page.evaluate(() => (window as any).__emit("menu", "sync"));
  await page.evaluate(() => (window as any).__emit("sync-status", {
    pushed: 0, pulled: 0, conflicts: 0, reverted: [],
    errors: ["calendarList: http error: dns error: failed to lookup address", "primary: http error: dns error"],
  }));
  const toast = page.locator(".toast");
  await expect(toast).toBeVisible();
  await expect(toast, "claimed success with Google unreachable").not.toContainText("Synced with Google");
  await expect(toast).toContainText(/couldn.t|failed|offline|not synced/i);
});

// [P2] GOT: nothing at all — the button goes back to "Connect Google", no
// toast or message; Rust's actionable text ("remove the app's access at
// myaccount.google.com/permissions and retry") is an unhandled rejection.
test("w5a: a failed Connect Google says why", async ({ page }) => {
  const errors = await boot(page, {
    patch: `mb.authStatus = async () => false;
      mb.connectGoogle = async () => { throw "Google returned no refresh token; remove the app's access at myaccount.google.com/permissions and retry"; };`,
  });
  await page.getByRole("button", { name: "Connect Google" }).click();
  await expect(page.getByRole("button", { name: "Connect Google" })).toBeEnabled();
  await expect(page.locator("body"), `unhandled: ${errors.join(" | ")}`).toContainText("myaccount.google.com/permissions");
});

// [P3] GOT: a blank window (no topbar, no grid): TypeError "Cannot read
// properties of null (reading 'suppressed')" thrown from stars.ts during
// render, and no error boundary. Clearing WKWebView storage is the only way out.
test("w5a: a corrupt goal-star entry does not blank the app", async ({ page }) => {
  await boot(page, { ls: { "goal-stars": '{"g":null}' } });
  await expect(page.locator(".chip-timed", { hasText: "Gym" })).toBeVisible();
});

// [P3] GOT: a blank window: TypeError "Cannot read properties of null
// (reading 'my')" from the sidebar's calendar-group collapse state.
test("w5a: a corrupt sidebar collapse value does not blank the app", async ({ page }) => {
  await boot(page, { ls: { "cal-collapsed": "null", "goals-collapsed": "null" } });
  await expect(page.locator(".chip-timed", { hasText: "Gym" })).toBeVisible();
});

// got: "Syncing…" for the instant the pass was queued, then "Sync now" again
// with nothing said, while the pass couldn't reach Google.
test("w5a: Settings' Sync now says why a pass failed", async ({ page }) => {
  await bootNative(page);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByTestId("settings");
  await settings.getByRole("tab", { name: /Google|@/ }).click();
  await settings.getByRole("button", { name: "Sync now" }).click();
  await expect(settings.getByRole("button", { name: "Syncing…" })).toBeVisible();
  await page.evaluate(() => (window as any).__emit("sync-status", {
    pushed: 0, pulled: 0, conflicts: 0, reverted: [], errors: ["calendarList: http error: dns error"],
  }));
  await expect(settings.getByRole("alert")).toContainText(/Couldn.t sync/);
  await expect(settings.getByRole("button", { name: "Sync now" })).toBeEnabled();
});

// got: "Sync now" came straight back, the pass's report unseen
test("w5a: Settings' Sync now stays Syncing… until the pass reports, then Synced", async ({ page }) => {
  await bootNative(page);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByTestId("settings");
  await settings.getByRole("tab", { name: /Google|@/ }).click();
  await settings.getByRole("button", { name: "Sync now" }).click();
  await expect(settings.getByRole("button", { name: "Syncing…" })).toBeVisible();
  await page.waitForTimeout(300);
  await expect(settings.getByRole("button", { name: "Syncing…" })).toBeVisible();
  await page.evaluate(() => (window as any).__emit("sync-status", { pushed: 1, pulled: 0, conflicts: 0, reverted: [], errors: [] }));
  await expect(settings.getByRole("button", { name: "Sync now" })).toBeEnabled();
  await expect(settings.getByRole("alert")).toHaveCount(0);
});

// got: nothing — 1,947 passes a day logged "token refresh failed: invalid_grant"
// while the UI said Connected and queued every change (2026-10-21)
test("w5a: a dead Google sign-in is said once and the account asks to connect again", async ({ page }) => {
  await bootNative(page);
  const dead = { pushed: 0, pulled: 0, conflicts: 0, reverted: [],
    errors: ["Google sign-in expired or revoked: connect Google again in Settings › Calendar accounts (your changes are kept and sync then)"] };
  await page.evaluate((d) => { (window as any).__emit("auth-changed", false); (window as any).__emit("sync-status", d); }, dead);
  await expect(page.locator(".toast")).toContainText("Google sign-in expired");
  await page.evaluate((d) => (window as any).__emit("sync-status", d), dead);
  await expect(page.locator(".toast")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByTestId("settings").getByRole("button", { name: /Connect Google|Add calendar account/ })).toBeVisible();
});
