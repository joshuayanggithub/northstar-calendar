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

/// One line of the thought dump: something to think about, kept with the
/// goals but never ticked or classified.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Thought {
    pub id: String,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct GoalsFile {
    pub goals: Vec<Goal>,
    /// goal id -> the period it was ticked in (a day, a week, or "done")
    #[serde(default)]
    pub checks: HashMap<String, String>,
    /// the thought dump (a file written before it existed reads as empty)
    #[serde(default)]
    pub thoughts: Vec<Thought>,
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    crate::state::data_dir(app).ok().map(|d| d.join("goals.json"))
}

pub fn read(app: &AppHandle) -> GoalsFile {
    let Some(p) = path(app) else { return GoalsFile::default() };
    read_file(&p)
}

/// An unreadable file (a hand edit, a sync tool's merge) is set aside as
/// goals.json.corrupt-<time> rather than read as empty: the next edit then
/// wrote an empty file over ten goals with no copy kept.
fn read_file(p: &PathBuf) -> GoalsFile {
    let Ok(raw) = std::fs::read_to_string(p) else { return GoalsFile::default() };
    match serde_json::from_str(&raw) {
        Ok(f) => f,
        Err(e) => {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let aside = p.with_extension(format!("json.corrupt-{stamp}"));
            tracing::warn!("goals.json doesn't parse ({e}); kept as {}", aside.display());
            let _ = std::fs::rename(p, &aside);
            GoalsFile::default()
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_goals_file_from_before_the_thought_dump_still_reads() {
        let old = r#"{"goals":[{"id":"g1","text":"Ship it","horizon":"daily"}],"checks":{}}"#;
        let f: GoalsFile = serde_json::from_str(old).unwrap();
        assert_eq!(f.goals.len(), 1);
        assert!(f.thoughts.is_empty());
    }

    #[test]
    fn a_goals_json_that_does_not_parse_is_not_overwritten_by_the_next_edit() {
        let dir = std::env::temp_dir().join(format!("northstar-goals-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("goals.json");
        // ten goals, one trailing comma (a hand edit, a sync tool's merge)
        let goals: Vec<String> = (1..=10).map(|i| format!(r#"{{"id":"g{i}","text":"Goal {i}","horizon":"long"}}"#)).collect();
        let raw = format!(r#"{{"goals":[{}],"checks":{{}},"thoughts":[],}}"#, goals.join(","));
        std::fs::write(&p, &raw).unwrap();
        let f = read_file(&p);
        assert!(f.goals.is_empty(), "an unreadable file reads as empty");
        // the person adds one thought in the now-empty sidebar
        let mut next = f.clone();
        next.thoughts.push(Thought { id: "t1".into(), text: "hm".into() });
        write_file(&p, &next).unwrap();
        let kept = dir
            .read_dir()
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with("goals.json.corrupt-") && std::fs::read_to_string(e.path()).unwrap().contains("Goal 10"));
        assert!(kept, "the ten goals are gone and no copy of the unreadable file was kept");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn thoughts_survive_a_round_trip() {
        let f = GoalsFile {
            thoughts: vec![Thought { id: "t1".into(), text: "which project should come next?".into() }],
            ..Default::default()
        };
        let back: GoalsFile = serde_json::from_str(&serde_json::to_string(&f).unwrap()).unwrap();
        assert_eq!(back, f);
    }
}
