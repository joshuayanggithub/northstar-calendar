//! Upcoming-meeting notifications + the menu bar item (Notion Calendar
//! style): the next event and how soon it starts sit in the menu bar; the
//! dropdown lists everything in the next 12 hours, and picking one opens it
//! in the app. A scheduler thread polls the local store; tray mutations are
//! proxied to the main thread (macOS requirement).

use chrono::{DateTime, Local, Timelike};
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;
use sync_core::db::Db;
use sync_core::models::Event;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tracing::{info, warn};

const POLL: Duration = Duration::from_secs(20);
const NOTIFY_LEAD_SECS: i64 = 60;

// ---- the hourly nudge: "what are you actually doing?" ----
// Once an hour, from 8:00 through 23:59, the app asks you to bring the
// calendar up to date with what you're really doing. It replaces the
// launchd job + helper app (~/bin/calendar-nudge.sh) that sent the same
// banner and opened Notion Calendar on a click. Not at launch (the first
// nudge waits for the next hour); after sleeping through an hour, once on
// wake. Clicking the banner brings North Star to the front, which counts as
// answering it (see answer_nudge): the app opens on now, on the event you're
// in (or a new one for this hour).
const NUDGE_FROM: u32 = 8;
const NUDGE_TO: u32 = 23;
/// bringing the app forward this soon after a nudge answers it
const NUDGE_ANSWER_SECS: u64 = 15 * 60;
static NUDGED_AT: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

pub fn nudge_text(now: DateTime<Local>) -> String {
    format!("{} — what are you actually doing? Update the current event.", now.format("%-I:%M %p"))
}

/// whether a nudge goes out on this tick: the hour changed since the last
/// one (or since launch), and it's inside the nudging hours
pub fn nudge_due(now: DateTime<Local>, last_hour: &str) -> bool {
    let key = now.format("%Y-%m-%d %H").to_string();
    key != last_hour && (NUDGE_FROM..=NUDGE_TO).contains(&now.hour())
}

pub fn send_nudge(app: &AppHandle, now: DateTime<Local>) {
    info!("nudging");
    let _ = app.notification().builder().title("North Star").body(nudge_text(now)).show();
    *NUDGED_AT.lock().unwrap() = Some(std::time::Instant::now());
}

/// The app came to the front (a window took focus, or it was reopened). If
/// a nudge went out recently, that was its answer: bring the window up and
/// tell the interface to open on what's happening now. Only once per nudge.
pub fn answer_nudge(app: &AppHandle) {
    let fresh = {
        let mut at = NUDGED_AT.lock().unwrap();
        match *at {
            Some(t) if t.elapsed().as_secs() <= NUDGE_ANSWER_SECS => {
                *at = None;
                true
            }
            _ => false,
        }
    };
    if !fresh {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit("nudge-open", ());
}

pub const TRAY_ID: &str = "main-tray";
/// how far ahead the dropdown lists events
const LIST_HOURS: i64 = 12;
const LIST_MAX: usize = 20;

fn parse_end(e: &Event) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(&e.end)
        .ok()
        .map(|d| d.with_timezone(&Local))
}

/// sleep tracking isn't something to be reminded of
fn is_sleep(e: &Event) -> bool {
    let t = e.summary.trim().to_lowercase();
    ["asleep", "sleep", "in bed"].iter().any(|p| t.starts_with(p))
}

/// "5m", "1h 05m", "2h"
pub fn fmt_until(mins: i64) -> String {
    let m = mins.max(0);
    if m < 60 {
        format!("{m}m")
    } else if m % 60 == 0 {
        format!("{}h", m / 60)
    } else {
        format!("{}h {:02}m", m / 60, m % 60)
    }
}

/// What the menu bar shows: the next event and how soon it starts (its clock
/// time when that's over 3 hours off); an event in progress takes over when
/// nothing starts within the hour. None: icon only.
pub fn bar_title(now: DateTime<Local>, events: &[(DateTime<Local>, DateTime<Local>, String)]) -> Option<String> {
    let next = events.iter().filter(|(s, _, _)| *s > now).min_by_key(|(s, _, _)| *s);
    let current = events
        .iter()
        .filter(|(s, e, _)| *s <= now && *e > now)
        .max_by_key(|(s, _, _)| *s);
    let mins = |a: DateTime<Local>, b: DateTime<Local>| ((b - a).num_seconds() + 59) / 60;
    match (next, current) {
        (Some((s, _, t)), cur) if mins(now, *s) <= 60 || cur.is_none() => {
            let m = mins(now, *s);
            Some(if m > 180 {
                format!("{} at {}", truncate(t, 18), s.format("%-I:%M %p"))
            } else {
                format!("{} in {}", truncate(t, 18), fmt_until(m))
            })
        }
        (_, Some((_, e, t))) => Some(format!("{} · {} left", truncate(t, 18), fmt_until(mins(now, *e)))),
        _ => None,
    }
}

