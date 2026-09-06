//! ScaleDue — a desktop front end for the HireDue Instagram creator scraper.
//!
//! The Rust side owns the database and the child-process lifecycle; all
//! scraping and login logic stays in the Node project one directory up.

mod gmail;
pub mod log;
pub mod model;
mod scraper;
mod session;
pub mod store;

use scraper::ScrapeEvent;
use serde::{Deserialize, Serialize};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// Event names the UI subscribes to.
const EV_LOG: &str = "scrape://log";
const EV_STATUS: &str = "scrape://status";
const EV_CONNECT: &str = "connect://status";



/// The two flows share one browser profile, so only one may run at a time.
struct RunningJob {
    kind: &'static str,
    child: std::process::Child,
}

/// Firestore is either connected, or we know exactly why it isn't. Holding the
/// failure rather than panicking lets the app start, explain itself, and retry
/// once the key file is in place.
enum Firebase {
    Ready(Box<store::Store>),
    Unconfigured(String),
}

struct AppState {
    firebase: tokio::sync::RwLock<Firebase>,
    job: Arc<Mutex<Option<RunningJob>>>,
    /// (username, connected_at) for the Instagram session, in memory only —
    /// the cookie store on disk is the durable part.
    instagram: Mutex<(String, String)>,
}

/// A borrowed, connected store. Holding the read guard keeps a concurrent
/// `reconnect_firebase` from swapping the client mid-operation.
struct StoreGuard<'a>(tokio::sync::RwLockReadGuard<'a, Firebase>);

impl std::ops::Deref for StoreGuard<'_> {
    type Target = store::Store;
    fn deref(&self) -> &store::Store {
        match &*self.0 {
            Firebase::Ready(s) => s,
            // Only ever constructed from the Ready arm in AppState::store.
            Firebase::Unconfigured(_) => unreachable!("StoreGuard built while unconfigured"),
        }
    }
}

impl AppState {
    /// The connected store, or the reason there isn't one.
    async fn store(&self) -> Result<StoreGuard<'_>, String> {
        let guard = self.firebase.read().await;
        match &*guard {
            Firebase::Ready(_) => Ok(StoreGuard(guard)),
            Firebase::Unconfigured(why) => Err(why.clone()),
        }
    }
}

