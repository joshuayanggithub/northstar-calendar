//! App state: DB handle for commands, keychain token store, OAuth config
//! discovery, log setup, and the background sync thread.

use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use sync_core::db::Db;
use sync_core::google::GoogleClient;
use sync_core::models::{OAuthConfig, OAuthTokens};
use sync_core::sync::SyncEngine;
use sync_core::{CoreError, Result as CoreResult, TokenStore};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{error, info, warn};

const SYNC_INTERVAL: Duration = Duration::from_secs(30);

/// Debug builds only: `CAL_SANDBOX=<dir>` runs the app on the data in <dir>
/// (e.g. a copy of calendar.db) with Google sync off and no access to the
/// stored refresh token, so the real window can be tested while the user's
/// own app keeps running on the real data.
pub fn sandbox_dir() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        std::env::var_os("CAL_SANDBOX").map(PathBuf::from)
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

/// Where the app keeps its files: the sandbox when one is set.
pub fn data_dir(app: &AppHandle) -> tauri::Result<PathBuf> {
    match sandbox_dir() {
        Some(d) => Ok(d),
        None => app.path().app_data_dir(),
    }
}
const KEYRING_SERVICE: &str = "com.joshuayang.calendar-app";
const KEYRING_ACCOUNT: &str = "google_refresh_token";

pub enum SyncKick {
    Now,
    /// A change touched these calendars: pull them first (a short pass), so
    /// the result shows without waiting on every other calendar, then run
    /// the regular full pass.
    Calendars(Vec<String>),
}

/// Dev-build token store: a 0600 file in the app data dir. Used in debug
/// builds because every `tauri dev` rebuild is a differently-signed binary,
/// so the keychain re-prompts on each rebuild ("Always Allow" cannot stick).
/// Release builds use the keychain.
#[cfg(debug_assertions)]
pub struct FileTokens {
    path: PathBuf,
}

#[cfg(debug_assertions)]
impl TokenStore for FileTokens {
    fn get_refresh_token(&self) -> Option<String> {
        let s = std::fs::read_to_string(&self.path).ok()?;
        let s = s.trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    }
    fn set_refresh_token(&self, token: &str) -> CoreResult<()> {
        std::fs::write(&self.path, token)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }
    fn clear(&self) -> CoreResult<()> {
        let _ = std::fs::remove_file(&self.path);
        Ok(())
    }
}

pub struct KeychainTokens;

impl TokenStore for KeychainTokens {
    fn get_refresh_token(&self) -> Option<String> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .ok()?
            .get_password()
            .ok()
    }
    fn set_refresh_token(&self, token: &str) -> CoreResult<()> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .and_then(|e| e.set_password(token))
            .map_err(|e| CoreError::Other(format!("keychain: {e}")))
    }
    fn clear(&self) -> CoreResult<()> {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT) {
            let _ = entry.delete_credential();
        }
        Ok(())
    }
}

struct AccessToken {
    token: String,
    expires_at: Instant,
}

pub struct AppState {
    db: Mutex<Db>,
    pub db_path: PathBuf,
    pub tokens: Arc<dyn TokenStore>,
    pub oauth_config: OAuthConfig,
    access: Arc<Mutex<Option<AccessToken>>>,
    kick_tx: Sender<SyncKick>,
    /// Held by the sync thread across each calendar's pull, and by a
    /// recurring-series change for its Google calls + local apply. A pull
    /// that ran between a split's truncate and its new series (or an edit's
    /// patch and its move) caught the series half-changed: gone from view
    /// until the next pass.
    pub sync_gate: Arc<Mutex<()>>,
}

