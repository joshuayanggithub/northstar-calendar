//! Sync-engine behavior tests against an in-memory fake Google API.
//! These cover the concurrency-safety rules: echo suppression, 412 remote-wins,
//! 409 insert idempotency, 410 full resync, and queue independence.

use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
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
    fail_event_ids: RefCell<Vec<String>>, // insert/delete failures for specific ids (500)
    fail_patch_once: RefCell<Vec<String>>, // next patch of these ids fails (500)
    lose_patch_once: RefCell<Vec<String>>, // next patch of these ids lands, its response is lost
    /// every patch of these ids is refused with this status and body
    reject_patch: RefCell<HashMap<String, (u16, String)>>,
    /// calendars on the account besides "cal"
    extra_cals: RefCell<Vec<String>>,
    /// runs inside every events.list call: lets a test look at the local
    /// store mid-download, the way a UI refetch would
    on_list: RefCell<Option<Box<dyn Fn()>>>,
    /// events live on one calendar each (moves, per-calendar lists and gets)
    per_cal: RefCell<bool>,
    cal_of: RefCell<HashMap<String, String>>,
    /// the next move lands on Google but its response is lost (500)
    lose_move: RefCell<bool>,
    /// access to "cal" is lost: its events calls 404
    gone: RefCell<bool>,
    /// every events.list call's calendar, in order
    listed: RefCell<Vec<String>>,
    /// moves are refused (403, e.g. someone else's invitation)
    refuse_move: RefCell<bool>,
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

    fn cal_of(&self, id: &str) -> String {
        self.cal_of.borrow().get(id).cloned().unwrap_or_else(|| "cal".into())
    }

    fn not_here(&self, c: &str, id: &str) -> bool {
        (*self.gone.borrow() && c == "cal") || (*self.per_cal.borrow() && self.cal_of(id) != c)
    }

    fn remote_summary(&self, id: &str) -> String {
        self.events.borrow()[id]["summary"].as_str().unwrap().to_string()
    }
}

impl CalendarApi for FakeApi {
    fn list_calendars(&self) -> Result<Vec<Calendar>> {
        let mut cals = vec![Calendar {
            id: "cal".into(),
            summary: "Test".into(),
            color: None,
            is_primary: true,
            hidden: false,
            access_role: "owner".into(),
        }];
        for id in self.extra_cals.borrow().iter() {
            cals.push(Calendar {
                id: id.clone(),
                summary: id.clone(),
                color: None,
                is_primary: false,
                hidden: false,
                access_role: "owner".into(),
            });
        }
        Ok(cals)
    }

    fn list_events_page(
        &self,
        calendar_id: &str,
        sync_token: Option<&str>,
        _page_token: Option<&str>,
    ) -> Result<EventsPage> {
        self.listed.borrow_mut().push(calendar_id.to_string());
        if let Some(f) = self.on_list.borrow().as_ref() {
            f();
        }
        if sync_token.is_some() && *self.expire_sync_token.borrow() {
            *self.expire_sync_token.borrow_mut() = false;
            return Err(CoreError::Api { status: 410, body: "gone".into() });
        }
        if *self.gone.borrow() && calendar_id == "cal" {
            return Err(CoreError::Api { status: 404, body: "not found".into() });
        }
        let mine = |v: &Value| !self.not_here(calendar_id, v["id"].as_str().unwrap_or(""));
        let events: Vec<Value> = if sync_token.is_some() {
            // incremental: only changed events
            // each calendar's feed carries only its own changes
            let changed = if *self.per_cal.borrow() {
                let mut all = self.changed.borrow_mut();
                let (here, rest): (Vec<_>, Vec<_>) =
                    all.drain(..).partition(|id| !self.not_here(calendar_id, id));
                *all = rest;
                here
            } else {
                self.changed.borrow_mut().drain(..).collect::<Vec<_>>()
            };
            let store = self.events.borrow();
            changed.iter().filter_map(|id| store.get(id).cloned()).filter(mine).collect()
        } else {
            self.changed.borrow_mut().clear();
            self.events.borrow().values().cloned().filter(mine).collect()
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
        if body["recurrence"].is_array() {
            // singleEvents=true: the feed carries two expanded instances,
            // never the master itself
            for n in 1..=2 {
                let iid = format!("{id}_{n}");
                let mut inst = event_body(&iid, body["summary"].as_str().unwrap_or(""));
                inst["recurringEventId"] = json!(id);
                inst["etag"] = json!(self.next_etag());
                self.events.borrow_mut().insert(iid.clone(), inst);
                self.changed.borrow_mut().push(iid);
            }
        } else {
            self.changed.borrow_mut().push(id);
        }
        Ok(ev)
    }

    fn patch_event(&self, c: &str, event_id: &str, body: &Value, etag: Option<&str>) -> Result<Value> {
        if self.not_here(c, event_id) {
            return Err(CoreError::Api { status: 404, body: "not found".into() });
        }
        {
            let mut once = self.fail_patch_once.borrow_mut();
            if let Some(i) = once.iter().position(|x| x == event_id) {
                once.remove(i);
                return Err(CoreError::Api { status: 500, body: "transient".into() });
            }
        }
        if let Some((status, body)) = self.reject_patch.borrow().get(event_id) {
            return Err(CoreError::Api { status: *status, body: body.clone() });
        }
        let lose = {
            let mut once = self.lose_patch_once.borrow_mut();
            once.iter().position(|x| x == event_id).map(|i| once.remove(i)).is_some()
        };
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
        if lose {
            return Err(CoreError::Api { status: 500, body: "lost".into() });
        }
        Ok(ev.clone())
    }

    fn delete_event(&self, c: &str, event_id: &str, etag: Option<&str>) -> Result<()> {
        // (as Google: a DELETE on a calendar the event isn't on is a 404)
        if self.not_here(c, event_id) {
            return Err(CoreError::Api { status: 404, body: "not found".into() });
        }
        if self.fail_event_ids.borrow().iter().any(|x| x == event_id) {
            return Err(CoreError::Api { status: 500, body: "boom".into() });
        }
        let mut events = self.events.borrow_mut();
        let ev = events
            .get(event_id)
            .ok_or(CoreError::Api { status: 404, body: "missing".into() })?;
        if let Some(expected) = etag {
            if ev["etag"].as_str() != Some(expected) {
                return Err(CoreError::Api { status: 412, body: "precondition".into() });
            }
        }
        if ev["recurringEventId"].is_string() {
            let ev = events.get_mut(event_id).unwrap();
            ev["status"] = json!("cancelled");
            ev["etag"] = json!(self.next_etag());
            self.changed.borrow_mut().push(event_id.to_string());
        } else {
            events.remove(event_id);
        }
        Ok(())
    }

    fn get_event(&self, c: &str, event_id: &str) -> Result<Value> {
        if self.not_here(c, event_id) {
            return Err(CoreError::Api { status: 404, body: "not found".into() });
        }
        self.events
            .borrow()
            .get(event_id)
            .cloned()
            .ok_or(CoreError::Api { status: 404, body: "missing".into() })
    }

    fn move_event(&self, c: &str, event_id: &str, destination: &str) -> Result<Value> {
        if !*self.per_cal.borrow() {
            return Err(CoreError::Other("move_event not supported".into()));
        }
        if *self.refuse_move.borrow() {
            return Err(CoreError::Api { status: 403, body: "forbiddenForNonOrganizer".into() });
        }
        if self.not_here(c, event_id) || !self.events.borrow().contains_key(event_id) {
            return Err(CoreError::Api { status: 404, body: "not found".into() });
        }
        let etag = self.next_etag();
        let ev = {
            let mut events = self.events.borrow_mut();
            let ev = events.get_mut(event_id).unwrap();
            ev["etag"] = json!(etag);
            ev.clone()
        };
        self.cal_of.borrow_mut().insert(event_id.to_string(), destination.to_string());
        self.changed.borrow_mut().push(event_id.to_string());
        if self.lose_move.replace(false) {
            return Err(CoreError::Api { status: 500, body: "lost".into() });
        }
        Ok(ev)
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

/// (Until 2026-10-22 this resolved "remote wins", which dropped an edit
/// made minutes ago whenever a series change had refreshed the etag.)
#[test]
fn concurrent_edit_412_reapplies_the_local_edit_and_converges() {
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
    assert_eq!(r.conflicts, 0);
    assert_eq!(r.pushed, 1);
    let local = db.get_event("cal", &id).unwrap().unwrap();
    assert_eq!(local.summary, "local edit", "the later edit must land");
    assert_eq!(api.remote_summary(&id), "local edit");
    assert!(db.list_pending_ops().unwrap().is_empty(), "the re-applied op must be done");
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

#[test]
fn undo_delete_then_patch_restores_recurring_instance_membership() {
    let (db, api) = setup();
    let id = "series_20261020T100000Z";
    let mut remote = event_body(id, "recurring instance");
    remote["recurringEventId"] = json!("series");
    remote["originalStartTime"] = json!({ "dateTime": "2026-10-20T10:00:00Z" });
    remote["etag"] = json!("\"initial\"");
    api.events.borrow_mut().insert(id.into(), remote);

    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    let occurrence = db.get_event("cal", id).unwrap().unwrap();
    assert_eq!(occurrence.recurring_event_id.as_deref(), Some("series"));

    db.delete_event("cal", id).unwrap();
    db.enqueue_op("cal", id, OpKind::Delete, None, occurrence.etag.as_deref()).unwrap();
    db.upsert_event(&occurrence).unwrap();
    db.enqueue_op("cal", id, OpKind::Patch, Some(&json!({ "status": "confirmed" })), None)
        .unwrap();

    let report = engine.sync_once().unwrap();
    assert_eq!(report.pushed, 2, "delete then undo patch should both be applied in queue order");
    let remote = &api.events.borrow()[id];
    assert_eq!(remote["status"], "confirmed");
    assert_eq!(remote["recurringEventId"], "series");
    assert_eq!(remote["originalStartTime"]["dateTime"], "2026-10-20T10:00:00Z");
    assert_eq!(db.get_event("cal", id).unwrap().unwrap().recurring_event_id.as_deref(), Some("series"));
    assert!(db.list_pending_ops().unwrap().is_empty());
}

/// Local edit helper mirroring the app layer: optimistic row + patch op whose
/// If-Match is the etag the edit was made against.
fn local_patch(db: &Db, id: &str, patch: Value) {
    let ev = db.get_event("cal", id).unwrap().unwrap();
    db.enqueue_op("cal", id, OpKind::Patch, Some(&patch), ev.etag.as_deref())
        .unwrap();
}

#[test]
fn second_queued_edit_to_one_event_is_not_lost() {
    // A note written and then erased before the next sync: both ops carry the
    // etag from before the first one. The first push changes the etag, so the
    // second must not 412 against our own write and be dropped remote-wins.
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "deep work");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();

    local_patch(&db, &id, json!({"description": "[DRILL] Focus."}));
    local_patch(&db, &id, json!({"description": null}));
    let r = engine.sync_once().unwrap();
    assert_eq!(r.conflicts, 0, "our own first edit 412'd our second");
    assert!(api.events.borrow()[&id]["description"].is_null(), "the erase never reached Google");
    assert!(db.get_event("cal", &id).unwrap().unwrap().description.is_none(), "the note came back locally");
    assert!(db.list_pending_ops().unwrap().is_empty());
}

#[test]
fn delete_queued_after_an_edit_still_deletes() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "to go");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();

    local_patch(&db, &id, json!({"summary": "renamed"}));
    let etag = db.get_event("cal", &id).unwrap().unwrap().etag;
    db.delete_event("cal", &id).unwrap();
    db.enqueue_op("cal", &id, OpKind::Delete, None, etag.as_deref()).unwrap();
    engine.sync_once().unwrap();
    assert!(!api.events.borrow().contains_key(&id), "the delete lost to our own rename");
    assert!(db.get_event("cal", &id).unwrap().is_none(), "the deleted event came back");
}

#[test]
fn a_failed_edit_is_not_overtaken_by_a_later_edit_to_the_same_event() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "v1");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();

    api.fail_patch_once.borrow_mut().push(id.clone());
    local_patch(&db, &id, json!({"summary": "v2"}));
    local_patch(&db, &id, json!({"summary": "v3"}));
    engine.sync_once().unwrap();
    // v3 must wait for v2, or v2's retry would land after it
    assert_eq!(api.remote_summary(&id), "v1");
    engine.sync_once().unwrap();
    assert_eq!(api.remote_summary(&id), "v3", "edits applied out of order");
    assert!(db.list_pending_ops().unwrap().is_empty());
}

