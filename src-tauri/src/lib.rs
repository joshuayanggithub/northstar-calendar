mod classify;
mod goals;
mod notes;
mod notify;
pub(crate) mod state;
#[cfg(debug_assertions)]
mod testhook;

use serde::Deserialize;
use state::{AppState, SyncKick};
use sync_core::models::*;
use sync_core::sync::generate_event_id;
use sync_core::google::CalendarApi;
use sync_core::TokenStore;
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::info;

type CmdResult<T> = Result<T, String>;

fn err_str<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
fn auth_status(app_state: State<AppState>) -> bool {
    app_state.tokens.get_refresh_token().is_some()
}

#[tauri::command]
async fn connect_google(app: AppHandle, app_state: State<'_, AppState>) -> CmdResult<bool> {
    let config = app_state.oauth_config.clone();
    let flow = sync_core::oauth::PkceFlow::start(config).map_err(err_str)?;
    let auth_url = flow.auth_url.clone();
    info!("opening browser for OAuth consent");
    tauri_plugin_opener::open_url(&auth_url, None::<&str>).map_err(err_str)?;

    // Block on the loopback redirect off the main thread.
    let tokens = tauri::async_runtime::spawn_blocking(move || flow.wait_for_code())
        .await
        .map_err(err_str)?
        .map_err(err_str)?;

    let refresh = tokens
        .refresh_token
        .clone()
        .ok_or("Google returned no refresh token; remove the app's access at myaccount.google.com/permissions and retry")?;
    app_state.tokens.set_refresh_token(&refresh).map_err(err_str)?;
    app_state.set_access_token(tokens);
    app_state.kick_sync(SyncKick::Now);
    let _ = app.emit("auth-changed", true);
    Ok(true)
}

#[tauri::command]
fn disconnect_google(app: AppHandle, app_state: State<AppState>) -> CmdResult<()> {
    app_state.tokens.clear().map_err(err_str)?;
    app_state.clear_access_token();
    let _ = app.emit("auth-changed", false);
    Ok(())
}

#[tauri::command]
fn sync_now(app_state: State<AppState>) {
    app_state.kick_sync(SyncKick::Now);
}

#[tauri::command]
fn list_calendars(app_state: State<AppState>) -> CmdResult<Vec<Calendar>> {
    app_state.db(|db| db.list_calendars()).map_err(err_str)
}

#[tauri::command]
fn set_calendar_hidden(
    app: AppHandle,
    app_state: State<AppState>,
    calendar_id: String,
    hidden: bool,
) -> CmdResult<()> {
    app_state
        .db(|db| db.set_calendar_hidden(&calendar_id, hidden))
        .map_err(err_str)?;
    let _ = app.emit("db-changed", ());
    Ok(())
}

#[tauri::command]
fn list_events(app_state: State<AppState>, start: String, end: String) -> CmdResult<Vec<Event>> {
    app_state.db(|db| db.list_events_between(&start, &end)).map_err(err_str)
}

#[derive(Deserialize)]
pub struct EventInput {
    pub calendar_id: String,
    pub summary: String,
    pub description: Option<String>,
    pub location: Option<String>,
    /// RFC3339 for timed events, YYYY-MM-DD for all-day.
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub with_meet: Option<bool>,
    /// RRULE lines, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"]
    pub recurrence: Option<Vec<String>>,
    /// attendee emails
    pub attendees: Option<Vec<String>>,
    /// "opaque" (busy) | "transparent" (free)
    pub transparency: Option<String>,
    /// "default" | "public" | "private"
    pub visibility: Option<String>,
    /// popup reminder minutes before start; None = calendar default
    pub reminder_minutes: Option<i64>,
}

