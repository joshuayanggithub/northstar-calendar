//! The sync engine. Concurrency-safety rules (see plan):
//! single-writer Db, If-Match on push, echo suppression by etag,
//! client-generated event IDs, idempotent queue, 410 full resync.

use crate::db::Db;
use crate::google::{event_from_google, CalendarApi};
use crate::models::*;
use crate::{CoreError, Result};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tracing::{info, warn};

const MAX_OP_ATTEMPTS: i64 = 8;

pub struct SyncEngine<'a> {
    pub db: &'a Db,
    pub api: &'a dyn CalendarApi,
    /// Local placeholder rows of recurring masters we just pushed. They stay
    /// on screen until their calendar's pull stores the expanded instances,
    /// and leave in the same transaction (see apply_remote_resource).
    superseded: RefCell<Vec<(String, String)>>,
    /// Held across each calendar's download + apply. A caller making a
    /// multi-step remote change (e.g. truncate a series, then start a new
    /// one) holds it too, so no pull can capture the change half done.
    pull_gate: Option<&'a Mutex<()>>,
}

impl<'a> SyncEngine<'a> {
    pub fn new(db: &'a Db, api: &'a dyn CalendarApi) -> Self {
        SyncEngine { db, api, superseded: RefCell::new(Vec::new()), pull_gate: None }
    }

    pub fn with_pull_gate(mut self, gate: &'a Mutex<()>) -> Self {
        self.pull_gate = Some(gate);
        self
    }

    /// One full pass: push pending ops, then pull every calendar incrementally.
    pub fn sync_once(&self) -> Result<SyncReport> {
        let mut report = SyncReport::default();
        self.refresh_calendars(&mut report)?;
        self.push_pending(&mut report)?;
        for cal in self.db.list_calendars()? {
            if let Err(e) = self.pull_calendar(&cal.id, &mut report) {
                warn!("pull failed for {}: {e}", cal.id);
                report.errors.push(format!("{}: {e}", cal.id));
            }
        }
        self.drop_superseded(None)?;
        Ok(report)
    }

    /// A short pass right after a local change: push, then pull only the
    /// calendars that change touched, so it shows up without waiting on every
    /// other calendar's round trip. The regular full pass follows.
    pub fn sync_calendars(&self, calendar_ids: &[String]) -> Result<SyncReport> {
        let mut report = SyncReport::default();
        self.push_pending(&mut report)?;
        for id in calendar_ids {
            if let Err(e) = self.pull_calendar(id, &mut report) {
                warn!("pull failed for {id}: {e}");
                report.errors.push(format!("{id}: {e}"));
            }
        }
        self.drop_superseded(None)?;
        Ok(report)
    }

    /// Remove master placeholders (all of them, or one calendar's).
    fn drop_superseded(&self, calendar_id: Option<&str>) -> Result<()> {
        let mut keep = Vec::new();
        for (cal, id) in self.superseded.borrow_mut().drain(..) {
            if calendar_id.map_or(true, |c| c == cal) {
                self.db.delete_event(&cal, &id)?;
            } else {
                keep.push((cal, id));
            }
        }
        *self.superseded.borrow_mut() = keep;
        Ok(())
    }

    fn refresh_calendars(&self, report: &mut SyncReport) -> Result<()> {
        match self.api.list_calendars() {
            Ok(cals) => {
                for c in cals {
                    self.db.upsert_calendar(&c)?;
                }
                Ok(())
            }
            Err(e) => {
                report.errors.push(format!("calendarList: {e}"));
                Ok(()) // non-fatal: sync known calendars anyway
            }
        }
    }

    // ---- push ----

