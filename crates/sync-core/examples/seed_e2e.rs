//! Create a deterministic, isolated native-E2E database.
//! This writes directly through sync-core, so it exercises the production
//! schema without creating pending Google operations.

use chrono::{Local, SecondsFormat, TimeZone};
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
    println!("seeded native E2E database at {path}");
    Ok(())
}