fn google_body(id: &str, input: &EventInput) -> serde_json::Value {
    let (start, end) = if input.all_day {
        (
            serde_json::json!({ "date": input.start }),
            serde_json::json!({ "date": input.end }),
        )
    } else {
        (
            serde_json::json!({ "dateTime": input.start }),
            serde_json::json!({ "dateTime": input.end }),
        )
    };
    let mut body = serde_json::json!({
        "id": id,
        "summary": input.summary,
        "start": start,
        "end": end,
    });
    if let Some(d) = &input.description {
        body["description"] = serde_json::json!(d);
    }
    if let Some(l) = &input.location {
        body["location"] = serde_json::json!(l);
    }
    if let Some(r) = &input.recurrence {
        if !r.is_empty() {
            body["recurrence"] = serde_json::json!(r);
            // Google REQUIRES an explicit IANA timeZone on recurring events;
            // RFC3339 offsets alone are rejected with 400.
            if !input.all_day {
                let tz = iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".into());
                body["start"]["timeZone"] = serde_json::json!(tz);
                body["end"]["timeZone"] = serde_json::json!(tz);
            }
        }
    }
    if let Some(att) = &input.attendees {
        body["attendees"] = serde_json::json!(att
            .iter()
            .map(|e| serde_json::json!({ "email": e }))
            .collect::<Vec<_>>());
    }
    if let Some(t) = &input.transparency {
        body["transparency"] = serde_json::json!(t);
    }
    if let Some(v) = &input.visibility {
        if v != "default" {
            body["visibility"] = serde_json::json!(v);
        }
    }
    if let Some(mins) = input.reminder_minutes {
        body["reminders"] = serde_json::json!({
            "useDefault": false,
            "overrides": [{ "method": "popup", "minutes": mins }]
        });
    }
    if input.with_meet == Some(true) {
        body["conferenceData"] = serde_json::json!({
            "createRequest": {
                "requestId": id,
                "conferenceSolutionKey": { "type": "hangoutsMeet" }
            }
        });
    }
    body
}

pub(crate) fn do_create_event(
    app: &AppHandle,
    app_state: &AppState,
    input: EventInput,
) -> CmdResult<String> {
    let id = generate_event_id();
    let body = google_body(&id, &input);
    let event = Event {
        id: id.clone(),
        calendar_id: input.calendar_id.clone(),
        etag: None,
        summary: input.summary.clone(),
        description: input.description.clone(),
        location: input.location.clone(),
        start: input.start.clone(),
        end: input.end.clone(),
        all_day: input.all_day,
        timezone: None,
        status: "confirmed".into(),
        recurrence: None,
        recurring_event_id: None,
        conference_url: None,
        updated: None,
        raw: None,
    };
    app_state
        .db(|db| {
            db.upsert_event(&event)?;
            db.enqueue_op(&input.calendar_id, &id, OpKind::Insert, Some(&body), None)?;
            Ok(())
        })
        .map_err(err_str)?;
    let _ = app.emit("db-changed", ());
    app_state.kick_sync(SyncKick::Now);
    Ok(id)
}

#[tauri::command]
fn create_event(app: AppHandle, app_state: State<AppState>, input: EventInput) -> CmdResult<String> {
    do_create_event(&app, &app_state, input)
}

