// Settings (⌘, or North Star > Settings…), laid out like Notion Calendar's:
// grouped sections in a sidebar, each a page of titled groups. Every
// control applies at once; nothing to save.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useModalFocus } from "../lib/useModalFocus";
import { calendarEditable, type Backend, type Calendar } from "../lib/types";
import { normalizeCalendarColor, type ColorMode } from "../lib/color";
import { colorOf } from "../lib/useBackend";
import { DEFAULT_DEEP, DEFAULT_SHADE, SHADE_RANGE, setPrefs, usePrefs, type Shade, type Theme } from "../lib/settings";
import { runningInTauri } from "../lib/backend";

export type SettingsTab = "general" | "notifications" | "insights" | "account" | "about";
export type SeamStyle = "scarf" | "rabbet" | "overlay";

interface NotifyPrefs {
  event_alerts: boolean;
  alert_lead_min: number;
  hourly_nudge: boolean;
  menubar_title: boolean;
}
const NOTIFY_DEFAULTS: NotifyPrefs = { event_alerts: true, alert_lead_min: 1, hourly_nudge: true, menubar_title: true };

const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  (await import("@tauri-apps/api/core")).invoke<T>(cmd, args);

const I = {
  general: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></svg>,
  notifications: <svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0" /></svg>,
  insights: <svg viewBox="0 0 24 24"><path d="M5 20V11M12 20V4M19 20v-7" /></svg>,
  shortcuts: <svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></svg>,
  about: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></svg>,
  plus: <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>,
  google: (
    <svg viewBox="0 0 24 24" className="set-g">
      <path fill="#4285F4" stroke="none" d="M22.6 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.3-4.8 3.3-7.9z" />
      <path fill="#34A853" stroke="none" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.7c-1 .7-2.2 1-3.7 1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.8A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" stroke="none" d="M5.8 14.1a6.6 6.6 0 0 1 0-4.2V7.1H2.1a11 11 0 0 0 0 9.8l3.7-2.8z" />
      <path fill="#EA4335" stroke="none" d="M12 5.4c1.6 0 3.1.6 4.2 1.6l3.2-3.2A11 11 0 0 0 2.1 7.1l3.7 2.8c.9-2.6 3.3-4.5 6.2-4.5z" />
    </svg>
  ),
};

function Switch(props: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className={"set-toggle" + (props.disabled ? " disabled" : "")}>
      <button
        role="switch"
        aria-checked={props.on}
        aria-label={props.label}
        disabled={props.disabled}
        className={"set-switch" + (props.on ? " on" : "")}
        onClick={() => props.onChange(!props.on)}
      >
        <span />
      </button>
      <span className="set-toggle-text">
        {props.label}
        {props.hint && <small>{props.hint}</small>}
      </span>
    </label>
  );
}

function Select<T extends string | number>(props: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="set-field">
      <span className="set-field-label">{props.label}</span>
      <select
        className="set-select"
        aria-label={props.label}
        disabled={props.disabled}
        value={String(props.value)}
        onChange={(e) => {
          const o = props.options.find(([v]) => String(v) === e.target.value);
          if (o) props.onChange(o[0]);
        }}
      >
        {props.options.map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>)}
      </select>
    </div>
  );
}

