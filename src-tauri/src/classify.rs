//! Background goal-work classification against the LOCAL Ollama server.
//! Design: design/goal-classifier.md. The model suggests (hollow star in the
//! UI); the user ratifies. Titles never leave the machine; results cache by
//! (title, goals-file) hash so edits re-classify and nothing runs twice.

use crate::state::AppState;
use chrono::{Duration as CDuration, Local};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

const OLLAMA: &str = "http://127.0.0.1:11434";
const BATCH_PER_TICK: usize = 4;
const TICK_SECS: u64 = 45;
/// bulk-friendly models first; gemma3:12b is accurate but 6-11s/title
const MODEL_PREFERENCE: [&str; 4] = ["qwen2.5:0.5b", "llama3.2:1b", "llama3.2:3b", "gemma3:12b"];
/// marks a note line inside a description (notes are the person's own; the
/// drill-sergeant supervisor that used to write them is gone)
pub const DRILL_MARK: &str = "[DRILL]";
/// salted into goals_hash so prompt changes re-classify cached titles
const PROMPT_VERSION: &str = "v3";

#[derive(Clone, Serialize, Deserialize)]
pub struct GoalClass {
    pub goal: Option<String>,
    pub confidence: String,
    pub title_hash: u64,
    pub goals_hash: u64,
}

static CACHE: Mutex<Option<HashMap<String, GoalClass>>> = Mutex::new(None);

fn hash_of(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

fn cache_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    crate::state::data_dir(app).ok().map(|d| d.join("goal-class.json"))
}

fn load_cache(app: &AppHandle) -> HashMap<String, GoalClass> {
    let mut guard = CACHE.lock().unwrap();
    if let Some(c) = guard.as_ref() {
        return c.clone();
    }
    let c: HashMap<String, GoalClass> = cache_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    *guard = Some(c.clone());
    c
}

fn save_cache(app: &AppHandle, cache: &HashMap<String, GoalClass>) {
    *CACHE.lock().unwrap() = Some(cache.clone());
    if let Some(p) = cache_path(app) {
        let _ = std::fs::create_dir_all(p.parent().unwrap());
        let _ = std::fs::write(p, serde_json::to_string(cache).unwrap_or_default());
    }
}

fn pick_model(agent: &ureq::Agent) -> Option<String> {
    let tags: serde_json::Value = agent
        .get(&format!("{OLLAMA}/api/tags"))
        .timeout(Duration::from_secs(2))
        .call()
        .ok()?
        .into_json()
        .ok()?;
    let names: Vec<String> = tags["models"]
        .as_array()?
        .iter()
        .filter_map(|m| m["name"].as_str().map(String::from))
        .collect();
    for pref in MODEL_PREFERENCE {
        if let Some(n) = names.iter().find(|n| n.starts_with(pref)) {
            return Some(n.clone());
        }
    }
    names.first().cloned()
}

/// Titles that are never goal work, settled without asking the model:
/// sleep, meals, hygiene, exercise, chores, inbox, entertainment, and
/// anything the person already marked as a distraction.
fn never_goal_work(title: &str) -> bool {
    let t = title.to_lowercase();
    if ["asleep", "sleep", "in bed", "nap", "distraction"].iter().any(|s| t.starts_with(s)) {
        return true;
    }
    const NEVER: [&str; 34] = [
        "breakfast", "lunch", "dinner", "dinners", "meal", "meals", "snack", "shower", "bath",
        "groceries", "grocery", "laundry", "chore", "chores", "commute", "gym", "workout",
        "exercise", "stretching", "soccer", "walk", "errand", "errands", "email", "emails",
        "inbox", "linkedin", "bills", "haircut", "tiktok", "youtube", "twitch", "reddit", "shopping",
    ];
    t.split(|c: char| !c.is_alphanumeric())
        .any(|w| NEVER.contains(&w))
}

/// the goals hash that current classifications carry (prompt version salted
/// in, so a stricter prompt retires every older verdict)
fn current_goals_hash(app: &AppHandle) -> Option<(Vec<String>, u64)> {
    let goals = crate::goals::texts(app);
    if goals.is_empty() {
        return None;
    }
    let h = hash_of(&format!("{PROMPT_VERSION}\n{}", goals.join("\n")));
    Some((goals, h))
}