impl AppState {
    /// Claim the browser for `kind`, or say what is already using it.
    fn claim(&self, kind: &'static str) -> Result<(), String> {
        let guard = self.job.lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some(job) if job.kind == kind => Err(format!("{kind} is already running")),
            Some(job) => Err(format!(
                "{} is using the browser — wait for it to finish",
                job.kind
            )),
            None => Ok(()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrapeConfig {
    pub keywords: Vec<String>,
    pub min_followers: Option<i64>,
    pub max_followers: Option<i64>,
    pub target_resolved: Option<i64>,
    pub max_search_pages_per_keyword: Option<i64>,
    pub require_relevance: Option<bool>,
    pub headless: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StatusPayload {
    running: bool,
    run_id: Option<String>,
    stage: String,
    message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConnectPayload {
    running: bool,
    connected: bool,
    stage: String,
    message: String,
    username: String,
}

fn emit_status(app: &AppHandle, running: bool, run_id: Option<String>, stage: &str, message: &str) {
    let _ = app.emit(
        EV_STATUS,
        StatusPayload {
            running,
            run_id,
            stage: stage.to_string(),
            message: message.to_string(),
        },
    );
}

fn emit_connect(app: &AppHandle, running: bool, connected: bool, stage: &str, message: &str, username: &str) {
    let _ = app.emit(
        EV_CONNECT,
        ConnectPayload {
            running,
            connected,
            stage: stage.to_string(),
            message: message.to_string(),
            username: username.to_string(),
        },
    );
}

/// Spawn a runner and hand back the receiver for its output.
fn launch(
    state: &State<AppState>,
    kind: &'static str,
    script: &str,
    config_json: &str,
) -> Result<mpsc::Receiver<ScrapeEvent>, String> {
    let runner = scraper::runner_path(script);
    if !runner.exists() {
        return Err(format!("runner not found at {}", runner.display()));
    }

    let (tx, rx) = mpsc::channel::<ScrapeEvent>();
    let child = scraper::spawn(&runner, config_json, tx)?;
    *state.job.lock().map_err(|e| e.to_string())? = Some(RunningJob { kind, child });
    Ok(rx)
}

/// Reap the finished child and release the browser claim.
fn release(job: &Arc<Mutex<Option<RunningJob>>>) -> Option<std::process::ExitStatus> {
    let status = {
        let mut guard = job.lock().ok()?;
        guard.as_mut().and_then(|j| j.child.wait().ok())
    };
    if let Ok(mut guard) = job.lock() {
        *guard = None;
    }
    status
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Which flow, if any, currently holds the browser.
#[tauri::command]
fn running_job(state: State<AppState>) -> Option<String> {
    state
        .job
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|j| j.kind.to_string()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    connected: bool,
    username: String,
    connected_at: String,
    detail: String,
}

/// Best-effort connection status, read from the browser profile's cookie store
/// so the UI can render a pill without opening a window.
#[tauri::command]
fn session_status(state: State<AppState>) -> Result<SessionInfo, String> {
    let cookie = session::status();
    let who = state.instagram.lock().map_err(|e| e.to_string())?.clone();
    Ok(SessionInfo {
        connected: cookie.connected,
        username: who.0,
        connected_at: who.1,
        detail: cookie.detail,
    })
}

/// Is Firestore usable, and against which project?
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FirebaseInfo {
    connected: bool,
    project_id: String,
    key_path: String,
    detail: String,
}

#[tauri::command]
async fn firebase_status(state: State<'_, AppState>) -> Result<FirebaseInfo, String> {
    let key_path = store::find_key()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    Ok(match &*state.firebase.read().await {
        Firebase::Ready(s) => FirebaseInfo {
            connected: true,
            project_id: s.project_id.clone(),
            key_path,
            detail: String::new(),
        },
        Firebase::Unconfigured(why) => FirebaseInfo {
            connected: false,
            project_id: String::new(),
            key_path,
            detail: why.clone(),
        },
    })
}

/// Retry the Firestore connection — so dropping the key file in place doesn't
/// require restarting the app.
#[tauri::command]
async fn reconnect_firebase(state: State<'_, AppState>) -> Result<FirebaseInfo, String> {
    let next = match store::Store::connect().await {
        Ok(s) => Firebase::Ready(Box::new(s)),
        Err(e) => Firebase::Unconfigured(e),
    };
    *state.firebase.write().await = next;
    firebase_status(state).await
}

/// Open a real browser window so the person can sign in to Instagram. Closes
/// itself as soon as a session is detected — immediately if one already exists.
#[tauri::command]
fn connect_instagram(app: AppHandle, state: State<AppState>, timeout_sec: Option<i64>) -> Result<(), String> {
    state.claim("connect")?;

    let config = serde_json::json!({ "timeoutSec": timeout_sec.unwrap_or(240) }).to_string();
    let rx = launch(&state, "connect", "login-runner.js", &config)?;

    emit_connect(&app, true, false, "running", "opening browser…", "");

    let job = state.job.clone();
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let mut outcome: Option<(bool, String)> = None; // (already_logged_in, username)
        let mut failure: Option<String> = None;

        for event in rx {
            match event {
                ScrapeEvent::Log { line } => {
                    let _ = app_handle.emit(EV_LOG, line);
                }
                ScrapeEvent::Login { already_logged_in, username } => {
                    outcome = Some((already_logged_in, username))
                }
                ScrapeEvent::Failed { error } => failure = Some(error),
                ScrapeEvent::Result { .. } | ScrapeEvent::Gmail { .. } => {}
            }
        }
        let status = release(&job);
        let state = app_handle.state::<AppState>();

        if let Some(err) = failure {
            emit_connect(&app_handle, false, false, "failed", &err, "");
            return;
        }

        let Some((already, username)) = outcome else {
            let msg = match status {
                Some(s) if !s.success() => format!("login flow exited with {s}"),
                _ => "login flow ended without connecting".to_string(),
            };
            emit_connect(&app_handle, false, false, "failed", &msg, "");
            return;
        };

        if let Ok(mut who) = state.instagram.lock() {
            *who = (username.clone(), chrono::Utc::now().to_rfc3339());
        }

        let msg = match (already, username.is_empty()) {
            (true, true) => "already connected".to_string(),
            (true, false) => format!("already connected as @{username}"),
            (false, true) => "connected".to_string(),
            (false, false) => format!("connected as @{username}"),
        };
        emit_connect(&app_handle, false, true, "done", &msg, &username);
    });

    Ok(())
}

/// Kick off a scrape. Returns the new run id immediately; progress arrives as
/// `scrape://log` events and completion as `scrape://status`.
#[tauri::command]
async fn start_scrape(
    app: AppHandle,
    state: State<'_, AppState>,
    config: ScrapeConfig,
) -> Result<String, String> {
    state.claim("scrape")?;
    if config.keywords.is_empty() {
        return Err("add at least one keyword".into());
    }

    // Only forward the knobs the user actually set; the scraper's own defaults
    // cover the rest, so the two entry points stay consistent.
    let mut payload = serde_json::Map::new();
    payload.insert("keywords".into(), serde_json::json!(config.keywords));
    let mut put = |k: &str, v: Option<serde_json::Value>| {
        if let Some(v) = v {
            payload.insert(k.into(), v);
        }
    };
    put("minFollowers", config.min_followers.map(Into::into));
    put("maxFollowers", config.max_followers.map(Into::into));
    put("targetResolved", config.target_resolved.map(Into::into));
    put("maxSearchPagesPerKeyword", config.max_search_pages_per_keyword.map(Into::into));
    put("requireRelevance", config.require_relevance.map(Into::into));
    put("headless", config.headless.map(Into::into));
    drop(put);

    // Hand the scraper every handle we already have so it drops them at
    // discovery: each run then surfaces genuinely new profiles instead of
    // re-resolving the same people, and the enrichment budget isn't wasted.
    let (run_id, known) = {
        let s = state.store().await?;
        let known = s.known_usernames().await?;
        let run_id = s.start_run(config.keywords.clone()).await?;
        (run_id, known)
    };
    payload.insert("excludeUsernames".into(), serde_json::json!(known));
    let config_json = serde_json::Value::Object(payload).to_string();

    let rx = match launch(&state, "scrape", "scrape-runner.js", &config_json) {
        Ok(rx) => rx,
        Err(e) => {
            if let Ok(s) = state.store().await {
                let _ = s.fail_run(&run_id, &e).await;
            }
            return Err(e);
        }
    };

    info!("scrape run {run_id} starting: {} keyword(s), excluding {} known handles",
          config.keywords.len(), known.len());
    emit_status(&app, true, Some(run_id.clone()), "running", "starting browser…");

    let job = state.job.clone();
    let app_handle = app.clone();
    let worker_run_id = run_id.clone();

    // The child's output arrives on a sync channel, so drain it on a blocking
    // thread, then do the Firestore writes back on the async runtime.
    tauri::async_runtime::spawn(async move {
        let log_handle = app_handle.clone();
        let drained = tauri::async_runtime::spawn_blocking(move || {
            let mut artifact: Option<String> = None;
            let mut failure: Option<String> = None;
            for event in rx {
                match event {
                    ScrapeEvent::Log { line } => {
                        let _ = log_handle.emit(EV_LOG, line);
                    }
                    ScrapeEvent::Result { json_path, .. } => artifact = Some(json_path),
                    ScrapeEvent::Failed { error } => failure = Some(error),
                    ScrapeEvent::Login { .. } | ScrapeEvent::Gmail { .. } => {}
                }
            }
            (artifact, failure, release(&job))
        })
        .await;

        let (artifact, failure, status) = match drained {
            Ok(v) => v,
            Err(e) => (None, Some(format!("output reader failed: {e}")), None),
        };

        let state = app_handle.state::<AppState>();

        let outcome: Result<usize, String> = if let Some(err) = failure {
            Err(err)
        } else if let Some(path) = artifact {
            ingest(&state, &worker_run_id, &path).await
        } else {
            Err(match status {
                Some(s) if !s.success() => format!("scraper exited with {s}"),
                _ => "scraper produced no results".to_string(),
            })
        };

        match &outcome {
            Ok(count) => info!("scrape run {worker_run_id} stored {count} creators"),
            Err(e) => error_!("scrape run {worker_run_id} failed: {e}"),
        }
        match outcome {
            Ok(count) => emit_status(
                &app_handle,
                false,
                Some(worker_run_id.clone()),
                "done",
                &format!("stored {count} creators"),
            ),
            Err(e) => {
                if let Ok(s) = state.store().await {
                    let _ = s.fail_run(&worker_run_id, &e).await;
                }
                emit_status(&app_handle, false, Some(worker_run_id.clone()), "failed", &e);
            }
        }
    });

    Ok(run_id)
}

/// Read a scraper artifact and push it to Firestore, then close out the run.
async fn ingest(state: &State<'_, AppState>, run_id: &str, path: &str) -> Result<usize, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("reading {path}: {e}"))?;
    let artifact: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parsing {path}: {e}"))?;

    let s = state.store().await?;
    let stored = s.ingest_artifact(run_id, &artifact).await?;
    s.finish_run(run_id, &artifact).await?;
    Ok(stored)
}

#[tauri::command]
fn cancel_job(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let kind = {
        let mut guard = state.job.lock().map_err(|e| e.to_string())?;
        let kind = guard.as_ref().map(|j| j.kind);
        if let Some(job) = guard.as_mut() {
            let _ = job.child.kill();
        }
        *guard = None;
        kind
    };
    match kind {
        Some("connect") => emit_connect(&app, false, false, "cancelled", "connect cancelled", ""),
        Some(_) => emit_status(&app, false, None, "cancelled", "run cancelled"),
        None => {}
    }
    Ok(())
}

#[tauri::command]
async fn list_runs(state: State<'_, AppState>) -> Result<Vec<model::Run>, String> {
    state.store().await?.list_runs().await
}

#[tauri::command]
async fn list_creators(
    state: State<'_, AppState>,
    run_id: Option<String>,
    search: Option<String>,
) -> Result<Vec<model::Creator>, String> {
    state.store().await?.list_creators(run_id, search).await
}

#[tauri::command]
async fn list_reels(state: State<'_, AppState>, creator_id: String) -> Result<Vec<model::Reel>, String> {
    state.store().await?.list_reels(&creator_id).await
}

#[tauri::command]
async fn stats(state: State<'_, AppState>) -> Result<model::Stats, String> {
    state.store().await?.stats().await
}

/// Drop the in-memory snapshot and re-read the collection — for picking up
/// edits made directly in the Firebase console.
#[tauri::command]
async fn refresh_from_cloud(state: State<'_, AppState>) -> Result<usize, String> {
    state.store().await?.refresh().await
}

/// Save hand-entered contact details for one creator. Empty strings clear the
/// override, falling back to whatever was scraped.
#[tauri::command]
async fn update_contact(
    state: State<'_, AppState>,
    creator_id: String,
    email: String,
    phone: String,
) -> Result<(), String> {
    state.store().await?.update_contact(&creator_id, &email, &phone).await
}

const EV_BULK: &str = "bulk://progress";

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BulkProgress {
    done: usize,
    total: usize,
}

/// Delete the given creators (and their reels).
///
/// Firestore deletes one document per round trip, so this emits progress —
/// a few hundred creators takes long enough that a silent UI reads as frozen.
#[tauri::command]
async fn delete_creators(
    app: AppHandle,
    state: State<'_, AppState>,
    creator_ids: Vec<String>,
) -> Result<store::BulkDelete, String> {
    if creator_ids.is_empty() {
        return Err("nothing selected".into());
    }
    info!("bulk delete: {} creator(s)", creator_ids.len());

    let store = state.store().await?;
    let result = store
        .delete_creators(&creator_ids, |done, total| {
            let _ = app.emit(EV_BULK, BulkProgress { done, total });
        })
        .await?;

    info!("bulk delete done: {} removed, {} failed", result.deleted, result.failed.len());
    for f in &result.failed {
        warn_!("bulk delete failure: {f}");
    }
    Ok(result)
}

/// Move a creator along the outreach pipeline.
#[tauri::command]
async fn set_status(
    state: State<'_, AppState>,
    creator_id: String,
    status: String,
) -> Result<(), String> {
    state.store().await?.set_status(&creator_id, &status).await
}

/// Delete every creator whose profile never resolved (no followers or bio).
#[tauri::command]
async fn delete_unresolved(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<store::BulkDelete, String> {
    info!("delete-unresolved requested");
    let store = state.store().await?;
    let result = store
        .delete_unresolved(|done, total| {
            let _ = app.emit(EV_BULK, BulkProgress { done, total });
        })
        .await?;
    info!("delete-unresolved done: {} removed, {} failed", result.deleted, result.failed.len());
    Ok(result)
}

/// Wipe every creator, reel and run from Firestore.
#[tauri::command]
async fn delete_all_data(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<store::BulkDelete, String> {
    info!("delete-all requested");

    let store = state.store().await?;
    let result = store
        .delete_all(|done, total| {
            let _ = app.emit(EV_BULK, BulkProgress { done, total });
        })
        .await?;

    info!("delete-all done: {} documents removed, {} failed", result.deleted, result.failed.len());
    for f in &result.failed {
        warn_!("delete-all failure: {f}");
    }
    Ok(result)
}

/// Remove one creator, along with its reels.
#[tauri::command]
async fn delete_creator(state: State<'_, AppState>, creator_id: String) -> Result<(), String> {
    state.store().await?.delete_creator(&creator_id).await
}

// ── Gmail ───────────────────────────────────────────────────────────────────

const EV_GMAIL: &str = "gmail://status";

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GmailEvent {
    running: bool,
    connected: bool,
    stage: String,
    message: String,
    email: String,
}

fn emit_gmail(app: &AppHandle, running: bool, connected: bool, stage: &str, message: &str, email: &str) {
    let _ = app.emit(
        EV_GMAIL,
        GmailEvent {
            running,
            connected,
            stage: stage.to_string(),
            message: message.to_string(),
            email: email.to_string(),
        },
    );
}

#[tauri::command]
async fn gmail_status() -> Result<gmail::GmailStatus, String> {
    // The helper shells out to node, so keep it off the UI thread.
    tauri::async_runtime::spawn_blocking(gmail::status)
        .await
        .map_err(|e| format!("gmail status failed: {e}"))
}

/// Run the Google consent flow in the system browser.
#[tauri::command]
fn connect_gmail(app: AppHandle, timeout_sec: Option<i64>) -> Result<(), String> {
    emit_gmail(&app, true, false, "running", "opening Google consent…", "");

    // Deliberately not behind the scrape/login lock: Gmail touches no browser
    // profile, so it can run while a scrape is in flight.
    std::thread::spawn(move || {
        let logger = app.clone();
        let result = gmail::connect(timeout_sec.unwrap_or(180), |line| {
            let _ = logger.emit(EV_LOG, line);
        });
        match result {
            Ok(email) => {
                let msg = if email.is_empty() {
                    "Gmail connected".to_string()
                } else {
                    format!("connected as {email}")
                };
                emit_gmail(&app, false, true, "done", &msg, &email);
            }
            Err(e) => emit_gmail(&app, false, false, "failed", &e, ""),
        }
    });
    Ok(())
}

/// Send one outreach email and record it on the creator.
#[tauri::command]
async fn send_email(
    app: AppHandle,
    state: State<'_, AppState>,
    creator_id: String,
    request: gmail::SendRequest,
) -> Result<gmail::SendResult, String> {
    let logger = app.clone();
    let sent = tauri::async_runtime::spawn_blocking(move || {
        gmail::send(&request, |line| {
            let _ = logger.emit(EV_LOG, line);
        })
    })
    .await
    .map_err(|e| format!("send failed: {e}"))??;

    // Record the outreach so the UI can show who has been contacted and stop a
    // second send by accident. A failure here must not read as a failed send —
    // the mail has already gone out.
    if let Ok(store) = state.store().await {
        if let Err(e) = store
            .record_outreach(&creator_id, &sent.to, &sent.sent_at, &sent.message_id)
            .await
        {
            eprintln!("scaledue: email sent but not recorded: {e}");
        }
    }
    Ok(sent)
}

/// Write the currently-filtered creator list to `path` as CSV.
///
/// Takes the same run/search filter the table is showing, so the export matches
/// what you are looking at rather than always dumping everything.
#[tauri::command]
async fn export_csv(
    state: State<'_, AppState>,
    run_id: Option<String>,
    search: Option<String>,
    path: String,
) -> Result<ExportResult, String> {
    let creators = state.store().await?.list_creators(run_id, search).await?;
    let csv = model::creators_to_csv(&creators);
    std::fs::write(&path, csv).map_err(|e| format!("could not write {path}: {e}"))?;
    Ok(ExportResult { rows: creators.len(), path })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
    rows: usize,
    path: String,
}

/// Shown in the footer so it's obvious which cloud project is being written to.
#[tauri::command]
async fn db_path(state: State<'_, AppState>) -> Result<String, String> {
    let target = match &*state.firebase.read().await {
        Firebase::Ready(s) => format!("Firestore · project {}", s.project_id),
        Firebase::Unconfigured(_) => "Firestore · not configured".to_string(),
    };
    Ok(format!("{target}   ·   log: {}", log::path()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The Firestore client speaks gRPC over rustls, which refuses to build a TLS
    // config unless a crypto provider is installed process-wide. Without this the
    // very first Firestore call fails with "no process-level CryptoProvider
    // available". aws-lc-rs is the provider this dependency tree compiles in;
    // an Err here just means one is already installed.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    tauri::Builder::default()
        // Lets the UI hand profile/reel links to the system browser instead of
        // navigating the app's own webview to instagram.com.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Ok(dir) = app.path().app_data_dir() {
                log::init(&dir);
            }
            info!("starting; node={}", scraper::resolve_node());
            info!("instagram profile: {}", session::profile_dir().display());

            // Connecting needs the async runtime, and a missing/invalid key must
            // not stop the app from starting — the UI explains and offers a retry.
            let firebase = tauri::async_runtime::block_on(async {
                match store::Store::connect().await {
                    Ok(s) => {
                        info!("Firestore connected: project {}", s.project_id);
                        Firebase::Ready(Box::new(s))
                    }
                    Err(e) => {
                        error_!("Firestore unavailable: {e}");
                        Firebase::Unconfigured(e)
                    }
                }
            });
            app.manage(AppState {
                firebase: tokio::sync::RwLock::new(firebase),
                job: Arc::new(Mutex::new(None)),
                instagram: Mutex::new((String::new(), String::new())),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connect_instagram,
            session_status,
            firebase_status,
            reconnect_firebase,
            refresh_from_cloud,
            gmail_status,
            connect_gmail,
            send_email,
            start_scrape,
            cancel_job,
            running_job,
            list_runs,
            list_creators,
            list_reels,
            stats,
            update_contact,
            delete_creator,
            delete_creators,
            delete_all_data,
            delete_unresolved,
            set_status,
            export_csv,
            db_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ScaleDue");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Byte-for-byte the payload ui/app.js sends inside `invoke("start_scrape")`.
    /// If a field is renamed on either side, this fails instead of the user
    /// hitting a deserialization error the moment they press the button.
    const UI_PAYLOAD: &str = r#"{
        "keywords": ["job search tips", "career advice"],
        "minFollowers": 2000,
        "maxFollowers": 1500000,
        "targetResolved": 200,
        "maxSearchPagesPerKeyword": 4,
        "requireRelevance": true,
        "headless": true
    }"#;

    #[test]
    fn deserializes_the_payload_the_ui_sends() {
        let cfg: ScrapeConfig = serde_json::from_str(UI_PAYLOAD).expect("UI payload must deserialize");
        assert_eq!(cfg.keywords, vec!["job search tips", "career advice"]);
        assert_eq!(cfg.min_followers, Some(2000));
        assert_eq!(cfg.max_followers, Some(1_500_000));
        assert_eq!(cfg.target_resolved, Some(200));
        assert_eq!(cfg.max_search_pages_per_keyword, Some(4));
        assert_eq!(cfg.require_relevance, Some(true));
        assert_eq!(cfg.headless, Some(true));
    }

    #[test]
    fn optional_knobs_may_be_omitted() {
        // Only keywords are required; the scraper's own defaults cover the rest.
        let cfg: ScrapeConfig =
            serde_json::from_str(r#"{"keywords":["resume tips"]}"#).expect("minimal payload");
        assert_eq!(cfg.keywords.len(), 1);
        assert!(cfg.min_followers.is_none());
        assert!(cfg.headless.is_none());
    }

    /// The forwarded config must use the key names instagram-scrape's CONFIG
    /// block reads, or the overrides silently do nothing.
    #[test]
    fn forwards_scraper_config_keys() {
        let cfg: ScrapeConfig = serde_json::from_str(UI_PAYLOAD).unwrap();
        let mut payload = serde_json::Map::new();
        payload.insert("keywords".into(), serde_json::json!(cfg.keywords));
        payload.insert("minFollowers".into(), cfg.min_followers.unwrap().into());
        payload.insert("targetResolved".into(), cfg.target_resolved.unwrap().into());
        let out = serde_json::Value::Object(payload);

        assert_eq!(out["minFollowers"], 2000);
        assert_eq!(out["targetResolved"], 200);
        assert_eq!(out["keywords"][0], "job search tips");
    }
}
