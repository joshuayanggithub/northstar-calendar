//! Goals: daily, weekly and long-term, kept by the app itself (goals.json in
//! the data dir; nothing outside the app is read or written). The frontend
//! owns the shape (src/lib/goals.ts); this side stores it, tells the UI when
//! it changes, and hands the classifier the list of goals.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Goal {
    pub id: String,
    pub text: String,
    /// "daily" | "weekly" | "long"
    pub horizon: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct GoalsFile {
    pub goals: Vec<Goal>,
    /// goal id -> the period it was ticked in (a day, a week, or "done")
    #[serde(default)]
    pub checks: HashMap<String, String>,
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    crate::state::data_dir(app).ok().map(|d| d.join("goals.json"))
}

pub fn read(app: &AppHandle) -> GoalsFile {
    let Some(p) = path(app) else { return GoalsFile::default() };
    std::fs::read_to_string(&p).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

fn write_file(p: &PathBuf, f: &GoalsFile) -> Result<(), String> {
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(f).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, p).map_err(|e| e.to_string())
}

pub fn write(app: &AppHandle, f: &GoalsFile) -> Result<(), String> {
    let p = path(app).ok_or("no data dir")?;
    write_file(&p, f)?;
    let _ = app.emit("goals-changed", ());
    Ok(())
}

/// every goal's text, for the classifier
pub fn texts(app: &AppHandle) -> Vec<String> {
    read(app).goals.into_iter().map(|g| g.text).collect()
}
