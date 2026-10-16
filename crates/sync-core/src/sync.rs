//! The sync engine. Concurrency-safety rules (see plan):
//! single-writer Db, If-Match on push, echo suppression by etag,
//! client-generated event IDs, idempotent queue, 410 full resync.

use crate::db::Db;
use crate::google::{event_from_google, CalendarApi};
use crate::models::*;
use crate::{CoreError, Result};
use serde_json::Value;
use tracing::{info, warn};

const MAX_OP_ATTEMPTS: i64 = 8;

pub struct SyncEngine<'a> {
    pub db: &'a Db,
    pub api: &'a dyn CalendarApi,
}

impl<'a> SyncEngine<'a> {
    pub fn new(db: &'a Db, api: &'a dyn CalendarApi) -> Self {
        SyncEngine { db, api }
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
        Ok(report)
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
        for op in self.db.list_pending_ops()? {
            match self.push_op(&op) {
                Ok(()) => {
                    self.db.remove_op(op.id)?;
                    report.pushed += 1;
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
    /// singleEvents=true, so only expanded instances live locally — the
    /// optimistic master row is removed and instances arrive on the next pull.
    fn apply_remote_resource(&self, calendar_id: &str, v: &Value) -> Result<()> {
        let is_master = v["recurrence"].as_array().map(|a| !a.is_empty()).unwrap_or(false);
        if is_master {
            if let Some(id) = v["id"].as_str() {
                self.db.delete_event(calendar_id, id)?;
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

    fn pull_calendar(&self, calendar_id: &str, report: &mut SyncReport) -> Result<()> {
        let sync_token = self.db.get_sync_token(calendar_id)?;
        match self.pull_pages(calendar_id, sync_token.as_deref(), report) {
            Err(CoreError::Api { status: 410, .. }) => {
                // Sync token expired: full resync converges by construction.
                info!("sync token expired for {calendar_id}; full resync");
                self.db.set_sync_token(calendar_id, None)?;
                self.db.delete_events_for_calendar(calendar_id)?;
                self.pull_pages(calendar_id, None, report)
            }
            other => other,
        }
    }

    fn pull_pages(
        &self,
        calendar_id: &str,
        sync_token: Option<&str>,
        report: &mut SyncReport,
    ) -> Result<()> {
        let mut page_token: Option<String> = None;
        loop {
            let page = self
                .api
                .list_events_page(calendar_id, sync_token, page_token.as_deref())?;
            for v in &page.events {
                if self.apply_incoming(calendar_id, v)? {
                    report.pulled += 1;
                }
            }
            if let Some(t) = page.next_sync_token {
                self.db.set_sync_token(calendar_id, Some(&t))?;
                return Ok(());
            }
            match page.next_page_token {
                Some(t) => page_token = Some(t),
                // No sync token and no page token: initial windowed sync pages
                // are done but Google only returns nextSyncToken on the last
                // page; defensive stop.
                None => return Ok(()),
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
