use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Calendar {
    pub id: String,
    pub summary: String,
    pub color: Option<String>,
    pub is_primary: bool,
    pub hidden: bool,
    /// Google accessRole: owner | writer | reader | freeBusyReader
    #[serde(default = "default_access_role")]
    pub access_role: String,
}

fn default_access_role() -> String {
    "owner".into()
}

/// Local representation of an event. `start`/`end` are RFC3339 timestamps for
/// timed events, or `YYYY-MM-DD` dates when `all_day` is true. `raw` keeps the
/// full Google resource so fields we don't model survive round-trips.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub id: String,
    pub calendar_id: String,
    pub etag: Option<String>,
    pub summary: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub timezone: Option<String>,
    pub status: String,
    pub recurrence: Option<Vec<String>>,
    pub recurring_event_id: Option<String>,
    pub conference_url: Option<String>,
    pub updated: Option<String>,
    pub raw: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpKind {
    Insert,
    Patch,
    Delete,
    /// Move an event to another calendar (payload: {"destination": id}).
    Move,
}

impl OpKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            OpKind::Insert => "insert",
            OpKind::Patch => "patch",
            OpKind::Delete => "delete",
            OpKind::Move => "move",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "insert" => Some(OpKind::Insert),
            "patch" => Some(OpKind::Patch),
            "delete" => Some(OpKind::Delete),
            "move" => Some(OpKind::Move),
            _ => None,
        }
    }
}

/// A queued local mutation waiting to be pushed to Google.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingOp {
    pub id: i64,
    pub calendar_id: String,
    pub event_id: String,
    pub kind: OpKind,
    /// Google event resource to send (None for deletes).
    pub payload: Option<serde_json::Value>,
    /// etag the mutation was based on, for If-Match.
    pub base_etag: Option<String>,
    pub attempts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct OAuthConfig {
    pub client_id: String,
    pub client_secret: String,
}

/// Outcome of one sync pass, for surfacing to the UI.
#[derive(Debug, Default, Clone, Serialize)]
pub struct SyncReport {
    pub pushed: usize,
    pub pulled: usize,
    pub conflicts: usize,
    pub errors: Vec<String>,
    /// titles of events whose local change Google refused for good; the
    /// local copy went back to Google's (the UI says so)
    pub reverted: Vec<String>,
}
