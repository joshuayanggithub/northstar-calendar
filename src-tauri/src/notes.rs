//! Obsidian markdown bridge (two-way, surgical) for the journal.
//!
//! The vault file remains the source of truth: we read it, watch its mtime,
//! and write back only through compare-and-swap (expected mtime), so edits
//! made in Obsidian are never clobbered. Only the configured file is
//! reachable; the frontend addresses it as "journal", never by path.
//! (Goals live in the app now, goals.rs; the old goals note is read once to
//! copy them over.)

use serde::Serialize;
use std::path::PathBuf;
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tracing::{info, warn};

/// relative to the home folder
const DEFAULT_GOALS: &str = "Documents/Obsidian Vault/!!Goals and Careers.md";
const DEFAULT_JOURNAL: &str = "Documents/Obsidian Vault/!!Journal.md";

#[derive(Serialize, Clone)]
pub struct MdFile {
    pub content: String,
    pub mtime_ms: u64,
    pub exists: bool,
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    crate::state::data_dir(app).ok().map(|d| d.join("notes-paths.json"))
}

pub fn path_for(app: &AppHandle, which: &str) -> Result<PathBuf, String> {
    match which {
        "journal" => configured(app, "journal", DEFAULT_JOURNAL),
        _ => Err("unknown notes file".into()),
    }
}

/// The old goals note, for goals.rs to copy from once.
pub fn legacy_goals_md(app: &AppHandle) -> Option<String> {
    std::fs::read_to_string(configured(app, "goals", DEFAULT_GOALS).ok()?).ok()
}

fn configured(app: &AppHandle, key: &str, default: &str) -> Result<PathBuf, String> {
    if let Some(sp) = settings_path(app) {
        if let Ok(raw) = std::fs::read_to_string(sp) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(p) = v[key].as_str() {
                    return Ok(PathBuf::from(p));
                }
            }
        }
    }
    let home = std::env::var("HOME").map_err(|_| "no home folder")?;
    Ok(PathBuf::from(home).join(default))
}

fn mtime_ms(path: &PathBuf) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn read(app: &AppHandle, which: &str) -> Result<MdFile, String> {
    let path = path_for(app, which)?;
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(MdFile { content, mtime_ms: mtime_ms(&path), exists: true }),
        Err(_) => Ok(MdFile { content: String::new(), mtime_ms: 0, exists: false }),
    }
}

/// Compare-and-swap write: refuses if the file changed since `expected_mtime_ms`.
pub fn write(
    app: &AppHandle,
    which: &str,
    content: &str,
    expected_mtime_ms: u64,
) -> Result<u64, String> {
    let path = path_for(app, which)?;
    let current = mtime_ms(&path);
    if current != 0 && expected_mtime_ms != 0 && current != expected_mtime_ms {
        return Err("conflict: the file changed on disk (edited in Obsidian?)".into());
    }
    std::fs::write(&path, content).map_err(|e| format!("write failed: {e}"))?;
    info!("notes: wrote {} ({} bytes)", which, content.len());
    Ok(mtime_ms(&path))
}

/// Poll the journal and notify the UI when Obsidian (or anything) edits it.
pub fn spawn_watcher(app: AppHandle) {
    std::thread::Builder::new()
        .name("notes-watch".into())
        .spawn(move || {
            let mut last: [(String, u64); 1] = [("journal".into(), 0)];
            loop {
                for (which, prev) in last.iter_mut() {
                    if let Ok(path) = path_for(&app, which) {
                        let m = mtime_ms(&path);
                        if m != *prev {
                            if *prev != 0 {
                                let _ = app.emit("md-changed", which.clone());
                            }
                            *prev = m;
                        }
                    }
                }
                std::thread::sleep(Duration::from_secs(3));
            }
        })
        .map_err(|e| warn!("notes watcher failed to start: {e}"))
        .ok();
}
