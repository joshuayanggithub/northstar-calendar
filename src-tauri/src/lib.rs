mod classify;
mod goals;
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CountSeriesSplit {
    original_recurrence: String,
    selected_original_start: serde_json::Value,
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
        // Every caller sends the event's current description and location
        // (the editor's fields, or the snapshot for moves), so None means
        // "cleared". Leaving the key out of a PATCH keeps Google's old text,
        // which the push response then wrote back over the local edit: an
        // erased note (or location) reappeared a few seconds later.
        if input.description.is_none() {
            b["description"] = serde_json::Value::Null;
        }
        if input.location.is_none() {
            b["location"] = serde_json::Value::Null;
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

/// Set (None clears) the red-pen note on one event, or one occurrence of a
/// recurring one, keeping the rest of its description. The new description
/// is built from the STORED one inside the db lock and only `description` is
/// patched, so an editor holding an older snapshot can neither resurrect an
/// erased note nor write stale titles/times back. Returns the note it
/// replaced, for undo.
pub(crate) fn do_set_event_note(
    app: &AppHandle,
    app_state: &AppState,
    calendar_id: String,
    event_id: String,
    note: Option<String>,
) -> CmdResult<Option<String>> {
    // one [DRILL] line: a pasted newline would split the note off the marker
    let note = note
        .map(|n| n.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|n| !n.is_empty());
    let (changed, previous) = app_state
        .db(|db| {
            let Some(mut ev) = db.get_event(&calendar_id, &event_id)? else {
                return Err(sync_core::CoreError::Other("event not found".into()));
            };
            let previous = classify::drill_line(ev.description.as_deref());
            let body = classify::strip_drill(ev.description.as_deref().unwrap_or(""));
            let next = match &note {
                Some(n) if body.is_empty() => format!("{} {n}", classify::DRILL_MARK),
                Some(n) => format!("{body}\n\n{} {n}", classify::DRILL_MARK),
                None => body,
            };
            let next = (!next.is_empty()).then_some(next);
            if next == ev.description {
                return Ok((false, previous));
            }
            let base_etag = ev.etag.clone();
            ev.description = next.clone();
            db.upsert_event(&ev)?;
            db.enqueue_op(
                &calendar_id,
                &event_id,
                OpKind::Patch,
                Some(&serde_json::json!({ "description": next })),
                base_etag.as_deref(),
            )?;
            Ok((true, previous))
        })
        .map_err(err_str)?;
    if changed {
        let _ = app.emit("db-changed", ());
        app_state.kick_sync(SyncKick::Now);
    }
    Ok(previous)
}

#[tauri::command]
fn set_event_note(
    app: AppHandle,
    app_state: State<AppState>,
    calendar_id: String,
    event_id: String,
    note: Option<String>,
) -> CmdResult<Option<String>> {
    do_set_event_note(&app, &app_state, calendar_id, event_id, note)
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
            // Deleting a recurring master: only its expanded instances live
            // locally, so take them off screen now. Waiting for the pull that
            // reports them cancelled kept the series up for a full sync pass.
            for inst in db.list_series_instances(&calendar_id, &event_id)? {
                db.delete_event(&calendar_id, &inst.id)?;
            }
            db.enqueue_op(&calendar_id, &event_id, OpKind::Delete, None, base_etag.as_deref())?;
            Ok(())
        })
        .map_err(err_str)?;
    let _ = app.emit("db-changed", ());
    app_state.kick_sync(SyncKick::Calendars(vec![calendar_id]));
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

/// Run Google round trips off the main thread. A plain (non-async) Tauri
/// command runs ON the main thread, so each blocking HTTP call in one froze
/// the whole window (scrolling, typing, the scope dialog) for as long as the
/// request took, and a recurring edit made two to four of them in a row.
async fn off_main<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&AppHandle, &AppState) -> CmdResult<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        f(&app, &state)
    })
    .await
    .map_err(err_str)?
}

