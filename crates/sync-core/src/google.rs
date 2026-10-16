//! Thin Google Calendar v3 REST client plus the `CalendarApi` trait the sync
//! engine is written against (so tests can substitute a fake server).

use crate::models::{Calendar, Event};
use crate::{CoreError, Result};
use serde::Deserialize;
use serde_json::Value;

const BASE: &str = "https://www.googleapis.com/calendar/v3";

/// One page of an events.list response, normalized.
#[derive(Debug, Default)]
pub struct EventsPage {
    pub events: Vec<Value>,
    pub next_page_token: Option<String>,
    pub next_sync_token: Option<String>,
}

/// What the sync engine needs from Google. Implemented by [`GoogleClient`]
/// for production and by fakes in tests.
pub trait CalendarApi {
    fn list_calendars(&self) -> Result<Vec<Calendar>>;
    fn list_events_page(
        &self,
        calendar_id: &str,
        sync_token: Option<&str>,
        page_token: Option<&str>,
    ) -> Result<EventsPage>;
    /// Returns the created/updated resource. `If-Match` is sent when `etag` is Some.
    fn insert_event(&self, calendar_id: &str, body: &Value) -> Result<Value>;
    fn patch_event(&self, calendar_id: &str, event_id: &str, body: &Value, etag: Option<&str>) -> Result<Value>;
    fn delete_event(&self, calendar_id: &str, event_id: &str, etag: Option<&str>) -> Result<()>;
    fn get_event(&self, calendar_id: &str, event_id: &str) -> Result<Value>;
    /// Move an event to another calendar. Default errs for fakes that don't model it.
    fn move_event(&self, _calendar_id: &str, _event_id: &str, _destination: &str) -> Result<Value> {
        Err(crate::CoreError::Other("move_event not supported".into()))
    }
}

pub struct GoogleClient {
    access_token: String,
    agent: ureq::Agent,
}

impl GoogleClient {
    pub fn new(access_token: String) -> Self {
        GoogleClient { access_token, agent: ureq::agent() }
    }

    fn auth(&self, req: ureq::Request) -> ureq::Request {
        req.set("Authorization", &format!("Bearer {}", self.access_token))
    }
}

#[derive(Deserialize)]
struct CalendarListResponse {
    items: Option<Vec<Value>>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct EventsResponse {
    items: Option<Vec<Value>>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
    #[serde(rename = "nextSyncToken")]
    next_sync_token: Option<String>,
}

impl CalendarApi for GoogleClient {
    fn list_calendars(&self) -> Result<Vec<Calendar>> {
        let mut out = Vec::new();
        let mut page_token: Option<String> = None;
        loop {
            let mut req = self.auth(self.agent.get(&format!("{BASE}/users/me/calendarList")));
            if let Some(t) = &page_token {
                req = req.query("pageToken", t);
            }
            let resp: CalendarListResponse = req.call()?.into_json().map_err(CoreError::from)?;
            for item in resp.items.unwrap_or_default() {
                out.push(Calendar {
                    id: item["id"].as_str().unwrap_or_default().to_string(),
                    summary: item["summaryOverride"]
                        .as_str()
                        .or(item["summary"].as_str())
                        .unwrap_or_default()
                        .to_string(),
                    color: item["backgroundColor"].as_str().map(String::from),
                    is_primary: item["primary"].as_bool().unwrap_or(false),
                    // Seed local visibility from Google's "selected" checkbox;
                    // only applies on first insert (local toggles are kept).
                    hidden: !item["selected"].as_bool().unwrap_or(false),
                    access_role: item["accessRole"].as_str().unwrap_or("reader").to_string(),
                });
            }
            page_token = resp.next_page_token;
            if page_token.is_none() {
                break;
            }
        }
        Ok(out)
    }

    fn list_events_page(
        &self,
        calendar_id: &str,
        sync_token: Option<&str>,
        page_token: Option<&str>,
    ) -> Result<EventsPage> {
        let url = format!("{BASE}/calendars/{}/events", urlencode(calendar_id));
        // singleEvents expands recurring series into instances, which is what
        // the local store renders. Params must stay identical across the
        // initial request and every syncToken request, or Google returns 400.
        let mut req = self
            .auth(self.agent.get(&url))
            .query("maxResults", "250")
            .query("singleEvents", "true")
            .query("showDeleted", "true");
        match (sync_token, page_token) {
            (_, Some(p)) => req = req.query("pageToken", p),
            (Some(s), None) => req = req.query("syncToken", s),
            (None, None) => {
                // Initial full sync: bound the window to keep first sync fast.
                // (timeMin/timeMax are allowed here and are remembered by the
                // returned sync token; they may not be sent WITH a syncToken.)
                let now = chrono::Utc::now();
                let min = (now - chrono::Duration::days(365)).to_rfc3339();
                let max = (now + chrono::Duration::days(730)).to_rfc3339();
                req = req.query("timeMin", &min).query("timeMax", &max);
            }
        }
        let resp: EventsResponse = req.call()?.into_json().map_err(CoreError::from)?;
        Ok(EventsPage {
            events: resp.items.unwrap_or_default(),
            next_page_token: resp.next_page_token,
            next_sync_token: resp.next_sync_token,
        })
    }

    fn insert_event(&self, calendar_id: &str, body: &Value) -> Result<Value> {
        let url = format!("{BASE}/calendars/{}/events", urlencode(calendar_id));
        let resp = self
            .auth(self.agent.post(&url))
            .query("conferenceDataVersion", "1")
            .send_json(body.clone())?;
        Ok(resp.into_json().map_err(CoreError::from)?)
    }