impl AppState {
    pub fn init(app: AppHandle) -> std::result::Result<Self, Box<dyn std::error::Error>> {
        let data_dir = data_dir(&app)?;
        let sandboxed = sandbox_dir().is_some();
        std::fs::create_dir_all(&data_dir)?;
        init_logging(&data_dir);
        if sandboxed {
            info!("SANDBOX: data in {}, Google sync off", data_dir.display());
        }

        let oauth_config = load_oauth_config(sandboxed)?;
        let db_path = data_dir.join("calendar.db");
        info!("opening db at {}", db_path.display());
        let db = Db::open(&db_path)?;

        #[cfg(debug_assertions)]
        let tokens: Arc<dyn TokenStore> = {
            let file = FileTokens { path: data_dir.join("google_refresh.token") };
            // One-time migration from the keychain (single "Allow" click),
            // after which dev builds never touch the keychain again.
            if file.get_refresh_token().is_none() && !sandboxed {
                if let Some(t) = KeychainTokens.get_refresh_token() {
                    let _ = file.set_refresh_token(&t);
                    info!("migrated refresh token from keychain to dev file store");
                }
            }
            Arc::new(file)
        };
        #[cfg(not(debug_assertions))]
        let tokens: Arc<dyn TokenStore> = Arc::new(KeychainTokens);
        let access: Arc<Mutex<Option<AccessToken>>> = Arc::new(Mutex::new(None));
        let (kick_tx, kick_rx) = std::sync::mpsc::channel();
        let sync_gate = Arc::new(Mutex::new(()));

        if !sandboxed {
            spawn_sync_thread(
                app,
                db_path.clone(),
                oauth_config.clone(),
                tokens.clone(),
                access.clone(),
                kick_rx,
                sync_gate.clone(),
            );
        }

        Ok(AppState {
            db: Mutex::new(db),
            db_path,
            tokens,
            oauth_config,
            access,
            kick_tx,
            sync_gate,
        })
    }

    /// Run a closure against the command-side DB connection.
    pub fn db<T>(&self, f: impl FnOnce(&Db) -> CoreResult<T>) -> CoreResult<T> {
        let db = self.db.lock().map_err(|_| CoreError::Other("db lock poisoned".into()))?;
        f(&db)
    }

    pub fn kick_sync(&self, kick: SyncKick) {
        let _ = self.kick_tx.send(kick);
    }

    pub fn set_access_token(&self, t: OAuthTokens) {
        let expires = t.expires_in.unwrap_or(3600).max(60) as u64;
        *self.access.lock().unwrap() = Some(AccessToken {
            token: t.access_token,
            expires_at: Instant::now() + Duration::from_secs(expires - 60),
        });
    }

    pub fn clear_access_token(&self) {
        *self.access.lock().unwrap() = None;
    }

    /// An authenticated Google client for direct (non-queued) API calls such
    /// as calendar management.
    pub fn google_client(&self) -> CoreResult<GoogleClient> {
        let token = current_access_token(&self.oauth_config, self.tokens.as_ref(), &self.access)?;
        Ok(GoogleClient::new(token))
    }
}

