//! Platform-agnostic Google Calendar sync core.
//!
//! No Tauri (or any OS-specific) dependencies live here so the crate can be
//! reused unchanged by desktop and future mobile shells. The host provides
//! token persistence via [`TokenStore`] and drives [`sync::SyncEngine`].

pub mod db;
pub mod google;
pub mod models;
pub mod oauth;
pub mod series;
pub mod sync;

pub use db::Db;
pub use models::*;
pub use sync::SyncEngine;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("http error: {0}")]
    Http(String),
    #[error("google api error (status {status}): {body}")]
    Api { status: u16, body: String },
    #[error("oauth error: {0}")]
    OAuth(String),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;

impl From<ureq::Error> for CoreError {
    fn from(e: ureq::Error) -> Self {
        match e {
            ureq::Error::Status(status, resp) => {
                let body = resp.into_string().unwrap_or_default();
                CoreError::Api { status, body }
            }
            other => CoreError::Http(other.to_string()),
        }
    }
}

/// Host-provided persistence for OAuth tokens (e.g. the OS keychain).
pub trait TokenStore: Send + Sync {
    fn get_refresh_token(&self) -> Option<String>;
    fn set_refresh_token(&self, token: &str) -> Result<()>;
    fn clear(&self) -> Result<()>;
}