    fn patch_event(&self, calendar_id: &str, event_id: &str, body: &Value, etag: Option<&str>) -> Result<Value> {
        let url = format!(
            "{BASE}/calendars/{}/events/{}",
            urlencode(calendar_id),
            urlencode(event_id)
        );
        let mut req = self
            .auth(self.agent.request("PATCH", &url))
            .query("conferenceDataVersion", "1");
        if let Some(e) = etag {
            req = req.set("If-Match", e);
        }
        let resp = req.send_json(body.clone())?;
        Ok(resp.into_json().map_err(CoreError::from)?)
    }

    fn delete_event(&self, calendar_id: &str, event_id: &str, etag: Option<&str>) -> Result<()> {
        let url = format!(
            "{BASE}/calendars/{}/events/{}",
            urlencode(calendar_id),
            urlencode(event_id)
        );
        let mut req = self.auth(self.agent.delete(&url));
        if let Some(e) = etag {
            req = req.set("If-Match", e);
        }
        req.call()?;
        Ok(())
    }

    fn get_event(&self, calendar_id: &str, event_id: &str) -> Result<Value> {
        let url = format!(
            "{BASE}/calendars/{}/events/{}",
            urlencode(calendar_id),
            urlencode(event_id)
        );
        Ok(self.auth(self.agent.get(&url)).call()?.into_json().map_err(CoreError::from)?)
    }

    fn move_event(&self, calendar_id: &str, event_id: &str, destination: &str) -> Result<Value> {
        let url = format!(
            "{BASE}/calendars/{}/events/{}/move",
            urlencode(calendar_id),
            urlencode(event_id)
        );
        let resp = self
            .auth(self.agent.post(&url))
            .query("destination", destination)
            .send_bytes(&[])?;
        Ok(resp.into_json().map_err(CoreError::from)?)
    }
}

impl GoogleClient {
    /// Fetch the recurrence's expanded instances, including cancelled ones,
    /// so a COUNT-based split can retain exactly its remaining occurrences.
    pub fn list_series_instances(&self, calendar_id: &str, master_id: &str) -> Result<Vec<Value>> {
        let url = format!(
            "{BASE}/calendars/{}/events/{}/instances",
            urlencode(calendar_id), urlencode(master_id)
        );
        let mut out = Vec::new();
        let mut page_token: Option<String> = None;
        loop {
            let mut req = self.auth(self.agent.get(&url))
                .query("maxResults", "2500")
                .query("showDeleted", "true");
            if let Some(token) = &page_token {
                req = req.query("pageToken", token);
            }
            let page: EventsResponse = req.call()?.into_json().map_err(CoreError::from)?;
            out.extend(page.items.unwrap_or_default());
            if out.len() > 5000 {
                return Err(CoreError::Other("series has too many instances to split safely".into()));
            }
            page_token = page.next_page_token;
            if page_token.is_none() {
                return Ok(out);
            }
        }
    }

    /// Create a new secondary calendar owned by the user.
    pub fn create_calendar(&self, summary: &str) -> Result<Value> {
        let resp = self
            .auth(self.agent.post(&format!("{BASE}/calendars")))
            .send_json(serde_json::json!({ "summary": summary }))?;
        Ok(resp.into_json().map_err(CoreError::from)?)
    }

    /// Subscribe to an existing calendar by its id (an email address or a
    /// …@group.calendar.google.com / holiday calendar id).
    pub fn subscribe_calendar(&self, calendar_id: &str) -> Result<Value> {
        let resp = self
            .auth(self.agent.post(&format!("{BASE}/users/me/calendarList")))
            .send_json(serde_json::json!({ "id": calendar_id }))?;
        Ok(resp.into_json().map_err(CoreError::from)?)
    }
}

/// Convert a raw Google event resource into our local [`Event`].
pub fn event_from_google(calendar_id: &str, v: &Value) -> Option<Event> {
    let id = v["id"].as_str()?.to_string();
    let status = v["status"].as_str().unwrap_or("confirmed").to_string();
    let (start, end, all_day, timezone) = if status == "cancelled" {
        // Cancelled events in incremental sync may carry no times.
        (String::new(), String::new(), false, None)
    } else {
        let start_o = &v["start"];
        let end_o = &v["end"];
        if let (Some(sd), Some(ed)) = (start_o["date"].as_str(), end_o["date"].as_str()) {
            (sd.to_string(), ed.to_string(), true, None)
        } else {
            (
                start_o["dateTime"].as_str().unwrap_or_default().to_string(),
                end_o["dateTime"].as_str().unwrap_or_default().to_string(),
                false,
                start_o["timeZone"].as_str().map(String::from),
            )
        }
    };
    let conference_url = v["conferenceData"]["entryPoints"]
        .as_array()
        .and_then(|eps| {
            eps.iter()
                .find(|ep| ep["entryPointType"] == "video")
                .and_then(|ep| ep["uri"].as_str())
        })
        .or(v["hangoutLink"].as_str())
        .map(String::from);
    Some(Event {
        id,
        calendar_id: calendar_id.to_string(),
        etag: v["etag"].as_str().map(String::from),
        summary: v["summary"].as_str().unwrap_or("(no title)").to_string(),
        description: v["description"].as_str().map(String::from),
        location: v["location"].as_str().map(String::from),
        start,
        end,
        all_day,
        timezone,
        status,
        recurrence: v["recurrence"].as_array().map(|a| {
            a.iter().filter_map(|r| r.as_str().map(String::from)).collect()
        }),
        recurring_event_id: v["recurringEventId"].as_str().map(String::from),
        conference_url,
        updated: v["updated"].as_str().map(String::from),
        raw: Some(v.clone()),
    })
}

fn urlencode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}
