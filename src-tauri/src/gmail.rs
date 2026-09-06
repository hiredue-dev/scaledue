//! Gmail integration, driven through runner/gmail-runner.js.
//!
//! Reuses the HireDue desktop app's Google OAuth client — same scopes and the
//! same `http://localhost:3000/oauth2callback` redirect — so no new consent
//! screen or verification is needed. See the runner for the details.
//!
//! Sending is a short-lived child process rather than a long-running job: it
//! touches no browser profile, so it deliberately does not take the scrape/login
//! lock and can run while a scrape is in flight.

use crate::scraper::{self, ScrapeEvent};
use serde::{Deserialize, Serialize};
use std::sync::mpsc;

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GmailStatus {
    pub connected: bool,
    pub email: String,
    pub connected_at: String,
    /// Whether the OAuth client JSON is present at all — distinguishes "not set
    /// up yet" from "set up but not signed in", which need different fixes.
    pub client_configured: bool,
    pub client_file: String,
    /// Truncated, for confirming which OAuth client is configured.
    pub client_id: String,
    pub detail: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    pub to: String,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub from_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    pub to: String,
    pub from: String,
    pub message_id: String,
    pub sent_at: String,
}

/// Run gmail-runner.js with a payload and collect its sentinel.
///
/// `on_log` receives progress lines so the consent flow can narrate itself.
fn run(payload: serde_json::Value, mut on_log: impl FnMut(String)) -> Result<serde_json::Value, String> {
    let runner = scraper::runner_path("gmail-runner.js");
    if !runner.exists() {
        return Err(format!("runner not found at {}", runner.display()));
    }

    let (tx, rx) = mpsc::channel::<ScrapeEvent>();
    let mut child = scraper::spawn(&runner, &payload.to_string(), tx)?;

    crate::info!("gmail action: {}", payload["action"].as_str().unwrap_or("?"));
    let mut result: Option<serde_json::Value> = None;
    let mut failure: Option<String> = None;
    for event in rx {
        match event {
            ScrapeEvent::Log { line } => on_log(line),
            ScrapeEvent::Gmail { payload } => result = Some(payload),
            ScrapeEvent::Failed { error } => failure = Some(error),
            _ => {}
        }
    }
    let status = child.wait().ok();

    if let Some(err) = failure {
        crate::error_!("gmail failed: {err}");
        return Err(err);
    }
    result.ok_or_else(|| match status {
        Some(s) if !s.success() => format!("gmail helper exited with {s}"),
        _ => "gmail helper returned nothing".to_string(),
    })
}

pub fn status() -> GmailStatus {
    match run(serde_json::json!({ "action": "status" }), |_| {}) {
        Ok(v) => GmailStatus {
            connected: v["connected"].as_bool().unwrap_or(false),
            email: v["email"].as_str().unwrap_or("").to_string(),
            connected_at: v["connectedAt"].as_str().unwrap_or("").to_string(),
            client_configured: v["clientConfigured"].as_bool().unwrap_or(false),
            client_file: v["clientFile"].as_str().unwrap_or("").to_string(),
            client_id: v["clientId"].as_str().unwrap_or("").to_string(),
            detail: v["clientError"].as_str().unwrap_or("").to_string(),
        },
        Err(e) => GmailStatus { detail: e, ..Default::default() },
    }
}

pub fn connect(timeout_sec: i64, on_log: impl FnMut(String)) -> Result<String, String> {
    let v = run(
        serde_json::json!({ "action": "connect", "timeoutSec": timeout_sec }),
        on_log,
    )?;
    Ok(v["email"].as_str().unwrap_or("").to_string())
}

pub fn send(req: &SendRequest, on_log: impl FnMut(String)) -> Result<SendResult, String> {
    let v = run(
        serde_json::json!({
            "action": "send",
            "to": req.to,
            "subject": req.subject,
            "body": req.body,
            "fromName": req.from_name,
        }),
        on_log,
    )?;
    Ok(SendResult {
        to: v["to"].as_str().unwrap_or(&req.to).to_string(),
        from: v["from"].as_str().unwrap_or("").to_string(),
        message_id: v["messageId"].as_str().unwrap_or("").to_string(),
        sent_at: chrono::Utc::now().to_rfc3339(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The runner is the only piece that talks to Google; make sure it's there,
    /// since a missing file would otherwise only surface on a button press.
    #[test]
    fn the_gmail_runner_exists() {
        let p = scraper::runner_path("gmail-runner.js");
        assert!(p.exists(), "missing {}", p.display());
    }

    /// Env vars are process-global, so the credential-resolution cases share one
    /// test rather than racing each other across parallel test threads.
    #[test]
    fn status_explains_every_credential_state() {
        std::env::set_var("SCALEDUE_GMAIL_TOKEN", "/nope/no-token.json");
        std::env::set_var("SCALEDUE_GOOGLE_CLIENT", "/nope/no-client.json");

        // Set them empty rather than unset: the runner loads a real .env for
        // keys absent from the environment, so unsetting would let a developer's
        // own credentials leak in and make this test pass or fail by accident.
        // An empty value is "present but blank", which blocks the .env fallback
        // and reads as unconfigured.
        std::env::set_var("GOOGLE_CLIENT_ID", "");
        std::env::set_var("GOOGLE_CLIENT_SECRET", "");

        // 1. Nothing configured — says where to put credentials, both ways.
        let s = status();
        assert!(!s.connected, "must not claim a connection without a token");
        assert!(!s.client_configured);
        assert!(s.client_id.is_empty());
        assert!(s.detail.contains("GOOGLE_CLIENT_ID"), "detail: {}", s.detail);
        assert!(s.detail.contains("/nope/no-client.json"), "detail: {}", s.detail);

        // 2. Half configured — a typo, and it must be named as one rather than
        //    silently falling through to a missing file.
        std::env::set_var("GOOGLE_CLIENT_ID", "abc.apps.googleusercontent.com");
        let s = status();
        assert!(!s.client_configured);
        assert!(s.detail.contains("both are required"), "detail: {}", s.detail);

        // 3. Fully configured from env — reports the source and a masked id.
        std::env::set_var("GOOGLE_CLIENT_SECRET", "shh");
        let s = status();
        assert!(s.client_configured);
        assert!(s.detail.is_empty(), "a working config is not an error: {}", s.detail);
        assert_eq!(s.client_file, "env", "source should be reported as env");
        assert!(s.client_id.starts_with("abc.apps"), "id: {}", s.client_id);
        assert!(!s.client_id.contains("googleusercontent"), "id must be truncated: {}", s.client_id);
        assert!(!s.connected, "credentials alone are not a connection");

        for k in ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SCALEDUE_GOOGLE_CLIENT", "SCALEDUE_GMAIL_TOKEN"] {
            std::env::remove_var(k);
        }
    }

    #[test]
    fn send_request_deserialises_the_ui_payload() {
        let raw = r#"{"to":"a@b.com","subject":"Hi","body":"Text","fromName":"Sanglap · HireDue"}"#;
        let r: SendRequest = serde_json::from_str(raw).expect("UI payload must deserialize");
        assert_eq!(r.to, "a@b.com");
        assert_eq!(r.from_name, "Sanglap · HireDue");
    }

    #[test]
    fn from_name_is_optional() {
        let r: SendRequest =
            serde_json::from_str(r#"{"to":"a@b.com","subject":"s","body":"b"}"#).unwrap();
        assert!(r.from_name.is_empty());
    }
}