/// The dropdown rows: (menu id, label) for timed events in progress or
/// starting within LIST_HOURS, in order.
pub fn list_rows(now: DateTime<Local>, events: &[(DateTime<Local>, DateTime<Local>, String, String)]) -> Vec<(String, String)> {
    let horizon = now + chrono::Duration::hours(LIST_HOURS);
    let mut rows: Vec<_> = events
        .iter()
        .filter(|(s, e, _, _)| *e > now && *s < horizon)
        .collect();
    rows.sort_by_key(|(s, _, _, _)| *s);
    rows.into_iter()
        .take(LIST_MAX)
        .map(|(s, e, title, key)| {
            let when = if *s <= now {
                format!("now – {}", e.format("%-I:%M %p"))
            } else {
                s.format("%-I:%M %p").to_string()
            };
            (format!("ev:{key}"), format!("{when}    {}", truncate(title, 40)))
        })
        .collect()
}

fn parse_start(e: &Event) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(&e.start)
        .ok()
        .map(|d| d.with_timezone(&Local))
}

/// An event copied in from one of the "Other calendars" stands for its
/// original (src/lib/copies.ts): the original is dropped when one of your own
/// events has its title and times, so the list and reminders show it once.
fn without_copied_originals(db: &Db, events: Vec<Event>) -> Vec<Event> {
    let read_only: HashSet<String> = db
        .list_calendars()
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.access_role != "owner" && c.access_role != "writer")
        .map(|c| c.id)
        .collect();
    if read_only.is_empty() {
        return events;
    }
    let sig = |e: &Event| (parse_start(e), parse_end(e), e.summary.trim().to_string());
    let yours: HashSet<_> = events.iter().filter(|e| !read_only.contains(&e.calendar_id)).map(sig).collect();
    events
        .into_iter()
        .filter(|e| !read_only.contains(&e.calendar_id) || !yours.contains(&sig(e)))
        .collect()
}

fn upcoming(db: &Db, horizon_hours: i64) -> Vec<Event> {
    let now = Local::now();
    let end = now + chrono::Duration::hours(horizon_hours);
    let found = db.list_events_between(&now.to_rfc3339(), &end.to_rfc3339()).unwrap_or_default();
    let mut events = without_copied_originals(db, found)
        .into_iter()
        .filter(|e| !e.all_day)
        .filter_map(|e| parse_start(&e).map(|s| (s, e)))
        .filter(|(s, _)| *s > now - chrono::Duration::minutes(1))
        .collect::<Vec<_>>();
    events.sort_by_key(|(s, _)| *s);
    events.into_iter().map(|(_, e)| e).collect()
}