/// Mirror a series-master change onto the local instances right away, so the
/// screen shows the result instead of the old series until a sync pass pulls
/// Google's regenerated instances (which replace these rows in one step).
fn apply_series_locally(
    db: &sync_core::db::Db,
    calendar_id: &str,
    master_id: &str,
    patch: &serde_json::Value,
    destination: Option<&str>,
    previous_start: Option<&str>,
) -> sync_core::Result<()> {
    sync_core::series::apply_locally(db, calendar_id, master_id, patch, destination, previous_start)
}

fn restore_series_locally(
    db: &sync_core::db::Db,
    calendar_id: &str,
    master_id: &str,
    destination: Option<&str>,
    previous: &[Event],
) -> sync_core::Result<()> {
    sync_core::series::restore_locally(db, calendar_id, master_id, destination, previous)
}

#[tauri::command]
async fn get_series_master(
    app: AppHandle,
    calendar_id: String,
    master_id: String,
) -> CmdResult<serde_json::Value> {
    off_main(app, move |_, st| {
        st.google_client().map_err(err_str)?.get_event(&calendar_id, &master_id).map_err(err_str)
    })
    .await
}

#[tauri::command]
async fn get_series_instances(
    app: AppHandle,
    calendar_id: String,
    master_id: String,
) -> CmdResult<Vec<serde_json::Value>> {
    off_main(app, move |_, st| {
        st.google_client()
            .map_err(err_str)?
            .list_series_instances(&calendar_id, &master_id)
            .map_err(err_str)
    })
    .await
}

/// Patch a recurring master and/or move it to another calendar, as ONE step:
/// both Google calls run under the sync gate, so no pass can pull the series
/// with the patch applied but the move not yet (instances gone from the old
/// calendar, not yet in the new one).
#[tauri::command]
async fn update_series_master(
    app: AppHandle,
    calendar_id: String,
    master_id: String,
    patch: serde_json::Value,
    destination_id: Option<String>,
    previous_start: Option<String>,
) -> CmdResult<()> {
    off_main(app, move |app, st| {
        let destination = destination_id.filter(|d| *d != calendar_id);
        let _gate = st.sync_gate.lock().unwrap_or_else(|p| p.into_inner());
        let previous = st
            .db(|db| db.list_series_instances(&calendar_id, &master_id))
            .map_err(err_str)?;
        st.db(|db| {
            db.in_transaction(|| {
                apply_series_locally(
                    db,
                    &calendar_id,
                    &master_id,
                    &patch,
                    destination.as_deref(),
                    previous_start.as_deref(),
                )
            })
        })
        .map_err(err_str)?;
        // Publish the locally-applied series before doing any network I/O.
        // Google can take seconds to PATCH a master; that latency must not
        // delay the visible change.
        let _ = app.emit("db-changed", ());

        let remote = (|| -> CmdResult<()> {
            let client = st.google_client().map_err(err_str)?;
            if patch.as_object().map_or(false, |o| !o.is_empty()) {
                client.patch_event(&calendar_id, &master_id, &patch, None).map_err(err_str)?;
            }
            if let Some(dest) = &destination {
                client.move_event(&calendar_id, &master_id, dest).map_err(err_str)?;
            }
            Ok(())
        })();
        if let Err(error) = remote {
            let rollback = st.db(|db| {
                db.in_transaction(|| {
                    restore_series_locally(
                        db,
                        &calendar_id,
                        &master_id,
                        destination.as_deref(),
                        &previous,
                    )
                })
            });
            if let Err(rollback_error) = rollback {
                tracing::error!("series optimistic rollback failed: {rollback_error}");
            }
            let _ = app.emit("db-changed", ());
            return Err(error);
        }
        st.kick_sync(SyncKick::Calendars([Some(calendar_id), destination].into_iter().flatten().collect()));
        Ok(())
    })
    .await
}

#[tauri::command]
async fn move_series_master(
    app: AppHandle,
    calendar_id: String,
    master_id: String,
    destination_id: String,
) -> CmdResult<()> {
    update_series_master(app, calendar_id, master_id, serde_json::json!({}), Some(destination_id), None).await
}

