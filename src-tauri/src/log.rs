//! Application logging.
//!
//! Writes a timestamped line to both stderr and `scaledue.log` in the app data
//! directory. Deliberately tiny — no logging framework — because what was
//! missing when a run appeared to hang was not log *levels* but any durable
//! record of which step started and how long it took.
//!
//! Use `info!`/`warn!`/`error!` from this module; `timed` wraps a fallible step
//! and records its duration either way.

use std::fmt::Arguments;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static SINK: OnceLock<Mutex<Option<File>>> = OnceLock::new();
static PATH: OnceLock<PathBuf> = OnceLock::new();

fn sink() -> &'static Mutex<Option<File>> {
    SINK.get_or_init(|| Mutex::new(None))
}

/// Point the log at `dir/scaledue.log`. Called once at startup.
pub fn init(dir: &Path) {
    let _ = std::fs::create_dir_all(dir);
    let file = dir.join("scaledue.log");
    // Truncate on launch: a per-session log is far easier to read back than one
    // that grows forever, and the previous session is kept alongside it.
    let previous = dir.join("scaledue.prev.log");
    let _ = std::fs::rename(&file, previous);

    match OpenOptions::new().create(true).append(true).open(&file) {
        Ok(f) => {
            *sink().lock().unwrap() = Some(f);
            let _ = PATH.set(file.clone());
            write(format_args!("--- scaledue {} ---", env!("CARGO_PKG_VERSION")), "info");
        }
        Err(e) => eprintln!("scaledue: could not open log {}: {e}", file.display()),
    }
}

pub fn path() -> String {
    PATH.get().map(|p| p.display().to_string()).unwrap_or_default()
}

pub fn write(args: Arguments<'_>, level: &str) {
    let line = format!("{} [{level}] {args}", chrono::Utc::now().to_rfc3339());
    eprintln!("{line}");
    if let Ok(mut guard) = sink().lock() {
        if let Some(f) = guard.as_mut() {
            let _ = writeln!(f, "{line}");
            let _ = f.flush();
        }
    }
}

#[macro_export]
macro_rules! info  { ($($a:tt)*) => { $crate::log::write(format_args!($($a)*), "info")  } }
#[macro_export]
macro_rules! warn_ { ($($a:tt)*) => { $crate::log::write(format_args!($($a)*), "warn")  } }
#[macro_export]
macro_rules! error_ { ($($a:tt)*) => { $crate::log::write(format_args!($($a)*), "error") } }

/// Run a fallible async step, logging how long it took and whether it failed.
/// Timing is the point: it makes "slow" distinguishable from "stuck".
pub async fn timed<T, E: std::fmt::Display>(
    label: &str,
    fut: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, E> {
    let t0 = std::time::Instant::now();
    write(format_args!("{label}…"), "info");
    match fut.await {
        Ok(v) => {
            write(format_args!("{label} ok in {:.1}s", t0.elapsed().as_secs_f64()), "info");
            Ok(v)
        }
        Err(e) => {
            write(
                format_args!("{label} FAILED after {:.1}s: {e}", t0.elapsed().as_secs_f64()),
                "error",
            );
            Err(e)
        }
    }
}