#[test]
fn a_pushed_series_swaps_its_placeholder_for_instances_in_one_step() {
    let db = Rc::new(Db::open_in_memory().unwrap());
    let api = FakeApi::default();
    let id = generate_event_id();
    local_create(&db, &id, "weekly review");
    // the queued insert is a recurring master
    let op = db.list_pending_ops().unwrap().remove(0);
    db.remove_op(op.id).unwrap();
    let mut body = event_body(&id, "weekly review");
    body["recurrence"] = json!(["RRULE:FREQ=WEEKLY"]);
    db.enqueue_op("cal", &id, OpKind::Insert, Some(&body), None).unwrap();

    let during = Rc::new(RefCell::new(Vec::new()));
    {
        let (db, during, id) = (db.clone(), during.clone(), id.clone());
        *api.on_list.borrow_mut() = Some(Box::new(move || {
            during.borrow_mut().push(db.get_event("cal", &id).unwrap().is_some());
        }));
    }
    SyncEngine::new(&db, &api).sync_once().unwrap();
    assert!(
        during.borrow().iter().all(|&shown| shown),
        "the edited occurrence vanished between the push and the pull of its instances"
    );
    assert!(db.get_event("cal", &id).unwrap().is_none(), "placeholder left behind");
    assert_eq!(db.list_series_instances("cal", &id).unwrap().len(), 2);
}

#[test]
fn expired_token_keeps_the_calendar_until_the_new_copy_is_in() {
    let db = Rc::new(Db::open_in_memory().unwrap());
    let api = FakeApi::default();
    let id = generate_event_id();
    api.insert_event("cal", &event_body(&id, "stays put")).unwrap();
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();

    let during = Rc::new(RefCell::new(Vec::new()));
    {
        let (db, during, id) = (db.clone(), during.clone(), id.clone());
        *api.on_list.borrow_mut() = Some(Box::new(move || {
            during.borrow_mut().push(db.get_event("cal", &id).unwrap().is_some());
        }));
    }
    *api.expire_sync_token.borrow_mut() = true;
    engine.sync_once().unwrap();
    assert!(
        during.borrow().iter().all(|&shown| shown),
        "the calendar sat empty while the full resync downloaded"
    );
    assert!(db.get_event("cal", &id).unwrap().is_some());
}

/// A local edit Google refuses for good (an invitation you can't edit): the
/// op is dropped and the local copy goes back to Google's, or the rejected
/// edit shows forever (nothing changed remotely for a pull to correct).
#[test]
fn a_permanently_rejected_edit_reverts_the_local_copy() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "Design review");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();

    let mut ev = db.get_event("cal", &id).unwrap().unwrap();
    ev.summary = "Design review (moved)".into();
    db.upsert_event(&ev).unwrap();
    local_patch(&db, &id, json!({"summary": "Design review (moved)"}));
    api.reject_patch.borrow_mut().insert(id.clone(), (403, "forbiddenForNonOrganizer".into()));
    let r = engine.sync_once().unwrap();
    assert!(!r.errors.is_empty(), "the refusal is reported");
    assert_eq!(r.reverted, vec!["Design review (moved)".to_string()], "the UI is told which event went back");
    assert!(db.list_pending_ops().unwrap().is_empty(), "a permanent refusal is not retried");
    assert_eq!(db.get_event("cal", &id).unwrap().unwrap().summary, "Design review");
}

