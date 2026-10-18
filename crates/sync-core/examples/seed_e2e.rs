//! Create a deterministic, isolated native-E2E database.
//! This writes directly through sync-core, so it exercises the production
//! schema without creating pending Google operations.

use chrono::{Duration, Local, SecondsFormat, TimeZone};
use std::path::Path;
use sync_core::db::Db;
use sync_core::models::{Calendar, Event};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).ok_or("usage: seed_e2e <calendar.db>")?;
    let db = Db::open(Path::new(&path))?;
    db.upsert_calendar(&Calendar {
        id: "e2e".into(),
        summary: "E2E Sandbox".into(),
        color: Some("#4f8cff".into()),
        is_primary: true,
        hidden: false,
        access_role: "owner".into(),
    })?;

    let today = Local::now().date_naive();
    let at = |hour: u32, minute: u32| {
        Local
            .from_local_datetime(&today.and_hms_opt(hour, minute, 0).unwrap())
            .earliest()
            .unwrap()
    };
    let fixtures = [
        ("e2e-focus", "Native E2E focus block", at(9, 0), at(10, 0), None),
        (
            "e2e-note",
            "Native E2E annotation",
            at(11, 0),
            at(12, 0),
            Some("[DRILL] Verify the native annotation path."),
        ),
        (
            "e2e-overlap",
            "Native E2E overlap",
            at(9, 30),
            at(10, 30),
            None,
        ),
    ];
    for (id, summary, start, end, description) in fixtures {
        db.upsert_event(&Event {
            id: id.into(),
            calendar_id: "e2e".into(),
            etag: None,
            summary: summary.into(),
            description: description.map(str::to_string),
            location: None,
            start: start.to_rfc3339_opts(SecondsFormat::Secs, false),
            end: end.to_rfc3339_opts(SecondsFormat::Secs, false),
            all_day: false,
            timezone: None,
            status: "confirmed".into(),
            recurrence: None,
            recurring_event_id: None,
            conference_url: None,
            updated: None,
            raw: None,
        })?;
    }

    // Opt-in renderer stress fixture for the real Tauri/WebKitGTK app. Keep
    // the default native E2E seed small; CAL_E2E_DENSE_EVENTS_PER_DAY=240
    // creates 21 adjacent dense days around today for pan profiling.
    let dense_per_day = std::env::var("CAL_E2E_DENSE_EVENTS_PER_DAY")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if dense_per_day > 0 {
        let minute_step = (600 / dense_per_day).max(1) as i64;
        for day_offset in -7..14 {
            let day = today + Duration::days(day_offset);
            for event_index in 0..dense_per_day {
                let local_start = day.and_hms_opt(8, 0, 0).unwrap()
                    + Duration::minutes(event_index as i64 * minute_step);
                let start = Local.from_local_datetime(&local_start).earliest().unwrap();
                let end = start + Duration::minutes(30 + (event_index % 3 * 15) as i64);
                db.upsert_event(&Event {
                    id: format!("e2e-dense-{day_offset}-{event_index}"),
                    calendar_id: "e2e".into(),
                    etag: None,
                    summary: format!("Dense {day_offset}-{event_index}"),
                    description: None,
                    location: None,
                    start: start.to_rfc3339_opts(SecondsFormat::Secs, false),
                    end: end.to_rfc3339_opts(SecondsFormat::Secs, false),
                    all_day: false,
                    timezone: None,
                    status: "confirmed".into(),
                    recurrence: None,
                    recurring_event_id: None,
                    conference_url: None,
                    updated: None,
                    raw: None,
                })?;
            }
        }
        println!("seeded {dense_per_day} dense events/day across 21 days");
    }
    println!("seeded native E2E database at {path}");
    Ok(())
}
