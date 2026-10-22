//! Local projection of recurring-series master changes.
//!
//! A series edit must be reflected in the expanded local instances before
//! waiting for Google's response. The response may take several seconds;
//! this module keeps the calendar responsive while preserving the server's
//! recurrence semantics when the sync pass later replaces these rows.

use crate::db::Db;
use crate::models::Event;
use crate::Result;
use chrono::{
    DateTime, Datelike, Duration, FixedOffset, NaiveDate, NaiveDateTime, TimeZone, Timelike,
};
use jiff::{civil, tz::TimeZone as IanaTimeZone};
use serde_json::{json, Value};

/// Preserve the remaining number of occurrences when a COUNT-limited series
/// is split. Google must supply every occurrence, including cancelled ones;
/// otherwise the count cannot be safely shortened.
pub fn count_split_recurrence(
    original_recurrence: &str,
    selected_original_start: &Value,
    instances: &[Value],
) -> Result<String> {
    use chrono::Utc;

    fn instant(value: &Value) -> Option<DateTime<chrono::Utc>> {
        if let Some(date_time) = value["dateTime"].as_str() {
            DateTime::parse_from_rfc3339(date_time)
                .ok()
                .map(|date_time| date_time.with_timezone(&chrono::Utc))
        } else {
            value["date"]
                .as_str()
                .and_then(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .map(|date_time| Utc.from_utc_datetime(&date_time))
        }
    }

    let boundary = instant(selected_original_start).ok_or_else(|| {
        crate::CoreError::Other("selected occurrence has no valid original start time".into())
    })?;
    let mut selected_exists = false;
    let mut earlier = 0usize;
    for instance in instances {
        let original = instant(&instance["originalStartTime"]).ok_or_else(|| {
            crate::CoreError::Other("series instance is missing its original start time".into())
        })?;
        if original == boundary {
            selected_exists = true;
        } else if original < boundary {
            earlier += 1;
        }
    }
    if !selected_exists {
        return Err(crate::CoreError::Other(
            "could not locate this occurrence in the series".into(),
        ));
    }
    let count = original_recurrence
        .split(';')
        .find_map(|part| part.strip_prefix("COUNT="))
        .and_then(|count| count.parse::<usize>().ok())
        .ok_or_else(|| crate::CoreError::Other("COUNT split did not contain a valid COUNT rule".into()))?;
    let remaining = count
        .checked_sub(earlier)
        .filter(|remaining| *remaining > 0)
        .ok_or_else(|| crate::CoreError::Other("no occurrences remain after this event".into()))?;
    let count_part = format!("COUNT={remaining}");
    Ok(original_recurrence
        .split(';')
        .map(|part| if part.starts_with("COUNT=") { count_part.as_str() } else { part })
        .collect::<Vec<_>>()
        .join(";"))
}

/// `UNTIL=` of an RRULE as a comparable UTC instant (date-only = that day's end).
fn rule_until(recurrence: &[String]) -> Option<DateTime<chrono::Utc>> {
    use chrono::Utc;
    let rule = recurrence.iter().find(|r| r.starts_with("RRULE"))?;
    let v = rule
        .split(';')
        .find_map(|p| p.strip_prefix("UNTIL").map(|x| x.trim_start_matches([':', '='])))?;
    if let Ok(t) = NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%SZ") {
        return Some(Utc.from_utc_datetime(&t));
    }
    let d = NaiveDate::parse_from_str(v, "%Y%m%d").ok()?;
    Some(Utc.from_utc_datetime(&d.and_hms_opt(23, 59, 59)?))
}

/// When an instance was scheduled by its series (`originalStartTime`), in UTC.
fn original_start(e: &Event) -> Option<DateTime<chrono::Utc>> {
    use chrono::Utc;
    let o = e.raw.as_ref().map(|r| &r["originalStartTime"]);
    let dt = o.and_then(|o| o["dateTime"].as_str()).or((!e.all_day).then_some(e.start.as_str()));
    if let Some(t) = dt.and_then(|t| DateTime::parse_from_rfc3339(t).ok()) {
        return Some(t.with_timezone(&Utc));
    }
    let d = o.and_then(|o| o["date"].as_str()).unwrap_or(&e.start);
    let d = NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()?;
    Some(Utc.from_utc_datetime(&d.and_hms_opt(0, 0, 0)?))
}

