//! Sync-engine behavior tests against an in-memory fake Google API.
//! These cover the concurrency-safety rules: echo suppression, 412 remote-wins,
//! 409 insert idempotency, 410 full resync, and queue independence.

use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use sync_core::db::Db;
use sync_core::google::{CalendarApi, EventsPage};
use sync_core::models::*;
use sync_core::sync::{generate_event_id, SyncEngine};
use sync_core::{CoreError, Result};

/// Fake remote: one calendar "cal", events keyed by id, etags bumped per write.
#[derive(Default)]
struct FakeApi {
    events: RefCell<HashMap<String, Value>>,
    etag_counter: RefCell<u64>,
    /// events changed since last sync token issue (returned on next incremental)
    changed: RefCell<Vec<String>>,
    expire_sync_token: RefCell<bool>,
    fail_event_ids: RefCell<Vec<String>>, // push failures for specific ids (500)
}

impl FakeApi {
    fn next_etag(&self) -> String {
        let mut c = self.etag_counter.borrow_mut();
        *c += 1;
        format!("\"etag-{}\"", *c)
    }

    /// Simulate an edit made remotely (e.g. in Google Calendar web).
    fn remote_edit(&self, id: &str, summary: &str) {
        let etag = self.next_etag();
        let mut events = self.events.borrow_mut();
        let ev = events.get_mut(id).expect("remote_edit: unknown id");
        ev["summary"] = json!(summary);
        ev["etag"] = json!(etag);
        self.changed.borrow_mut().push(id.to_string());
    }

    fn remote_summary(&self, id: &str) -> String {
        self.events.borrow()[id]["summary"].as_str().unwrap().to_string()
    }
}

impl CalendarApi for FakeApi {
    fn list_calendars(&self) -> Result<Vec<Calendar>> {
        Ok(vec![Calendar {
            id: "cal".into(),
            summary: "Test".into(),
            color: None,
            is_primary: true,
            hidden: false,
            access_role: "owner".into(),
        }])
    }

    fn list_events_page(
        &self,
        _calendar_id: &str,
        sync_token: Option<&str>,
        _page_token: Option<&str>,
    ) -> Result<EventsPage> {
        if sync_token.is_some() && *self.expire_sync_token.borrow() {
            *self.expire_sync_token.borrow_mut() = false;
            return Err(CoreError::Api { status: 410, body: "gone".into() });
        }
        let events = if sync_token.is_some() {
            // incremental: only changed events
            let changed = self.changed.borrow_mut().drain(..).collect::<Vec<_>>();
            let store = self.events.borrow();
            changed.iter().filter_map(|id| store.get(id).cloned()).collect()
        } else {
            self.changed.borrow_mut().clear();
            self.events.borrow().values().cloned().collect()
        };
        Ok(EventsPage {
            events,
            next_page_token: None,
            next_sync_token: Some("tok".into()),
        })
    }

    fn insert_event(&self, _c: &str, body: &Value) -> Result<Value> {
        let id = body["id"].as_str().expect("client-generated id required").to_string();
        if self.fail_event_ids.borrow().contains(&id) {
            return Err(CoreError::Api { status: 500, body: "boom".into() });
        }
        if self.events.borrow().contains_key(&id) {
            return Err(CoreError::Api { status: 409, body: "duplicate".into() });
        }
        let mut ev = body.clone();
        ev["etag"] = json!(self.next_etag());
        ev["status"] = json!("confirmed");
        self.events.borrow_mut().insert(id.clone(), ev.clone());
        self.changed.borrow_mut().push(id);
        Ok(ev)
    }

    fn patch_event(&self, _c: &str, event_id: &str, body: &Value, etag: Option<&str>) -> Result<Value> {
        let mut events = self.events.borrow_mut();
        let ev = events
            .get_mut(event_id)
            .ok_or(CoreError::Api { status: 404, body: "missing".into() })?;
        if let Some(expected) = etag {
            if ev["etag"].as_str() != Some(expected) {
                return Err(CoreError::Api { status: 412, body: "precondition".into() });
            }
        }
        if let Some(obj) = body.as_object() {
            for (k, v) in obj {
                ev[k] = v.clone();
            }
        }
        ev["etag"] = json!(self.next_etag());
        self.changed.borrow_mut().push(event_id.to_string());
        Ok(ev.clone())
    }

    fn delete_event(&self, _c: &str, event_id: &str, etag: Option<&str>) -> Result<()> {
        let mut events = self.events.borrow_mut();
        let ev = events
            .get(event_id)
            .ok_or(CoreError::Api { status: 404, body: "missing".into() })?;
        if let Some(expected) = etag {
            if ev["etag"].as_str() != Some(expected) {
                return Err(CoreError::Api { status: 412, body: "precondition".into() });
            }
        }
        events.remove(event_id);
        Ok(())
    }

    fn get_event(&self, _c: &str, event_id: &str) -> Result<Value> {
        self.events
            .borrow()
            .get(event_id)
            .cloned()
            .ok_or(CoreError::Api { status: 404, body: "missing".into() })
    }
}

fn event_body(id: &str, summary: &str) -> Value {
    json!({
        "id": id,
        "summary": summary,
        "start": {"dateTime": "2026-10-20T10:00:00Z"},
        "end": {"dateTime": "2026-10-20T11:00:00Z"},
    })
}