/// The sync thread owns its own DB connection (WAL + busy_timeout make the
/// two-connection setup safe; all logical conflict rules live in sync-core).
fn spawn_sync_thread(
    app: AppHandle,
    db_path: PathBuf,
    config: OAuthConfig,
    tokens: Arc<dyn TokenStore>,
    access: Arc<Mutex<Option<AccessToken>>>,
    kick_rx: Receiver<SyncKick>,
    gate: Arc<Mutex<()>>,
) {
    std::thread::Builder::new()
        .name("sync".into())
        .spawn(move || {
            let db = match Db::open(&db_path) {
                Ok(db) => db,
                Err(e) => {
                    error!("sync thread could not open db: {e}");
                    return;
                }
            };
            let mut first: Vec<String> = Vec::new();
            loop {
                if tokens.get_refresh_token().is_some() {
                    match current_access_token(&config, tokens.as_ref(), &access) {
                        Ok(token) => {
                            let client = GoogleClient::new(token);
                            let engine = SyncEngine::new(&db, &client).with_pull_gate(&gate);
                            if !first.is_empty() {
                                match engine.sync_calendars(&first) {
                                    Ok(report) => {
                                        if ui_needs_refresh(&report, &None, &None) {
                                            let _ = app.emit("db-changed", ());
                                        }
                                        // (a refused change reverted in this pass: say so)
                                        if !report.reverted.is_empty() {
                                            let _ = app.emit("sync-status", &report);
                                        }
                                    }
                                    Err(e) => warn!("priority sync failed: {e}"),
                                }
                                first.clear();
                            }
                            let before = calendar_list(&db);
                            // a calendar edited while the pass runs is pulled
                            // next, and the UI refreshes as each calendar
                            // lands (a series change showed 15 s later)
                            let last_pulled = std::cell::Cell::new(0usize);
                            match engine.sync_once_with(
                                || {
                                    let mut ids = Vec::new();
                                    while let Ok(kick) = kick_rx.try_recv() {
                                        if let SyncKick::Calendars(v) = kick {
                                            ids.extend(v);
                                        }
                                    }
                                    ids
                                },
                                |_, report| {
                                    if report.pulled > last_pulled.get() {
                                        last_pulled.set(report.pulled);
                                        let _ = app.emit("db-changed", ());
                                    }
                                },
                            ) {
                                Ok(report) => {
                                    let after = calendar_list(&db);
                                    if before != after {
                                        info!("sync: calendar list changed (a color, name or access)");
                                    }
                                    if ui_needs_refresh(&report, &before, &after) {
                                        info!(
                                            "sync: pushed={} pulled={} conflicts={}",
                                            report.pushed, report.pulled, report.conflicts
                                        );
                                        let _ = app.emit("db-changed", ());
                                    }
                                    if !report.errors.is_empty() {
                                        warn!("sync errors: {:?}", report.errors);
                                    }
                                    let _ = app.emit("sync-status", &report);
                                }
                                // (a pass that couldn't run, or a sign-in
                                // that can't be refreshed, reports too: the
                                // UI said "Synced" and "Connected" regardless)
                                Err(e) => {
                                    warn!("sync failed: {e}");
                                    let _ = app.emit("sync-status", &failed_pass(format!("sync: {e}")));
                                }
                            }
                        }
                        Err(e) => {
                            warn!("token refresh failed: {e}");
                            if e.to_string().contains("invalid_grant") {
                                // Google's refresh token is dead (expired after 7
                                // days while the OAuth app is in Testing, or
                                // revoked): the app said "Connected" and queued a
                                // day of changes without a word. The token goes,
                                // the UI asks to connect again, the queue waits.
                                warn!("Google refresh token expired or revoked: sign-in needed");
                                if let Err(e) = tokens.clear() {
                                    warn!("could not clear the dead refresh token: {e}");
                                }
                                *access.lock().unwrap() = None;
                                let _ = app.emit("auth-changed", false);
                                let _ = app.emit("sync-status", &failed_pass(
                                    "Google sign-in expired or revoked: connect Google again in Settings › Calendar accounts (your changes are kept and sync then)".into(),
                                ));
                            } else {
                                let _ = app.emit("sync-status", &failed_pass(format!("Google sign-in: {e}")));
                            }
                        }
                    }
                }
                // Wait for the next interval or an explicit kick.
                let mut take = |kick: SyncKick| {
                    if let SyncKick::Calendars(ids) = kick {
                        for id in ids {
                            if !first.contains(&id) {
                                first.push(id);
                            }
                        }
                    }
                };
                match kick_rx.recv_timeout(SYNC_INTERVAL) {
                    Ok(kick) => {
                        take(kick);
                        // Drain coalesced kicks so burst edits cause one sync.
                        while let Ok(kick) = kick_rx.try_recv() {
                            take(kick);
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
        })
        .expect("failed to spawn sync thread");
}

/// the calendar list as the interface shows it (colors, names, access), to
/// tell whether a sync changed it
fn calendar_list(db: &Db) -> Option<String> {
    db.list_calendars().ok().and_then(|c| serde_json::to_string(&c).ok())
}

/// Whether the interface must reload after a sync: an event moved either
/// way, or a calendar changed in Google (its color or name) with no event
/// changing at all.
fn ui_needs_refresh(report: &sync_core::SyncReport, before: &Option<String>, after: &Option<String>) -> bool {
    report.pushed + report.pulled + report.conflicts + report.reverted.len() > 0 || before != after
}

/// the report of a pass that didn't run
fn failed_pass(error: String) -> sync_core::models::SyncReport {
    sync_core::models::SyncReport { errors: vec![error], ..Default::default() }
}

fn current_access_token(
    config: &OAuthConfig,
    tokens: &dyn TokenStore,
    access: &Mutex<Option<AccessToken>>,
) -> CoreResult<String> {
    {
        let guard = access.lock().unwrap();
        if let Some(a) = guard.as_ref() {
            if a.expires_at > Instant::now() {
                return Ok(a.token.clone());
            }
        }
    }
    let refresh = tokens
        .get_refresh_token()
        .ok_or_else(|| CoreError::OAuth("no refresh token".into()))?;
    let t = sync_core::oauth::refresh_access_token(config, &refresh)?;
    let expires = t.expires_in.unwrap_or(3600).max(120) as u64;
    let token = t.access_token.clone();
    *access.lock().unwrap() = Some(AccessToken {
        token: token.clone(),
        expires_at: Instant::now() + Duration::from_secs(expires - 60),
    });
    Ok(token)
}

/// Dev-time OAuth config discovery: CALENDAR_APP_OAUTH env var, or
/// .oauth.local.json walking up from the executable/cwd.
fn load_oauth_config(sandboxed: bool) -> std::result::Result<OAuthConfig, Box<dyn std::error::Error>> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("CALENDAR_APP_OAUTH") {
        candidates.push(PathBuf::from(p));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join(".oauth.local.json"));
        candidates.push(cwd.join("../.oauth.local.json"));
        candidates.push(cwd.join("../../.oauth.local.json"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join("calendar-app/.oauth.local.json"));
    }
    for path in candidates {
        if path.is_file() {
            let raw = std::fs::read_to_string(&path)?;
            let v: serde_json::Value = serde_json::from_str(&raw)?;
            let client_id = v["client_id"].as_str().unwrap_or_default().to_string();
            let client_secret = v["client_secret"].as_str().unwrap_or_default().to_string();
            if !client_id.is_empty() {
                info!("oauth config loaded from {}", path.display());
                return Ok(OAuthConfig { client_id, client_secret });
            }
        }
    }
    // A sandbox never starts the sync thread and never opens OAuth. Requiring
    // a developer secret here prevented isolated native E2E on fresh Linux
    // machines even though those credentials could not be used.
    if sandboxed {
        info!("SANDBOX: no OAuth config; using disabled test placeholder");
        return Ok(OAuthConfig {
            client_id: "sandbox-disabled".into(),
            client_secret: String::new(),
        });
    }
    Err("no .oauth.local.json found (set CALENDAR_APP_OAUTH or place it at the repo root)".into())
}

fn init_logging(data_dir: &std::path::Path) {
    let log_dir = data_dir.join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let file_appender = tracing_appender::rolling::daily(&log_dir, "calendar-app.log");
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    let _ = tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stdout))
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(file_appender),
        )
        .try_init();
    info!("logs at {}", log_dir.display());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_calendar_recolored_in_google_reaches_the_interface() {
        let quiet = sync_core::SyncReport::default();
        let black = Some(r##"[{"id":"life","color":"#000000"}]"##.to_string());
        let graphite = Some(r##"[{"id":"life","color":"#c2c2c2"}]"##.to_string());
        // only the color changed, no event did: still reload
        assert!(ui_needs_refresh(&quiet, &black, &graphite));
        // nothing changed at all: stay quiet
        assert!(!ui_needs_refresh(&quiet, &black, &black));
        // events moved: reload as before
        let pulled = sync_core::SyncReport { pulled: 1, ..Default::default() };
        assert!(ui_needs_refresh(&pulled, &black, &black));
    }
}
