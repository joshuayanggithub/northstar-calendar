//! OAuth 2.0 installed-app flow with PKCE over a loopback redirect.
//!
//! The "client secret" of a Google Desktop-app client is not confidential;
//! PKCE (S256) is what actually protects the exchange.

use crate::models::{OAuthConfig, OAuthTokens};
use crate::{CoreError, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;

pub const SCOPE: &str = "https://www.googleapis.com/auth/calendar";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

pub struct PkceFlow {
    config: OAuthConfig,
    verifier: String,
    listener: TcpListener,
    pub redirect_uri: String,
    pub auth_url: String,
}

impl PkceFlow {
    /// Bind the loopback listener and build the browser URL. The caller opens
    /// `auth_url` in the system browser, then calls [`wait_for_code`].
    pub fn start(config: OAuthConfig) -> Result<Self> {
        let mut bytes = [0u8; 48];
        rand::thread_rng().fill_bytes(&mut bytes);
        let verifier = URL_SAFE_NO_PAD.encode(bytes);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));

        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let redirect_uri = format!("http://127.0.0.1:{port}");

        let auth_url = format!(
            "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}\
             &code_challenge={challenge}&code_challenge_method=S256\
             &access_type=offline&prompt=consent",
            urlencode(&config.client_id),
            urlencode(&redirect_uri),
            urlencode(SCOPE),
        );

        Ok(PkceFlow { config, verifier, listener, redirect_uri, auth_url })
    }

    /// Block until the browser redirects back with ?code=..., then exchange it.
    pub fn wait_for_code(self) -> Result<OAuthTokens> {
        let code = accept_redirect(&self.listener)?;
        exchange(
            &self.config,
            &[
                ("code", code.as_str()),
                ("code_verifier", self.verifier.as_str()),
                ("redirect_uri", self.redirect_uri.as_str()),
                ("grant_type", "authorization_code"),
            ],
        )
    }
}

pub fn refresh_access_token(config: &OAuthConfig, refresh_token: &str) -> Result<OAuthTokens> {
    exchange(
        config,
        &[
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ],
    )
}

fn exchange(config: &OAuthConfig, extra: &[(&str, &str)]) -> Result<OAuthTokens> {
    let mut form: Vec<(&str, &str)> = vec![
        ("client_id", config.client_id.as_str()),
        ("client_secret", config.client_secret.as_str()),
    ];
    form.extend_from_slice(extra);
    // (with timeouts: the sync thread refreshes the token, and a hung refresh
    // stalled it as surely as a hung sync)
    let resp = crate::google::http_agent().post(TOKEN_URL).send_form(&form)?;
    let tokens: OAuthTokens = resp.into_json().map_err(|e| CoreError::OAuth(e.to_string()))?;
    Ok(tokens)
}

/// Accept one HTTP request on the loopback listener and pull `code` out of the
/// query string. Responds with a tiny "you can close this window" page.
fn accept_redirect(listener: &TcpListener) -> Result<String> {
    loop {
        let (mut stream, _) = listener.accept()?;
        let mut reader = BufReader::new(stream.try_clone()?);
        let mut request_line = String::new();
        reader.read_line(&mut request_line)?;

        // request_line: GET /?code=...&scope=... HTTP/1.1
        let path = request_line.split_whitespace().nth(1).unwrap_or("/");
        let query = path.splitn(2, '?').nth(1).unwrap_or("");
        let mut code = None;
        let mut error = None;
        for pair in query.split('&') {
            let mut kv = pair.splitn(2, '=');
            match (kv.next(), kv.next()) {
                (Some("code"), Some(v)) => code = Some(urldecode(v)),
                (Some("error"), Some(v)) => error = Some(urldecode(v)),
                _ => {}
            }
        }

        // Browsers often probe /favicon.ico; only answer the real redirect.
        if code.is_none() && error.is_none() {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            continue;
        }

        // (a denied consent came back with ?error=…: said "connected" too)
        let body = if code.is_some() {
            "<html><body style=\"font-family:sans-serif;padding:2rem\">\
             <h2>calendar-app is connected.</h2>You can close this window.</body></html>"
        } else {
            "<html><body style=\"font-family:sans-serif;padding:2rem\">\
             <h2>calendar-app was not connected.</h2>The sign-in was cancelled or refused. \
             You can close this window and try again from the app.</body></html>"
        };
        let _ = stream.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        );

        return match (code, error) {
            (Some(c), _) => Ok(c),
            (None, Some(e)) => Err(CoreError::OAuth(format!("authorization denied: {e}"))),
            _ => unreachable!(),
        };
    }
}

fn urlencode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn urldecode(s: &str) -> String {
    url::form_urlencoded::parse(format!("x={s}").as_bytes())
        .next()
        .map(|(_, v)| v.into_owned())
        .unwrap_or_else(|| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_of_verifier() {
        let cfg = OAuthConfig { client_id: "id".into(), client_secret: "sec".into() };
        let flow = PkceFlow::start(cfg).unwrap();
        let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(flow.verifier.as_bytes()));
        assert!(flow.auth_url.contains(&format!("code_challenge={expected}")));
        assert!(flow.auth_url.contains("code_challenge_method=S256"));
        assert!(flow.auth_url.contains("access_type=offline"));
    }

    /// Cancelling Google's consent screen redirects back with
    /// ?error=access_denied: the loopback page must not say "connected".
    #[test]
    fn a_denied_consent_does_not_say_connected() {
        use std::io::{Read, Write};
        let cfg = OAuthConfig { client_id: "id".into(), client_secret: "sec".into() };
        let flow = PkceFlow::start(cfg).unwrap();
        let port: u16 = flow
            .auth_url
            .split("redirect_uri=http%3A%2F%2F127.0.0.1%3A")
            .nth(1)
            .and_then(|s| s.split('&').next())
            .and_then(|p| p.parse().ok())
            .expect("redirect port in auth_url");
        let waiter = std::thread::spawn(move || flow.wait_for_code());
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(b"GET /?error=access_denied HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
        let mut body = String::new();
        s.read_to_string(&mut body).unwrap();
        let result = waiter.join().unwrap();
        assert!(result.is_err(), "a denial is not a code");
        assert!(!body.contains("is connected"), "the browser was told 'connected' after a denial: {body}");
        assert!(body.contains("not connected"));
    }
}
