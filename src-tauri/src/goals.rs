//! Goals: daily, weekly and long-term, kept by the app itself (goals.json in
//! the data dir; nothing outside the app is read or written). The frontend
//! owns the shape (src/lib/goals.ts); this side stores it, tells the UI when
//! it changes, and hands the classifier the list of goals.
//!
//! On first run the goals in the old Obsidian note are copied in once (its
//! "Daily" / "Weekly" sections by heading, everything else long-term); the
//! note is never read again after that.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tracing::info;

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
    if let Ok(raw) = std::fs::read_to_string(&p) {
        return serde_json::from_str(&raw).unwrap_or_default();
    }
    let migrated = crate::notes::legacy_goals_md(app).map(|md| from_md(&md)).unwrap_or_default();
    if !migrated.goals.is_empty() {
        info!("goals: copied {} goals from the old notes file", migrated.goals.len());
    }
    let _ = write_file(&p, &migrated);
    migrated
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

/// every goal's text, for the classifier and the supervisor
pub fn texts(app: &AppHandle) -> Vec<String> {
    read(app).goals.into_iter().map(|g| g.text).collect()
}

/// The old markdown outline -> goals: top-level tasks, numbered and bulleted
/// items; the section heading decides daily / weekly / long-term.
fn from_md(md: &str) -> GoalsFile {
    let mut out = GoalsFile::default();
    let mut horizon = "long";
    for line in md.lines() {
        let t = line.trim_end();
        if let Some(h) = t.strip_prefix('#') {
            let h = h.trim_start_matches('#').trim().to_lowercase();
            horizon = if h.starts_with("daily") {
                "daily"
            } else if h.starts_with("weekly") {
                "weekly"
            } else {
                "long"
            };
            continue;
        }
        if t.starts_with(' ') || t.starts_with('\t') {
            continue; // sub-items stay with the note they came from
        }
        let mut done = false;
        let text = if let Some(r) = t.strip_prefix("- [ ] ") {
            Some(r)
        } else if let Some(r) = t.strip_prefix("- [x] ").or_else(|| t.strip_prefix("- [X] ")) {
            done = true;
            Some(r)
        } else if let Some(r) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
            Some(r)
        } else {
            t.split_once(". ")
                .filter(|(n, _)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
                .map(|(_, r)| r)
        };
        let Some(text) = text else { continue };
        let text = text.replace("[[", "").replace("]]", "");
        let text = text.trim();
        if text.is_empty() || out.goals.iter().any(|g| g.text == text) {
            continue;
        }
        let id = format!("g{}", out.goals.len() + 1);
        if done && horizon == "long" {
            out.checks.insert(id.clone(), "done".into());
        }
        out.goals.push(Goal { id, text: text.to_string(), horizon: horizon.to_string() });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_note_becomes_goals_by_section() {
        let f = from_md(
            "# Goals\n\n## Daily\n- [ ] Deep work first\n- [x] No phone\n\n## Weekly\n- [ ] Three runs\n\n## North Star\n1. Publish a paper\n\t1. sub-step\n2. [[Learn Spanish]]\n\nA paragraph.\n",
        );
        let got: Vec<(&str, &str)> = f.goals.iter().map(|g| (g.horizon.as_str(), g.text.as_str())).collect();
        assert_eq!(
            got,
            vec![
                ("daily", "Deep work first"),
                ("daily", "No phone"),
                ("weekly", "Three runs"),
                ("long", "Publish a paper"),
                ("long", "Learn Spanish"),
            ]
        );
        // a daily tick from the old note belongs to a day long gone
        assert!(f.checks.is_empty());
    }
}