/// Google sends rate limits as 403 too: those are retried, not reverted.
#[test]
fn a_rate_limited_edit_is_kept_for_retry() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "v1");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();

    local_patch(&db, &id, json!({"summary": "v2"}));
    api.reject_patch.borrow_mut().insert(id.clone(), (403, "{\"reason\": \"userRateLimitExceeded\"}".into()));
    engine.sync_once().unwrap();
    assert_eq!(db.list_pending_ops().unwrap().len(), 1, "a rate-limited edit was dropped");
    api.reject_patch.borrow_mut().clear();
    engine.sync_once().unwrap();
    assert_eq!(api.remote_summary(&id), "v2");
}

/// The sync token expires while an edit is queued and nobody else touched
/// the event: the full resync must not drop the edit "remote wins".
#[test]
fn a_token_expiry_resync_keeps_an_unpushed_edit_nobody_conflicted_with() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "Dentist");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();

    let mut ev = db.get_event("cal", &id).unwrap().unwrap();
    ev.summary = "Dentist (rescheduled)".into();
    db.upsert_event(&ev).unwrap();
    local_patch(&db, &id, json!({"summary": "Dentist (rescheduled)"}));
    api.fail_patch_once.borrow_mut().push(id.clone());
    *api.expire_sync_token.borrow_mut() = true;
    engine.sync_once().unwrap();
    assert_eq!(db.get_event("cal", &id).unwrap().unwrap().summary, "Dentist (rescheduled)",
        "the resync put the old title back over the queued edit");
    engine.sync_once().unwrap();
    assert_eq!(api.remote_summary(&id), "Dentist (rescheduled)");
    assert!(db.list_pending_ops().unwrap().is_empty());
}

/// A queued delete survives a token-expiry resync (the event must not come back).
#[test]
fn a_token_expiry_resync_keeps_a_queued_delete() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "Old meeting");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();

    let ev = db.get_event("cal", &id).unwrap().unwrap();
    db.delete_event("cal", &id).unwrap();
    db.enqueue_op("cal", &id, OpKind::Delete, None, ev.etag.as_deref()).unwrap();
    api.fail_event_ids.borrow_mut().push(id.clone());
    *api.expire_sync_token.borrow_mut() = true;
    engine.sync_once().unwrap();
    assert!(db.get_event("cal", &id).unwrap().is_none(), "the deleted event came back");
    assert_eq!(db.list_pending_ops().unwrap().len(), 1);
}

/// Google's usage-limit 403s are temporary: retried, never reverted.
#[test]
fn a_quota_refusal_is_kept_for_retry() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "v1");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    let mut ev = db.get_event("cal", &id).unwrap().unwrap();
    ev.summary = "v2".into();
    db.upsert_event(&ev).unwrap();
    local_patch(&db, &id, json!({"summary": "v2"}));
    api.reject_patch.borrow_mut().insert(id.clone(),
        (403, r#"{"error":{"errors":[{"domain":"usageLimits","reason":"quotaExceeded"}]}}"#.into()));
    engine.sync_once().unwrap();
    assert_eq!(db.list_pending_ops().unwrap().len(), 1, "a quota-refused edit was dropped");
    assert_eq!(db.get_event("cal", &id).unwrap().unwrap().summary, "v2", "a quota-refused edit was reverted");
}

/// A refused edit followed by a queued delete: the event stays deleted.
#[test]
fn a_refused_edit_before_a_delete_does_not_bring_the_event_back() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "v1");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    let ev = db.get_event("cal", &id).unwrap().unwrap();
    local_patch(&db, &id, json!({"summary": "v2"}));
    db.delete_event("cal", &id).unwrap();
    db.enqueue_op("cal", &id, OpKind::Delete, None, ev.etag.as_deref()).unwrap();
    api.reject_patch.borrow_mut().insert(id.clone(), (400, "invalid".into()));
    engine.sync_once().unwrap();
    assert!(db.get_event("cal", &id).unwrap().is_none(), "the deleted event came back");
    engine.sync_once().unwrap();
    assert!(!api.events.borrow().contains_key(&id), "the delete never reached Google");
}

/// A calendar unsubscribed (or deleted) in Google leaves the app; one with
/// changes still queued stays (the list can lag a just-created calendar).
#[test]
fn a_calendar_gone_from_the_account_is_removed() {
    let (db, api) = setup();
    api.extra_cals.borrow_mut().extend(["team".to_string(), "fresh".to_string()]);
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    assert!(db.list_calendars().unwrap().iter().any(|c| c.id == "team"));
    db.enqueue_op("fresh", "x1", OpKind::Patch, Some(&json!({"summary": "s"})), None).unwrap();
    api.extra_cals.borrow_mut().clear();
    let r = SyncEngine::new(&db, &api).sync_once().unwrap();
    let ids: Vec<String> = db.list_calendars().unwrap().into_iter().map(|c| c.id).collect();
    assert!(!ids.contains(&"team".to_string()), "an unsubscribed calendar stayed: {ids:?} ({:?})", r.errors);
    assert!(ids.contains(&"fresh".to_string()), "a calendar with queued changes was dropped");
}

/// The quick pass after a change pulls only that change's calendars: it
/// must not blank a new series' placeholder on another calendar.
#[test]
fn the_priority_pass_keeps_other_calendars_series_placeholders() {
    let db = Rc::new(Db::open_in_memory().unwrap());
    let api = FakeApi::default();
    let id = generate_event_id();
    local_create(&db, &id, "weekly review");
    let op = db.list_pending_ops().unwrap().remove(0);
    db.remove_op(op.id).unwrap();
    let mut body = event_body(&id, "weekly review");
    body["recurrence"] = json!(["RRULE:FREQ=WEEKLY"]);
    db.enqueue_op("cal", &id, OpKind::Insert, Some(&body), None).unwrap();
    let engine = SyncEngine::new(&db, &api);
    engine.sync_calendars(&["other".to_string()]).unwrap();
    assert!(db.get_event("cal", &id).unwrap().is_some(), "the series blanked until the full pass");
    engine.sync_once().unwrap();
    assert!(db.get_event("cal", &id).unwrap().is_none(), "the full pass drops the placeholder");
}

/// A queued calendar move whose push hasn't gone through yet, and a remote
/// change to the event meanwhile: the event stays moved (once), the move
/// stays queued.
#[test]
fn a_remote_change_during_a_queued_move_keeps_the_move() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "1:1");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    let mut ev = db.get_event("cal", &id).unwrap().unwrap();
    db.delete_event("cal", &id).unwrap();
    ev.calendar_id = "work".into();
    db.upsert_event(&ev).unwrap();
    db.enqueue_op("cal", &id, OpKind::Move, Some(&json!({"destination": "work"})), None).unwrap();
    api.remote_edit(&id, "1:1 (rsvp)");
    engine.sync_once().unwrap(); // the fake can't move: the push fails, retried
    assert!(db.get_event("cal", &id).unwrap().is_none(), "the event showed on both calendars");
    assert!(db.get_event("work", &id).unwrap().is_some());
    assert!(db.list_pending_ops().unwrap().iter().any(|op| op.kind == OpKind::Move), "the move was dropped");
}