    fn push_pending(&self, report: &mut SyncReport) -> Result<()> {
        // Events whose earlier op failed this pass: their later ops wait, so
        // a retry can never land after (and undo) a newer edit.
        let mut held: HashSet<String> = HashSet::new();
        // etags our own pushes produced this pass (the queue was read up front)
        let mut rebased: HashMap<String, String> = HashMap::new();
        for mut op in self.db.list_pending_ops()? {
            if held.contains(&op.event_id) {
                continue;
            }
            if op.base_etag.is_some() {
                if let Some(etag) = rebased.get(&op.event_id) {
                    op.base_etag = Some(etag.clone());
                }
            }
            match self.push_op(&op) {
                Ok(()) => {
                    self.db.remove_op(op.id)?;
                    report.pushed += 1;
                    // Every queued op carries the etag from when it was made.
                    // Two edits queued between syncs (a note written then
                    // erased, an edit then a delete) both carry the etag from
                    // before the first, so without this the second 412s
                    // against our own write and is dropped "remote wins".
                    if let Some(etag) = self.local_etag_after(&op)? {
                        self.db.rebase_pending_ops(&op.event_id, &etag)?;
                        rebased.insert(op.event_id.clone(), etag);
                    }
                }
                Err(CoreError::Api { status: 412, .. }) => {
                    // Remote changed under us: remote wins. Refetch, apply, drop op.
                    info!("412 on {} {}: remote wins", op.kind.as_str(), op.event_id);
                    self.resolve_conflict_remote_wins(&op)?;
                    self.db.remove_op(op.id)?;
                    report.conflicts += 1;
                }
                Err(CoreError::Api { status: 409, .. }) if op.kind == OpKind::Insert => {
                    // Insert already landed (retry after lost response): treat as success.
                    self.adopt_remote(&op)?;
                    self.db.remove_op(op.id)?;
                    report.pushed += 1;
                }
                Err(CoreError::Api { status: 404 | 410, .. }) if op.kind == OpKind::Delete => {
                    // Already gone remotely.
                    self.db.remove_op(op.id)?;
                    report.pushed += 1;
                }
                Err(e) => {
                    held.insert(op.event_id.clone());
                    let attempts = self.db.bump_op_attempts(op.id)?;
                    warn!(
                        "push {} {} failed (attempt {attempts}): {e}",
                        op.kind.as_str(),
                        op.event_id
                    );
                    report.errors.push(format!("{} {}: {e}", op.kind.as_str(), op.event_id));
                    if attempts >= MAX_OP_ATTEMPTS {
                        warn!("dropping op after {MAX_OP_ATTEMPTS} attempts");
                        self.db.remove_op(op.id)?;
                    }
                    // A failed op for one event must not block others: continue.
                }
            }
        }
        Ok(())
    }

    /// The etag our just-pushed op left on the local event, if it still exists.
    fn local_etag_after(&self, op: &PendingOp) -> Result<Option<String>> {
        let calendar_id = match op.kind {
            OpKind::Move => op.payload.as_ref().and_then(|p| p["destination"].as_str()).map(String::from),
            OpKind::Delete => None,
            _ => Some(op.calendar_id.clone()),
        };
        let Some(calendar_id) = calendar_id else { return Ok(None) };
        Ok(self.db.get_event(&calendar_id, &op.event_id)?.and_then(|e| e.etag))
    }

    fn push_op(&self, op: &PendingOp) -> Result<()> {
        match op.kind {
            OpKind::Insert => {
                let body = op.payload.clone().ok_or_else(|| CoreError::Other("insert without payload".into()))?;
                let created = self.api.insert_event(&op.calendar_id, &body)?;
                self.apply_remote_resource(&op.calendar_id, &created)?;
            }
            OpKind::Patch => {
                let body = op.payload.clone().ok_or_else(|| CoreError::Other("patch without payload".into()))?;
                let updated = self.api.patch_event(
                    &op.calendar_id,
                    &op.event_id,
                    &body,
                    op.base_etag.as_deref(),
                )?;
                self.apply_remote_resource(&op.calendar_id, &updated)?;
            }
            OpKind::Delete => {
                self.api.delete_event(&op.calendar_id, &op.event_id, op.base_etag.as_deref())?;
                self.db.delete_event(&op.calendar_id, &op.event_id)?;
            }
            OpKind::Move => {
                // op.calendar_id is the SOURCE; payload carries the destination.
                let dest = op
                    .payload
                    .as_ref()
                    .and_then(|p| p["destination"].as_str())
                    .ok_or_else(|| CoreError::Other("move without destination".into()))?
                    .to_string();
                let moved = self.api.move_event(&op.calendar_id, &op.event_id, &dest)?;
                self.db.delete_event(&op.calendar_id, &op.event_id)?;
                self.apply_remote_resource(&dest, &moved)?;
            }
        }
        Ok(())
    }

    /// Store the resource Google returned from our own write. Updating the
    /// local etag to the returned one is what makes echo suppression work:
    /// when the same change comes back via incremental sync its etag matches
    /// and we skip it, so it can never clobber a newer local edit.
    ///
    /// A returned RECURRING MASTER is not stored: we sync with
    /// singleEvents=true, so only expanded instances live locally. The
    /// optimistic master row is swapped for those instances inside the pull
    /// that brings them; deleting it here left the edited occurrence missing
    /// from the screen until that pull landed.
    fn apply_remote_resource(&self, calendar_id: &str, v: &Value) -> Result<()> {
        let is_master = v["recurrence"].as_array().map(|a| !a.is_empty()).unwrap_or(false);
        if is_master {
            if let Some(id) = v["id"].as_str() {
                self.superseded.borrow_mut().push((calendar_id.to_string(), id.to_string()));
            }
            return Ok(());
        }
        if let Some(ev) = event_from_google(calendar_id, v) {
            self.db.upsert_event(&ev)?;
        }
        Ok(())
    }