function Segmented<T extends string>(props: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  // a radio group: one Tab stop, the arrows move the choice
  const idx = Math.max(0, props.options.findIndex(([v]) => v === props.value));
  const move = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = (idx + d + props.options.length) % props.options.length;
    props.onChange(props.options[next][0]);
    (e.currentTarget.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div className="set-field">
      <span className="set-field-label">{props.label}</span>
      <div className="set-seg" role="radiogroup" aria-label={props.label} onKeyDown={move}>
        {props.options.map(([v, l]) => (
          <button
            key={v}
            role="radio"
            aria-checked={props.value === v}
            tabIndex={props.value === v ? 0 : -1}
            className={props.value === v ? "on" : ""}
            onClick={() => props.onChange(v)}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

function Slider(props: { label: string; value: number; min: number; max: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <label className="set-slider">
      <span className="set-field-label">{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        value={props.value}
        aria-label={props.label}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={{ "--fill": `${((props.value - props.min) / (props.max - props.min)) * 100}%` } as React.CSSProperties}
      />
      <span className="set-slider-val">{props.value}{props.unit ?? "%"}</span>
    </label>
  );
}

/** a sample upcoming and past chip in one theme, drawn with that theme's
 *  own colors whatever theme is showing now */
function ShadePreview(props: { theme: "light" | "dark"; shade: Shade; colors: string[]; active: boolean; onPick: () => void }) {
  const bg = props.theme === "dark" ? "#191919" : "#ffffff";
  const fg = props.theme === "dark" ? "#e8e8e6" : "#1f1f1f";
  const fg2 = props.theme === "dark" ? "#9b9a97" : "#6f6e69";
  const textMix = props.theme === "dark" ? 55 : 38;
  const chip = (cal: string, past: boolean, title: string, time: string) => {
    const t = past ? props.shade.upcoming * (props.shade.past / 100) : props.shade.upcoming;
    return (
      <span
        className="shade-chip"
        style={{
          background: `color-mix(in srgb, ${cal} ${t}%, ${bg})`,
          color: past ? `color-mix(in srgb, ${cal} 16%, ${fg2})` : `color-mix(in srgb, ${cal} ${textMix}%, ${fg})`,
        }}
      >
        <b>{title}</b>
        <small>{time}</small>
      </span>
    );
  };
  return (
    <button
      type="button"
      className={"shade-preview" + (props.active ? " on" : "")}
      style={{ background: bg, color: fg2 }}
      onClick={props.onPick}
      aria-pressed={props.active}
      data-testid={`shade-preview-${props.theme}`}
    >
      <span className="shade-preview-head">{props.theme === "dark" ? "Dark" : "Light"}</span>
      <span className="shade-col">
        <span className="shade-label">past</span>
        {chip(props.colors[0], true, "Gym", "9 – 10 AM")}
        {chip(props.colors[1], true, "Lecture", "10:30 AM")}
      </span>
      <span className="shade-col">
        <span className="shade-label">upcoming</span>
        {chip(props.colors[0], false, "Team sync", "2 – 3 PM")}
        {chip(props.colors[1], false, "Problem set", "4 PM")}
      </span>
    </button>
  );
}

function Group(props: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="set-group">
      <h3>{props.title}</h3>
      {props.children}
      {props.note && <p className="set-note">{props.note}</p>}
    </section>
  );
}

export function SettingsDialog(props: {
  tab: SettingsTab;
  onTab: (t: SettingsTab) => void;
  onClose: () => void;
  onShortcuts: () => void;
  backend: Backend | null;
  calendars: Calendar[];
  authed: boolean | null;
  hideWeekends: boolean;
  onHideWeekends: (v: boolean) => void;
  secondaryTz: string | null;
  onSecondaryTz: (tz: string | null) => void;
  seamStyle: SeamStyle;
  onSeamStyle: (s: SeamStyle) => void;
  onConnect: () => void;
}) {
  const prefs = usePrefs();
  const [shadeTheme, setShadeTheme] = useState<"light" | "dark">(() => {
    if (prefs.theme !== "system") return prefs.theme;
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [confirmOut, setConfirmOut] = useState(false);
  const [notify, setNotify] = useState<NotifyPrefs>(NOTIFY_DEFAULTS);
  useEffect(() => {
    if (runningInTauri) void invoke<NotifyPrefs>("get_notify_prefs").then(setNotify).catch(() => {});
  }, []);
  const saveNotify = (patch: Partial<NotifyPrefs>) => {
    const next = { ...notify, ...patch };
    setNotify(next);
    if (runningInTauri) void invoke("set_notify_prefs", { prefs: next }).catch(() => {});
  };
  const zones = useMemo(() => {
    try {
      return (Intl as any).supportedValuesOf("timeZone") as string[];
    } catch {
      return ["UTC", "America/Los_Angeles", "America/New_York", "Europe/London", "Asia/Tokyo"];
    }
  }, []);
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const win = useRef<HTMLDivElement | null>(null);
  useModalFocus(win);
  // the account page is the connected account's: after Disconnect it still
  // read "Connected" with Sync now beside a sidebar saying Add account
  useEffect(() => {
    if (!props.authed && props.tab === "account") props.onTab("general");
  }, [props.authed, props.tab]); // eslint-disable-line react-hooks/exhaustive-deps
  // each page opens at its top (one scroller is shared: Notifications
  // opened at General's scroll, its first section above the fold)
  const content = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [props.tab]);
  const mine = props.calendars.filter((c) => calendarEditable(c));
  const others = props.calendars.filter((c) => !calendarEditable(c));
  const email = props.calendars.find((c) => c.is_primary && c.id.includes("@"))?.id;
  const deep = new Set(prefs.deepCalendars.map((n) => n.trim().toLowerCase()));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [props.onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  const nav = (id: SettingsTab, label: string, icon: ReactNode) => (
    <button key={id} role="tab" aria-selected={props.tab === id} className={"set-nav-item" + (props.tab === id ? " on" : "")} onClick={() => props.onTab(id)}>
      {icon}
      <span>{label}</span>
    </button>
  );
  const calRow = (c: Calendar, on: boolean, onChange: (v: boolean) => void, label: string) => (
    <li key={c.id} className="set-cal">
      <span className="set-cal-dot" style={{ background: colorOf(props.calendars, c.id) }} />
      <span className="set-cal-name">{c.summary}</span>
      {c.is_primary && <span className="set-tag">Default</span>}
      <button role="switch" aria-checked={on} aria-label={label} className={"set-switch" + (on ? " on" : "")} onClick={() => onChange(!on)}>
        <span />
      </button>
    </li>
  );
  const shortcutsLink = (what: string) => (
    <button className="set-link" onClick={props.onShortcuts}>
      List of all {what} <b>keyboard shortcuts</b> ›
    </button>
  );

  return (
    <div className="set-scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div ref={win} tabIndex={-1} className="set-window settings-window" role="dialog" aria-modal="true" aria-label="Settings" data-testid="settings">
        <aside className="set-sidebar" role="tablist" aria-orientation="vertical">
          <span className="set-nav-head">App</span>
          {nav("general", "General", I.general)}
          {nav("notifications", "Notifications", I.notifications)}
          {nav("insights", "Insights & review", I.insights)}
          <span className="set-nav-head">Calendar accounts</span>
          {props.authed ? (
            nav("account", email ?? "Google Calendar", I.google)
          ) : (
            <button className="set-nav-item" onClick={props.onConnect}>
              {I.plus}
              <span>Add calendar account</span>
            </button>
          )}
          <span className="set-nav-head">Help</span>
          <button className="set-nav-item" onClick={props.onShortcuts}>
            {I.shortcuts}
            <span>Keyboard shortcuts</span>
          </button>
          {nav("about", "About North Star", I.about)}
        </aside>

        {/* (outside the scroller: it scrolled away with a long page) */}
        <button className="set-close" aria-label="Close settings" onClick={props.onClose}>✕</button>
        <div className="set-content" ref={content}>

          {props.tab === "general" && (
            <>
              <Group title="Appearance">
                <Segmented<Theme>
                  label="Theme"
                  value={prefs.theme}
                  options={[["system", "System"], ["light", "Light"], ["dark", "Dark"]]}
                  onChange={(theme) => setPrefs({ theme })}
                />
                <Segmented<SeamStyle>
                  label="Overlapping events"
                  value={props.seamStyle}
                  options={[["rabbet", "Stepped"], ["scarf", "Angled"], ["overlay", "Stacked"]]}
                  onChange={props.onSeamStyle}
                />
                <Segmented<ColorMode>
                  label="Calendar colors"
                  value={prefs.colorMode}
                  options={[["balanced", "Balanced"], ["google", "Google's exact"]]}
                  onChange={(colorMode) => setPrefs({ colorMode })}
                />
                <p className="set-note" data-testid="color-mode-hint">
                  {prefs.colorMode === "balanced"
                    ? "Each calendar keeps its Google hue, evened out in brightness; calendars that share a color are nudged apart. Right-click a calendar in the sidebar to pick its color."
                    : "Exactly the colors Google Calendar shows, even where calendars share one."}
                </p>
              </Group>
              <Group
                title="Event shading"
                note={
                  <>
                    How strongly events are filled with their calendar's color, and how much of it an event keeps once
                    it's over. Each theme has its own (dark looks stronger at the same setting).{" "}
                    <button className="set-link inline" onClick={() => setPrefs({ shade: DEFAULT_SHADE })}>Reset both</button>
                  </>
                }
              >
                <div className="shade-previews">
                  {(["light", "dark"] as const).map((t) => (
                    <ShadePreview
                      key={t}
                      theme={t}
                      shade={prefs.shade[t]}
                      active={shadeTheme === t}
                      onPick={() => setShadeTheme(t)}
                      colors={[
                        mine[0] ? colorOf(props.calendars, mine[0].id, t === "dark") : normalizeCalendarColor("#4986e7", t === "dark"),
                        mine[1] ? colorOf(props.calendars, mine[1].id, t === "dark") : normalizeCalendarColor("#2fbf71", t === "dark"),
                      ]}
                    />
                  ))}
                </div>
                <Segmented<"light" | "dark">
                  label="Adjusting"
                  value={shadeTheme}
                  options={[["light", "Light"], ["dark", "Dark"]]}
                  onChange={setShadeTheme}
                />
                <Slider
                  label="Upcoming events"
                  min={SHADE_RANGE.upcoming[0]}
                  max={SHADE_RANGE.upcoming[1]}
                  value={prefs.shade[shadeTheme].upcoming}
                  onChange={(v) => setPrefs({ shade: { ...prefs.shade, [shadeTheme]: { ...prefs.shade[shadeTheme], upcoming: v } } })}
                />
                <Slider
                  label="Past events keep"
                  min={SHADE_RANGE.past[0]}
                  max={SHADE_RANGE.past[1]}
                  value={prefs.shade[shadeTheme].past}
                  onChange={(v) => setPrefs({ shade: { ...prefs.shade, [shadeTheme]: { ...prefs.shade[shadeTheme], past: v } } })}
                />
              </Group>
              <Group title="Show on the calendar" note={<>How many days show is set on the grid itself (1–9, W, M). {shortcutsLink("calendar view")}</>}>
                <Switch label="Weekends" on={!props.hideWeekends} onChange={(v) => props.onHideWeekends(!v)} />
                <Switch label="Declined events" hint="Invitations you said no to, struck through" on={prefs.showDeclined} onChange={(v) => setPrefs({ showDeclined: v })} />
                <Switch label="Notes" hint="Your red-pen margin notes · A to toggle" on={prefs.showNotes} onChange={(v) => setPrefs({ showNotes: v })} />
              </Group>
              <Group title="Time zones" note={`Your time zone is ${here.replace(/_/g, " ")}, from this Mac.`}>
                <Select<string>
                  label="Secondary time zone in the time gutter:"
                  value={props.secondaryTz ?? ""}
                  options={[["", "None"], ...zones.map((z) => [z, z.replace(/_/g, " ")] as [string, string])]}
                  onChange={(z) => props.onSecondaryTz(z || null)}
                />
              </Group>
            </>
          )}

          {props.tab === "notifications" && (
            <>
              <Group title="Event alerts" note={!runningInTauri ? "Notifications come from the Mac app." : undefined}>
                <Switch label="Alert me before events" on={notify.event_alerts} onChange={(v) => saveNotify({ event_alerts: v })} />
                <Select<number>
                  label="Alert:"
                  disabled={!notify.event_alerts}
                  value={notify.alert_lead_min}
                  options={[[0, "When it starts"], [1, "1 minute before"], [5, "5 minutes before"], [10, "10 minutes before"], [15, "15 minutes before"]]}
                  onChange={(m) => saveNotify({ alert_lead_min: m })}
                />
              </Group>
              <Group title="Check-ins">
                <Switch
                  label="Hourly check-in"
                  hint="Once an hour in waking hours: what are you doing? Click it to log the hour."
                  on={notify.hourly_nudge}
                  onChange={(v) => saveNotify({ hourly_nudge: v })}
                />
              </Group>
              <Group title="Menu bar" note="The North Star icon in the menu bar lists the next 12 hours; click an event to open it, or join its meeting.">
                <Switch label="Show the next event beside the icon" hint="Its title and how soon it starts" on={notify.menubar_title} onChange={(v) => saveNotify({ menubar_title: v })} />
                <p className="set-row-text">
                  <kbd className="help-kbd">⌥</kbd> <kbd className="help-kbd">C</kbd> &nbsp;quick-creates an event from any app.
                </p>
              </Group>
              <Group title="macOS">
                {runningInTauri ? (
                  <button
                    className="set-link"
                    onClick={() => void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl("x-apple.systempreferences:com.apple.preference.notifications"))}
                  >
                    Banner style, sounds and Focus: <b>macOS Notification settings</b> ›
                  </button>
                ) : (
                  <p className="set-note">Banner style, sounds and Focus are set in macOS System Settings › Notifications.</p>
                )}
              </Group>
            </>
          )}

          {props.tab === "insights" && (
            <>
              <Group title="Deep work" note={<>Time on these calendars counts as deep work in Insights and the day score. <button className="set-link inline" onClick={() => setPrefs({ deepCalendars: DEFAULT_DEEP })}>Restore defaults</button></>}>
                <ul className="set-cals">
                  {mine.map((c) =>
                    calRow(c, deep.has(c.summary.trim().toLowerCase()), (v) =>
                      setPrefs({
                        deepCalendars: v
                          ? [...prefs.deepCalendars, c.summary]
                          : prefs.deepCalendars.filter((n) => n.trim().toLowerCase() !== c.summary.trim().toLowerCase()),
                      }), `${c.summary} counts as deep work`),
                  )}
                </ul>
              </Group>
              <Group title="Sleep and distraction">
                <p className="set-row-text">
                  <b>Sleep</b> is a calendar named Sleep, or events titled Sleep, Asleep or In bed. <b>Distraction</b> is a calendar
                  with “distraction” in its name, or events titled “Distraction: …” (what follows the colon is the source).
                </p>
              </Group>
            </>
          )}

          {props.tab === "account" && (
            <>
              <Group title="Google Calendar" note="Changes sync both ways within seconds; Google is the source of truth.">
                <div className="set-account">
                  {I.google}
                  <div>
                    <b>{email ?? "Google account"}</b>
                    <small>Connected</small>
                  </div>
                </div>
                <div className="set-buttons">
                  <button
                    className="set-btn"
                    disabled={syncing}
                    onClick={async () => {
                      setSyncing(true);
                      setSyncError(null);
                      try {
                        await props.backend?.syncNow();
                      } catch (e) {
                        // (the pass's own report: "Syncing…" lasted an instant and said nothing)
                        setSyncError(String(e));
                      } finally {
                        setSyncing(false);
                      }
                    }}
                  >
                    {syncing ? "Syncing…" : "Sync now"}
                  </button>
                  {syncError && <small className="set-err" role="alert">Couldn't sync: {syncError}</small>}
                  {confirmOut ? (
                    <button className="set-btn danger" onClick={() => { setConfirmOut(false); void props.backend?.disconnectGoogle(); }}>
                      Disconnect this account
                    </button>
                  ) : (
                    <button className="set-btn" onClick={() => setConfirmOut(true)}>Disconnect…</button>
                  )}
                </div>
              </Group>
              {mine.length > 0 && (
                <Group title="My calendars">
                  <ul className="set-cals">{mine.map((c) => calRow(c, !c.hidden, (v) => void props.backend?.setCalendarHidden(c.id, !v), `Show ${c.summary}`))}</ul>
                </Group>
              )}
              {others.length > 0 && (
                <Group title="Other calendars" note="Read-only. Copy an event to one of yours to plan around it.">
                  <ul className="set-cals">{others.map((c) => calRow(c, !c.hidden, (v) => void props.backend?.setCalendarHidden(c.id, !v), `Show ${c.summary}`))}</ul>
                </Group>
              )}
            </>
          )}

          {props.tab === "about" && (
            <div className="set-about">
              <img src="/app-icon.png" alt="" className="set-about-icon" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
              <h2>North Star</h2>
              <p className="set-about-version" data-testid="settings-version">Version {__APP_VERSION__}</p>
              <p>A calendar for doing the work, synced with Google Calendar both ways.</p>
              <div className="set-buttons center">
                {runningInTauri && (
                  <button className="set-btn" onClick={() => void invoke("reveal_data_dir")}>Show data folder</button>
                )}
                <a className="set-btn" href="https://github.com/joshuayanggithub/northstar-calendar/issues" target="_blank" rel="noreferrer">
                  Report an issue
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