pub(crate) fn do_update_event(
    app: &AppHandle,
    app_state: &AppState,
    event_id: String,
    input: EventInput,
    prev_calendar_id: Option<String>,
) -> CmdResult<()> {
    let old_cal = prev_calendar_id.unwrap_or_else(|| input.calendar_id.clone());
    let moving = old_cal != input.calendar_id;
    let body = {
        let mut b = google_body(&event_id, &input);
        let obj = b.as_object_mut().unwrap();
        obj.remove("id");
        // PATCH replaces only provided fields, so switching between timed and
        // all-day must explicitly null the other representation or Google
        // rejects/keeps the stale one.
        if input.all_day {
            b["start"]["dateTime"] = serde_json::Value::Null;
            b["end"]["dateTime"] = serde_json::Value::Null;
        } else {
            b["start"]["date"] = serde_json::Value::Null;
            b["end"]["date"] = serde_json::Value::Null;
        }
        b
    };
    app_state
        .db(|db| {
            let Some(mut ev) = db.get_event(&old_cal, &event_id)? else {
                return Err(sync_core::CoreError::Other("event not found".into()));
            };
            let base_etag = ev.etag.clone();
            if moving {
                // Optimistic local move + queued Google move, then the field
                // patch runs against the destination calendar (queue is FIFO).
                db.delete_event(&old_cal, &event_id)?;
                ev.calendar_id = input.calendar_id.clone();
                db.enqueue_op(
                    &old_cal,
                    &event_id,
                    OpKind::Move,
                    Some(&serde_json::json!({ "destination": input.calendar_id })),
                    None,
                )?;
            }
            ev.summary = input.summary.clone();
            ev.description = input.description.clone();
            ev.location = input.location.clone();
            ev.start = input.start.clone();
            ev.end = input.end.clone();
            ev.all_day = input.all_day;
            db.upsert_event(&ev)?;
            db.enqueue_op(
                &input.calendar_id,
                &event_id,
                OpKind::Patch,
                Some(&body),
                // after a move the etag changes; let the patch go unconditional
                if moving { None } else { base_etag.as_deref() },
            )?;
            Ok(())
        })
        .map_err(err_str)?;
    let _ = app.emit("db-changed", ());
    app_state.kick_sync(SyncKick::Now);
    Ok(())
}

#[tauri::command]
fn update_event(
    app: AppHandle,
    app_state: State<AppState>,
    event_id: String,
    input: EventInput,
    prev_calendar_id: Option<String>,
) -> CmdResult<()> {
    do_update_event(&app, &app_state, event_id, input, prev_calendar_id)
}

pub(crate) fn do_delete_event(
    app: &AppHandle,
    app_state: &AppState,
    calendar_id: String,
    event_id: String,
) -> CmdResult<()> {
    app_state
        .db(|db| {
            let base_etag = db.get_event(&calendar_id, &event_id)?.and_then(|e| e.etag);
            db.delete_event(&calendar_id, &event_id)?;
            db.enqueue_op(&calendar_id, &event_id, OpKind::Delete, None, base_etag.as_deref())?;
            Ok(())
        })
        .map_err(err_str)?;
    let _ = app.emit("db-changed", ());
    app_state.kick_sync(SyncKick::Now);
    Ok(())
}

#[tauri::command]
fn delete_event(
    app: AppHandle,
    app_state: State<AppState>,
    calendar_id: String,
    event_id: String,
) -> CmdResult<()> {
    do_delete_event(&app, &app_state, calendar_id, event_id)
}

pub(crate) fn do_add_calendar(
    app: &AppHandle,
    app_state: &AppState,
    name_or_id: String,
    subscribe: bool,
) -> CmdResult<()> {
    let client = app_state.google_client().map_err(err_str)?;
    let v = if subscribe {
        client.subscribe_calendar(&name_or_id).map_err(err_str)?
    } else {
        client.create_calendar(&name_or_id).map_err(err_str)?
    };
    // Make it visible locally right away; full details arrive via next sync.
    let cal = sync_core::models::Calendar {
        id: v["id"].as_str().unwrap_or(&name_or_id).to_string(),
        summary: v["summaryOverride"]
            .as_str()
            .or(v["summary"].as_str())
            .unwrap_or(&name_or_id)
            .to_string(),
        color: v["backgroundColor"].as_str().map(String::from),
        is_primary: false,
        hidden: false,
        access_role: v["accessRole"].as_str().unwrap_or("owner").to_string(),
    };
    app_state.db(|db| db.upsert_calendar(&cal)).map_err(err_str)?;
    let _ = app.emit("db-changed", ());
    app_state.kick_sync(SyncKick::Now);
    Ok(())
}

#[tauri::command]
fn add_calendar(
    app: AppHandle,
    app_state: State<AppState>,
    name_or_id: String,
    subscribe: bool,
) -> CmdResult<()> {
    do_add_calendar(&app, &app_state, name_or_id, subscribe)
}