/// Local create helper mirroring what the app layer does: optimistic local row
/// + queued insert op.
fn local_create(db: &Db, id: &str, summary: &str) {
    let body = event_body(id, summary);
    db.upsert_event(&Event {
        id: id.into(),
        calendar_id: "cal".into(),
        etag: None,
        summary: summary.into(),
        description: None,
        location: None,
        start: "2026-10-20T10:00:00Z".into(),
        end: "2026-10-20T11:00:00Z".into(),
        all_day: false,
        timezone: None,
        status: "confirmed".into(),
        recurrence: None,
        recurring_event_id: None,
        conference_url: None,
        updated: None,
        raw: None,
    })
    .unwrap();
    db.enqueue_op("cal", id, OpKind::Insert, Some(&body), None).unwrap();
}

fn setup() -> (Db, FakeApi) {
    (Db::open_in_memory().unwrap(), FakeApi::default())
}

#[test]
fn create_pushes_and_echo_is_suppressed() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "standup");

    let engine = SyncEngine::new(&db, &api);
    let r1 = engine.sync_once().unwrap();
    assert_eq!(r1.pushed, 1);
    // The push already stored the returned etag; the echo on the next
    // incremental sync must be skipped, not double-applied.
    let r2 = engine.sync_once().unwrap();
    assert_eq!(r2.pulled, 0, "own write came back and was not suppressed");

    let local = db.get_event("cal", &id).unwrap().unwrap();
    assert_eq!(local.etag.as_deref(), api.events.borrow()[&id]["etag"].as_str());
}

#[test]
fn echo_does_not_clobber_newer_local_edit() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "v1");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();

    // User edits locally to v2 (optimistic write + patch op), while the v1
    // echo is still pending in the remote changed-feed... which it isn't here
    // because push consumed it; simulate the race by re-marking it changed.
    api.changed.borrow_mut().push(id.clone());

    let mut ev = db.get_event("cal", &id).unwrap().unwrap();
    let base_etag = ev.etag.clone();
    ev.summary = "v2".into();
    db.upsert_event(&ev).unwrap();
    db.enqueue_op("cal", &id, OpKind::Patch, Some(&json!({"summary": "v2"})), base_etag.as_deref())
        .unwrap();

    engine.sync_once().unwrap();
    let local = db.get_event("cal", &id).unwrap().unwrap();
    assert_eq!(local.summary, "v2", "echo of v1 clobbered the newer local edit");
    assert_eq!(api.remote_summary(&id), "v2");
}

#[test]
fn concurrent_edit_412_remote_wins_and_converges() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "original");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();

    // Remote edit happens first...
    api.remote_edit(&id, "remote edit");
    // ...then a local edit based on the now-stale etag.
    let ev = db.get_event("cal", &id).unwrap().unwrap();
    db.enqueue_op(
        "cal",
        &id,
        OpKind::Patch,
        Some(&json!({"summary": "local edit"})),
        ev.etag.as_deref(),
    )
    .unwrap();

    let r = engine.sync_once().unwrap();
    assert_eq!(r.conflicts, 1);
    let local = db.get_event("cal", &id).unwrap().unwrap();
    assert_eq!(local.summary, "remote edit", "412 must resolve remote-wins");
    assert_eq!(api.remote_summary(&id), "remote edit");
    assert!(db.list_pending_ops().unwrap().is_empty(), "conflicted op must be dropped");
}

#[test]
fn insert_retry_after_success_is_idempotent() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "meeting");

    // First attempt "succeeds remotely but the response is lost": simulate by
    // pre-inserting remotely with the same id, so our push gets 409.
    api.insert_event("cal", &event_body(&id, "meeting")).unwrap();

    let engine = SyncEngine::new(&db, &api);
    let r = engine.sync_once().unwrap();
    assert_eq!(r.pushed, 1, "409 on insert must count as success");
    assert!(db.list_pending_ops().unwrap().is_empty());
    assert_eq!(api.events.borrow().len(), 1, "no duplicate event created");
}

#[test]
fn expired_sync_token_triggers_clean_full_resync() {
    let (db, api) = setup();
    let id = generate_event_id();
    api.insert_event("cal", &event_body(&id, "remote-only")).unwrap();
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    assert!(db.get_event("cal", &id).unwrap().is_some());

    *api.expire_sync_token.borrow_mut() = true;
    api.remote_edit(&id, "after expiry");
    let r = engine.sync_once().unwrap();
    assert!(r.errors.is_empty(), "410 must be handled, not surfaced: {:?}", r.errors);
    let local = db.get_event("cal", &id).unwrap().unwrap();
    assert_eq!(local.summary, "after expiry");
}

#[test]
fn failed_op_does_not_block_other_events() {
    let (db, api) = setup();
    let bad = generate_event_id();
    let good = generate_event_id();
    local_create(&db, &bad, "will fail");
    local_create(&db, &good, "will succeed");
    api.fail_event_ids.borrow_mut().push(bad.clone());

    let engine = SyncEngine::new(&db, &api);
    let r = engine.sync_once().unwrap();
    assert_eq!(r.pushed, 1, "good op must push despite earlier failure");
    let remaining = db.list_pending_ops().unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].event_id, bad);
    assert_eq!(remaining[0].attempts, 1);
}

#[test]
fn remote_delete_removes_local_event() {
    let (db, api) = setup();
    let id = generate_event_id();
    api.insert_event("cal", &event_body(&id, "to be cancelled")).unwrap();
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();

    // Google reports deletions as status=cancelled in incremental sync.
    {
        let mut events = api.events.borrow_mut();
        let ev = events.get_mut(&id).unwrap();
        ev["status"] = json!("cancelled");
        let etag = format!("\"etag-cancel\"");
        ev["etag"] = json!(etag);
    }
    api.changed.borrow_mut().push(id.clone());

    engine.sync_once().unwrap();
    assert!(db.get_event("cal", &id).unwrap().is_none());
}
