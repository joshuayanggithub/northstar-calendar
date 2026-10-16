use crate::models::*;
use crate::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

/// Single-connection SQLite store. All mutations must flow through one `Db`
/// instance owned by one thread/actor — rusqlite's Connection is !Sync, which
/// enforces the single-writer rule at compile time.
pub struct Db {
    conn: Connection,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db = Db { conn };
        db.migrate()?;
        Ok(db)
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Db { conn };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        // Sync-format epoch. v2 = singleEvents (expanded recurring instances).
        // Bumping it wipes synced data so the next pass is a clean full resync.
        // v2 = singleEvents (expanded recurring instances); v3 = calendars
        // reseeded so Google's "selected" flag initializes local visibility;
        // v4 = calendars.access_role column (reseeded again to populate it).
        const SYNC_EPOCH: i64 = 4;
        let v: i64 = self.conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        let has_tables: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='events'",
            [],
            |r| r.get(0),
        )?;
        if has_tables > 0 && v < SYNC_EPOCH {
            if v < 2 {
                self.conn.execute_batch(
                    "DELETE FROM events; DELETE FROM sync_state; DELETE FROM pending_ops;",
                )?;
            }
            if v < 3 {
                self.conn.execute_batch("DELETE FROM calendars;")?;
            }
            if v < 4 {
                let _ = self
                    .conn
                    .execute_batch("ALTER TABLE calendars ADD COLUMN access_role TEXT NOT NULL DEFAULT 'owner';");
                self.conn.execute_batch("DELETE FROM calendars;")?;
            }
        }
        self.conn
            .pragma_update(None, "user_version", SYNC_EPOCH)?;
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS calendars (
                id TEXT PRIMARY KEY,
                summary TEXT NOT NULL,
                color TEXT,
                is_primary INTEGER NOT NULL DEFAULT 0,
                hidden INTEGER NOT NULL DEFAULT 0,
                access_role TEXT NOT NULL DEFAULT 'owner'
            );
            CREATE TABLE IF NOT EXISTS events (
                id TEXT NOT NULL,
                calendar_id TEXT NOT NULL,
                etag TEXT,
                summary TEXT NOT NULL DEFAULT '',
                description TEXT,
                location TEXT,
                start TEXT NOT NULL,
                end TEXT NOT NULL,
                all_day INTEGER NOT NULL DEFAULT 0,
                timezone TEXT,
                status TEXT NOT NULL DEFAULT 'confirmed',
                recurrence TEXT,
                recurring_event_id TEXT,
                conference_url TEXT,
                updated TEXT,
                raw TEXT,
                PRIMARY KEY (calendar_id, id)
            );
            CREATE INDEX IF NOT EXISTS idx_events_start ON events (start);
            CREATE TABLE IF NOT EXISTS pending_ops (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                calendar_id TEXT NOT NULL,
                event_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                payload TEXT,
                base_etag TEXT,
                attempts INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS sync_state (
                calendar_id TEXT PRIMARY KEY,
                sync_token TEXT,
                last_sync TEXT
            );
            "#,
        )?;
        Ok(())
    }

    // ---- calendars ----

    pub fn upsert_calendar(&self, c: &Calendar) -> Result<()> {
        self.conn.execute(
            "INSERT INTO calendars (id, summary, color, is_primary, hidden, access_role)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET summary=?2, color=?3, is_primary=?4, access_role=?6",
            params![
                c.id,
                c.summary,
                c.color,
                c.is_primary as i64,
                c.hidden as i64,
                c.access_role
            ],
        )?;
        Ok(())
    }

    pub fn list_calendars(&self) -> Result<Vec<Calendar>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, summary, color, is_primary, hidden, access_role FROM calendars ORDER BY is_primary DESC, summary")?;
        let rows = stmt.query_map([], |r| {
            Ok(Calendar {
                id: r.get(0)?,
                summary: r.get(1)?,
                color: r.get(2)?,
                is_primary: r.get::<_, i64>(3)? != 0,
                hidden: r.get::<_, i64>(4)? != 0,
                access_role: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn set_calendar_hidden(&self, id: &str, hidden: bool) -> Result<()> {
        self.conn.execute(
            "UPDATE calendars SET hidden=?2 WHERE id=?1",
            params![id, hidden as i64],
        )?;
        Ok(())
    }

    // ---- events ----

    pub fn upsert_event(&self, e: &Event) -> Result<()> {
        self.conn.execute(
            "INSERT INTO events (id, calendar_id, etag, summary, description, location, start, end,
                                 all_day, timezone, status, recurrence, recurring_event_id,
                                 conference_url, updated, raw)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
             ON CONFLICT(calendar_id, id) DO UPDATE SET
                etag=?3, summary=?4, description=?5, location=?6, start=?7, end=?8,
                all_day=?9, timezone=?10, status=?11, recurrence=?12, recurring_event_id=?13,
                conference_url=?14, updated=?15, raw=?16",
            params![
                e.id,
                e.calendar_id,
                e.etag,
                e.summary,
                e.description,
                e.location,
                e.start,
                e.end,
                e.all_day as i64,
                e.timezone,
                e.status,
                e.recurrence.as_ref().map(|r| serde_json::to_string(r).unwrap_or_default()),
                e.recurring_event_id,
                e.conference_url,
                e.updated,
                e.raw.as_ref().map(|r| r.to_string()),
            ],
        )?;
        Ok(())
    }

    pub fn delete_event(&self, calendar_id: &str, event_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM events WHERE calendar_id=?1 AND id=?2",
            params![calendar_id, event_id],
        )?;
        Ok(())
    }

    pub fn delete_events_for_calendar(&self, calendar_id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM events WHERE calendar_id=?1", params![calendar_id])?;
        Ok(())
    }

    pub fn get_event(&self, calendar_id: &str, event_id: &str) -> Result<Option<Event>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, calendar_id, etag, summary, description, location, start, end, all_day,
                    timezone, status, recurrence, recurring_event_id, conference_url, updated, raw
             FROM events WHERE calendar_id=?1 AND id=?2",
        )?;
        let row = stmt
            .query_row(params![calendar_id, event_id], row_to_event)
            .optional()?;
        Ok(row)
    }

    /// Events overlapping [start, end) by their start/end strings. RFC3339 and
    /// YYYY-MM-DD both sort lexicographically within their kind, which is good
    /// enough for windowed queries (callers pass wide windows).
    pub fn list_events_between(&self, start: &str, end: &str) -> Result<Vec<Event>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, calendar_id, etag, summary, description, location, start, end, all_day,
                    timezone, status, recurrence, recurring_event_id, conference_url, updated, raw
             FROM events
             WHERE status != 'cancelled' AND end >= ?1 AND start < ?2
             ORDER BY start",
        )?;
        let rows = stmt.query_map(params![start, end], row_to_event)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    // ---- pending ops ----

    pub fn enqueue_op(
        &self,
        calendar_id: &str,
        event_id: &str,
        kind: OpKind,
        payload: Option<&serde_json::Value>,
        base_etag: Option<&str>,
    ) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO pending_ops (calendar_id, event_id, kind, payload, base_etag)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                calendar_id,
                event_id,
                kind.as_str(),
                payload.map(|p| p.to_string()),
                base_etag
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn list_pending_ops(&self) -> Result<Vec<PendingOp>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, calendar_id, event_id, kind, payload, base_etag, attempts
             FROM pending_ops ORDER BY id",
        )?;
        let rows = stmt.query_map([], |r| {
            let kind_s: String = r.get(3)?;
            let payload_s: Option<String> = r.get(4)?;
            Ok(PendingOp {
                id: r.get(0)?,
                calendar_id: r.get(1)?,
                event_id: r.get(2)?,
                kind: OpKind::parse(&kind_s).unwrap_or(OpKind::Patch),
                payload: payload_s.and_then(|s| serde_json::from_str(&s).ok()),
                base_etag: r.get(5)?,
                attempts: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn has_pending_op_for(&self, calendar_id: &str, event_id: &str) -> Result<bool> {
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM pending_ops WHERE calendar_id=?1 AND event_id=?2",
            params![calendar_id, event_id],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    pub fn remove_op(&self, op_id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM pending_ops WHERE id=?1", params![op_id])?;
        Ok(())
    }

    pub fn remove_ops_for_event(&self, calendar_id: &str, event_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM pending_ops WHERE calendar_id=?1 AND event_id=?2",
            params![calendar_id, event_id],
        )?;
        Ok(())
    }

    pub fn bump_op_attempts(&self, op_id: i64) -> Result<i64> {
        self.conn.execute(
            "UPDATE pending_ops SET attempts = attempts + 1 WHERE id=?1",
            params![op_id],
        )?;
        let attempts: i64 = self.conn.query_row(
            "SELECT attempts FROM pending_ops WHERE id=?1",
            params![op_id],
            |r| r.get(0),
        )?;
        Ok(attempts)
    }

    // ---- sync state ----

    pub fn get_sync_token(&self, calendar_id: &str) -> Result<Option<String>> {
        let tok = self
            .conn
            .query_row(
                "SELECT sync_token FROM sync_state WHERE calendar_id=?1",
                params![calendar_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?;
        Ok(tok.flatten())
    }

    pub fn set_sync_token(&self, calendar_id: &str, token: Option<&str>) -> Result<()> {
        self.conn.execute(
            "INSERT INTO sync_state (calendar_id, sync_token, last_sync)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(calendar_id) DO UPDATE SET sync_token=?2, last_sync=datetime('now')",
            params![calendar_id, token],
        )?;
        Ok(())
    }
}

fn row_to_event(r: &rusqlite::Row<'_>) -> rusqlite::Result<Event> {
    let recurrence_s: Option<String> = r.get(11)?;
    let raw_s: Option<String> = r.get(15)?;
    Ok(Event {
        id: r.get(0)?,
        calendar_id: r.get(1)?,
        etag: r.get(2)?,
        summary: r.get(3)?,
        description: r.get(4)?,
        location: r.get(5)?,
        start: r.get(6)?,
        end: r.get(7)?,
        all_day: r.get::<_, i64>(8)? != 0,
        timezone: r.get(9)?,
        status: r.get(10)?,
        recurrence: recurrence_s.and_then(|s| serde_json::from_str(&s).ok()),
        recurring_event_id: r.get(12)?,
        conference_url: r.get(13)?,
        updated: r.get(14)?,
        raw: raw_s.and_then(|s| serde_json::from_str(&s).ok()),
    })
}
