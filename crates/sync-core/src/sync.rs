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
    /// Versions our own pushes produced this pass, stored locally or not
    /// (a response superseded by a later delete or move isn't): one coming
    /// back in the pull is our echo, never a remote change.
    own_etags: RefCell<HashSet<String>>,
}

impl<'a> SyncEngine<'a> {
    pub fn new(db: &'a Db, api: &'a dyn CalendarApi) -> Self {
        SyncEngine { db, api, superseded: RefCell::new(Vec::new()), pull_gate: None, own_etags: RefCell::new(HashSet::new()) }
    }

    pub fn with_pull_gate(mut self, gate: &'a Mutex<()>) -> Self {
        self.pull_gate = Some(gate);
        self
    }

    /// One full pass: push pending ops, then pull every calendar incrementally.
    pub fn sync_once(&self) -> Result<SyncReport> {
        self.sync_once_with(Vec::new, |_, _| {})
    }

    /// A full pass that can be preempted: between calendars, `preempt` names
    /// calendars to pull next (a change just made on one: its pull waited
    /// behind the whole pass, 10–15 s over twenty calendars), and `pulled`
    /// hears each calendar as it lands (the UI refreshes then, not at the
    /// end of the pass).
    pub fn sync_once_with(
        &self,
        mut preempt: impl FnMut() -> Vec<String>,
        mut pulled: impl FnMut(&str, &SyncReport),
    ) -> Result<SyncReport> {
        let mut report = SyncReport::default();
        self.refresh_calendars(&mut report)?;
        self.push_pending(&mut report)?;
        let mut failed: HashSet<String> = HashSet::new();
        let mut done: HashSet<String> = HashSet::new();
        let queue: Vec<String> = self.db.list_calendars()?.into_iter().map(|c| c.id).collect();
        let mut pull = |id: &str, report: &mut SyncReport, failed: &mut HashSet<String>| {
            if let Err(e) = self.pull_calendar(id, report) {
                warn!("pull failed for {id}: {e}");
                report.errors.push(format!("{id}: {e}"));
                failed.insert(id.to_string());
            }
            pulled(id, report);
        };
        let mut i = 0;
        loop {
            for id in preempt() {
                if done.insert(id.clone()) {
                    pull(&id, &mut report, &mut failed);
                }
            }
            let Some(id) = queue.get(i) else { break };
            i += 1;
            if done.insert(id.clone()) {
                pull(id, &mut report, &mut failed);
            }
        }
        // (a calendar that didn't pull keeps its placeholders: a new series
        // was on Google but on no local row until a later pass)
        self.drop_superseded_except(&failed)?;
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
        // (no drop of other calendars' placeholders here: their calendars
        // weren't pulled, so the series would blank until the full pass,
        // which follows at once and drops each as its calendar pulls)
        Ok(report)
    }

    /// Remove master placeholders (all of them, or one calendar's).
    fn drop_superseded(&self, calendar_id: Option<&str>) -> Result<()> {
        self.drop_superseded_where(|cal| calendar_id.map_or(true, |c| c == cal))
    }

    fn drop_superseded_except(&self, failed: &HashSet<String>) -> Result<()> {
        self.drop_superseded_where(|cal| !failed.contains(cal))
    }

