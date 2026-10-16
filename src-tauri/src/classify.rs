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
/// marker separating the drill-sergeant annotation inside a description
pub const DRILL_MARK: &str = "[DRILL]";
const DRILL_PER_TICK: usize = 2;
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
    if let Some(model) = model.or_else(|| pick_model(&agent)) {
        run_drill(app, &agent, &model, &goals);
    }
}

fn drill_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    crate::state::data_dir(app).ok().map(|d| d.join("drill.json"))
}

/// What the supervisor wrote on an event. `line` fingerprints the note text
/// it wrote: when the event's note no longer matches (the person edited or
/// erased it), the note is theirs and is never rewritten. Older records
/// (a bare signature) count as settled.
#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum DrillEntry {
    Wrote { sig: u64, line: u64 },
    Legacy(u64),
}

fn load_drill(app: &AppHandle) -> HashMap<String, DrillEntry> {
    drill_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// the note text on an event, if any (the [DRILL] line)
pub(crate) fn drill_line(desc: Option<&str>) -> Option<String> {
    desc?
        .lines()
        .find(|l| l.trim_start().starts_with(DRILL_MARK))
        .map(|l| l.trim_start()[DRILL_MARK.len()..].trim().to_string())
}

/// Whether the supervisor may (re)write this event's note: never over a
/// note the person wrote, edited or erased.
fn may_annotate(entry: Option<&DrillEntry>, current: Option<&str>, sig: u64) -> bool {
    match entry {
        None => current.is_none(),
        Some(DrillEntry::Legacy(_)) => false,
        Some(DrillEntry::Wrote { sig: s, line }) => {
            current.map(hash_of) == Some(*line) && *s != sig
        }
    }
}

fn save_drill(app: &AppHandle, m: &HashMap<String, DrillEntry>) {
    if let Some(p) = drill_path(app) {
        let _ = std::fs::create_dir_all(p.parent().unwrap());
        let _ = std::fs::write(p, serde_json::to_string(m).unwrap_or_default());
    }
}

/// The note as it should read: the model sometimes wraps its line in stage
/// directions ("**[Red marker scribble in margin next to X]**", "**Calendar
/// Entry: X**") or repeats the event title first. Mirrors cleanDrill in
/// src/lib/drill.ts (which also cleans notes written before this existed).
fn clean_note(raw: &str, title: &str) -> Option<String> {
    let collapse = |x: &str| x.split_whitespace().collect::<Vec<_>>().join(" ");
    let scene = |x: &str| {
        let l = x.to_lowercase();
        ["red marker", "red pen", "red ink", "margin", "scrawl", "scribbl", "calendar entry", "calendar event"]
            .iter()
            .any(|k| l.contains(k))
    };
    let mut s = collapse(raw);
    let t = collapse(title).to_lowercase();
    for _ in 0..3 {
        let before = s.clone();
        if let Some(rest) = s.strip_prefix("**") {
            match rest.find("**") {
                Some(end) if scene(&rest[..end]) => s = rest[end + 2..].trim().to_string(),
                None if scene(rest) => s = rest.trim().to_string(),
                _ => {}
            }
        }
        if s.starts_with('[') || s.starts_with('(') {
            if let Some(end) = s.find([']', ')']) {
                if scene(&s[..end]) {
                    s = s[end + 1..].trim().to_string();
                }
            }
        }
        let lower = s.to_lowercase();
        for p in ["calendar entry:", "calendar event:"] {
            if lower.starts_with(p) {
                s = s[p.len()..].trim().to_string();
                break;
            }
        }
        if !t.is_empty() && s.to_lowercase().starts_with(&t) {
            let n = t.chars().count();
            s = s.chars().skip(n).collect::<String>();
            s = s.trim_start_matches(|c: char| c.is_whitespace() || ":-–—".contains(c)).to_string();
        }
        s = s.trim().to_string();
        if s == before {
            break;
        }
    }
    if s.len() > 2 && s.starts_with('*') && s.ends_with('*') && !s[1..s.len() - 1].contains('*') {
        s = s[1..s.len() - 1].trim().to_string();
    }
    if s.chars().all(|c| c == '*' || c == '.' || c == '…' || c.is_whitespace()) {
        return None;
    }
    Some(s)
}

pub(crate) fn strip_drill(desc: &str) -> String {
    desc.lines()
        .filter(|l| !l.trim_start().starts_with(DRILL_MARK))
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_string()
}

/// One red-pen line from the supervisor, grounded in what the event was.
fn drill_one(
    agent: &ureq::Agent,
    model: &str,
    goals: &[String],
    e: &sync_core::models::Event,
    kind: &str,
) -> Option<String> {
    let goal_list = goals.join("; ");
    let prompt = format!(
        "You are a drill-sergeant personal coach (think David Goggins) reviewing a printed \
         calendar with a red marker. The person's goals: {goal_list}.\n\
         Event: \"{}\" ({kind}).\n\
         Write EXACTLY ONE short handwritten-style margin note, max 12 words, addressed as \
         'you'. Harsh and blunt for distractions, demanding-but-proud for goal work, \
         disciplinarian about sleep schedule. No emojis, no hashtags, no slurs, \
         no quotation marks, no markdown. Write only the note itself: do not \
         describe the marker or the margin, do not repeat the event title.",
        e.summary
    );
    let resp: serde_json::Value = agent
        .post(&format!("{OLLAMA}/api/generate"))
        .timeout(Duration::from_secs(90))
        .send_json(serde_json::json!({
            "model": model,
            "prompt": prompt,
            "stream": false,
            "options": {"temperature": 0.7, "num_predict": 40}
        }))
        .ok()?
        .into_json()
        .ok()?;
    let line = resp["response"].as_str()?.trim().replace(['\n', '"'], " ");
    let line = clean_note(&line, &e.summary)?;
    if line.len() > 140 {
        return None;
    }
    Some(line)
}

fn run_drill(app: &AppHandle, agent: &ureq::Agent, model: &str, goals: &[String]) {
    let now = Local::now();
    let start = (now - CDuration::days(1)).format("%Y-%m-%dT00:00:00").to_string();
    let end = now.format("%Y-%m-%dT%H:%M:%S").to_string();
    let state = app.state::<AppState>();
    let Ok(events) = state.db(|db| db.list_events_between(&start, &end)) else { return };
    let class_cache = load_cache(app);
    let mut drill = load_drill(app);
    let mut done = 0;
    for e in events {
        if done >= DRILL_PER_TICK {
            break;
        }
        if e.all_day || e.end > end {
            continue; // only events that already ended
        }
        let key = format!("{}/{}", e.calendar_id, e.id);
        // the goals text, not the classifier's prompt version: a stricter
        // classifier is no reason to rewrite yesterday's notes
        let sig = hash_of(&format!("{}|{}|{}", e.summary, DRILL_MARK, goals.join("\n")));
        let current = drill_line(e.description.as_deref());
        if !may_annotate(drill.get(&key), current.as_deref(), sig) {
            continue;
        }
        let lower = e.summary.to_lowercase();
        let kind = if lower.starts_with("distraction") {
            "a self-labelled distraction"
        } else if lower.contains("sleep") || lower.contains("asleep") || lower.contains("in bed") {
            "sleep - judge the schedule and duration from the title"
        } else if class_cache.get(&key).map(|c| c.goal.is_some()) == Some(true) {
            "goal work"
        } else {
            continue; // the supervisor doesn't annotate neutral events
        };
        let Some(line) = drill_one(agent, model, goals, &e, kind) else { continue };
        let new_desc = {
            let base = strip_drill(e.description.as_deref().unwrap_or(""));
            if base.is_empty() {
                format!("{DRILL_MARK} {line}")
            } else {
                format!("{base}\n\n{DRILL_MARK} {line}")
            }
        };
        info!("drill: {} <- {}", line, e.summary);
        let cal = e.calendar_id.clone();
        let id = e.id.clone();
        let res = state.db(|db| {
            let Some(mut ev) = db.get_event(&cal, &id)? else {
                return Ok(());
            };
            let etag = ev.etag.clone();
            ev.description = Some(new_desc.clone());
            db.upsert_event(&ev)?;
            db.enqueue_op(
                &cal,
                &id,
                sync_core::models::OpKind::Patch,
                Some(&serde_json::json!({ "description": new_desc })),
                etag.as_deref(),
            )?;
            Ok(())
        });
        if res.is_ok() {
            drill.insert(key, DrillEntry::Wrote { sig, line: hash_of(&line) });
            done += 1;
        }
    }
    if done > 0 {
        save_drill(app, &drill);
        let _ = app.emit("db-changed", ());
        state.kick_sync(crate::state::SyncKick::Now);
    }
}

pub fn spawn(app: AppHandle) {
    std::thread::Builder::new()
        .name("goal-classify".into())
        .spawn(move || {
            std::thread::sleep(Duration::from_secs(10));
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
    fn supervisor_never_rewrites_a_note_the_person_owns() {
        let wrote = DrillEntry::Wrote { sig: 1, line: hash_of("Read faster.") };
        // its own note, unchanged, and the event changed: may rewrite
        assert!(may_annotate(Some(&wrote), Some("Read faster."), 2));
        // unchanged event: nothing to do
        assert!(!may_annotate(Some(&wrote), Some("Read faster."), 1));
        // edited or erased by the person: theirs for good
        assert!(!may_annotate(Some(&wrote), Some("I did read it, slowly."), 2));
        assert!(!may_annotate(Some(&wrote), None, 2));
        // a note the person wrote first; older records are settled
        assert!(!may_annotate(None, Some("my own note"), 2));
        assert!(!may_annotate(Some(&DrillEntry::Legacy(7)), None, 2));
        // a fresh event with no note
        assert!(may_annotate(None, None, 2));
    }

    #[test]
    fn clean_note_drops_stage_directions_and_the_title() {
        assert_eq!(
            clean_note("**[Red Marker Scribble in Margin Next to  Read Chapter 4 ]**  You *will* understand it.", "Read Chapter 4").as_deref(),
            Some("You *will* understand it.")
        );
        assert_eq!(
            clean_note("**Calendar Entry: Read the style guide**  *You. Read. Absorb.*", "Read the style guide").as_deref(),
            Some("You. Read. Absorb.")
        );
        assert_eq!(
            clean_note("Finish Diffusion Notes: *Finally! Push harder.*", "Finish Diffusion Notes").as_deref(),
            Some("Finally! Push harder.")
        );
        assert_eq!(clean_note("**Calendar Entry:  Big Lecture", "Big Lecture"), None);
        assert_eq!(clean_note("frontier work", "Read paper").as_deref(), Some("frontier work"));
    }

    #[test]
    fn drill_line_reads_the_note() {
        assert_eq!(drill_line(Some("body\n\n[DRILL] Ship it.")).as_deref(), Some("Ship it."));
        assert_eq!(drill_line(Some("no note")), None);
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