#[test]
fn delete_during_pull_of_own_echo_stays_deleted() {
    let db = Rc::new(Db::open_in_memory().unwrap());
    let api = FakeApi::default();
    let id = generate_event_id();
    local_create(&db, &id, "oops");
    {
        let (db, id) = (db.clone(), id.clone());
        let fired = RefCell::new(false);
        *api.on_list.borrow_mut() = Some(Box::new(move || {
            if fired.replace(true) { return; }
            let etag = db.get_event("cal", &id).unwrap().and_then(|e| e.etag);
            db.delete_event("cal", &id).unwrap();
            db.enqueue_op("cal", &id, OpKind::Delete, None, etag.as_deref()).unwrap();
        }));
    }
    SyncEngine::new(&db, &api).sync_once().unwrap();
    *api.on_list.borrow_mut() = None;
    SyncEngine::new(&db, &api).sync_once().unwrap();
    assert!(db.get_event("cal", &id).unwrap().is_none(), "the deleted event came back");
    assert!(!api.events.borrow().contains_key(&id), "the delete never reached Google");
}
#[test]
fn edit_queued_before_a_move_does_not_duplicate_the_event() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "1:1");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    let mut ev = db.get_event("cal", &id).unwrap().unwrap();
    ev.summary = "1:1 renamed".into();
    db.upsert_event(&ev).unwrap();
    db.enqueue_op("cal", &id, OpKind::Patch, Some(&json!({"summary": "1:1 renamed"})), ev.etag.as_deref()).unwrap();
    db.delete_event("cal", &id).unwrap();
    ev.calendar_id = "work".into();
    db.upsert_event(&ev).unwrap();
    db.enqueue_op("cal", &id, OpKind::Move, Some(&json!({"destination": "work"})), None).unwrap();
    db.enqueue_op("work", &id, OpKind::Patch, Some(&json!({"summary": "1:1 renamed"})), None).unwrap();
    engine.sync_once().unwrap(); // the fake can't move: the move stays queued
    assert!(db.get_event("work", &id).unwrap().is_some());
    assert!(db.get_event("cal", &id).unwrap().is_none(), "patch response put the moved event back on its old calendar");
}
#[test]
fn token_expiry_keeps_unconditional_edit_of_just_created_event() {
    let (db, api) = setup();
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    let id = generate_event_id();
    local_create(&db, &id, "Lunch");
    let mut ev = db.get_event("cal", &id).unwrap().unwrap();
    ev.summary = "Lunch w/ Sam".into();
    db.upsert_event(&ev).unwrap();
    db.enqueue_op("cal", &id, OpKind::Patch, Some(&json!({"summary": "Lunch w/ Sam"})), None).unwrap();
    api.fail_patch_once.borrow_mut().push(id.clone());
    *api.expire_sync_token.borrow_mut() = true;
    engine.sync_once().unwrap();
    engine.sync_once().unwrap();
    assert_eq!(api.remote_summary(&id), "Lunch w/ Sam", "410 resync dropped the edit");
    assert_eq!(db.get_event("cal", &id).unwrap().unwrap().summary, "Lunch w/ Sam");
}

#[test]
fn insert_with_lost_response_keeps_the_edit_queued_behind_it() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "Lunch");
    let mut ev = db.get_event("cal", &id).unwrap().unwrap();
    ev.summary = "Lunch w/ Sam".into();
    db.upsert_event(&ev).unwrap();
    db.enqueue_op("cal", &id, OpKind::Patch, Some(&json!({"summary": "Lunch w/ Sam"})), None).unwrap();
    api.insert_event("cal", &event_body(&id, "Lunch")).unwrap(); // landed, response lost
    api.fail_event_ids.borrow_mut().push(id.clone());
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    api.fail_event_ids.borrow_mut().clear();
    engine.sync_once().unwrap();
    assert_eq!(api.remote_summary(&id), "Lunch w/ Sam", "the edit behind the insert was dropped");
    assert_eq!(db.get_event("cal", &id).unwrap().unwrap().summary, "Lunch w/ Sam");
}

#[test]
fn an_event_reverted_while_its_calendar_was_unreachable_comes_back() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "Seminar");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    local_patch(&db, &id, json!({"summary": "Seminar (room 2)"}));
    *api.gone.borrow_mut() = true; // the patch 404s, so does the revert's get
    engine.sync_once().unwrap();
    *api.gone.borrow_mut() = false;
    engine.sync_once().unwrap();
    assert!(db.get_event("cal", &id).unwrap().is_some(), "the event never came back");
}

#[test]
fn a_move_whose_response_was_lost_keeps_the_event_and_the_edit_after_it() {
    let (db, api) = setup();
    *api.per_cal.borrow_mut() = true;
    api.extra_cals.borrow_mut().push("work".into());
    let id = generate_event_id();
    local_create(&db, &id, "1:1");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    // move to work and rename, the way do_update_event queues it
    let mut ev = db.get_event("cal", &id).unwrap().unwrap();
    db.delete_event("cal", &id).unwrap();
    ev.calendar_id = "work".into();
    ev.summary = "1:1 renamed".into();
    db.upsert_event(&ev).unwrap();
    db.enqueue_op("cal", &id, OpKind::Move, Some(&json!({"destination": "work"})), None).unwrap();
    db.enqueue_op("work", &id, OpKind::Patch, Some(&json!({"summary": "1:1 renamed"})), None).unwrap();
    *api.lose_move.borrow_mut() = true;
    engine.sync_once().unwrap();
    engine.sync_once().unwrap();
    engine.sync_once().unwrap();
    assert!(db.list_pending_ops().unwrap().is_empty());
    assert!(db.get_event("cal", &id).unwrap().is_none());
    let local = db.get_event("work", &id).unwrap().expect("the moved event vanished");
    assert_eq!(local.summary, "1:1 renamed");
    assert_eq!(api.remote_summary(&id), "1:1 renamed", "the edit after the move was lost");
}

#[test]
fn an_edit_whose_response_was_lost_keeps_the_edit_queued_behind_it() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "Lunch");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    local_patch(&db, &id, json!({"summary": "Lunch w/ Sam"}));
    local_patch(&db, &id, json!({"location": "Cafe"}));
    let mut ev = db.get_event("cal", &id).unwrap().unwrap();
    ev.summary = "Lunch w/ Sam".into();
    db.upsert_event(&ev).unwrap();
    api.lose_patch_once.borrow_mut().push(id.clone());
    engine.sync_once().unwrap();
    engine.sync_once().unwrap();
    assert_eq!(api.remote_summary(&id), "Lunch w/ Sam");
    assert_eq!(api.events.borrow()[&id]["location"], json!("Cafe"), "the second edit was dropped");
    assert!(db.list_pending_ops().unwrap().is_empty());
}

#[test]
fn a_remote_edit_while_two_edits_are_queued_still_wins() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "Lunch");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    local_patch(&db, &id, json!({"summary": "Lunch w/ Sam"}));
    local_patch(&db, &id, json!({"location": "Cafe"}));
    api.fail_patch_once.borrow_mut().push(id.clone()); // ours never lands
    api.remote_edit(&id, "Lunch moved");
    engine.sync_once().unwrap();
    engine.sync_once().unwrap();
    assert_eq!(api.remote_summary(&id), "Lunch moved");
    assert_eq!(db.get_event("cal", &id).unwrap().unwrap().summary, "Lunch moved");
}

// ---- second sync fuzz (after the lost-response fixes)

/// FakeApi whose next get of one (calendar, id) fails with a 500.
struct FlakyGet<'a>(&'a FakeApi, RefCell<Option<(String, String)>>);
impl CalendarApi for FlakyGet<'_> {
    fn list_calendars(&self) -> Result<Vec<Calendar>> { self.0.list_calendars() }
    fn list_events_page(&self, c: &str, s: Option<&str>, p: Option<&str>) -> Result<EventsPage> { self.0.list_events_page(c, s, p) }
    fn insert_event(&self, c: &str, b: &Value) -> Result<Value> { self.0.insert_event(c, b) }
    fn patch_event(&self, c: &str, id: &str, b: &Value, e: Option<&str>) -> Result<Value> { self.0.patch_event(c, id, b, e) }
    fn delete_event(&self, c: &str, id: &str, e: Option<&str>) -> Result<()> { self.0.delete_event(c, id, e) }
    fn get_event(&self, c: &str, id: &str) -> Result<Value> {
        if self.1.borrow().as_ref().is_some_and(|(fc, fid)| fc == c && fid == id) {
            self.1.borrow_mut().take();
            return Err(CoreError::Api { status: 500, body: "backendError".into() });
        }
        self.0.get_event(c, id)
    }
    fn move_event(&self, c: &str, id: &str, d: &str) -> Result<Value> { self.0.move_event(c, id, d) }
}

#[test]
fn lost_edit_response_then_412_keeps_the_edit_behind_it() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "Lunch");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    local_patch(&db, &id, json!({"summary": "Lunch w/ Sam"}));
    local_patch(&db, &id, json!({"location": "Cafe"}));
    api.lose_patch_once.borrow_mut().push(id.clone());
    // the first edit lands, its response is lost, and "cal" isn't pulled this pass
    engine.sync_calendars(&[]).unwrap();
    engine.sync_once().unwrap();
    assert_eq!(api.remote_summary(&id), "Lunch w/ Sam");
    assert_eq!(api.events.borrow()[&id]["location"], json!("Cafe"), "the second edit was dropped 'remote wins' against our own first edit");
}