    fn drop_superseded_where(&self, drop: impl Fn(&str) -> bool) -> Result<()> {
        let mut keep = Vec::new();
        for (cal, id) in self.superseded.borrow_mut().drain(..) {
            if drop(&cal) {
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
                // One gone from the account (unsubscribed or deleted in
                // Google) leaves too: it stayed on screen, 404ing every pass.
                // Not one with changes still queued (the list can lag a
                // just-created calendar; never drop local edits on that).
                let pending = self.db.list_pending_ops()?;
                for local in self.db.list_calendars()? {
                    if !cals.iter().any(|c| c.id == local.id)
                        && !pending.iter().any(|op| op.calendar_id == local.id)
                    {
                        info!("calendar {} is gone from the account; removing it", local.id);
                        self.db.delete_calendar(&local.id)?;
                    }
                }
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
            // an occurrence ({series}_{start}) waits for its series too: a
            // split's note patch sent before the series' insert landed got a
            // 404, which drops it for good
            let series_held = op
                .event_id
                .rsplit_once('_')
                .is_some_and(|(series, _)| held.contains(series));
            if held.contains(&op.event_id) || series_held {
                held.insert(op.event_id.clone());
                continue;
            }
            if op.base_etag.is_some() {
                if let Some(etag) = rebased.get(&op.event_id) {
                    op.base_etag = Some(etag.clone());
                }
            }
            match self.push_op(&op) {
                Ok(unstored) => {
                    self.db.remove_op(op.id)?;
                    report.pushed += 1;
                    // Every queued op carries the etag from when it was made.
                    // Two edits queued between syncs (a note written then
                    // erased, an edit then a delete) both carry the etag from
                    // before the first, so without this the second 412s
                    // against our own write and is dropped "remote wins".
                    if let Some(etag) = unstored.map_or_else(|| self.local_etag_after(&op), |e| Ok(Some(e)))? {
                        self.db.rebase_pending_ops(&op.event_id, &etag)?;
                        rebased.insert(op.event_id.clone(), etag);
                    }
                }
                Err(CoreError::Api { status: 412, .. }) if op.kind == OpKind::Delete => {
                    // Changed in Google since: your delete still wins (you
                    // asked for it gone, as Google's own app deletes whatever
                    // happened to the event meanwhile).
                    match self.api.delete_event(&op.calendar_id, &op.event_id, None) {
                        Ok(()) | Err(CoreError::Api { status: 404 | 410, .. }) => {
                            info!("412 on delete {}: deleted anyway", op.event_id);
                            self.db.delete_event(&op.calendar_id, &op.event_id)?;
                            self.db.remove_op(op.id)?;
                            report.pushed += 1;
                        }
                        Err(e) => {
                            held.insert(op.event_id.clone());
                            report.errors.push(format!("delete {}: {e}", op.event_id));
                        }
                    }
                }
                Err(CoreError::Api { status: 412, .. }) => {
                    // Remote changed under us: remote wins. Refetch, apply, drop op.
                    // (Unless the change is our own edit, landed on an earlier
                    // try whose response was lost: then it's done, and the
                    // edits behind it rebase onto it.)
                    let remote = match self.api.get_event(&op.calendar_id, &op.event_id) {
                        Ok(v) => Some(v),
                        Err(CoreError::Api { status: 404 | 410, .. }) => None,
                        Err(e) => {
                            // can't look now: keep the op, retry next pass
                            // (the pass goes on for every other event)
                            held.insert(op.event_id.clone());
                            report.errors.push(format!("{} {}: {e}", op.kind.as_str(), op.event_id));
                            continue;
                        }
                    };
                    if let Some(v) = remote.as_ref().filter(|v| self.is_our_landed_patch(&op, v)) {
                        self.db.remove_op(op.id)?;
                        report.pushed += 1;
                        if let Some(etag) = v["etag"].as_str() {
                            self.own_etags.borrow_mut().insert(etag.to_string());
                            self.db.rebase_pending_ops(&op.event_id, etag)?;
                            rebased.insert(op.event_id.clone(), etag.to_string());
                            if let Some(mut l) = self.db.get_event(&op.calendar_id, &op.event_id)? {
                                l.etag = Some(etag.to_string());
                                self.db.upsert_event(&l)?;
                            }
                        }
                        continue;
                    }
                    // your answer to an invitation only touches your own
                    // responseStatus, which the organizer's change never
                    // does: put it on their version and send it again
                    if let Some(v) = remote.as_ref().filter(|_| is_reply(&op)) {
                        if self.rebase_reply(&op, v)? {
                            info!("412 on reply {}: rebased onto the organizer's change", op.event_id);
                            held.insert(op.event_id.clone());
                            continue;
                        }
                    }
                    // your edit on Google's newer version: the fields you
                    // changed go on top of it (sent again against its etag),
                    // the rest stays Google's. "Remote wins" dropped an edit
                    // made minutes ago whenever a series change had given the
                    // occurrence a new etag meanwhile.
                    if let (Some(v), OpKind::Patch) = (remote.as_ref(), &op.kind) {
                        if let Some(etag) = v["etag"].as_str() {
                            let mut again = op.clone();
                            again.base_etag = Some(etag.to_string());
                            match self.push_op(&again) {
                                Ok(unstored) => {
                                    info!("412 on patch {}: re-applied onto Google's newer version", op.event_id);
                                    self.db.remove_op(op.id)?;
                                    report.pushed += 1;
                                    if let Some(etag) = unstored.map_or_else(|| self.local_etag_after(&op), |e| Ok(Some(e)))? {
                                        self.db.rebase_pending_ops(&op.event_id, &etag)?;
                                        rebased.insert(op.event_id.clone(), etag);
                                    }
                                    continue;
                                }
                                Err(e) => warn!("412 on patch {}: re-apply failed ({e}); remote wins", op.event_id),
                            }
                        }
                    }
                    info!("412 on {} {}: remote wins", op.kind.as_str(), op.event_id);
                    match remote {
                        Some(v) => self.apply_remote_resource(&op.calendar_id, &v)?,
                        None => self.db.delete_event(&op.calendar_id, &op.event_id)?,
                    }
                    self.db.remove_op(op.id)?;
                    report.conflicts += 1;
                }
                Err(CoreError::Api { status: 409, .. }) if op.kind == OpKind::Insert => {
                    // Insert already landed (retry after lost response): treat as success.
                    if let Err(e) = self.adopt_remote(&op) {
                        // couldn't look it up: keep the op (the next try
                        // 409s again), or the event was gone for good
                        held.insert(op.event_id.clone());
                        report.errors.push(format!("{} {}: {e}", op.kind.as_str(), op.event_id));
                        continue;
                    }
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
                    // A refusal (400/403/404…) never succeeds on a retry: an
                    // invitation you can't edit, a single occurrence moved
                    // to another calendar, an event gone remotely. A
                    // temporary failure (Google down or rate-limiting, no
                    // network, a stale token) is retried for as long as it
                    // lasts: counted attempts gave up after 8 passes, which
                    // reverted the edit, and erased an event created during
                    // a 4-minute outage (its "revert" found nothing remote).
                    let permanent = match &e {
                        CoreError::Api { status: 401 | 408 | 429, .. } => false,
                        CoreError::Api { status: 403, body } => !["ateLimitExceeded", "quotaExceeded", "dailyLimitExceeded", "usageLimits"]
                            .iter()
                            .any(|reason| body.contains(reason)),
                        CoreError::Api { status, .. } => (400..500).contains(status),
                        _ => false,
                    };
                    let attempts = if permanent { MAX_OP_ATTEMPTS } else { self.db.bump_op_attempts(op.id)? };
                    warn!(
                        "push {} {} failed (attempt {attempts}): {e}",
                        op.kind.as_str(),
                        op.event_id
                    );
                    report.errors.push(format!("{} {}: {e}", op.kind.as_str(), op.event_id));
                    if permanent {
                        // Giving up: put the local copy back to Google's, or
                        // the rejected edit (or move) shows forever, since
                        // nothing changed remotely for a pull to correct.
                        let title = self
                            .db
                            .get_event(&op.calendar_id, &op.event_id)
                            .ok()
                            .flatten()
                            .map(|e| e.summary)
                            .unwrap_or_default();
                        match self.revert_to_remote(&op) {
                            Ok(landed) => {
                                report.reverted.push(title);
                                warn!("dropping op after {attempts} attempts; local copy reverted");
                                self.db.remove_op(op.id)?;
                                // a move that had landed after all: what was
                                // queued behind it goes ahead from its version
                                if let Some(etag) = landed {
                                    held.remove(&op.event_id);
                                    rebased.insert(op.event_id.clone(), etag);
                                }
                            }
                            // can't reach Google to revert: keep it for later
                            Err(re) => warn!("revert of {} failed: {re}", op.event_id),
                        }
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

    /// Returns the etag of a response that wasn't stored because a later
    /// delete or move supersedes it: the ops queued behind rebase onto it.
    fn push_op(&self, op: &PendingOp) -> Result<Option<String>> {
        match op.kind {
            OpKind::Insert => {
                let body = op.payload.clone().ok_or_else(|| CoreError::Other("insert without payload".into()))?;
                let created = self.api.insert_event(&op.calendar_id, &body)?;
                self.note_own(&created);
                if self.superseded(op)? {
                    return Ok(created["etag"].as_str().map(String::from));
                }
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
                self.note_own(&updated);
                // a later delete or move settles the local row: writing the
                // response back put a moved event back on its old calendar
                if self.superseded(op)? {
                    return Ok(updated["etag"].as_str().map(String::from));
                }
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
                self.note_own(&moved);
                self.db.delete_event(&op.calendar_id, &op.event_id)?;
                // deleted (or moved on) after the move: it lands, but
                // writing it onto the destination brought it back
                if self.superseded_on(&dest, op)? {
                    return Ok(moved["etag"].as_str().map(String::from));
                }
                self.apply_remote_resource(&dest, &moved)?;
            }
        }
        Ok(None)
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
            // its series' placeholder (an optimistic master row from the
            // push, kept while its calendar's pull failed) goes with the
            // first instance that arrives: this engine's list of placeholders
            // to swap doesn't outlive the pass
            if let Some(master) = ev.recurring_event_id.as_deref() {
                if self.db.get_event(calendar_id, master)?.is_some_and(|m| m.recurrence.is_some()) {
                    self.db.delete_event(calendar_id, master)?;
                }
            }
        }
        Ok(())
    }

    /// An op Google will never take: the local store goes back to what
    /// Google has (a move's destination copy goes; a rejected insert, absent
    /// remotely, goes too; a rejected delete comes back). Returns the version
    /// of a move found already landed: the ops queued behind it were made on
    /// the moved event, so they go on from that version.
    fn revert_to_remote(&self, op: &PendingOp) -> Result<Option<String>> {
        // A later queued delete, or move off this calendar, of the same event
        // settles its local state: Google's copy written back here would
        // bring a deleted event back, or show a moved one twice.
        if op.kind != OpKind::Move && self.superseded(op)? {
            return Ok(None);
        }
        if op.kind == OpKind::Move {
            if let Some(dest) = op.payload.as_ref().and_then(|p| p["destination"].as_str()) {
                if dest != op.calendar_id {
                    // a retry of a move that already landed (its response
                    // was lost) 404s on the source: the event is on dest
                    match self.api.get_event(dest, &op.event_id) {
                        Ok(v) if v["status"].as_str() != Some("cancelled") => {
                            self.db.delete_event(&op.calendar_id, &op.event_id)?;
                            let etag = v["etag"].as_str().map(String::from);
                            if let Some(etag) = &etag {
                                self.db.rebase_pending_ops(&op.event_id, etag)?;
                            }
                            // (unless it was deleted there since)
                            if !self.superseded_on(dest, op)? {
                                self.apply_remote_resource(dest, &v)?;
                            }
                            return Ok(etag);
                        }
                        Ok(_) | Err(CoreError::Api { status: 404 | 410, .. }) => {}
                        // can't tell where it is right now: keep the op
                        Err(e) => return Err(e),
                    }
                    self.db.delete_event(dest, &op.event_id)?;
                    // The event stays where it was: what was queued for it on
                    // the destination (a delete, an edit) applies there
                    // instead. A delete after a refused move brought the
                    // event back on its old calendar.
                    self.db.retarget_ops(&op.event_id, dest, &op.calendar_id, op.id)?;
                    if self.superseded(op)? {
                        self.db.delete_event(&op.calendar_id, &op.event_id)?;
                        return Ok(None);
                    }
                }
            }
        }
        match self.api.get_event(&op.calendar_id, &op.event_id) {
            Ok(v) => self.apply_remote_resource(&op.calendar_id, &v)?,
            Err(CoreError::Api { status: 404 | 410, .. }) => {
                // gone, or the calendar can't be reached right now: the next
                // pull is a full one, so an event still on Google comes back
                // (an incremental feed never re-sends an unchanged event)
                self.db.delete_event(&op.calendar_id, &op.event_id)?;
                self.db.set_sync_token(&op.calendar_id, None)?;
            }
            Err(e) => return Err(e),
        }
        Ok(None)
    }

    /// A later queued delete, or move off this calendar, of the same event.
    fn superseded(&self, op: &PendingOp) -> Result<bool> {
        self.superseded_on(&op.calendar_id, op)
    }

    /// A later queued delete, or move off `calendar_id`, of op's event.
    fn superseded_on(&self, calendar_id: &str, op: &PendingOp) -> Result<bool> {
        Ok(self.db.list_pending_ops()?.into_iter().any(|later| {
            later.id > op.id
                && later.event_id == op.event_id
                && later.calendar_id == calendar_id
                && matches!(later.kind, OpKind::Delete | OpKind::Move)
        }))
    }

    fn note_own(&self, v: &Value) {
        if let Some(etag) = v["etag"].as_str() {
            self.own_etags.borrow_mut().insert(etag.to_string());
        }
    }

    /// Our queued edit already on Google (a try whose response was lost):
    /// what Google has carries every field the edit sent, and every field it
    /// didn't send is still as it was when the edit was made (the local
    /// row's copy of Google's resource). A concurrent remote change that
    /// happens to match the sent fields differs elsewhere.
    fn is_our_landed_patch(&self, op: &PendingOp, v: &Value) -> bool {
        if op.kind != OpKind::Patch {
            return false;
        }
        let Some(sent) = op.payload.as_ref().and_then(|p| p.as_object()).filter(|o| !o.is_empty()) else {
            return false;
        };
        if !carries(v, &Value::Object(sent.clone())) {
            return false;
        }
        let Ok(Some(local)) = self.db.get_event(&op.calendar_id, &op.event_id) else { return false };
        let Some(base) = local.raw.as_ref() else { return false };
        ["summary", "description", "location", "start", "end", "status", "recurrence"]
            .iter()
            .filter(|k| !sent.contains_key(**k))
            .all(|k| v.get(*k).unwrap_or(&Value::Null) == base.get(*k).unwrap_or(&Value::Null))
    }

    /// Your reply put onto Google's version of the event: the local row takes
    /// that version with your responseStatus on it, and a fresh reply op is
    /// queued against its etag. False when you aren't a guest of it.
    fn rebase_reply(&self, op: &PendingOp, v: &Value) -> Result<bool> {
        let Some(me) = v["attendees"]
            .as_array()
            .and_then(|a| a.iter().find(|x| x["self"].as_bool() == Some(true)))
            .and_then(|x| x["email"].as_str())
            .map(str::to_lowercase)
        else {
            return Ok(false);
        };
        let Some(status) = op
            .payload
            .as_ref()
            .and_then(|p| p["attendees"].as_array())
            .and_then(|a| a.iter().find(|x| x["email"].as_str().is_some_and(|e| e.to_lowercase() == me)))
            .and_then(|x| x["responseStatus"].as_str())
            .map(String::from)
        else {
            return Ok(false);
        };
        let mut merged = v.clone();
        if let Some(list) = merged["attendees"].as_array_mut() {
            for x in list.iter_mut() {
                if x["email"].as_str().is_some_and(|e| e.to_lowercase() == me) {
                    x["responseStatus"] = Value::String(status.clone());
                }
            }
        }
        if let Some(ev) = event_from_google(&op.calendar_id, &merged) {
            self.db.upsert_event(&ev)?;
        }
        let body = serde_json::json!({ "attendees": merged["attendees"] });
        self.db.remove_op(op.id)?;
        self.db.enqueue_op(&op.calendar_id, &op.event_id, OpKind::Patch, Some(&body), v["etag"].as_str())?;
        Ok(true)
    }

    /// Store Google's copy of an insert that already landed. Only a lookup
    /// that says it's gone counts as done; any other failure is an error, so
    /// the op stays for the next try.
    fn adopt_remote(&self, op: &PendingOp) -> Result<()> {
        match self.api.get_event(&op.calendar_id, &op.event_id) {
            Ok(v) => {
                self.note_own(&v);
                if !self.superseded(op)? {
                    self.apply_remote_resource(&op.calendar_id, &v)?;
                }
                Ok(())
            }
            Err(CoreError::Api { status: 404 | 410, .. }) => Ok(()),
            Err(e) => Err(e),
        }
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
            // A full resync wipes the calendar, and with it the local state
            // of edits still queued. An event whose remote is unchanged since
            // its ops were made (every base etag matches) keeps its local copy
            // (or stays deleted) and its ops, instead of the ops being dropped
            // "remote wins" against nobody; a queued insert, not on Google
            // yet, is put back.
            let mut pending: HashMap<String, (Option<Event>, Vec<Option<String>>)> = HashMap::new();
            if full {
                for op in self.db.list_pending_ops()? {
                    if op.calendar_id != calendar_id {
                        continue;
                    }
                    if !pending.contains_key(&op.event_id) {
                        let local = self.db.get_event(calendar_id, &op.event_id)?;
                        pending.insert(op.event_id.clone(), (local, Vec::new()));
                    }
                    pending.get_mut(&op.event_id).unwrap().1.push(op.base_etag.clone());
                }
                self.db.delete_events_for_calendar(calendar_id)?;
            }
            for v in &events {
                let mut kept_local = None;
                if let Some((local, bases)) = v["id"].as_str().and_then(|id| pending.remove(id)) {
                    let etag = v["etag"].as_str();
                    // unconditional ops (no base: an edit right after a create
                    // or move) are judged by the local row's version instead
                    let unchanged = etag.is_some()
                        && match &local {
                            Some(l) if l.etag.is_some() => l.etag.as_deref() == etag,
                            _ => bases.iter().all(|b| b.as_deref() == etag),
                        };
                    if unchanged {
                        if let Some(local) = local {
                            self.db.upsert_event(&local)?;
                        }
                        continue;
                    }
                    // put our copy back first: apply_incoming judges a lost
                    // response's echo against it (is_our_landed_patch), and
                    // dropped the edit queued behind it against nobody
                    if let Some(l) = &local {
                        self.db.upsert_event(l)?;
                    }
                    kept_local = local;
                }
                if self.apply_incoming(calendar_id, v)? {
                    report.pulled += 1;
                } else if let Some(local) = kept_local {
                    // skipped as our own (an insert whose response was
                    // lost, an echo): the wiped calendar keeps our copy
                    if self.db.get_event(calendar_id, &local.id)?.is_none() {
                        self.db.upsert_event(&local)?;
                    }
                }
            }
            for (local, _) in pending.into_values() {
                if let Some(local) = local.filter(|l| l.etag.is_none()) {
                    self.db.upsert_event(&local)?;
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

        // A move off this calendar is still queued: the event lives on the
        // destination now (the move carries it, with this change, across).
        // Writing it back here showed it twice and dropped the move.
        let has_ops = self.db.has_pending_op_for(calendar_id, &incoming.id)?;
        if has_ops
            && self.db.list_pending_ops()?.into_iter().any(|op| {
                op.kind == OpKind::Move && op.calendar_id == calendar_id && op.event_id == incoming.id
            })
        {
            return Ok(false);
        }

        // A version our own push produced this pass (its response not stored:
        // a later delete or move superseded it): our echo, not a remote change
        if has_ops && incoming.etag.as_ref().is_some_and(|e| self.own_etags.borrow().contains(e)) {
            return Ok(false);
        }

        // Our own create, or move onto this calendar, landed but its response
        // was lost: ids are client-generated, so nobody else made this copy.
        // The queued insert/move retries and adopts it (409, or a 404 on the
        // source) and the edits queued behind it still go.
        if has_ops
            && self.db.list_pending_ops()?.iter().any(|o| {
                o.event_id == incoming.id
                    && match o.kind {
                        OpKind::Insert => o.calendar_id == calendar_id,
                        OpKind::Move => {
                            o.payload.as_ref().and_then(|p| p["destination"].as_str()) == Some(calendar_id)
                        }
                        _ => false,
                    }
            })
        {
            return Ok(false);
        }

        // Our first queued edit landed but its response was lost: what came
        // back carries exactly what it sent. Dropping every op "remote wins"
        // lost the edits queued behind it; those rebase onto this version.
        if has_ops {
            let ops: Vec<PendingOp> = self
                .db
                .list_pending_ops()?
                .into_iter()
                .filter(|o| o.calendar_id == calendar_id && o.event_id == incoming.id)
                .collect();
            if let [first, _, ..] = ops.as_slice() {
                if self.is_our_landed_patch(first, v) {
                    self.db.remove_op(first.id)?;
                    if let Some(etag) = incoming.etag.as_deref() {
                        self.db.rebase_pending_ops(&incoming.id, etag)?;
                        if let Some(mut l) = local {
                            l.etag = incoming.etag.clone();
                            self.db.upsert_event(&l)?;
                        }
                    }
                    return Ok(false);
                }
            }
        }

        // Every queued op was made against exactly this version: it is our
        // own write coming back after the local row changed (a delete made
        // while the pull downloaded the echo), not a remote edit.
        if has_ops
            && self
                .db
                .list_pending_ops()?
                .iter()
                .filter(|o| o.calendar_id == calendar_id && o.event_id == incoming.id)
                .all(|o| o.base_etag.is_some() && o.base_etag == incoming.etag)
        {
            return Ok(false);
        }

        // You deleted it and the delete is still queued: an edit made in
        // Google meanwhile doesn't bring it back (the delete wins when it
        // pushes). Cancelled remotely too: just gone.
        if has_ops && incoming.status != "cancelled" {
            let last = self
                .db
                .list_pending_ops()?
                .into_iter()
                .filter(|o| o.calendar_id == calendar_id && o.event_id == incoming.id)
                .last();
            if last.is_some_and(|o| o.kind == OpKind::Delete) {
                return Ok(false);
            }
        }

        if has_ops {
            let ops: Vec<PendingOp> = self
                .db
                .list_pending_ops()?
                .into_iter()
                .filter(|o| o.calendar_id == calendar_id && o.event_id == incoming.id)
                .collect();
            let unconditional = |o: &PendingOp| o.kind == OpKind::Patch && o.base_etag.is_none();
            // Only unconditional patches for a row we never had: a split's
            // note on its new series' first occurrence, whose first push
            // failed. Take the occurrence and let the note go on the next push
            // (remote-wins dropped it for good).
            if local.is_none() && ops.iter().all(unconditional) {
                if incoming.status != "cancelled" {
                    self.db.upsert_event(&incoming)?;
                }
                return Ok(true);
            }
            // ⌘Z of a delete queued its restore while this pull was bringing
            // the delete's own cancellation back: the restore wins (dropping
            // it lost the occurrence on Google and spent the undo).
            let restore = |o: &PendingOp| {
                unconditional(o) && o.payload.as_ref().is_some_and(|p| p["status"] == "confirmed")
            };
            // (whatever was queued after the restore, a note say, rides along;
            // a Delete still queued from a lost response is older than it)
            let last_restore = ops.iter().rposition(restore);
            let last_delete = ops.iter().rposition(|o| o.kind == OpKind::Delete);
            if incoming.status == "cancelled" && last_restore.is_some_and(|r| last_delete.map_or(true, |d| r > d)) {
                return Ok(false);
            }
        }

        // Remote changed an event we also changed locally (op still queued):
        // remote wins, drop our op (and its stale If-Match would 412 anyway).
        // Your answer to an invitation is the exception: it goes onto the
        // organizer's version instead.
        let reply = if has_ops {
            let reply = self
                .db
                .list_pending_ops()?
                .into_iter()
                .filter(|o| o.calendar_id == calendar_id && o.event_id == incoming.id)
                .filter(is_reply)
                .last();
            self.db.remove_ops_for_event(calendar_id, &incoming.id)?;
            reply
        } else {
            None
        };

        if incoming.status == "cancelled" {
            self.db.delete_event(calendar_id, &incoming.id)?;
        } else {
            self.db.upsert_event(&incoming)?;
            if let Some(op) = reply {
                self.rebase_reply(&op, v)?;
            }
        }
        Ok(true)
    }
}

/// An answer to an invitation: a patch of the attendees and nothing else
/// (what respond_event queues).
fn is_reply(op: &PendingOp) -> bool {
    op.kind == OpKind::Patch
        && op
            .payload
            .as_ref()
            .and_then(|p| p.as_object())
            .is_some_and(|o| o.len() == 1 && o.contains_key("attendees"))
}

/// Every field of `sent` is in `got` (objects compared field by field; a
/// null clears the field). Google normalizes some values (times gain a time
/// zone, say), so a miss only means we can't tell: the caller falls back.
fn carries(got: &Value, sent: &Value) -> bool {
    match (got, sent) {
        (_, Value::Object(s)) => s.iter().all(|(k, sv)| carries(got.get(k).unwrap_or(&Value::Null), sv)),
        (g, Value::Null) => g.is_null(),
        (g, s) => g == s,
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