fn wall_datetime(value: &str) -> Option<NaiveDateTime> {
    DateTime::parse_from_rfc3339(value).ok().map(|value| value.naive_local())
}

/// The wall-clock time of an instant in the series' own zone. A series edit
/// made on a computer in another zone writes that computer's offset (1 PM
/// -04:00 for a Los Angeles series edited from New York): its own offset's
/// wall time, read again as Los Angeles time, put every occurrence 3 hours
/// late until the next pull.
fn wall_in(value: &str, timezone: Option<&str>) -> Option<NaiveDateTime> {
    let Some(tz) = timezone.and_then(|name| IanaTimeZone::get(name).ok()) else {
        return wall_datetime(value);
    };
    let instant = DateTime::parse_from_rfc3339(value).ok()?;
    let ts = jiff::Timestamp::from_second(instant.timestamp()).ok()?;
    let civil = ts.to_zoned(tz).datetime();
    NaiveDate::from_ymd_opt(civil.year() as i32, civil.month() as u32, civil.day() as u32)?
        .and_hms_nano_opt(
            civil.hour() as u32,
            civil.minute() as u32,
            civil.second() as u32,
            instant.timestamp_subsec_nanos(),
        )
}

fn localize(
    naive: NaiveDateTime,
    timezone: Option<&str>,
    fallback: FixedOffset,
) -> Option<DateTime<FixedOffset>> {
    if let Some(timezone) = timezone.and_then(|name| IanaTimeZone::get(name).ok()) {
        let local = civil::DateTime::new(
            i16::try_from(naive.year()).ok()?,
            naive.month() as i8,
            naive.day() as i8,
            naive.hour() as i8,
            naive.minute() as i8,
            naive.second() as i8,
            naive.nanosecond() as i32,
        )
        .ok()?;
        // Jiff's compatible resolution moves forward through a spring gap and
        // selects the earlier occurrence in a fall-back overlap.
        let zoned = local.to_zoned(timezone).ok()?;
        let rfc3339 = zoned.strftime("%Y-%m-%dT%H:%M:%S%:z").to_string();
        return DateTime::parse_from_rfc3339(&rfc3339).ok();
    }
    fallback.from_local_datetime(&naive).single()
}

/// A series body edit applies to every inherited instance body, but the
/// `[DRILL]` note belongs to its individual occurrence and must survive it.
fn series_description(existing: Option<&str>, new_body: Option<&str>) -> Option<String> {
    let drill = note_in(existing.unwrap_or_default());
    let drill = drill.as_deref().filter(|note| !note.is_empty());
    let body = new_body.unwrap_or_default().trim_end_matches('\n');
    let merged = match (body.is_empty(), drill) {
        (true, Some(note)) => format!("[DRILL] {note}"),
        (false, Some(note)) => format!("{body}\n\n[DRILL] {note}"),
        (true, None) => String::new(),
        (false, None) => body.to_string(),
    };
    (!merged.is_empty()).then_some(merged)
}

