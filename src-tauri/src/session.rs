//! Cheap Instagram session check.
//!
//! Launching a browser just to answer "are we connected?" would cost seconds
//! and a visible window, so instead we read the Camoufox/Firefox cookie store
//! in the shared profile directory and look for a live `sessionid`.
//!
//! This is a *signal*, not proof — a cookie can be present but revoked
//! server-side. The definitive check happens when a flow actually runs, which
//! is why connecting is always offered even when this reports connected.

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub connected: bool,
    /// Unix seconds; 0 when unknown.
    pub expires_at: i64,
    /// Set when the cookie store could not be read at all.
    pub detail: String,
}

/// `<repo>/.local/instagram-profile` — the profile both flows share.
pub fn profile_dir() -> PathBuf {
    if let Ok(explicit) = std::env::var("SCALEDUE_IG_PROFILE") {
        if !explicit.trim().is_empty() {
            return PathBuf::from(explicit);
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .unwrap_or(&PathBuf::from("."))
        .join(".local")
        .join("instagram-profile")
}

fn query_session(conn: &Connection) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT expiry FROM moz_cookies
         WHERE name = 'sessionid'
           AND (host = '.instagram.com' OR host = 'instagram.com' OR host LIKE '%.instagram.com')
           AND value <> ''
         ORDER BY expiry DESC LIMIT 1",
        [],
        |r| r.get::<_, i64>(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

pub fn status() -> SessionStatus {
    let cookies = profile_dir().join("cookies.sqlite");
    if !cookies.exists() {
        return SessionStatus {
            connected: false,
            expires_at: 0,
            detail: "no browser profile yet — connect to create one".into(),
        };
    }

    // Read-only first. If the browser holds the write lock we fall back to
    // immutable mode, which ignores the -wal file: possibly slightly stale, but
    // a stale "connected" is fine for a status pill.
    let open = Connection::open_with_flags(&cookies, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .or_else(|_| {
            Connection::open_with_flags(
                format!("file:{}?immutable=1", cookies.display()),
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
            )
        });

    let conn = match open {
        Ok(c) => c,
        Err(e) => {
            return SessionStatus {
                connected: false,
                expires_at: 0,
                detail: format!("could not read cookie store: {e}"),
            }
        }
    };

    match query_session(&conn) {
        Ok(Some(expiry)) => {
            let now = chrono::Utc::now().timestamp();
            // Firefox stores expiry in seconds; a session cookie has 0.
            let live = expiry == 0 || expiry > now;
            SessionStatus {
                connected: live,
                expires_at: expiry,
                detail: if live { String::new() } else { "session cookie expired".into() },
            }
        }
        Ok(None) => SessionStatus {
            connected: false,
            expires_at: 0,
            detail: "not signed in".into(),
        },
        Err(e) => SessionStatus {
            connected: false,
            expires_at: 0,
            detail: format!("cookie query failed: {e}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(host: &str, expiry: i64) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, name TEXT, value TEXT, host TEXT, expiry INTEGER);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO moz_cookies (name, value, host, expiry) VALUES ('sessionid', 'abc', ?1, ?2)",
            rusqlite::params![host, expiry],
        )
        .unwrap();
        conn
    }

    #[test]
    fn finds_session_cookie_on_dotted_host() {
        let conn = fixture(".instagram.com", 99_999_999_999);
        assert_eq!(query_session(&conn).unwrap(), Some(99_999_999_999));
    }

    #[test]
    fn finds_session_cookie_on_bare_host() {
        let conn = fixture("instagram.com", 42);
        assert_eq!(query_session(&conn).unwrap(), Some(42));
    }

    #[test]
    fn ignores_empty_values() {
        let conn = fixture(".instagram.com", 1);
        conn.execute("UPDATE moz_cookies SET value = ''", []).unwrap();
        assert_eq!(query_session(&conn).unwrap(), None);
    }

    #[test]
    fn no_rows_is_not_an_error() {
        let conn = fixture(".example.com", 1);
        assert_eq!(query_session(&conn).unwrap(), None);
    }
}