#[test]
fn create_edit_delete_before_sync_stays_deleted_when_the_edit_push_fails_once() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "oops");
    let mut ev = db.get_event("cal", &id).unwrap().unwrap();
    ev.summary = "oops 2".into();
    db.upsert_event(&ev).unwrap();
    db.enqueue_op("cal", &id, OpKind::Patch, Some(&json!({"summary": "oops 2"})), None).unwrap();
    db.delete_event("cal", &id).unwrap();
    db.enqueue_op("cal", &id, OpKind::Delete, None, None).unwrap(); // the row had no etag yet
    api.fail_patch_once.borrow_mut().push(id.clone());
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    engine.sync_once().unwrap();
    assert!(db.get_event("cal", &id).unwrap().is_none(), "the deleted event came back");
    assert!(!api.events.borrow().contains_key(&id), "the delete never reached Google");
}

#[test]
fn a_move_landing_does_not_bring_back_an_event_deleted_after_it() {
    let (db, api) = setup();
    *api.per_cal.borrow_mut() = true;
    api.extra_cals.borrow_mut().push("work".into());
    let id = generate_event_id();
    local_create(&db, &id, "1:1");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    let mut ev = db.get_event("cal", &id).unwrap().unwrap();
    db.delete_event("cal", &id).unwrap();
    ev.calendar_id = "work".into();
    db.upsert_event(&ev).unwrap();
    db.enqueue_op("cal", &id, OpKind::Move, Some(&json!({"destination": "work"})), None).unwrap();
    db.enqueue_op("work", &id, OpKind::Patch, Some(&json!({"summary": "1:1"})), None).unwrap();
    db.delete_event("work", &id).unwrap();
    db.enqueue_op("work", &id, OpKind::Delete, None, ev.etag.as_deref()).unwrap();
    api.fail_patch_once.borrow_mut().push(id.clone());
    engine.sync_once().unwrap();
    assert!(db.get_event("work", &id).unwrap().is_none(), "the deleted event came back when its move landed");
}

#[test]
fn a_lost_move_whose_destination_lookup_fails_keeps_the_edits_after_it() {
    let (db, api) = setup();
    *api.per_cal.borrow_mut() = true;
    api.extra_cals.borrow_mut().push("work".into());
    let id = generate_event_id();
    local_create(&db, &id, "1:1");
    SyncEngine::new(&db, &api).sync_once().unwrap();
    let mut ev = db.get_event("cal", &id).unwrap().unwrap();
    db.delete_event("cal", &id).unwrap();
    ev.calendar_id = "work".into();
    ev.summary = "1:1 renamed".into();
    db.upsert_event(&ev).unwrap();
    db.enqueue_op("cal", &id, OpKind::Move, Some(&json!({"destination": "work"})), None).unwrap();
    db.enqueue_op("work", &id, OpKind::Patch, Some(&json!({"summary": "1:1 renamed"})), None).unwrap();
    db.delete_event("work", &id).unwrap();
    db.enqueue_op("work", &id, OpKind::Delete, None, ev.etag.as_deref()).unwrap();
    *api.lose_move.borrow_mut() = true;
    SyncEngine::new(&db, &api).sync_calendars(&[]).unwrap(); // move lands, response lost, no pull
    // the retry 404s on the source; the lookup of the destination copy hits a 500
    let flaky = FlakyGet(&api, RefCell::new(Some(("work".into(), id.clone()))));
    SyncEngine::new(&db, &flaky).sync_calendars(&["work".to_string()]).unwrap();
    SyncEngine::new(&db, &api).sync_once().unwrap();
    assert!(db.get_event("work", &id).unwrap().is_none(), "the deleted event came back");
    assert!(!api.events.borrow().contains_key(&id), "the delete was dropped");
}

#[test]
fn a_failed_lookup_after_a_conflict_does_not_abort_the_pass() {
    let (db, api) = setup();
    let a = generate_event_id();
    let b = generate_event_id();
    local_create(&db, &a, "A");
    local_create(&db, &b, "B");
    SyncEngine::new(&db, &api).sync_once().unwrap();
    api.remote_edit(&a, "A remote");
    local_patch(&db, &a, json!({"summary": "A local"}));
    local_patch(&db, &b, json!({"summary": "B local"}));
    let flaky = FlakyGet(&api, RefCell::new(Some(("cal".into(), a.clone()))));
    let r = SyncEngine::new(&db, &flaky).sync_once();
    assert!(r.is_ok(), "one event's failed lookup aborted the whole pass: {:?}", r.err());
    assert_eq!(api.remote_summary(&b), "B local", "another event's edit waited on it");
}

#[test]
fn a_matching_remote_clear_is_not_mistaken_for_our_own_landed_edit() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "Standup");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    local_patch(&db, &id, json!({"description": "[DRILL] x"}));
    engine.sync_once().unwrap();
    local_patch(&db, &id, json!({"description": null}));
    local_patch(&db, &id, json!({"summary": "Standup (daily)", "start": {"dateTime": "2026-10-20T10:00:00Z", "date": null},
        "end": {"dateTime": "2026-10-20T11:00:00Z", "date": null}, "description": null, "location": null}));
    api.fail_patch_once.borrow_mut().push(id.clone());
    {   // someone else, in Google Calendar, also clears the note and moves it to 3pm
        let etag = api.next_etag();
        let mut evs = api.events.borrow_mut();
        let ev = evs.get_mut(&id).unwrap();
        ev.as_object_mut().unwrap().remove("description");
        ev["start"] = json!({"dateTime": "2026-10-20T15:00:00Z"});
        ev["end"] = json!({"dateTime": "2026-10-20T16:00:00Z"});
        ev["etag"] = json!(etag);
    }
    api.changed.borrow_mut().push(id.clone());
    engine.sync_once().unwrap();
    engine.sync_once().unwrap();
    assert_eq!(api.events.borrow()[&id]["start"]["dateTime"], "2026-10-20T15:00:00Z",
        "a queued edit made against the old version overwrote a concurrent remote change");
}

#[test]
fn token_expiry_while_a_lost_insert_retries_keeps_the_event() {
    let (db, api) = setup();
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    let id = generate_event_id();
    local_create(&db, &id, "Lunch");
    api.insert_event("cal", &event_body(&id, "Lunch")).unwrap(); // landed, response lost
    api.fail_event_ids.borrow_mut().push(id.clone());
    *api.expire_sync_token.borrow_mut() = true;
    engine.sync_once().unwrap();
    let vanished = db.get_event("cal", &id).unwrap().is_none();
    api.fail_event_ids.borrow_mut().clear();
    let flaky = FlakyGet(&api, RefCell::new(Some(("cal".into(), id.clone()))));
    SyncEngine::new(&db, &flaky).sync_once().unwrap();
    engine.sync_once().unwrap();
    assert!(db.get_event("cal", &id).unwrap().is_some(),
        "the event is on Google but gone locally (vanished after the resync: {vanished})");
}

// ---- policy: your delete wins over a concurrent edit made in Google

#[test]
fn a_delete_wins_over_a_concurrent_remote_edit() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "Dentist");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    let etag = db.get_event("cal", &id).unwrap().unwrap().etag;
    db.delete_event("cal", &id).unwrap();
    db.enqueue_op("cal", &id, OpKind::Delete, None, etag.as_deref()).unwrap();
    api.remote_edit(&id, "Dentist (moved)"); // the delete now 412s
    engine.sync_once().unwrap();
    assert!(!api.events.borrow().contains_key(&id), "the remote edit undid the delete");
    assert!(db.get_event("cal", &id).unwrap().is_none(), "the deleted event came back");
    assert!(db.list_pending_ops().unwrap().is_empty());
}

#[test]
fn a_queued_delete_survives_a_pull_of_a_remote_edit() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "Dentist");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    let etag = db.get_event("cal", &id).unwrap().unwrap().etag;
    db.delete_event("cal", &id).unwrap();
    db.enqueue_op("cal", &id, OpKind::Delete, None, etag.as_deref()).unwrap();
    api.remote_edit(&id, "Dentist (moved)");
    api.fail_event_ids.borrow_mut().push(id.clone()); // the delete fails once: the pull sees the edit first
    engine.sync_once().unwrap();
    assert!(db.get_event("cal", &id).unwrap().is_none(), "the pull brought the deleted event back");
    api.fail_event_ids.borrow_mut().clear();
    engine.sync_once().unwrap();
    assert!(!api.events.borrow().contains_key(&id), "the delete was dropped");
}