/// The `[DRILL]` note's text in a description, on its own line or, as
/// Google web re-saves descriptions, after a `<br>` or in its own `<p>`
/// (the shape the UI's splitDrill reads; a note in HTML was erased by a
/// series body edit).
fn note_in(desc: &str) -> Option<String> {
    // (real tags only: a plain note's "< 30 min" keeps its words)
    let bare = |l: &str| -> String {
        let mut out = String::new();
        let mut rest = l;
        while let Some(i) = rest.find('<') {
            out.push_str(&rest[..i]);
            let after = &rest[i + 1..];
            let name_start = after.strip_prefix('/').unwrap_or(after);
            let is_tag = name_start.chars().next().is_some_and(|c| c.is_ascii_alphabetic());
            match after.find('>') {
                Some(j) if is_tag => rest = &after[j + 1..],
                _ => {
                    out.push('<');
                    rest = after;
                }
            }
        }
        out.push_str(rest);
        out.trim().to_string()
    };
    let find = |lines: &[String]| {
        lines.iter().map(|l| bare(l)).find(|l| l.starts_with("[DRILL]")).map(|l| {
            l["[DRILL]".len()..]
                .trim()
                .replace("&nbsp;", " ")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
                .replace("&amp;", "&")
        })
    };
    let plain: Vec<String> = desc.lines().map(String::from).collect();
    if plain.iter().any(|l| l.trim_start().starts_with("[DRILL]")) {
        return find(&plain);
    }
    // line-breaking tags as line breaks
    let mut s = String::new();
    let mut rest = desc;
    while let Some(i) = rest.find('<') {
        s.push_str(&rest[..i]);
        let Some(j) = rest[i..].find('>') else { s.push_str(&rest[i..]); rest = ""; break };
        let tag = &rest[i..i + j + 1];
        let name: String = tag
            .trim_start_matches('<')
            .trim_start_matches('/')
            .chars()
            .take_while(|c| c.is_ascii_alphabetic())
            .collect::<String>()
            .to_ascii_lowercase();
        if name == "br" || name == "p" || name == "div" { s.push('\n') } else { s.push_str(tag) }
        rest = &rest[i + j + 1..];
    }
    s.push_str(rest);
    let html: Vec<String> = s.lines().map(String::from).collect();
    find(&html)
}

fn update_instance_time(
    inst: &mut Event,
    previous_start: &str,
    new_start: &Value,
    new_end: &Value,
) -> bool {
    // every date and time below is read in the series' zone
    let series_tz = new_start["timeZone"].as_str();
    let date_of = |value: &str| {
        NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .ok()
            .or_else(|| wall_in(value, series_tz).map(|dt| dt.date()))
    };
    let original = inst.raw.as_ref().and_then(|raw| {
        raw["originalStartTime"]["dateTime"]
            .as_str()
            .or(raw["originalStartTime"]["date"].as_str())
    });
    if let Some(original) = original {
        // A manually moved occurrence is an exception to the master rule.
        // Leave its own time intact when the series schedule changes.
        let same_slot = if inst.all_day {
            original == inst.start
        } else {
            DateTime::parse_from_rfc3339(original).ok()
                == DateTime::parse_from_rfc3339(&inst.start).ok()
        };
        if !same_slot {
            return false;
        }
    }
    let slot = original.unwrap_or(&inst.start);
    let (Some(old_master_date), Some(instance_date)) = (date_of(previous_start), date_of(slot)) else {
        return false;
    };
    let (new_value, all_day) = if let Some(date) = new_start["date"].as_str() {
        (date, true)
    } else if let Some(date_time) = new_start["dateTime"].as_str() {
        (date_time, false)
    } else {
        return false;
    };
    let Some(new_master_date) = date_of(new_value) else { return false };
    let target_date = new_master_date + Duration::days(instance_date.signed_duration_since(old_master_date).num_days());

    if all_day {
        let Some(end_value) = new_end["date"].as_str() else { return false };
        let Some(master_end_date) = date_of(end_value) else { return false };
        let span = master_end_date.signed_duration_since(new_master_date).num_days().max(1);
        inst.start = target_date.format("%Y-%m-%d").to_string();
        inst.end = (target_date + Duration::days(span)).format("%Y-%m-%d").to_string();
        inst.all_day = true;
        inst.timezone = None;
        let (start, end) = (inst.start.clone(), inst.end.clone());
        let raw = inst.raw.get_or_insert_with(|| json!({}));
        raw["start"] = json!({ "date": start });
        raw["end"] = json!({ "date": end });
        raw["originalStartTime"] = json!({ "date": start });
        true
    } else {
        let (Some(master_start), Some(master_end)) = (
            wall_in(new_value, series_tz),
            new_end["dateTime"].as_str().and_then(|v| wall_in(v, series_tz)),
        ) else {
            return false;
        };
        let duration = master_end - master_start;
        let start_naive = target_date.and_time(master_start.time());
        let timezone = new_start["timeZone"].as_str();
        let fixed_offset = DateTime::parse_from_rfc3339(new_value).ok().map(|dt| *dt.offset());
        let Some(fixed_offset) = fixed_offset else {
            return false;
        };
        let (Some(start), Some(end)) = (
            localize(start_naive, timezone, fixed_offset),
            localize(start_naive + duration, timezone, fixed_offset),
        ) else {
            return false;
        };
        inst.start = start.to_rfc3339();
        inst.end = end.to_rfc3339();
        inst.all_day = false;
        inst.timezone = new_start["timeZone"].as_str().map(String::from);
        let (start, end, timezone) = (inst.start.clone(), inst.end.clone(), inst.timezone.clone());
        let raw = inst.raw.get_or_insert_with(|| json!({}));
        raw["start"] = json!({ "dateTime": start, "timeZone": timezone });
        raw["end"] = json!({ "dateTime": end, "timeZone": timezone });
        raw["originalStartTime"] = json!({ "dateTime": start, "timeZone": timezone });
        true
    }
}

