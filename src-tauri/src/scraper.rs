//! Supervises the Node scraper child process.
//!
//! Output is streamed line-by-line to the UI as it arrives rather than collected
//! at exit, so a fifteen-minute run shows progress instead of a frozen window.
//! Two sentinel lines carry structured data back; everything else is a log line.

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::Sender;

/// Kept in sync with runner/scrape-runner.js.
const RESULT_PREFIX: &str = "@@SCALEDUE_RESULT@@";
const LOGIN_PREFIX: &str = "@@SCALEDUE_LOGIN@@";
const GMAIL_PREFIX: &str = "@@SCALEDUE_GMAIL@@";
const ERROR_PREFIX: &str = "@@SCALEDUE_ERROR@@";

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScrapeEvent {
    Log { line: String },
    Result { json_path: String, csv_path: String },
    Login { already_logged_in: bool, username: String },
    /// Payload from gmail-runner.js; shape depends on the action.
    Gmail { payload: serde_json::Value },
    Failed { error: String },
}

/// Locate a usable `node`.
///
/// A GUI app inherits launchd's minimal PATH, not the user's shell PATH, so a
/// bare `Command::new("node")` fails for anyone using nvm/fnm/asdf — which is
/// most people. Ask a login shell where node lives before giving up.
pub fn resolve_node() -> String {
    if let Ok(explicit) = std::env::var("SCALEDUE_NODE") {
        if !explicit.trim().is_empty() {
            return explicit;
        }
    }
    if let Ok(out) = Command::new("/bin/sh")
        .args(["-lc", "command -v node"])
        .output()
    {
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !path.is_empty() {
            return path;
        }
    }
    "node".to_string()
}

/// Spawn the runner. Lines are pushed to `tx` as they arrive; the caller owns
/// the returned `Child` so it can cancel the run.
pub fn spawn(
    runner: &Path,
    config_json: &str,
    tx: Sender<ScrapeEvent>,
) -> Result<Child, String> {
    let node = resolve_node();

    crate::info!("spawn {} {}", node, runner.display());
    let mut child = Command::new(&node)
        .arg(runner)
        .arg(config_json)
        // The scraper resolves its paths from __dirname, and all dependencies
        // are now self-contained within scaledue/. Set cwd to the scaledue root
        // so relative paths (e.g. .local/) resolve inside the folder.
        // runner is <scaledue>/runner/scrape-runner.js — one level up.
        .current_dir(scaledue_root(runner))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            crate::error_!("could not start node ({node}): {e}");
            format!("could not start node ({node}): {e}")
        })?;
    crate::info!("child pid {}", child.id());

    if let Some(stdout) = child.stdout.take() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = tx.send(classify(&line));
            }
        });
    }

    // stderr carries Camoufox/Playwright warnings — useful context, same stream.
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = tx.send(ScrapeEvent::Log { line });
            }
        });
    }

    Ok(child)
}

/// <scaledue>/runner/scrape-runner.js → <scaledue>
fn scaledue_root(runner: &Path) -> PathBuf {
    runner
        .ancestors()
        .nth(2)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn classify(line: &str) -> ScrapeEvent {
    if let Some(payload) = line.strip_prefix(RESULT_PREFIX) {
        let v: serde_json::Value = serde_json::from_str(payload).unwrap_or_default();
        return ScrapeEvent::Result {
            json_path: v["jsonPath"].as_str().unwrap_or("").to_string(),
            csv_path: v["csvPath"].as_str().unwrap_or("").to_string(),
        };
    }
    if let Some(payload) = line.strip_prefix(LOGIN_PREFIX) {
        let v: serde_json::Value = serde_json::from_str(payload).unwrap_or_default();
        return ScrapeEvent::Login {
            already_logged_in: v["alreadyLoggedIn"].as_bool().unwrap_or(false),
            username: v["username"].as_str().unwrap_or("").to_string(),
        };
    }
    if let Some(payload) = line.strip_prefix(GMAIL_PREFIX) {
        return ScrapeEvent::Gmail {
            payload: serde_json::from_str(payload).unwrap_or_default(),
        };
    }
    if let Some(payload) = line.strip_prefix(ERROR_PREFIX) {
        let v: serde_json::Value = serde_json::from_str(payload).unwrap_or_default();
        return ScrapeEvent::Failed {
            error: v["error"].as_str().unwrap_or("unknown error").to_string(),
        };
    }
    ScrapeEvent::Log {
        line: line.to_string(),
    }
}

/// Path to a script in runner/, resolved from the app's location.
///
/// In `tauri dev` the binary sits in scaledue/src-tauri/target/debug, so we walk
/// up to the scaledue root. A bundled .app has no such ancestry, hence the
/// SCALEDUE_RUNNER_DIR override for that case.
pub fn runner_path(script: &str) -> PathBuf {
    if let Ok(dir) = std::env::var("SCALEDUE_RUNNER_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir).join(script);
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .unwrap_or(&manifest)
        .join("runner")
        .join(script)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_the_result_sentinel() {
        let line = r#"@@SCALEDUE_RESULT@@{"jsonPath":"/tmp/a.json","csvPath":"/tmp/a.csv"}"#;
        match classify(line) {
            ScrapeEvent::Result { json_path, csv_path } => {
                assert_eq!(json_path, "/tmp/a.json");
                assert_eq!(csv_path, "/tmp/a.csv");
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn classifies_the_login_sentinel() {
        let line = r#"@@SCALEDUE_LOGIN@@{"connected":true,"alreadyLoggedIn":true,"username":"hiredue"}"#;
        match classify(line) {
            ScrapeEvent::Login { already_logged_in, username } => {
                assert!(already_logged_in);
                assert_eq!(username, "hiredue");
            }
            other => panic!("expected Login, got {other:?}"),
        }
    }

    #[test]
    fn classifies_the_error_sentinel() {
        match classify(r#"@@SCALEDUE_ERROR@@{"error":"boom"}"#) {
            ScrapeEvent::Failed { error } => assert_eq!(error, "boom"),
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[test]
    fn ordinary_output_stays_a_log_line() {
        match classify("  page 1: +15 reels") {
            ScrapeEvent::Log { line } => assert_eq!(line, "  page 1: +15 reels"),
            other => panic!("expected Log, got {other:?}"),
        }
    }

    /// A typo in a runner filename would otherwise only surface as a
    /// "runner not found" error the moment someone presses the button.
    #[test]
    fn classifies_the_gmail_sentinel() {
        let line = r#"@@SCALEDUE_GMAIL@@{"connected":true,"email":"me@example.com"}"#;
        match classify(line) {
            ScrapeEvent::Gmail { payload } => {
                assert_eq!(payload["email"], "me@example.com");
                assert_eq!(payload["connected"], true);
            }
            other => panic!("expected Gmail, got {other:?}"),
        }
    }

    #[test]
    fn both_runner_scripts_exist() {
        for script in ["scrape-runner.js", "login-runner.js", "gmail-runner.js"] {
            let path = runner_path(script);
            assert!(path.exists(), "missing runner script: {}", path.display());
        }
    }

    #[test]
    fn scaledue_root_is_one_level_above_the_runner() {
        let runner = PathBuf::from("/x/scaledue/runner/scrape-runner.js");
        assert_eq!(scaledue_root(&runner), PathBuf::from("/x/scaledue"));
    }
}