#[test]
fn a_delete_after_a_refused_move_deletes_the_event_where_it_is() {
    let (db, api) = setup();
    *api.per_cal.borrow_mut() = true;
    api.extra_cals.borrow_mut().push("work".into());
    let id = generate_event_id();
    local_create(&db, &id, "Seminar");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    // moved to work (Google will refuse), then deleted there
    let mut ev = db.get_event("cal", &id).unwrap().unwrap();
    db.delete_event("cal", &id).unwrap();
    ev.calendar_id = "work".into();
    db.upsert_event(&ev).unwrap();
    db.enqueue_op("cal", &id, OpKind::Move, Some(&json!({"destination": "work"})), None).unwrap();
    db.delete_event("work", &id).unwrap();
    db.enqueue_op("work", &id, OpKind::Delete, None, ev.etag.as_deref()).unwrap();
    *api.refuse_move.borrow_mut() = true;
    engine.sync_once().unwrap();
    engine.sync_once().unwrap();
    assert!(db.list_pending_ops().unwrap().is_empty());
    assert!(db.get_event("cal", &id).unwrap().is_none(), "the event came back on its old calendar");
    assert!(db.get_event("work", &id).unwrap().is_none());
    assert!(!api.events.borrow().contains_key(&id), "the delete never reached Google");
}

// "This and following" queues the new series' insert, then the red-pen note
// as a patch on its first occurrence (found by the 2026-10-19 run 4 pass).
fn queue_split_note(db: &Db, id: &str) -> String {
    local_create(db, id, "Standup");
    let op = db.list_pending_ops().unwrap().remove(0);
    db.remove_op(op.id).unwrap();
    let mut body = event_body(id, "Standup");
    body["recurrence"] = json!(["RRULE:FREQ=DAILY;COUNT=2"]);
    db.enqueue_op("cal", id, OpKind::Insert, Some(&body), None).unwrap();
    let first = format!("{id}_1"); // this fake's id for the first occurrence
    db.enqueue_op("cal", &first, OpKind::Patch, Some(&json!({ "description": "[DRILL] Stay on time" })), None).unwrap();
    first
}

#[test]
fn a_split_note_waits_for_its_series_insert() {
    let (db, api) = setup();
    let id = generate_event_id();
    let first = queue_split_note(&db, &id);
    api.fail_event_ids.borrow_mut().push(id.clone());
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    api.fail_event_ids.borrow_mut().clear();
    engine.sync_once().unwrap();
    assert_eq!(api.events.borrow()[&first]["description"], "[DRILL] Stay on time", "the note was dropped");
}

#[test]
fn a_split_note_survives_one_failed_push() {
    let (db, api) = setup();
    let id = generate_event_id();
    let first = queue_split_note(&db, &id);
    api.fail_patch_once.borrow_mut().push(first.clone());
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    engine.sync_once().unwrap();
    assert_eq!(api.events.borrow()[&first]["description"], "[DRILL] Stay on time", "the note was dropped");
}

#[test]
fn undoing_an_occurrence_delete_during_the_pull_of_its_echo_sticks() {
    let db = Rc::new(Db::open_in_memory().unwrap());
    let api = FakeApi::default();
    let id = "series_20261020T100000Z";
    let mut remote = event_body(id, "Standup");
    remote["recurringEventId"] = json!("series");
    remote["etag"] = json!("\"initial\"");
    api.events.borrow_mut().insert(id.into(), remote);
    SyncEngine::new(&db, &api).sync_once().unwrap();
    let occurrence = db.get_event("cal", id).unwrap().unwrap();
    db.delete_event("cal", id).unwrap();
    db.enqueue_op("cal", id, OpKind::Delete, None, occurrence.etag.as_deref()).unwrap();
    {
        let (db, ev) = (db.clone(), occurrence.clone());
        let fired = RefCell::new(false);
        *api.on_list.borrow_mut() = Some(Box::new(move || {
            if fired.replace(true) {
                return;
            }
            // ⌘Z lands between the push and the pull
            db.upsert_event(&ev).unwrap();
            db.enqueue_op("cal", &ev.id, OpKind::Patch, Some(&json!({ "status": "confirmed" })), None).unwrap();
        }));
    }
    SyncEngine::new(&db, &api).sync_once().unwrap();
    *api.on_list.borrow_mut() = None;
    SyncEngine::new(&db, &api).sync_once().unwrap();
    assert_eq!(api.events.borrow()[id]["status"], "confirmed", "the undo never reached Google");
    assert!(db.get_event("cal", id).unwrap().is_some(), "the restored occurrence vanished again");
}

/// your reply to an invitation, queued while the organizer moves the
/// meeting, must survive: only your responseStatus is in the patch, and the
/// organizer's edit never changes that
#[test]
fn a_reply_queued_while_the_organizer_moves_the_meeting_is_kept() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "Course staff");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    {
        let mut evs = api.events.borrow_mut();
        let ev = evs.get_mut(&id).unwrap();
        ev["organizer"] = json!({"email": "prof@x.edu"});
        ev["attendees"] = json!([{"email": "prof@x.edu", "organizer": true, "responseStatus": "accepted"}, {"email": "me@x.edu", "self": true, "responseStatus": "needsAction"}]);
    }
    api.remote_edit(&id, "Course staff");
    engine.sync_once().unwrap();
    // you answer Yes (respond_event: attendees-only patch against the stored etag)
    local_patch(&db, &id, json!({"attendees": [{"email": "prof@x.edu", "organizer": true, "responseStatus": "accepted"}, {"email": "me@x.edu", "self": true, "responseStatus": "accepted"}]}));
    // ...and before it pushes, the organizer moves the meeting an hour later
    {
        let mut evs = api.events.borrow_mut();
        let ev = evs.get_mut(&id).unwrap();
        ev["start"] = json!({"dateTime": "2026-10-20T11:00:00Z"});
        ev["end"] = json!({"dateTime": "2026-10-20T12:00:00Z"});
    }
    api.remote_edit(&id, "Course staff");
    engine.sync_once().unwrap();
    engine.sync_once().unwrap();
    let mine = api.events.borrow()[&id]["attendees"][1]["responseStatus"].clone();
    assert_eq!(mine, json!("accepted"), "your Yes was dropped 'remote wins'");
    // and the move came through
    let local = db.get_event("cal", &id).unwrap().unwrap();
    assert!(local.start.contains("11:00"), "the organizer's move was lost: {}", local.start);
    assert!(db.list_pending_ops().unwrap().is_empty());
}

// ---- run 5 sync fuzz findings (each failed before its fix) ----

#[test]
fn token_expiry_in_the_pass_that_lost_an_edit_response_keeps_the_edit_behind_it() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "Lunch");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    local_patch(&db, &id, json!({"summary": "Lunch w/ Sam"}));
    local_patch(&db, &id, json!({"location": "Cafe"}));
    // the first edit lands but its response is lost (a read timeout), and the
    // same pass's pull finds the sync token expired
    api.lose_patch_once.borrow_mut().push(id.clone());
    *api.expire_sync_token.borrow_mut() = true;
    engine.sync_once().unwrap();
    let r = engine.sync_once().unwrap();
    assert_eq!(api.remote_summary(&id), "Lunch w/ Sam");
    assert_eq!(api.events.borrow()[&id]["location"], json!("Cafe"),
        "the second edit was dropped 'remote wins' against our own first edit (reverted: {:?})", r.reverted);
}

fn synced_occurrence(db: &Db, api: &FakeApi) -> Event {
    let id = "series_20261020T100000Z";
    let mut remote = event_body(id, "Standup");
    remote["recurringEventId"] = json!("series");
    remote["etag"] = json!("\"initial\"");
    api.events.borrow_mut().insert(id.into(), remote);
    SyncEngine::new(db, api).sync_once().unwrap();
    db.get_event("cal", id).unwrap().unwrap()
}