/// Apply the visible part of a master patch to its expanded rows in one DB
/// transaction. `previous_start` is needed to translate all occurrences when
/// the series date or time changes.
pub fn apply_locally(
    db: &Db,
    calendar_id: &str,
    master_id: &str,
    patch: &Value,
    destination: Option<&str>,
    previous_start: Option<&str>,
) -> Result<()> {
    let until = patch["recurrence"].as_array().and_then(|r| {
        rule_until(&r.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>())
    });
    for mut inst in db.list_series_instances(calendar_id, master_id)? {
        if let (Some(until), Some(at)) = (until, original_start(&inst)) {
            if at > until {
                db.delete_event(calendar_id, &inst.id)?;
                continue;
            }
        }
        let mut changed = false;
        if let Some(value) = patch["summary"].as_str() {
            inst.summary = value.to_string();
            changed = true;
        }
        if let (Some(previous_start), Some(new_start), Some(new_end)) =
            (previous_start, patch.get("start"), patch.get("end"))
        {
            changed |= update_instance_time(&mut inst, previous_start, new_start, new_end);
        }
        if let Some(value) = patch.get("description") {
            inst.description = series_description(inst.description.as_deref(), value.as_str());
            inst.raw.get_or_insert_with(|| json!({}))["description"] =
                inst.description.clone().map(Value::String).unwrap_or(Value::Null);
            changed = true;
        }
        if let Some(value) = patch.get("location") {
            inst.location = value.as_str().map(String::from);
            changed = true;
        }
        if let Some(destination) = destination {
            db.delete_event(calendar_id, &inst.id)?;
            inst.calendar_id = destination.to_string();
            changed = true;
        }
        for (key, value) in [
            ("transparency", patch.get("transparency")),
            ("visibility", patch.get("visibility")),
            ("reminders", patch.get("reminders")),
            ("attendees", patch.get("attendees")),
        ] {
            if let Some(value) = value {
                inst.raw.get_or_insert_with(|| json!({}))[key] = value.clone();
                changed = true;
            }
        }
        if changed {
            db.upsert_event(&inst)?;
        }
    }
    if let Some(destination) = destination.filter(|d| *d != calendar_id) {
        db.move_pending_ops(calendar_id, destination, master_id)?;
    }
    Ok(())
}

