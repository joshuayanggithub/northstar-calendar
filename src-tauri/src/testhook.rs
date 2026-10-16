//! Debug-build-only automation hook: a tiny HTTP listener on 127.0.0.1 that
//! dispatches the same operations the UI invokes, so end-to-end tests (and
//! Claude) can drive the real app without native-window access. Compiled out
//! of release builds entirely; binds loopback only.

use crate::state::{AppState, SyncKick};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

const PORT: u16 = 14211;

/// Results reported back by `webview_eval` scripts via the `test_report`
/// command, keyed by eval id.
pub fn eval_results() -> &'static Mutex<HashMap<String, String>> {
    static RESULTS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    RESULTS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn spawn(app: AppHandle) {
    std::thread::Builder::new()
        .name("testhook".into())
        .spawn(move || {
            let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
                Ok(l) => l,
                Err(e) => {
                    warn!("test hook disabled (bind failed: {e})");
                    return;
                }
            };
            info!("test hook listening on 127.0.0.1:{PORT} (debug builds only)");
            for stream in listener.incoming().flatten() {
                if let Err(e) = handle(stream, &app) {
                    warn!("test hook request failed: {e}");
                }
            }
        })
        .expect("failed to spawn testhook thread");
}

fn handle(mut stream: TcpStream, app: &AppHandle) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let line = line.trim();
        if line.is_empty() {
            break;
        }
        if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = v.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body)?;
    let req: Value = serde_json::from_slice(&body).unwrap_or(json!({}));

    let result = dispatch(app, &req);
    let (status, payload) = match result {
        Ok(v) => ("200 OK", json!({"ok": true, "result": v})),
        Err(e) => ("400 Bad Request", json!({"ok": false, "error": e})),
    };
    let body = payload.to_string();
    stream.write_all(
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    )
}

fn dispatch(app: &AppHandle, req: &Value) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let cmd = req["cmd"].as_str().ok_or("missing cmd")?;
    info!("test hook: {cmd}");
    match cmd {
        "create_event" => {
            let input: crate::EventInput =
                serde_json::from_value(req["input"].clone()).map_err(|e| e.to_string())?;
            let id = crate::do_create_event(app, &state, input)?;
            Ok(json!({"id": id}))
        }
        "update_event" => {
            let event_id = req["event_id"].as_str().ok_or("missing event_id")?.to_string();
            let input: crate::EventInput =
                serde_json::from_value(req["input"].clone()).map_err(|e| e.to_string())?;
            let prev = req["prev_calendar_id"].as_str().map(String::from);
            crate::do_update_event(app, &state, event_id, input, prev)?;
            Ok(json!({}))
        }
        "delete_event" => {
            let calendar_id = req["calendar_id"].as_str().ok_or("missing calendar_id")?;
            let event_id = req["event_id"].as_str().ok_or("missing event_id")?;
            crate::do_delete_event(app, &state, calendar_id.into(), event_id.into())?;
            Ok(json!({}))
        }
        "list_events" => {
            let start = req["start"].as_str().ok_or("missing start")?;
            let end = req["end"].as_str().ok_or("missing end")?;
            let events = state
                .db(|db| db.list_events_between(start, end))
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(events).map_err(|e| e.to_string())?)
        }
        "list_calendars" => {
            let cals = state.db(|db| db.list_calendars()).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(cals).map_err(|e| e.to_string())?)
        }
        "pending_ops" => {
            let ops = state.db(|db| db.list_pending_ops()).map_err(|e| e.to_string())?;
            Ok(json!({"count": ops.len()}))
        }
        "add_calendar" => {
            let name_or_id = req["name_or_id"].as_str().ok_or("missing name_or_id")?.to_string();
            let subscribe = req["subscribe"].as_bool().unwrap_or(false);
            crate::do_add_calendar(app, &state, name_or_id, subscribe)?;
            Ok(json!({}))
        }
        "sync_now" => {
            state.kick_sync(SyncKick::Now);
            let _ = app.emit("db-changed", ());
            Ok(json!({}))
        }
        // Evaluate JS inside the REAL WKWebView and collect the result: the
        // one window into actual webview DOM/geometry macOS gives us, since
        // WKWebView has no WebDriver/CDP endpoint for external drivers.
        // The script body may use `return` and `await`.
        "eval" => {
            let script = req["script"].as_str().ok_or("missing script")?;
            let id = format!("ev{}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
            let window = app
                .get_webview_window("main")
                .ok_or("no main window")?;
            let wrapped = format!(
                r#"(async () => {{
                    let payload;
                    try {{
                        const value = await (async () => {{ {script} }})();
                        payload = JSON.stringify(value === undefined ? null : value);
                    }} catch (e) {{
                        payload = JSON.stringify({{ __eval_error: String(e && e.stack || e) }});
                    }}
                    window.__TAURI_INTERNALS__.invoke('test_report', {{ id: '{id}', value: payload }});
                }})();"#
            );
            window.eval(&wrapped).map_err(|e| e.to_string())?;
            // wait for the webview to report back (a window behind others
            // is throttled by WebKit, so allow well beyond a normal frame)
            for _ in 0..800 {
                if let Some(v) = eval_results().lock().unwrap().remove(&id) {
                    let parsed: Value = serde_json::from_str(&v).unwrap_or(Value::Null);
                    if parsed.get("__eval_error").is_some() {
                        return Err(parsed["__eval_error"].as_str().unwrap_or("eval error").to_string());
                    }
                    return Ok(parsed);
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err("eval timed out after 20s (is the window alive?)".into())
        }
        // Screenshot of the real window via /usr/sbin/screencapture (needs the
        // user to have granted Screen Recording to the app once).
        "screenshot" => {
            let path = req["path"].as_str().unwrap_or("/tmp/claude/app-window.png");
            let out = std::process::Command::new("screencapture")
                .args(["-x", "-o", path])
                .output()
                .map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).to_string());
            }
            Ok(json!({"path": path}))
        }
        // what the menu bar item shows: its title and dropdown rows
        "tray_state" => {
            let (title, rows) = crate::notify::TRAY_STATE.lock().unwrap().clone();
            Ok(json!({ "title": title, "rows": rows }))
        }
        other => Err(format!("unknown cmd: {other}")),
    }
}