/// "This and following": end the old series before this occurrence and start
/// a new one here, as ONE step. Done as two separate calls, the sync pass
/// kicked by the first pulled the old series' cancelled tail before the new
/// series existed, so the rest of the series vanished from view until the
/// next pass brought it back. The truncate goes to Google under the sync
/// gate. Locally truncate the old rows and show a placeholder for the new
/// series first; only queue its insert after Google's truncate succeeds, so
/// a sync pass cannot publish the new master while the old one still includes
/// the same occurrences. Returns the new series' id.
#[tauri::command]
async fn split_series(
    app: AppHandle,
    calendar_id: String,
    master_id: String,
    recurrence: Vec<String>,
    input: EventInput,
    count_split: Option<CountSeriesSplit>,
) -> CmdResult<String> {
    off_main(app, move |app, st| {
        let patch = serde_json::json!({ "recurrence": recurrence });
        let _gate = st.sync_gate.lock().unwrap_or_else(|p| p.into_inner());
        let target = input.calendar_id.clone();
        let previous = st
            .db(|db| db.list_series_instances(&calendar_id, &master_id))
            .map_err(err_str)?;
        let id = generate_event_id();
        let placeholder = Event {
            id: id.clone(),
            calendar_id: target.clone(),
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
        st.db(|db| {
            db.in_transaction(|| {
                apply_series_locally(db, &calendar_id, &master_id, &patch, None, None)?;
                db.upsert_event(&placeholder)
            })
        })
        .map_err(err_str)?;
        let _ = app.emit("db-changed", ());

        // The calendar now shows both halves of the split. Only after the
        // remote truncate succeeds do we queue the new master for insertion;
        // otherwise a sync pass could publish it while the old master still
        // includes the same occurrences.
        let mut input = input;
        let body = st.google_client().map_err(err_str).and_then(|client| {
            if let Some(count_split) = count_split {
                let instances = client
                    .list_series_instances(&calendar_id, &master_id)
                    .map_err(err_str)?;
                let rule = sync_core::series::count_split_recurrence(
                    &count_split.original_recurrence,
                    &count_split.selected_original_start,
                    &instances,
                )
                .map_err(err_str)?;
                input.recurrence = Some(vec![rule]);
            }
            let body = google_body(&id, &input);
            client.patch_event(&calendar_id, &master_id, &patch, None).map_err(err_str)?;
            Ok(body)
        });
        let body = match body {
            Ok(body) => body,
            Err(error) => {
                let rollback = st.db(|db| {
                    db.in_transaction(|| {
                        sync_core::series::restore_locally(
                            db,
                            &calendar_id,
                            &master_id,
                            None,
                            &previous,
                        )?;
                        db.delete_event(&target, &id)?;
                        db.remove_ops_for_event(&target, &id)
                    })
                });
                if let Err(rollback_error) = rollback {
                    tracing::error!("series split rollback failed: {rollback_error}");
                }
                let _ = app.emit("db-changed", ());
                return Err(error);
            }
        };
        st.db(|db| db.enqueue_op(&target, &id, OpKind::Insert, Some(&body), None))
            .map_err(err_str)?;
        let _ = app.emit("db-changed", ());
        st.kick_sync(SyncKick::Calendars(if target == calendar_id { vec![target] } else { vec![calendar_id, target] }));
        Ok(id)
    })
    .await
}

#[tauri::command]
fn goals_read(app: AppHandle) -> goals::GoalsFile {
    goals::read(&app)
}

#[tauri::command]
fn goals_write(app: AppHandle, file: goals::GoalsFile) -> CmdResult<()> {
    goals::write(&app, &file)
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
            set_event_note,
            delete_event,
            add_calendar,
            get_series_master,
            get_series_instances,
            update_series_master,
            move_series_master,
            split_series,
            goals_read,
            goals_write,
            classify::get_goal_classifications,
            log_frontend,
            test_report,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod series_tests {
    use super::*;
    use serde_json::json;
    use sync_core::db::Db;

    fn instance(id: &str, start: &str) -> Event {
        Event {
            id: id.into(),
            calendar_id: "cal".into(),
            etag: Some("\"e\"".into()),
            summary: "Standup".into(),
            description: Some("[DRILL] occurrence note".into()),
            location: None,
            start: start.into(),
            end: start.replace("T09", "T10"),
            all_day: false,
            timezone: None,
            status: "confirmed".into(),
            recurrence: None,
            recurring_event_id: Some("m".into()),
            conference_url: None,
            updated: None,
            raw: Some(json!({ "originalStartTime": { "dateTime": start } })),
        }
    }

    fn series() -> Db {
        let db = Db::open_in_memory().unwrap();
        for (id, start) in [
            ("m_1", "2026-10-12T09:00:00-07:00"),
            ("m_2", "2026-10-13T09:00:00-07:00"),
            ("m_3", "2026-10-14T09:00:00-07:00"),
        ] {
            db.upsert_event(&instance(id, start)).unwrap();
        }
        db
    }

    fn ids(db: &Db, cal: &str) -> Vec<String> {
        let mut v: Vec<_> = db.list_series_instances(cal, "m").unwrap().into_iter().map(|e| e.id).collect();
        v.sort();
        v
    }

    #[test]
    fn truncating_a_series_drops_the_tail_locally_at_once() {
        // "this and following" from the 13th: UNTIL is one second before it
        let db = series();
        let patch = json!({ "recurrence": ["RRULE:FREQ=DAILY;UNTIL=20261013T155959Z"] });
        apply_series_locally(&db, "cal", "m", &patch, None, None).unwrap();
        assert_eq!(ids(&db, "cal"), vec!["m_1"]);
    }

    #[test]
    fn a_series_move_and_rename_show_before_any_sync() {
        let db = series();
        apply_series_locally(&db, "cal", "m", &json!({ "summary": "Daily sync" }), Some("work"), None).unwrap();
        assert!(ids(&db, "cal").is_empty(), "instances left behind in the old calendar");
        let moved = db.list_series_instances("work", "m").unwrap();
        assert_eq!(moved.len(), 3);
        assert!(moved.iter().all(|e| e.summary == "Daily sync"));
        // fields the patch doesn't name are left alone (the occurrence's note)
        assert!(moved.iter().all(|e| e.description.as_deref() == Some("[DRILL] occurrence note")));
    }

    #[test]
    fn series_time_changes_are_visible_locally_before_google_sync() {
        use chrono::{Duration, Timelike};

        let db = series();
        let local = |value: &str| {
            chrono::DateTime::parse_from_rfc3339(value)
                .unwrap()
                .with_timezone(&chrono::Local)
        };
        let before = local("2026-10-13T09:00:00-07:00");
        let patch = json!({
            "start": { "dateTime": "2026-10-12T11:00:00-07:00", "timeZone": "America/Los_Angeles" },
            "end": { "dateTime": "2026-10-12T12:30:00-07:00", "timeZone": "America/Los_Angeles" },
            "transparency": "transparent",
            "visibility": "private",
            "reminders": { "useDefault": false, "overrides": [{ "method": "popup", "minutes": 15 }] },
        });
        apply_series_locally(
            &db,
            "cal",
            "m",
            &patch,
            None,
            Some("2026-10-12T09:00:00-07:00"),
        )
        .unwrap();

        let second = db.get_event("cal", "m_2").unwrap().unwrap();
        let after = local(&second.start);
        let after_end = local(&second.end);
        assert_eq!(after.naive_local(), before.naive_local() + Duration::hours(2));
        assert_eq!(after.hour(), 11);
        assert_eq!(after_end.naive_local() - after.naive_local(), Duration::minutes(90));
        let raw = second.raw.unwrap();
        assert_eq!(raw["transparency"], "transparent");
        assert_eq!(raw["visibility"], "private");
        assert_eq!(raw["reminders"]["overrides"][0]["minutes"], 15);
    }

    #[test]
    fn all_day_series_time_shift_changes_dates_locally() {
        let db = series();
        let patch = json!({
            "start": { "date": "2026-10-14" },
            "end": { "date": "2026-10-15" },
        });
        apply_series_locally(
            &db,
            "cal",
            "m",
            &patch,
            None,
            Some("2026-10-12T09:00:00-07:00"),
        )
        .unwrap();
        let second = db.get_event("cal", "m_2").unwrap().unwrap();
        assert!(second.all_day);
        assert_eq!(second.start, "2026-10-15");
        assert_eq!(second.end, "2026-10-16");
    }
}