fn classify_one(
    agent: &ureq::Agent,
    model: &str,
    goals: &[String],
    title: &str,
) -> Option<(Option<String>, String)> {
    let goal_list = goals
        .iter()
        .enumerate()
        .map(|(i, g)| format!("{}. {}", i + 1, g))
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = format!(
        "You decide whether ONE calendar event is focused goal work for a person. Goals:\n{goal_list}\n\n\
         Event title: \"{title}\"\n\n\
         Be very conservative: most events are NOT goal work. Give a goal number ONLY if the \
         title clearly names deliberate, focused work that directly produces progress on that \
         goal, e.g. reading or studying a specific paper or lecture, doing coursework, writing, \
         coding or building toward it. Everything else is null: attending talks, seminars, \
         defenses or meetings; applications, job search, networking, email, scheduling, admin \
         and logistics; meals, chores, hygiene, exercise, sleep, leisure and entertainment; \
         anything marked as a distraction. If in doubt, null.\n\
         Reply with ONLY compact JSON: {{\"goal\": <goal number or null>, \
         \"confidence\": <\"high\"|\"low\">}}."
    );
    let resp: serde_json::Value = agent
        .post(&format!("{OLLAMA}/api/generate"))
        .timeout(Duration::from_secs(90))
        .send_json(serde_json::json!({
            "model": model,
            "prompt": prompt,
            "stream": false,
            "format": "json",
            "options": {"temperature": 0, "num_predict": 40}
        }))
        .ok()?
        .into_json()
        .ok()?;
    let parsed: serde_json::Value = serde_json::from_str(resp["response"].as_str()?).ok()?;
    let conf = parsed["confidence"].as_str().unwrap_or("low").to_string();
    let goal = parsed["goal"]
        .as_u64()
        .and_then(|n| goals.get((n as usize).saturating_sub(1)))
        .cloned();
    Some((goal, conf))
}

fn run_once(app: &AppHandle) {
    let agent = ureq::agent();
    // silently idle when Ollama isn't running
    if agent
        .get(&format!("{OLLAMA}/api/version"))
        .timeout(Duration::from_secs(1))
        .call()
        .is_err()
    {
        return;
    }
    let Some((goals, goals_hash)) = current_goals_hash(app) else { return };

    let start = (Local::now() - CDuration::days(3)).format("%Y-%m-%dT00:00:00").to_string();
    let end = (Local::now() + CDuration::days(7)).format("%Y-%m-%dT00:00:00").to_string();
    let state = app.state::<AppState>();
    let Ok(events) = state.db(|db| db.list_events_between(&start, &end)) else { return };

    let mut cache = load_cache(app);
    let pending: Vec<_> = events
        .iter()
        .filter(|e| !e.all_day && !e.summary.trim().is_empty())
        .filter(|e| {
            let key = format!("{}/{}", e.calendar_id, e.id);
            match cache.get(&key) {
                Some(c) => c.title_hash != hash_of(&e.summary) || c.goals_hash != goals_hash,
                None => true,
            }
        })
        .cloned()
        .collect();
    if pending.is_empty() {
        return;
    }
    let mut changed = false;
    // the obvious "never goal work" titles settle instantly, without the model
    let mut asked = Vec::new();
    for e in pending {
        if never_goal_work(&e.summary) {
            cache.insert(
                format!("{}/{}", e.calendar_id, e.id),
                GoalClass { goal: None, confidence: "high".into(), title_hash: hash_of(&e.summary), goals_hash },
            );
            changed = true;
        } else if asked.len() < BATCH_PER_TICK {
            asked.push(e);
        }
    }
    let model = if asked.is_empty() { None } else { pick_model(&agent) };
    for e in asked.into_iter().filter(|_| model.is_some()) {
        let model = model.as_deref().unwrap();
        if let Some((goal, confidence)) = classify_one(&agent, model, &goals, &e.summary) {
            info!("goal-class [{model}] {:?} <- {}", goal, e.summary);
            cache.insert(
                format!("{}/{}", e.calendar_id, e.id),
                GoalClass {
                    goal,
                    confidence,
                    title_hash: hash_of(&e.summary),
                    goals_hash,
                },
            );
            changed = true;
        } else {
            warn!("goal-class failed for {}", e.summary);
        }
    }
    if changed {
        save_cache(app, &cache);
        let _ = app.emit("goal-class-changed", ());
    }
}

fn data_file(app: &AppHandle, name: &str) -> Option<std::path::PathBuf> {
    crate::state::data_dir(app).ok().map(|d| d.join(name))
}

/// the note text on an event, if any (its [DRILL] line)
pub(crate) fn drill_line(desc: Option<&str>) -> Option<String> {
    desc?
        .lines()
        .find(|l| l.trim_start().starts_with(DRILL_MARK))
        .map(|l| l.trim_start()[DRILL_MARK.len()..].trim().to_string())
}

/// a description without its note lines, the rest as written
pub(crate) fn strip_drill(desc: &str) -> String {
    desc.lines()
        .filter(|l| !l.trim_start().starts_with(DRILL_MARK))
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_string()
}

