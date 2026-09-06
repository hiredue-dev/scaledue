//! Resolve bundled resource paths for browsers, runners, and scripts.
//!
//! In a packaged .app/.exe, Tauri places `bundle.resources` entries next to the
//! binary's parent directory.  In `tauri dev` there is no bundle, so we fall
//! back to the project root — `CARGO_MANIFEST_DIR`'s parent — matching what
//! `runner_path()` already does for runner scripts.

use std::path::PathBuf;

/// Directory that holds the bundled browser-bin/ tree (Camoufox + Playwright).
///
/// In a packaged app this is `<bundle>/Resources/browser-bin/` on macOS —
/// `App::path().resource_dir()` joined with the relative path we used in
/// `tauri.conf.json` `bundle.resources`.  During `tauri dev`, fall back to the
/// project root so the developer can download the browsers once and reuse them.
pub fn browser_bin_dir(resource_dir: Option<&std::path::Path>) -> PathBuf {
    if let Some(dir) = resource_dir {
        // resource_dir is the bundle's Resources/ directory; the mapping
        //   "../browser-bin/camoufox/": "browser-bin/camoufox/"
        // places the tree at Resources/browser-bin/camoufox/.
        let bundled = dir.join("browser-bin");
        if bundled.is_dir() {
            return bundled;
        }
    }

    // dev fallback — same relative layout as the repository.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest.parent().unwrap_or(&manifest).join("browser-bin")
}

/// Sets the environment variables that the Node scrapers read at startup so
/// they find the bundled browsers without any post-install download.
///
/// Call this early — before any Tauri commands are registered.  The vars are:
///   CAMOUFOX_INSTALL_DIR   — where Camoufox's own `launchPath()` looks
///   PLAYWRIGHT_BROWSERS_PATH — where Playwright looks for its browser binaries
///   SCALEDUE_RUNNER_DIR    — where scraper.rs `runner_path()` looks (optional;
///     if unset, runner_path() still falls back to the Cargo manifest parent)
pub fn set_env(browser_bin: &std::path::Path) {
    let camoufox_dir = browser_bin.join("camoufox");
    let playwright_dir = browser_bin.join("playwright");

    // Set these only if we haven't already (an explicit env override wins).
    if std::env::var("CAMOUFOX_INSTALL_DIR").is_err() && camoufox_dir.is_dir() {
        std::env::set_var("CAMOUFOX_INSTALL_DIR", &camoufox_dir);
        crate::info!("CAMOUFOX_INSTALL_DIR={}", camoufox_dir.display());
    }

    if std::env::var("PLAYWRIGHT_BROWSERS_PATH").is_err() && playwright_dir.is_dir() {
        std::env::set_var("PLAYWRIGHT_BROWSERS_PATH", &playwright_dir);
        crate::info!("PLAYWRIGHT_BROWSERS_PATH={}", playwright_dir.display());
    }

    // Also set the runner dir so scraper.rs finds runner/ scripts inside a
    // packaged app where the Cargo manifest directory doesn't exist.
    if std::env::var("SCALEDUE_RUNNER_DIR").is_err() {
        // In a bundle, runner/ is alongside browser-bin/ in Resources/.
        let parent = browser_bin
            .parent()
            .unwrap_or(browser_bin);
        let runner_dir = parent.join("runner");
        if runner_dir.is_dir() {
            std::env::set_var("SCALEDUE_RUNNER_DIR", &runner_dir);
            crate::info!("SCALEDUE_RUNNER_DIR={}", runner_dir.display());
        }
    }
}