/// What App.tsx's undo does (do_restore_recurring_occurrence), then a red-pen
/// note on the restored occurrence (do_set_event_note: base = the row's etag).
fn restore_then_note(db: &Db, occurrence: &Event) {
    db.upsert_event(occurrence).unwrap();
    db.enqueue_op("cal", &occurrence.id, OpKind::Patch, Some(&json!({
        "status": "confirmed", "summary": occurrence.summary, "description": occurrence.description,
        "location": occurrence.location, "start": {"dateTime": occurrence.start}, "end": {"dateTime": occurrence.end},
    })), None).unwrap();
    let mut ev = db.get_event("cal", &occurrence.id).unwrap().unwrap();
    ev.description = Some("[DRILL] Keep it short".into());
    db.upsert_event(&ev).unwrap();
    db.enqueue_op("cal", &ev.id, OpKind::Patch, Some(&json!({"description": "[DRILL] Keep it short"})), ev.etag.as_deref()).unwrap();
}

#[test]
fn a_note_after_undoing_an_occurrence_delete_during_the_echo_pull_keeps_the_undo() {
    let db = Rc::new(Db::open_in_memory().unwrap());
    let api = FakeApi::default();
    let occurrence = synced_occurrence(&db, &api);
    let id = occurrence.id.clone();
    db.delete_event("cal", &id).unwrap();
    db.enqueue_op("cal", &id, OpKind::Delete, None, occurrence.etag.as_deref()).unwrap();
    {
        let (db, ev) = (db.clone(), occurrence.clone());
        let fired = RefCell::new(false);
        *api.on_list.borrow_mut() = Some(Box::new(move || {
            if fired.replace(true) { return; }
            // ⌘Z, then a note, between the delete's push and the pull of its echo
            restore_then_note(&db, &ev);
        }));
    }
    SyncEngine::new(&db, &api).sync_once().unwrap();
    *api.on_list.borrow_mut() = None;
    SyncEngine::new(&db, &api).sync_once().unwrap();
    SyncEngine::new(&db, &api).sync_once().unwrap();
    assert_eq!(api.events.borrow()[&id]["status"], "confirmed", "the undo never reached Google");
    assert!(db.get_event("cal", &id).unwrap().is_some(), "the restored occurrence vanished again");
    assert_eq!(api.events.borrow()[&id]["description"], "[DRILL] Keep it short", "the note was dropped");
}

#[test]
fn a_note_after_undoing_an_occurrence_delete_survives_one_failed_restore_push() {
    let (db, api) = setup();
    let occurrence = synced_occurrence(&db, &api);
    let id = occurrence.id.clone();
    // delete, ⌘Z, note: all queued before the next pass
    db.delete_event("cal", &id).unwrap();
    db.enqueue_op("cal", &id, OpKind::Delete, None, occurrence.etag.as_deref()).unwrap();
    restore_then_note(&db, &occurrence);
    api.fail_patch_once.borrow_mut().push(id.clone()); // the restore's push hits a 5xx once
    let engine = SyncEngine::new(&db, &api);
    let r1 = engine.sync_once().unwrap();
    let r2 = engine.sync_once().unwrap();
    assert_eq!(api.events.borrow()[&id]["status"], "confirmed",
        "the undo died: Google keeps the occurrence deleted (reverted: {:?} {:?})", r1.reverted, r2.reverted);
    assert!(db.get_event("cal", &id).unwrap().is_some(), "the restored occurrence vanished");
}

/// "This and following" when the truncate PATCH reaches Google but its
/// response doesn't come back (a read timeout, a 5xx after commit).
/// split_series (src-tauri/src/lib.rs) now re-reads the master, sees the
/// truncation landed, and queues the new series as on success; this is the
/// engine's half of that: the tail's cancellation and the new series'
/// insert in one pass leave every occurrence on the calendar.
#[test]
fn a_split_whose_truncate_landed_but_timed_out_keeps_the_following_occurrences() {
    let (db, api) = setup();
    let master = generate_event_id();
    let mut body = event_body(&master, "Standup");
    body["recurrence"] = json!(["RRULE:FREQ=DAILY;COUNT=2"]);
    api.insert_event("cal", &body).unwrap(); // the fake expands {master}_1, {master}_2
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    let tail = format!("{master}_2");
    assert!(db.get_event("cal", &tail).unwrap().is_some());

    // split_series: local truncate + placeholder for the new series
    let previous = db.list_series_instances("cal", &master).unwrap();
    db.delete_event("cal", &tail).unwrap();
    let new_id = generate_event_id();
    let mut placeholder = previous[0].clone();
    placeholder.id = new_id.clone();
    placeholder.etag = None;
    placeholder.recurring_event_id = None;
    db.upsert_event(&placeholder).unwrap();
    // the truncate lands (Google cancels the tail) but the call errs
    api.lose_patch_once.borrow_mut().push(master.clone());
    let truncate = json!({"recurrence": ["RRULE:FREQ=DAILY;UNTIL=20261020T235959Z"]});
    let sent = api.patch_event("cal", &master, &truncate, None);
    {
        let mut evs = api.events.borrow_mut();
        let t = evs.get_mut(&tail).unwrap();
        t["status"] = json!("cancelled");
        t["etag"] = json!("\"truncated\"");
    }
    api.changed.borrow_mut().push(tail.clone());
    assert!(sent.is_err());
    // split_series re-reads the master: the truncation is there, so it goes
    // on as on success and queues the new series
    assert_eq!(api.get_event("cal", &master).unwrap()["recurrence"], truncate["recurrence"]);
    let mut new_body = event_body(&new_id, "Standup");
    new_body["recurrence"] = json!(["RRULE:FREQ=DAILY;COUNT=1"]);
    db.enqueue_op("cal", &new_id, OpKind::Insert, Some(&new_body), None).unwrap();

    engine.sync_once().unwrap();
    engine.sync_once().unwrap();
    assert!(db.get_event("cal", &tail).unwrap().is_none(), "the truncated tail should be gone");
    let continued = !db.list_series_instances("cal", &new_id).unwrap().is_empty()
        || db.get_event("cal", &new_id).unwrap().is_some();
    assert!(continued, "the occurrences after the split are gone from the calendar");
    assert!(db.list_pending_ops().unwrap().is_empty());
}

#[test]
fn undoing_an_occurrence_delete_whose_response_was_lost_sticks() {
    let (db, api) = setup();
    let occurrence = synced_occurrence(&db, &api);
    let id = occurrence.id.clone();
    db.delete_event("cal", &id).unwrap();
    db.enqueue_op("cal", &id, OpKind::Delete, None, occurrence.etag.as_deref()).unwrap();
    // ⌘Z (do_restore_recurring_occurrence)
    db.upsert_event(&occurrence).unwrap();
    db.enqueue_op("cal", &id, OpKind::Patch, Some(&json!({"status": "confirmed", "summary": "Standup",
        "start": {"dateTime": occurrence.start}, "end": {"dateTime": occurrence.end}})), None).unwrap();
    // the delete lands on Google but its response is lost (read timeout)
    api.delete_event("cal", &id, None).unwrap();
    api.fail_event_ids.borrow_mut().push(id.clone());
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    api.fail_event_ids.borrow_mut().clear();
    engine.sync_once().unwrap();
    engine.sync_once().unwrap();
    assert_eq!(api.events.borrow()[&id]["status"], "confirmed", "the undo died with the delete's echo");
    assert!(db.get_event("cal", &id).unwrap().is_some(), "the restored occurrence vanished");
}