/// Restore a failed optimistic update, including instances removed by a
/// truncation or relocated to another calendar.
pub fn restore_locally(
    db: &Db,
    calendar_id: &str,
    master_id: &str,
    destination: Option<&str>,
    previous: &[Event],
) -> Result<()> {
    let mut calendars = vec![calendar_id];
    if let Some(destination) = destination.filter(|d| *d != calendar_id) {
        calendars.push(destination);
    }
    for calendar in calendars {
        for instance in db.list_series_instances(calendar, master_id)? {
            db.delete_event(calendar, &instance.id)?;
        }
    }
    for event in previous {
        db.upsert_event(event)?;
    }
    if let Some(destination) = destination.filter(|d| *d != calendar_id) {
        db.move_pending_ops(destination, calendar_id, master_id)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Timelike;

    fn instance(id: &str, start: &str) -> Event {
        Event {
            id: id.into(), calendar_id: "cal".into(), etag: Some("\"e\"".into()),
            summary: "Standup".into(), description: Some("[DRILL] occurrence note".into()),
            location: None, start: start.into(), end: start.replace("T09", "T10"), all_day: false,
            timezone: None, status: "confirmed".into(), recurrence: None,
            recurring_event_id: Some("m".into()), conference_url: None, updated: None,
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

    fn ids(db: &Db, calendar: &str) -> Vec<String> {
        let mut ids: Vec<_> = db.list_series_instances(calendar, "m").unwrap().into_iter().map(|e| e.id).collect();
        ids.sort();
        ids
    }

    #[test]
    fn until_parses_timed_and_date_values() {
        let timed = rule_until(&["RRULE:FREQ=DAILY;UNTIL=20261013T155959Z".into()]).unwrap();
        assert_eq!(timed.to_rfc3339(), "2026-10-13T15:59:59+00:00");
        let all_day = rule_until(&["RRULE:FREQ=DAILY;UNTIL=20261013".into()]).unwrap();
        assert_eq!(all_day.to_rfc3339(), "2026-10-13T23:59:59+00:00");
        assert!(rule_until(&["RRULE:FREQ=DAILY;COUNT=3".into()]).is_none());
    }

    #[test]
    fn series_time_edit_from_another_zone_projects_the_sent_instant() {
        // a 9 AM Los Angeles series moved to 1 PM New York time (10 AM PT)
        // from a New York computer: the offset is the computer's
        let db = series();
        let patch = json!({
            "start": { "dateTime": "2026-10-12T13:00:00-04:00", "timeZone": "America/Los_Angeles", "date": null },
            "end": { "dateTime": "2026-10-12T14:00:00-04:00", "timeZone": "America/Los_Angeles", "date": null },
        });
        apply_locally(&db, "cal", "m", &patch, None, Some("2026-10-12T09:00:00-07:00")).unwrap();
        let s = db.get_event("cal", "m_2").unwrap().unwrap().start;
        let got = DateTime::parse_from_rfc3339(&s).unwrap().with_timezone(&chrono::Utc);
        assert_eq!(got.to_rfc3339(), "2026-10-13T17:00:00+00:00", "projected {s}; Google shows 10 AM PT");
    }

    #[test]
    fn truncation_drops_the_tail_locally() {
        let db = series();
        let patch = json!({ "recurrence": ["RRULE:FREQ=DAILY;UNTIL=20261013T155959Z"] });
        apply_locally(&db, "cal", "m", &patch, None, None).unwrap();
        assert_eq!(ids(&db, "cal"), vec!["m_1"]);
    }

    #[test]
    fn move_and_rename_are_visible_locally_without_losing_occurrence_notes() {
        let db = series();
        apply_locally(&db, "cal", "m", &json!({ "summary": "Daily sync" }), Some("work"), None).unwrap();
        assert!(ids(&db, "cal").is_empty());
        let moved = db.list_series_instances("work", "m").unwrap();
        assert_eq!(moved.len(), 3);
        assert!(moved.iter().all(|e| e.summary == "Daily sync"));
        assert!(moved.iter().all(|e| e.description.as_deref() == Some("[DRILL] occurrence note")));
    }

    #[test]
    fn timed_series_changes_shift_all_instances_and_settings_locally() {
        let db = series();
        let before = wall_datetime("2026-10-13T09:00:00-07:00").unwrap();
        let patch = json!({
            "start": { "dateTime": "2026-10-12T11:00:00-07:00" },
            "end": { "dateTime": "2026-10-12T12:30:00-07:00" },
            "transparency": "transparent", "visibility": "private",
            "reminders": { "useDefault": false, "overrides": [{ "method": "popup", "minutes": 15 }] },
        });
        apply_locally(&db, "cal", "m", &patch, None, Some("2026-10-12T09:00:00-07:00")).unwrap();
        let second = db.get_event("cal", "m_2").unwrap().unwrap();
        let after = wall_datetime(&second.start).unwrap();
        let after_end = wall_datetime(&second.end).unwrap();
        assert_eq!(after, before + Duration::hours(2));
        assert_eq!(after.hour(), 11);
        assert_eq!(after_end - after, Duration::minutes(90));
        assert_eq!(second.raw.as_ref().unwrap()["transparency"], "transparent");
        assert_eq!(second.raw.as_ref().unwrap()["visibility"], "private");
        assert_eq!(second.raw.as_ref().unwrap()["reminders"]["overrides"][0]["minutes"], 15);
        assert_eq!(second.raw.as_ref().unwrap()["originalStartTime"]["dateTime"], second.start);
    }

    #[test]
    fn changing_series_description_preserves_each_occurrence_note() {
        let db = series();
        for mut event in db.list_series_instances("cal", "m").unwrap() {
            event.description = Some(format!("Old series body\n\n[DRILL] Note for {}", event.id));
            db.upsert_event(&event).unwrap();
        }

        apply_locally(
            &db,
            "cal",
            "m",
            &json!({ "description": "New series body" }),
            None,
            None,
        )
        .unwrap();

        for event in db.list_series_instances("cal", "m").unwrap() {
            let expected = format!("New series body\n\n[DRILL] Note for {}", event.id);
            assert_eq!(
                event.description.as_deref(),
                Some(expected.as_str()),
                "changing the shared body erased occurrence-specific annotation {}",
                event.id,
            );
            assert_eq!(
                event.raw.as_ref().unwrap()["description"],
                expected,
                "raw description got out of sync for {}",
                event.id,
            );
        }
    }

    #[test]
    fn timed_to_all_day_updates_local_occurrence_dates() {
        let db = series();
        let patch = json!({ "start": { "date": "2026-10-14" }, "end": { "date": "2026-10-15" } });
        apply_locally(&db, "cal", "m", &patch, None, Some("2026-10-12T09:00:00-07:00")).unwrap();
        let second = db.get_event("cal", "m_2").unwrap().unwrap();
        assert!(second.all_day);
        assert_eq!(second.start, "2026-10-15");
        assert_eq!(second.end, "2026-10-16");
        assert_eq!(second.raw.unwrap()["originalStartTime"]["date"], "2026-10-15");
    }

    #[test]
    fn manually_moved_occurrence_keeps_its_exception_time() {
        let db = series();
        let mut moved = db.get_event("cal", "m_2").unwrap().unwrap();
        moved.start = "2026-10-20T10:00:00-07:00".into();
        moved.end = "2026-10-20T11:00:00-07:00".into();
        db.upsert_event(&moved).unwrap();
        let patch = json!({
            "start": { "dateTime": "2026-10-12T11:00:00-07:00" },
            "end": { "dateTime": "2026-10-12T12:00:00-07:00" },
        });
        apply_locally(&db, "cal", "m", &patch, None, Some("2026-10-12T09:00:00-07:00")).unwrap();
        let preserved = db.get_event("cal", "m_2").unwrap().unwrap();
        assert_eq!(preserved.start, "2026-10-20T10:00:00-07:00");
        assert_eq!(preserved.end, "2026-10-20T11:00:00-07:00");
    }

    #[test]
    fn timed_series_projection_uses_iana_zone_not_host_zone_across_dst() {
        let db = Db::open_in_memory().unwrap();
        for (id, start) in [
            ("m_1", "2026-10-31T09:00:00-04:00"),
            ("m_2", "2026-11-01T09:00:00-05:00"),
            ("m_3", "2026-11-02T09:00:00-05:00"),
        ] {
            let mut event = instance(id, start);
            event.timezone = Some("America/New_York".into());
            event.raw.as_mut().unwrap()["originalStartTime"]["timeZone"] = json!("America/New_York");
            db.upsert_event(&event).unwrap();
        }
        let patch = json!({
            "start": { "dateTime": "2026-10-31T10:00:00-04:00", "timeZone": "America/New_York" },
            "end": { "dateTime": "2026-10-31T11:00:00-04:00", "timeZone": "America/New_York" },
        });
        apply_locally(&db, "cal", "m", &patch, None, Some("2026-10-31T09:00:00-04:00")).unwrap();

        let second = db.get_event("cal", "m_2").unwrap().unwrap();
        assert_eq!(wall_datetime(&second.start).unwrap().hour(), 10);
        let offset = DateTime::parse_from_rfc3339(&second.start).unwrap().offset().local_minus_utc();
        assert_eq!(offset, -5 * 60 * 60, "Nov 1 in New York is after its DST transition");
        assert_eq!(second.timezone.as_deref(), Some("America/New_York"));

        let spring_gap = NaiveDate::from_ymd_opt(2026, 3, 8)
            .unwrap()
            .and_hms_opt(2, 30, 0)
            .unwrap();
        let eastern_standard = FixedOffset::west_opt(5 * 60 * 60).unwrap();
        let shifted = localize(spring_gap, Some("America/New_York"), eastern_standard).unwrap();
        assert_eq!(shifted.to_rfc3339(), "2026-03-08T03:30:00-04:00");
    }

    #[test]
    fn rollback_restores_deleted_and_moved_instances() {
        let db = series();
        let previous = db.list_series_instances("cal", "m").unwrap();
        apply_locally(&db, "cal", "m", &json!({ "summary": "temporary" }), Some("work"), None).unwrap();
        restore_locally(&db, "cal", "m", Some("work"), &previous).unwrap();
        assert_eq!(ids(&db, "cal"), vec!["m_1", "m_2", "m_3"]);
        assert!(ids(&db, "work").is_empty());
        assert!(db.list_series_instances("cal", "m").unwrap().iter().all(|e| e.summary == "Standup"));
    }

    #[test]
    fn counted_split_preserves_cancelled_occurrences_in_the_remaining_count() {
        let instances = [12, 13, 14, 15, 16]
            .into_iter()
            .map(|day| {
                json!({
                    "status": if day == 13 { "cancelled" } else { "confirmed" },
                    "originalStartTime": {
                        "dateTime": format!("2026-10-{day}T09:00:00-04:00")
                    }
                })
            })
            .collect::<Vec<_>>();
        let rule = count_split_recurrence(
            "RRULE:FREQ=DAILY;COUNT=5",
            &json!({ "dateTime": "2026-10-14T13:00:00Z" }),
            &instances,
        )
        .unwrap();
        assert_eq!(rule, "RRULE:FREQ=DAILY;COUNT=3");
    }

    #[test]
    fn counted_split_rejects_missing_selected_occurrence() {
        let instances = vec![json!({
            "originalStartTime": { "date": "2026-10-12" }
        })];
        let error = count_split_recurrence(
            "RRULE:FREQ=DAILY;COUNT=5",
            &json!({ "date": "2026-10-13" }),
            &instances,
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "could not locate this occurrence in the series");
    }

    #[test]
    fn counted_all_day_split_uses_date_only_original_starts() {
        let instances = [12, 13, 14]
            .into_iter()
            .map(|day| {
                json!({
                    "originalStartTime": { "date": format!("2026-10-{day}") }
                })
            })
            .collect::<Vec<_>>();
        let rule = count_split_recurrence(
            "RRULE:FREQ=DAILY;COUNT=5",
            &json!({ "date": "2026-10-13" }),
            &instances,
        )
        .unwrap();
        assert_eq!(rule, "RRULE:FREQ=DAILY;COUNT=4");
    }

    // A note saved on an occurrence whose description Google web stored as
    // HTML (the shape the UI's splitDrill reads): an "All events" body edit
    // keeps the note on that occurrence, as the mock does.
    #[test]
    fn series_body_edit_keeps_an_html_wrapped_occurrence_note() {
        let db = Db::open_in_memory().unwrap();
        let html = |id: &str, start: &str, description: &str| {
            let mut e = instance(id, start);
            e.description = Some(description.into());
            e
        };
        db.upsert_event(&html("m_1", "2026-10-13T09:00:00-04:00", "<p>Agenda</p><p>[DRILL] skipped the warmup</p>")).unwrap();
        db.upsert_event(&html("m_2", "2026-10-14T09:00:00-04:00", "Agenda<br>[DRILL] late again")).unwrap();
        apply_locally(&db, "cal", "m", &json!({ "description": "New agenda" }), None, None).unwrap();
        for (id, note) in [("m_1", "skipped the warmup"), ("m_2", "late again")] {
            let got = db.get_event("cal", id).unwrap().unwrap().description.unwrap_or_default();
            assert!(got.contains(note), "{id}: note erased by the series body edit; got {got:?}");
        }
    }
}