/// The drill-sergeant supervisor is gone. Once, take down every note it
/// left: each [DRILL] line comes off its event, here and in Google Calendar,
/// and the rest of the description stays. What came off is kept in
/// drill-removed.json. Notes written from now on are the person's own.
pub fn retire_drill_notes(app: &AppHandle) {
    let (Some(marker), Some(backup)) = (data_file(app, "drill-retired"), data_file(app, "drill-removed.json")) else {
        return;
    };
    if marker.exists() {
        return;
    }
    let state = app.state::<AppState>();
    let Ok(events) = state.db(|db| db.list_events_between("0000", "9999")) else { return };
    let noted: Vec<_> = events
        .into_iter()
        .filter(|e| e.description.as_deref().is_some_and(|d| d.lines().any(|l| l.trim_start().starts_with(DRILL_MARK))))
        .collect();
    // the backup first (and only the first time), so nothing is lost
    if !backup.exists() {
        let kept: Vec<_> = noted
            .iter()
            .map(|e| {
                serde_json::json!({
                    "calendar_id": e.calendar_id, "id": e.id, "summary": e.summary,
                    "start": e.start, "description": e.description,
                })
            })
            .collect();
        let _ = std::fs::create_dir_all(backup.parent().unwrap());
        if std::fs::write(&backup, serde_json::to_string_pretty(&kept).unwrap_or_default()).is_err() {
            return;
        }
    }
    let mut cleared = 0;
    for e in &noted {
        let desc = strip_drill(e.description.as_deref().unwrap_or(""));
        let res = state.db(|db| {
            let Some(mut ev) = db.get_event(&e.calendar_id, &e.id)? else {
                return Ok(());
            };
            let etag = ev.etag.clone();
            ev.description = (!desc.is_empty()).then(|| desc.clone());
            db.upsert_event(&ev)?;
            db.enqueue_op(
                &e.calendar_id,
                &e.id,
                sync_core::models::OpKind::Patch,
                Some(&serde_json::json!({ "description": desc })),
                etag.as_deref(),
            )?;
            Ok(())
        });
        if res.is_ok() {
            cleared += 1;
        }
    }
    info!("drill notes retired: {cleared} of {} cleared", noted.len());
    if cleared == noted.len() {
        let _ = std::fs::write(&marker, Local::now().to_rfc3339());
        if let Some(p) = data_file(app, "drill.json") {
            let _ = std::fs::remove_file(p); // the supervisor's own records
        }
    }
    if cleared > 0 {
        let _ = app.emit("db-changed", ());
        state.kick_sync(crate::state::SyncKick::Now);
    }
}

pub fn spawn(app: AppHandle) {
    std::thread::Builder::new()
        .name("goal-classify".into())
        .spawn(move || {
            std::thread::sleep(Duration::from_secs(10));
            retire_drill_notes(&app);
            loop {
                run_once(&app);
                std::thread::sleep(Duration::from_secs(TICK_SECS));
            }
        })
        .expect("failed to spawn goal classifier");
}

/// key -> goal text: high-confidence verdicts made under the current prompt
/// and goals only (older, looser verdicts are not shown while they wait to
/// be re-judged).
#[tauri::command]
pub fn get_goal_classifications(app: AppHandle) -> HashMap<String, String> {
    let Some((_, current)) = current_goals_hash(&app) else { return HashMap::new() };
    load_cache(&app)
        .into_iter()
        .filter(|(_, v)| v.confidence == "high" && v.goals_hash == current)
        .filter(|(_, v)| v.goal.is_some())
        .filter_map(|(k, v)| v.goal.map(|g| (k, g)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drill_line_reads_the_note() {
        assert_eq!(drill_line(Some("body\n\n[DRILL] Ship it.")).as_deref(), Some("Ship it."));
        assert_eq!(drill_line(Some("no note")), None);
    }

    #[test]
    fn retiring_takes_only_the_note_line() {
        assert_eq!(strip_drill("[DRILL] Ship it."), "");
        assert_eq!(strip_drill("Agenda: budget\nRoom 4\n\n[DRILL] Ship it."), "Agenda: budget\nRoom 4");
        assert_eq!(strip_drill("  [DRILL] indented\nkeep me"), "keep me");
        assert_eq!(strip_drill("no note here"), "no note here");
    }

    #[test]
    fn never_goal_work_catches_routine() {
        assert!(never_goal_work("Asleep (6.1h)"));
        assert!(never_goal_work("Email, LinkedIn, resume, job search"));
        assert!(never_goal_work("Meal Prep Weekday Dinners"));
        assert!(!never_goal_work("Read Chapter 4"));
        assert!(!never_goal_work("Stats Notes — Lecture 14"));
    }
}