/// timed events on visible calendars that end after now and start within
/// the list horizon (in-progress ones included), sleep left out
fn tray_events(db: &Db) -> Vec<(DateTime<Local>, DateTime<Local>, String, String, Option<String>)> {
    let now = Local::now();
    let end = now + chrono::Duration::hours(LIST_HOURS);
    let hidden: HashSet<String> = db
        .list_calendars()
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.hidden)
        .map(|c| c.id)
        .collect();
    let found = db.list_events_between(&now.to_rfc3339(), &end.to_rfc3339()).unwrap_or_default();
    without_copied_originals(db, found)
        .into_iter()
        .filter(|e| !e.all_day && !hidden.contains(&e.calendar_id) && !is_sleep(e))
        .filter_map(|e| {
            let (s, en) = (parse_start(&e)?, parse_end(&e)?);
            Some((s, en, e.summary.clone(), format!("{}/{}", e.calendar_id, e.id), e.conference_url.clone()))
        })
        .filter(|(_, en, _, _, _)| *en > now)
        .collect()
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("open", "Open North Star").build(app)?)
        .item(&MenuItemBuilder::with_id("sync", "Sync now").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "Quit").build(app)?)
        .build()?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png"))
        .unwrap_or_else(|_| app.default_window_icon().unwrap().clone());
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("North Star")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "sync" => {
                let state = app.state::<crate::state::AppState>();
                state.kick_sync(crate::state::SyncKick::Now);
            }
            "quit" => app.exit(0),
            id if id.starts_with("join:") => {
                let url = id.trim_start_matches("join:").to_string();
                let _ = tauri_plugin_opener::open_url(&url, None::<&str>);
            }
            id if id.starts_with("ev:") => {
                // open the app on that event
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                let _ = app.emit("tray-open-event", id.trim_start_matches("ev:").to_string());
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

pub fn spawn_scheduler(app: AppHandle, db_path: PathBuf) {
    std::thread::Builder::new()
        .name("notify".into())
        .spawn(move || {
            let db = match Db::open(&db_path) {
                Ok(db) => db,
                Err(e) => {
                    warn!("notify thread: db open failed: {e}");
                    return;
                }
            };
            let mut notified: HashSet<String> = HashSet::new();
            let mut last_tray_label = String::new();
            // the hour the last nudge went out in; launch counts as one
            let mut nudged_hour = Local::now().format("%Y-%m-%d %H").to_string();
            loop {
                let now = Local::now();
                if nudge_due(now, &nudged_hour) {
                    send_nudge(&app, now);
                }
                nudged_hour = now.format("%Y-%m-%d %H").to_string();
                let soon = upcoming(&db, 24);

                // notifications at T-1min
                for e in &soon {
                    let Some(start) = parse_start(e) else { continue };
                    let secs = (start - now).num_seconds();
                    let key = format!("{}/{}/{}", e.calendar_id, e.id, e.start);
                    if (0..=NOTIFY_LEAD_SECS).contains(&secs) && !notified.contains(&key) {
                        notified.insert(key);
                        let when = start.format("%-I:%M %p");
                        let body = match &e.conference_url {
                            Some(u) => format!("{when} · click tray to join\n{u}"),
                            None => format!("at {when}"),
                        };
                        info!("notifying: {}", e.summary);
                        let _ = app
                            .notification()
                            .builder()
                            .title(&e.summary)
                            .body(&body)
                            .show();
                    }
                }
                if notified.len() > 256 {
                    notified.clear();
                }

                // menu bar: next event + how soon; dropdown: the next 12 hours
                let evs = tray_events(&db);
                let spans: Vec<_> = evs.iter().map(|(s, e, t, _, _)| (*s, *e, t.clone())).collect();
                let title = bar_title(now, &spans);
                let rows = list_rows(
                    now,
                    &evs.iter().map(|(s, e, t, k, _)| (*s, *e, t.clone(), k.clone())).collect::<Vec<_>>(),
                );
                let join = evs
                    .iter()
                    .filter(|(s, _, _, _, u)| u.is_some() && *s > now - chrono::Duration::minutes(10))
                    .map(|(_, _, _, _, u)| u.clone().unwrap())
                    .next();
                let label = format!("{title:?}|{rows:?}|{join:?}");
                if label != last_tray_label {
                    last_tray_label = label;
                    *TRAY_STATE.lock().unwrap() = (title.clone(), rows.iter().map(|(_, l)| l.clone()).collect());
                    let app2 = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        if let Some(tray) = app2.tray_by_id(TRAY_ID) {
                            let _ = tray.set_title(title.as_deref());
                            if let Ok(menu) = build_menu(&app2, &rows, join.as_deref()) {
                                let _ = tray.set_menu(Some(menu));
                            }
                        }
                    });
                }

                std::thread::sleep(POLL);
            }
        })
        .expect("failed to spawn notify thread");
}

/// what the menu bar currently shows (title, dropdown rows), for the debug
/// hook's checks
pub static TRAY_STATE: std::sync::Mutex<(Option<String>, Vec<String>)> = std::sync::Mutex::new((None, Vec::new()));

fn build_menu(app: &AppHandle, rows: &[(String, String)], join: Option<&str>) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let mut b = MenuBuilder::new(app);
    if rows.is_empty() {
        b = b.item(&MenuItemBuilder::with_id("none", "Nothing in the next 12 hours").enabled(false).build(app)?);
    } else {
        b = b.item(&MenuItemBuilder::with_id("hdr", "Next 12 hours").enabled(false).build(app)?);
        for (id, label) in rows {
            b = b.item(&MenuItemBuilder::with_id(id, label).build(app)?);
        }
    }
    b = b.separator();
    if let Some(url) = join {
        b = b.item(&MenuItemBuilder::with_id(format!("join:{url}"), "Join next meeting").build(app)?);
    }
    b.item(&MenuItemBuilder::with_id("open", "Open North Star").build(app)?)
        .item(&MenuItemBuilder::with_id("sync", "Sync now").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "Quit").build(app)?)
        .build()
}