/// Google's quota 403s are temporary (the existing test's own words:
/// "retried, never reverted"), but each refused pass bumps the op's attempts,
/// so the 8th pass (~4 minutes at the 30s interval) reverts the local edit.
#[test]
fn a_quota_refused_edit_is_still_kept_after_many_passes() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "v1");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    let mut ev = db.get_event("cal", &id).unwrap().unwrap();
    ev.summary = "v2".into();
    db.upsert_event(&ev).unwrap();
    local_patch(&db, &id, json!({"summary": "v2"}));
    api.reject_patch.borrow_mut().insert(id.clone(),
        (403, r#"{"error":{"errors":[{"domain":"usageLimits","reason":"dailyLimitExceeded"}]}}"#.into()));
    for _ in 0..8 {
        engine.sync_once().unwrap();
    }
    assert_eq!(db.get_event("cal", &id).unwrap().unwrap().summary, "v2",
        "a quota-refused edit was reverted after 8 passes");
    assert_eq!(db.list_pending_ops().unwrap().len(), 1, "a quota-refused edit was dropped");
    // the quota resets: the edit lands
    api.reject_patch.borrow_mut().clear();
    engine.sync_once().unwrap();
    assert_eq!(api.remote_summary(&id), "v2");
}

/// An event created while Google answers 500 (a backend outage of a few
/// minutes): after 8 failed inserts the "revert" looks the event up, gets
/// 404 (it never landed), and deletes the user's new event locally.
#[test]
fn an_event_created_during_a_google_outage_is_not_erased() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "Dentist");
    api.fail_event_ids.borrow_mut().push(id.clone());
    let engine = SyncEngine::new(&db, &api);
    for _ in 0..8 {
        engine.sync_once().unwrap();
    }
    assert!(db.get_event("cal", &id).unwrap().is_some(), "the new event was erased after 8 failed inserts");
    assert_eq!(db.list_pending_ops().unwrap().len(), 1, "the queued insert was dropped");
    api.fail_event_ids.borrow_mut().clear();
    engine.sync_once().unwrap();
    assert_eq!(api.remote_summary(&id), "Dentist");
}

/// A new recurring series is pushed, then its calendar's pull fails
/// (5xx / rate limit / network blip; the fake's knob is a 404). sync_once's
/// final drop_superseded(None) deletes the placeholder anyway, so the series
/// is on Google but on no local row until a later pass pulls the calendar.
#[test]
fn a_new_series_stays_on_screen_when_its_calendars_pull_fails() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "weekly review");
    let op = db.list_pending_ops().unwrap().remove(0);
    db.remove_op(op.id).unwrap();
    let mut body = event_body(&id, "weekly review");
    body["recurrence"] = json!(["RRULE:FREQ=WEEKLY"]);
    db.enqueue_op("cal", &id, OpKind::Insert, Some(&body), None).unwrap();
    // the insert lands; the events.list that follows fails (insert_event ignores `gone`)
    *api.gone.borrow_mut() = true;
    let report = SyncEngine::new(&db, &api).sync_once().unwrap();
    assert!(api.events.borrow().contains_key(&id), "the insert landed on Google");
    assert!(!report.errors.is_empty(), "the pull of cal failed");
    let shown = db.get_event("cal", &id).unwrap().is_some()
        || !db.list_series_instances("cal", &id).unwrap().is_empty();
    assert!(shown, "the new series vanished: its placeholder was dropped though its calendar never pulled");
}

/// An occurrence deleted ("This event") or noted, its op still queued
/// on the source calendar, then "All events" moved to another calendar
/// (update_series_master: apply_locally moves the rows, Google moves the
/// series with its instances). The queued op still targets the source: the
/// delete 404s and is dropped as "already gone", the note 404s and is
/// reverted; the pull of the destination brings the deleted occurrence back
/// and the note is lost.
#[test]
fn occurrence_ops_queued_before_a_series_move_follow_the_series() {
    let (db, api) = setup();
    *api.per_cal.borrow_mut() = true;
    api.extra_cals.borrow_mut().push("work".into());
    for n in 1..=3 {
        let iid = format!("m_{n}");
        let mut inst = event_body(&iid, "Standup");
        inst["recurringEventId"] = json!("m");
        inst["etag"] = json!(api.next_etag());
        api.events.borrow_mut().insert(iid, inst);
    }
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    assert_eq!(db.list_series_instances("cal", "m").unwrap().len(), 3);

    // do_delete_event("cal", "m_1"): row gone, Delete queued
    let base = db.get_event("cal", "m_1").unwrap().unwrap().etag;
    db.delete_event("cal", "m_1").unwrap();
    db.enqueue_op("cal", "m_1", OpKind::Delete, None, base.as_deref()).unwrap();
    // do_set_event_note("cal", "m_2", ..): row updated, Patch queued
    let mut ev = db.get_event("cal", "m_2").unwrap().unwrap();
    ev.description = Some("[DRILL] came late".into());
    db.upsert_event(&ev).unwrap();
    db.enqueue_op("cal", "m_2", OpKind::Patch, Some(&json!({"description": "[DRILL] came late"})), ev.etag.as_deref()).unwrap();

    // update_series_master("cal", "m", {}, destination "work") before those pushed
    sync_core::series::apply_locally(&db, "cal", "m", &json!({}), Some("work"), None).unwrap();
    for n in 1..=3 {
        let iid = format!("m_{n}");
        api.cal_of.borrow_mut().insert(iid.clone(), "work".into());
        api.changed.borrow_mut().push(iid);
    }
    // (the fake's full listing of one calendar clears every calendar's
    // change feed; Google's feed for work would carry the moved instances:
    // pull work in full instead)
    db.set_sync_token("work", None).unwrap();

    engine.sync_once().unwrap();
    engine.sync_once().unwrap();
    assert!(db.get_event("work", "m_1").unwrap().is_none(), "the deleted occurrence came back after the series move");
    assert!(db.list_pending_ops().unwrap().is_empty());
    assert_eq!(api.events.borrow()["m_2"]["description"], json!("[DRILL] came late"),
        "the occurrence's note never reached Google (its op was dropped; the local row only keeps it until the next remote change)");
}

/// A calendar edited while a pass runs is pulled next, not after every
/// other calendar (a series change showed 15 s later), and each pulled
/// calendar is reported as it lands.
#[test]
fn a_kick_during_a_pass_pulls_that_calendar_next() {
    let (db, api) = setup();
    api.extra_cals.borrow_mut().extend(["b".to_string(), "c".to_string(), "d".to_string()]);
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap(); // the calendars are known
    api.listed.borrow_mut().clear();
    let kicks = RefCell::new(vec![vec!["d".to_string()]]);
    let landed = RefCell::new(Vec::new());
    engine
        .sync_once_with(
            || if api.listed.borrow().len() == 1 { kicks.borrow_mut().pop().unwrap_or_default() } else { Vec::new() },
            |id, _| landed.borrow_mut().push(id.to_string()),
        )
        .unwrap();
    let order = api.listed.borrow().clone();
    assert_eq!(order.first().map(String::as_str), Some("cal"));
    assert_eq!(order.get(1).map(String::as_str), Some("d"), "the kicked calendar waited: {order:?}");
    assert_eq!(order.len(), 4, "a preempted calendar was pulled twice: {order:?}");
    assert_eq!(landed.borrow().len(), 4);
}

/// An edit whose etag went stale (the event changed on Google meanwhile,
/// e.g. a series change gave every occurrence a new etag) is re-applied
/// on top of Google's version instead of being dropped as "remote wins".
#[test]
fn a_stale_edit_is_reapplied_onto_googles_newer_version() {
    let (db, api) = setup();
    let id = generate_event_id();
    local_create(&db, &id, "v1");
    let engine = SyncEngine::new(&db, &api);
    engine.sync_once().unwrap();
    // Google changes the location (new etag); we rename with the old etag
    {
        let mut events = api.events.borrow_mut();
        let ev = events.get_mut(&id).unwrap();
        ev["location"] = json!("Room 4");
        ev["etag"] = json!(api.next_etag());
    }
    let mut ev = db.get_event("cal", &id).unwrap().unwrap();
    ev.summary = "v2".into();
    db.upsert_event(&ev).unwrap();
    local_patch(&db, &id, json!({"summary": "v2"}));
    let report = engine.sync_once().unwrap();
    assert_eq!(api.remote_summary(&id), "v2", "the rename was dropped");
    assert_eq!(api.events.borrow()[&id]["location"], json!("Room 4"), "Google's change was overwritten");
    assert_eq!(report.conflicts, 0);
    assert!(db.list_pending_ops().unwrap().is_empty());
    let local = db.get_event("cal", &id).unwrap().unwrap();
    assert_eq!((local.summary.as_str(), local.location.as_deref()), ("v2", Some("Room 4")));
}