#[tauri::command]
fn get_series_master(
    app_state: State<AppState>,
    calendar_id: String,
    master_id: String,
) -> CmdResult<serde_json::Value> {
    let client = app_state.google_client().map_err(err_str)?;
    client.get_event(&calendar_id, &master_id).map_err(err_str)
}

#[tauri::command]
fn get_series_instances(
    app_state: State<AppState>,
    calendar_id: String,
    master_id: String,
) -> CmdResult<Vec<serde_json::Value>> {
    let client = app_state.google_client().map_err(err_str)?;
    client.list_series_instances(&calendar_id, &master_id).map_err(err_str)
}

#[tauri::command]
fn update_series_master(
    app: AppHandle,
    app_state: State<AppState>,
    calendar_id: String,
    master_id: String,
    patch: serde_json::Value,
) -> CmdResult<()> {
    let client = app_state.google_client().map_err(err_str)?;
    client
        .patch_event(&calendar_id, &master_id, &patch, None)
        .map_err(err_str)?;
    let _ = app.emit("db-changed", ());
    app_state.kick_sync(SyncKick::Now);
    Ok(())
}

#[tauri::command]
fn move_series_master(
    app: AppHandle,
    app_state: State<AppState>,
    calendar_id: String,
    master_id: String,
    destination_id: String,
) -> CmdResult<()> {
    let client = app_state.google_client().map_err(err_str)?;
    client
        .move_event(&calendar_id, &master_id, &destination_id)
        .map_err(err_str)?;
    let _ = app.emit("db-changed", ());
    app_state.kick_sync(SyncKick::Now);
    Ok(())
}

#[tauri::command]
fn md_read(app: AppHandle, which: String) -> CmdResult<notes::MdFile> {
    notes::read(&app, &which)
}

#[tauri::command]
fn goals_read(app: AppHandle) -> goals::GoalsFile {
    goals::read(&app)
}

#[tauri::command]
fn goals_write(app: AppHandle, file: goals::GoalsFile) -> CmdResult<()> {
    goals::write(&app, &file)
}

#[tauri::command]
fn md_write(
    app: AppHandle,
    which: String,
    content: String,
    expected_mtime_ms: u64,
) -> CmdResult<u64> {
    notes::write(&app, &which, &content, expected_mtime_ms)
}

/// Frontend console/error forwarding so browser-side failures land in the
/// Receives results from test-hook `eval` scripts (debug builds only; the
/// release binary has no hook to read them, so this is inert there).
#[tauri::command]
fn test_report(id: String, value: String) {
    #[cfg(debug_assertions)]
    testhook::eval_results().lock().unwrap().insert(id, value);
    #[cfg(not(debug_assertions))]
    let _ = (id, value);
}

/// same log file as Rust tracing (debuggability without devtools attached).
#[tauri::command]
fn log_frontend(level: String, message: String) {
    match level.as_str() {
        "error" => tracing::error!(target: "frontend", "{message}"),
        "warn" => tracing::warn!(target: "frontend", "{message}"),
        _ => tracing::info!(target: "frontend", "{message}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    {
        let builder = tauri::Builder::default();
        #[cfg(debug_assertions)]
        let builder = builder.plugin(tauri_plugin_webdriver::init());
        builder
    }
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let state = AppState::init(app.handle().clone())?;
            let db_path = state.db_path.clone();
            app.manage(state);
            notify::setup_tray(app.handle())?;
            notify::spawn_scheduler(app.handle().clone(), db_path);
            notify::register_global_shortcut(app.handle());
            notes::spawn_watcher(app.handle().clone());
            #[cfg(debug_assertions)]
            testhook::spawn(app.handle().clone());
            classify::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth_status,
            connect_google,
            disconnect_google,
            sync_now,
            list_calendars,
            set_calendar_hidden,
            list_events,
            create_event,
            update_event,
            delete_event,
            add_calendar,
            get_series_master,
            get_series_instances,
            update_series_master,
            move_series_master,
            md_read,
            md_write,
            goals_read,
            goals_write,
            classify::get_goal_classifications,
            log_frontend,
            test_report,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