pub fn register_global_shortcut(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
    let shortcut = Shortcut::new(Some(Modifiers::ALT), Code::KeyC);
    let handle = app.clone();
    let result = app.global_shortcut().on_shortcut(shortcut, move |_app, _sc, event| {
        if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
            if let Some(w) = handle.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
            let _ = handle.emit("quick-create", ());
        }
    });
    if let Err(e) = result {
        warn!("global shortcut ⌥C not registered: {e}");
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(h: u32, m: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 10, 16, h, m, 0).unwrap()
    }

    #[test]
    fn title_shows_next_event_and_how_soon() {
        let evs = vec![(at(10, 30), at(11, 0), "Standup".to_string())];
        assert_eq!(bar_title(at(10, 15), &evs).as_deref(), Some("Standup in 15m"));
        assert_eq!(bar_title(at(8, 0), &evs).as_deref(), Some("Standup in 2h 30m"));
        assert_eq!(bar_title(at(6, 0), &evs).as_deref(), Some("Standup at 10:30 AM"));
        assert_eq!(bar_title(at(11, 0), &evs), None);
    }

    #[test]
    fn title_prefers_current_event_unless_next_is_within_the_hour() {
        let evs = vec![
            (at(9, 0), at(11, 0), "Deep work".to_string()),
            (at(13, 0), at(14, 0), "Lunch talk".to_string()),
        ];
        assert_eq!(bar_title(at(10, 40), &evs).as_deref(), Some("Deep work · 20m left"));
        assert_eq!(bar_title(at(12, 30), &evs).as_deref(), Some("Lunch talk in 30m"));
    }

    #[test]
    fn list_covers_the_next_12_hours_in_order() {
        let evs = vec![
            (at(14, 0), at(15, 0), "B".to_string(), "c/b".to_string()),
            (at(9, 0), at(11, 0), "A".to_string(), "c/a".to_string()),
            (at(23, 30), at(23, 45), "Late".to_string(), "c/late".to_string()),
        ];
        let rows = list_rows(at(10, 0), &evs);
        assert_eq!(rows.len(), 2); // 23:30 is past the 12-hour horizon from 10:00
        assert_eq!(rows[0], ("ev:c/a".to_string(), "now – 11:00 AM    A".to_string()));
        assert_eq!(rows[1], ("ev:c/b".to_string(), "2:00 PM    B".to_string()));
    }

    #[test]
    fn a_copied_original_shows_once_an_uncopied_one_stays() {
        let db = Db::open_in_memory().unwrap();
        let cal = |id: &str, role: &str| sync_core::models::Calendar {
            id: id.into(),
            summary: id.into(),
            color: None,
            is_primary: id == "me",
            hidden: false,
            access_role: role.into(),
        };
        db.upsert_calendar(&cal("me", "owner")).unwrap();
        db.upsert_calendar(&cal("school", "reader")).unwrap();
        let ev = |id: &str, cal: &str, title: &str, h: u32| Event {
            id: id.into(),
            calendar_id: cal.into(),
            etag: None,
            summary: title.into(),
            description: None,
            location: None,
            start: at(h, 0).to_rfc3339(),
            end: at(h + 1, 0).to_rfc3339(),
            all_day: false,
            timezone: None,
            status: "confirmed".into(),
            recurrence: None,
            recurring_event_id: None,
            conference_url: None,
            updated: None,
            raw: None,
        };
        let got = without_copied_originals(
            &db,
            vec![
                ev("lec", "school", "Lecture", 10),
                ev("copy", "me", "Lecture", 10),
                ev("talk", "school", "Seminar", 14),
            ],
        );
        let ids: Vec<&str> = got.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["copy", "talk"]);
    }

    #[test]
    fn nudges_once_an_hour_in_waking_hours_never_at_launch() {
        let at = |d: u32, h: u32, m: u32| Local.with_ymd_and_hms(2026, 10, 17, h, m, 0).unwrap() + chrono::Duration::days(d as i64 - 17);
        let key = |t: DateTime<Local>| t.format("%Y-%m-%d %H").to_string();
        // launched at 9:40: nothing until 10:00
        let launch = at(17, 9, 40);
        assert!(!nudge_due(at(17, 9, 59), &key(launch)));
        assert!(nudge_due(at(17, 10, 0), &key(launch)));
        // once per hour, however many ticks
        assert!(!nudge_due(at(17, 10, 20), &key(at(17, 10, 0))));
        // slept through 11:00 and 12:00, woke at 12:35: one nudge then
        assert!(nudge_due(at(17, 12, 35), &key(at(17, 10, 59))));
        // 23:xx yes, past midnight and before 8 no
        assert!(nudge_due(at(17, 23, 0), &key(at(17, 22, 59))));
        assert!(!nudge_due(at(18, 0, 0), &key(at(17, 23, 59))));
        assert!(!nudge_due(at(18, 7, 0), &key(at(18, 6, 59))));
        assert!(nudge_due(at(18, 8, 0), &key(at(18, 7, 59))));
        assert_eq!(nudge_text(at(17, 17, 0)), "5:00 PM — what are you actually doing? Update the current event.");
    }

    #[test]
    fn until_format() {
        assert_eq!(fmt_until(5), "5m");
        assert_eq!(fmt_until(60), "1h");
        assert_eq!(fmt_until(65), "1h 05m");
    }
}