    fn resolve_conflict_remote_wins(&self, op: &PendingOp) -> Result<()> {
        match self.api.get_event(&op.calendar_id, &op.event_id) {
            Ok(v) => self.apply_remote_resource(&op.calendar_id, &v),
            Err(CoreError::Api { status: 404 | 410, .. }) => {
                self.db.delete_event(&op.calendar_id, &op.event_id)
            }
            Err(e) => Err(e),
        }
    }

    fn adopt_remote(&self, op: &PendingOp) -> Result<()> {
        if let Ok(v) = self.api.get_event(&op.calendar_id, &op.event_id) {
            self.apply_remote_resource(&op.calendar_id, &v)?;
        }
        Ok(())
    }

    // ---- pull ----

    /// Download every page, then apply them in one transaction. The UI
    /// re-reads the store on any db-changed (an edit, the classifier, another
    /// kick), so applying page by page let it catch a calendar half-pulled:
    /// a series' old instances cancelled but its regenerated ones not stored
    /// yet, which read as the whole series vanishing until the next pass. The
    /// 410 resync was worse: the calendar sat empty for the whole download.
    fn pull_calendar(&self, calendar_id: &str, report: &mut SyncReport) -> Result<()> {
        let _gate = self.pull_gate.map(|g| g.lock().unwrap_or_else(|p| p.into_inner()));
        let sync_token = self.db.get_sync_token(calendar_id)?;
        let (events, next_token, full) = match self.fetch_pages(calendar_id, sync_token.as_deref()) {
            Err(CoreError::Api { status: 410, .. }) => {
                // Sync token expired: full resync converges by construction.
                info!("sync token expired for {calendar_id}; full resync");
                let (events, token) = self.fetch_pages(calendar_id, None)?;
                (events, token, true)
            }
            Ok((events, token)) => (events, token, false),
            Err(e) => return Err(e),
        };
        self.db.in_transaction(|| {
            if full {
                self.db.delete_events_for_calendar(calendar_id)?;
            }
            for v in &events {
                if self.apply_incoming(calendar_id, v)? {
                    report.pulled += 1;
                }
            }
            self.drop_superseded(Some(calendar_id))?;
            if let Some(t) = &next_token {
                self.db.set_sync_token(calendar_id, Some(t))?;
            }
            Ok(())
        })
    }

    /// All pages of one events.list run, and the sync token that ends it.
    fn fetch_pages(&self, calendar_id: &str, sync_token: Option<&str>) -> Result<(Vec<Value>, Option<String>)> {
        let mut events = Vec::new();
        let mut page_token: Option<String> = None;
        loop {
            let page = self
                .api
                .list_events_page(calendar_id, sync_token, page_token.as_deref())?;
            events.extend(page.events);
            if let Some(t) = page.next_sync_token {
                return Ok((events, Some(t)));
            }
            match page.next_page_token {
                Some(t) => page_token = Some(t),
                // No sync token and no page token: initial windowed sync pages
                // are done but Google only returns nextSyncToken on the last
                // page; defensive stop.
                None => return Ok((events, None)),
            }
        }
    }

    /// Apply one incoming remote event. Returns true if it changed local state.
    fn apply_incoming(&self, calendar_id: &str, v: &Value) -> Result<bool> {
        let Some(incoming) = event_from_google(calendar_id, v) else {
            return Ok(false);
        };
        let local = self.db.get_event(calendar_id, &incoming.id)?;

        // Echo suppression: our own write coming back.
        if let Some(ref l) = local {
            if l.etag.is_some() && l.etag == incoming.etag {
                return Ok(false);
            }
        }

        // Remote changed an event we also changed locally (op still queued):
        // remote wins, drop our op (and its stale If-Match would 412 anyway).
        if self.db.has_pending_op_for(calendar_id, &incoming.id)? {
            self.db.remove_ops_for_event(calendar_id, &incoming.id)?;
        }

        if incoming.status == "cancelled" {
            self.db.delete_event(calendar_id, &incoming.id)?;
        } else {
            self.db.upsert_event(&incoming)?;
        }
        Ok(true)
    }
}

/// Generate a client-side event id Google accepts (base32hex, 5-1024 chars).
/// Client-generated ids make offline creates idempotent: a retried insert
/// returns 409, which the engine treats as success.
pub fn generate_event_id() -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuv";
    let mut rng = rand::thread_rng();
    (0..26).map(|_| ALPHABET[rng.gen_range(0..32)] as char).collect()
}
