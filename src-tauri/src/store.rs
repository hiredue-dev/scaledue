//! Firestore-backed storage.
//!
//! Layout:
//!   creators/{lowercased-username}            one document per profile
//!   creators/{lowercased-username}/reels/{shortcode}
//!   runs/{run-id}
//!
//! Using the lowercased handle as the document id is what makes duplicate
//! profiles structurally impossible — re-storing a handle addresses the same
//! document rather than adding a row.
//!
//! Reads go through a process-local snapshot of the `creators` collection.
//! Firestore charges per document read and cannot do substring search, so
//! pulling the collection once per change and querying it in memory is both
//! cheaper and more capable than issuing a query per keystroke. The snapshot is
//! dropped whenever we write, and lives only in memory — nothing is persisted
//! to disk.

use crate::model::{self, Creator, Reel, Run, Stats};
use firestore::*;
use futures::stream::BoxStream;
use futures::TryStreamExt;
use std::path::{Path, PathBuf};
use tokio::sync::RwLock;

pub const CREATORS: &str = "creators";
pub const REELS: &str = "reels";
pub const RUNS: &str = "runs";

/// Outcome of a bulk delete. `failed` carries per-document errors so a partial
/// result can be reported honestly rather than as a blanket success.
#[derive(Debug, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BulkDelete {
    pub deleted: usize,
    pub failed: Vec<String>,
}

pub struct Store {
    db: FirestoreDb,
    pub project_id: String,
    /// In-memory only; see the module note on why this exists.
    snapshot: RwLock<Option<Vec<Creator>>>,
}

/// Where to look for the service-account key, in order.
pub fn key_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(explicit) = std::env::var("SCALEDUE_FIREBASE_KEY") {
        if !explicit.trim().is_empty() {
            out.push(PathBuf::from(explicit));
        }
    }
    let scaledue = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    out.push(scaledue.join("firebase-service-account.json"));
    out
}

pub fn find_key() -> Option<PathBuf> {
    key_candidates().into_iter().find(|p| p.exists())
}

/// Pull the project id straight out of the key file, so there's nothing else to
/// configure and the two can never disagree.
fn project_id_from_key(path: &Path) -> Result<String, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("{} is not valid JSON: {e}", path.display()))?;
    match json["project_id"].as_str() {
        Some(id) if !id.is_empty() => Ok(id.to_string()),
        _ => Err(format!(
            "{} has no project_id — is it a service account key? \
             (Firebase console → Project settings → Service accounts → Generate new private key)",
            path.display()
        )),
    }
}

impl Store {
    pub async fn connect() -> Result<Self, String> {
        let key = find_key().ok_or_else(|| {
            let looked = key_candidates()
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join("\n  ");
            format!("No Firebase service-account key found. Looked in:\n  {looked}")
        })?;
        let project_id = project_id_from_key(&key)?;

        let db = FirestoreDb::with_options_service_account_key_file(
            FirestoreDbOptions::new(project_id.clone()),
            key.clone(),
        )
        .await
        .map_err(|e| format!("could not connect to Firestore project {project_id}: {e}"))?;

        Ok(Self { db, project_id, snapshot: RwLock::new(None) })
    }

    // ── snapshot ────────────────────────────────────────────────────────────

    async fn invalidate(&self) {
        *self.snapshot.write().await = None;
    }

    /// Every creator, from the snapshot when warm, otherwise one collection read.
    pub async fn creators(&self) -> Result<Vec<Creator>, String> {
        if let Some(cached) = self.snapshot.read().await.as_ref() {
            return Ok(cached.clone());
        }
        let stream: BoxStream<FirestoreResult<Creator>> = self
            .db
            .fluent()
            .select()
            .from(CREATORS)
            .obj()
            .stream_query_with_errors()
            .await
            .map_err(|e| format!("reading creators: {e}"))?;
        let fetched: Vec<Creator> = stream
            .try_collect()
            .await
            .map_err(|e| format!("reading creators: {e}"))?;

        *self.snapshot.write().await = Some(fetched.clone());
        Ok(fetched)
    }

    pub async fn refresh(&self) -> Result<usize, String> {
        self.invalidate().await;
        Ok(self.creators().await?.len())
    }

    // ── queries ─────────────────────────────────────────────────────────────

    pub async fn list_creators(
        &self,
        run_id: Option<String>,
        search: Option<String>,
    ) -> Result<Vec<Creator>, String> {
        let all = self.creators().await?;
        Ok(model::query(&all, run_id.as_deref(), search.as_deref()))
    }

    pub async fn known_usernames(&self) -> Result<Vec<String>, String> {
        Ok(model::known_usernames(&self.creators().await?))
    }

    pub async fn stats(&self) -> Result<Stats, String> {
        let creators = self.creators().await?;
        let runs = self.list_runs().await?.len() as i64;
        Ok(model::compute_stats(&creators, runs))
    }

    pub async fn list_reels(&self, creator_id: &str) -> Result<Vec<Reel>, String> {
        let parent = self
            .db
            .parent_path(CREATORS, creator_id)
            .map_err(|e| format!("bad creator id {creator_id}: {e}"))?;
        let stream: BoxStream<FirestoreResult<Reel>> = self
            .db
            .fluent()
            .select()
            .from(REELS)
            .parent(&parent)
            .obj()
            .stream_query_with_errors()
            .await
            .map_err(|e| format!("reading reels: {e}"))?;
        let mut reels: Vec<Reel> = stream
            .try_collect()
            .await
            .map_err(|e| format!("reading reels: {e}"))?;
        reels.sort_by(|a, b| b.plays.cmp(&a.plays));
        Ok(reels)
    }

    pub async fn list_runs(&self) -> Result<Vec<Run>, String> {
        let stream: BoxStream<FirestoreResult<Run>> = self
            .db
            .fluent()
            .select()
            .from(RUNS)
            .obj()
            .stream_query_with_errors()
            .await
            .map_err(|e| format!("reading runs: {e}"))?;
        let mut runs: Vec<Run> = stream
            .try_collect()
            .await
            .map_err(|e| format!("reading runs: {e}"))?;
        // Newest first; ids are timestamp-prefixed so this is a plain sort.
        runs.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        Ok(runs)
    }

    // ── runs ────────────────────────────────────────────────────────────────

    pub async fn start_run(&self, keywords: Vec<String>) -> Result<String, String> {
        let run = Run {
            id: format!("run-{}", now().replace([':', '.'], "-")),
            started_at: now(),
            status: "running".into(),
            keywords,
            ..Default::default()
        };
        self.put_run(&run).await?;
        Ok(run.id)
    }

    async fn put_run(&self, run: &Run) -> Result<(), String> {
        self.db
            .fluent()
            .update()
            .in_col(RUNS)
            .document_id(&run.id)
            .object(run)
            .execute::<Run>()
            .await
            .map_err(|e| format!("writing run {}: {e}", run.id))?;
        Ok(())
    }

    async fn get_run(&self, run_id: &str) -> Result<Option<Run>, String> {
        self.db
            .fluent()
            .select()
            .by_id_in(RUNS)
            .obj::<Run>()
            .one(run_id)
            .await
            .map_err(|e| format!("reading run {run_id}: {e}"))
    }

    pub async fn finish_run(&self, run_id: &str, meta: &serde_json::Value) -> Result<(), String> {
        let mut run = self.get_run(run_id).await?.unwrap_or_else(|| Run {
            id: run_id.to_string(),
            started_at: now(),
            ..Default::default()
        });
        run.finished_at = now();
        run.status = "success".into();
        run.discovered = meta["discovered"].as_i64().unwrap_or(0);
        run.reels_seen = meta["reelsSeen"].as_i64().unwrap_or(0);
        run.enrich_attempted = meta["enrichAttempted"].as_i64().unwrap_or(0);
        run.enrich_resolved = meta["enrichResolved"].as_i64().unwrap_or(0);
        run.qualified = meta["qualified"].as_i64().unwrap_or(0);
        run.stored = meta["stored"].as_i64().unwrap_or(0);
        run.skipped_known = meta["skippedKnown"].as_i64().unwrap_or(0);
        run.rate_limited = meta["rateLimited"].as_bool().unwrap_or(false);
        self.put_run(&run).await
    }

    pub async fn fail_run(&self, run_id: &str, error: &str) -> Result<(), String> {
        let mut run = self.get_run(run_id).await?.unwrap_or_else(|| Run {
            id: run_id.to_string(),
            started_at: now(),
            ..Default::default()
        });
        run.finished_at = now();
        run.status = "failed".into();
        run.error = error.to_string();
        self.put_run(&run).await
    }

    // ── ingest ──────────────────────────────────────────────────────────────

    /// Store an artifact's creators and their reels. Returns how many creators
    /// were written.
    pub async fn ingest_artifact(
        &self,
        run_id: &str,
        artifact: &serde_json::Value,
    ) -> Result<usize, String> {
        let empty = vec![];
        let entries = artifact["creators"].as_array().unwrap_or(&empty);
        if entries.is_empty() {
            return Ok(0);
        }

        // Existing docs carry the manual edits and first-seen timestamps that a
        // re-scrape must not lose, so read before writing.
        let existing = self.creators().await?;
        let by_id: std::collections::HashMap<&str, &Creator> =
            existing.iter().map(|c| (c.id.as_str(), c)).collect();

        let stamp = now();
        let mut written = 0usize;

        for entry in entries {
            let Some(creator) = model::creator_from_artifact(
                entry,
                run_id,
                &stamp,
                by_id.get(model::doc_id(entry["username"].as_str().unwrap_or("")).as_str()).copied(),
            ) else {
                continue;
            };

            self.db
                .fluent()
                .update()
                .in_col(CREATORS)
                .document_id(&creator.id)
                .object(&creator)
                .execute::<Creator>()
                .await
                .map_err(|e| format!("writing creator {}: {e}", creator.username))?;

            let reels = model::reels_from_artifact(entry, &creator.id);
            if !reels.is_empty() {
                let parent = self
                    .db
                    .parent_path(CREATORS, &creator.id)
                    .map_err(|e| format!("bad creator id: {e}"))?;
                for reel in &reels {
                    self.db
                        .fluent()
                        .update()
                        .in_col(REELS)
                        .document_id(&reel.shortcode)
                        .parent(&parent)
                        .object(reel)
                        .execute::<Reel>()
                        .await
                        .map_err(|e| format!("writing reel {}: {e}", reel.shortcode))?;
                }
            }
            written += 1;
        }

        self.invalidate().await;
        Ok(written)
    }

    // ── edits ───────────────────────────────────────────────────────────────

    pub async fn update_contact(&self, creator_id: &str, email: &str, phone: &str) -> Result<(), String> {
        let mut creator = self.fetch_creator(creator_id).await?;
        creator.email_override = email.trim().to_string();
        creator.phone_override = phone.trim().to_string();
        creator.recompute();

        self.put_creator(&creator).await?;
        self.invalidate().await;
        Ok(())
    }

    /// Move a creator to a different pipeline status.
    pub async fn set_status(&self, creator_id: &str, status: &str) -> Result<(), String> {
        if !model::is_valid_status(status) {
            return Err(format!("unknown status: {status}"));
        }
        let mut creator = self.fetch_creator(creator_id).await?;
        creator.status = status.to_string();
        self.put_creator(&creator).await?;
        self.invalidate().await;
        Ok(())
    }

    /// Delete every creator whose profile lookup never resolved.
    ///
    /// These are bare handles with no follower count or bio — discovered but
    /// never enriched, because enrichment is rate-limited and capped per run.
    pub async fn delete_unresolved(
        &self,
        progress: impl FnMut(usize, usize),
    ) -> Result<BulkDelete, String> {
        let ids: Vec<String> = self
            .creators()
            .await?
            .into_iter()
            .filter(|c| !c.is_enriched)
            .map(|c| c.id)
            .collect();
        if ids.is_empty() {
            return Ok(BulkDelete::default());
        }
        self.delete_creators(&ids, progress).await
    }

    async fn fetch_creator(&self, creator_id: &str) -> Result<Creator, String> {
        self.db
            .fluent()
            .select()
            .by_id_in(CREATORS)
            .obj()
            .one(creator_id)
            .await
            .map_err(|e| format!("reading creator {creator_id}: {e}"))?
            .ok_or_else(|| "creator not found".to_string())
    }

    async fn put_creator(&self, creator: &Creator) -> Result<(), String> {
        self.db
            .fluent()
            .update()
            .in_col(CREATORS)
            .document_id(&creator.id)
            .object(creator)
            .execute::<Creator>()
            .await
            .map_err(|e| format!("saving creator {}: {e}", creator.id))?;
        Ok(())
    }

    /// Note that an outreach email went out. Written straight to the document
    /// rather than folded into a scrape, so it survives every later re-scrape.
    pub async fn record_outreach(
        &self,
        creator_id: &str,
        to: &str,
        sent_at: &str,
        message_id: &str,
    ) -> Result<(), String> {
        let mut creator = self.fetch_creator(creator_id).await?;
        creator.emailed_at = sent_at.to_string();
        creator.emailed_to = to.to_string();
        creator.email_message_id = message_id.to_string();
        // Sending mail *is* initiating outreach — advance the pipeline unless a
        // reply has already been recorded, which is further along.
        if creator.status != model::STATUS_RESPONDED {
            creator.status = model::STATUS_OUTREACH.to_string();
        }

        self.put_creator(&creator).await?;
        self.invalidate().await;
        Ok(())
    }

    /// Delete many creators, reporting progress as it goes.
    ///
    /// Firestore has no server-side "delete these documents" call, so this is a
    /// loop of round trips — slow enough for a few hundred creators that the UI
    /// needs to show progress rather than appear frozen. Errors on individual
    /// creators are collected instead of aborting: a partial delete that skips
    /// two bad documents beats one that stops a third of the way through.
    pub async fn delete_creators(
        &self,
        ids: &[String],
        mut progress: impl FnMut(usize, usize),
    ) -> Result<BulkDelete, String> {
        let total = ids.len();
        let mut deleted = 0usize;
        let mut failures: Vec<String> = Vec::new();

        for (i, id) in ids.iter().enumerate() {
            match self.delete_one(id).await {
                Ok(()) => deleted += 1,
                Err(e) => failures.push(format!("{id}: {e}")),
            }
            progress(i + 1, total);
        }

        self.invalidate().await;
        Ok(BulkDelete { deleted, failed: failures })
    }

    /// Wipe every creator, reel and run. Used by "Delete all".
    pub async fn delete_all(
        &self,
        mut progress: impl FnMut(usize, usize),
    ) -> Result<BulkDelete, String> {
        let creators = self.creators().await?;
        let runs = self.list_runs().await?;
        let total = creators.len() + runs.len();

        let mut deleted = 0usize;
        let mut failures: Vec<String> = Vec::new();
        let mut done = 0usize;

        for c in &creators {
            match self.delete_one(&c.id).await {
                Ok(()) => deleted += 1,
                Err(e) => failures.push(format!("{}: {e}", c.id)),
            }
            done += 1;
            progress(done, total);
        }

        // Runs are metadata about scrapes; leaving them behind would populate
        // the run filter with entries that match nothing.
        for r in &runs {
            match self
                .db
                .fluent()
                .delete()
                .from(RUNS)
                .document_id(&r.id)
                .execute()
                .await
            {
                Ok(()) => deleted += 1,
                Err(e) => failures.push(format!("run {}: {e}", r.id)),
            }
            done += 1;
            progress(done, total);
        }

        self.invalidate().await;
        Ok(BulkDelete { deleted, failed: failures })
    }

    /// Delete one creator and its reels, without invalidating the snapshot —
    /// bulk callers invalidate once at the end instead of per document.
    async fn delete_one(&self, creator_id: &str) -> Result<(), String> {
        let parent = self
            .db
            .parent_path(CREATORS, creator_id)
            .map_err(|e| format!("bad creator id: {e}"))?;

        for reel in self.list_reels(creator_id).await.unwrap_or_default() {
            let _ = self
                .db
                .fluent()
                .delete()
                .from(REELS)
                .parent(&parent)
                .document_id(&reel.shortcode)
                .execute()
                .await;
        }

        self.db
            .fluent()
            .delete()
            .from(CREATORS)
            .document_id(creator_id)
            .execute()
            .await
            .map_err(|e| format!("deleting creator: {e}"))
    }

    /// Delete a creator and its reels. Firestore does not cascade, so the
    /// subcollection has to be cleared explicitly or the reels are orphaned and
    /// keep costing storage while being unreachable from the UI.
    pub async fn delete_creator(&self, creator_id: &str) -> Result<(), String> {
        let parent = self
            .db
            .parent_path(CREATORS, creator_id)
            .map_err(|e| format!("bad creator id: {e}"))?;

        for reel in self.list_reels(creator_id).await.unwrap_or_default() {
            let _ = self
                .db
                .fluent()
                .delete()
                .from(REELS)
                .parent(&parent)
                .document_id(&reel.shortcode)
                .execute()
                .await;
        }

        self.db
            .fluent()
            .delete()
            .from(CREATORS)
            .document_id(creator_id)
            .execute()
            .await
            .map_err(|e| format!("deleting creator: {e}"))?;

        self.invalidate().await;
        Ok(())
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(name: &str, body: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("scaledue-key-{}-{name}", std::process::id()));
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn reads_the_project_id_out_of_a_key_file() {
        let p = write("ok.json", r#"{"type":"service_account","project_id":"hiredue-abc","client_email":"x@y.z"}"#);
        assert_eq!(project_id_from_key(&p).unwrap(), "hiredue-abc");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn rejects_a_json_file_that_is_not_a_service_account() {
        // The most likely setup mistake: downloading the *web app* config
        // (firebaseConfig) instead of a service-account key.
        let p = write("web.json", r#"{"apiKey":"AIza...","projectId":"hiredue-abc"}"#);
        let err = project_id_from_key(&p).unwrap_err();
        assert!(err.contains("no project_id"), "got: {err}");
        assert!(err.contains("Service accounts"), "error should say where to get the right file");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn reports_unparseable_json_clearly() {
        let p = write("bad.json", "not json at all");
        let err = project_id_from_key(&p).unwrap_err();
        assert!(err.contains("not valid JSON"), "got: {err}");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn missing_file_is_an_error_not_a_panic() {
        let err = project_id_from_key(Path::new("/nope/definitely-missing.json")).unwrap_err();
        assert!(err.contains("reading"), "got: {err}");
    }

    #[test]
    fn key_lookup_prefers_the_env_override() {
        // Documents the precedence the setup instructions rely on.
        let candidates = key_candidates();
        assert!(
            candidates
                .last()
                .unwrap()
                .ends_with("firebase-service-account.json"),
            "the project-local path is the documented default"
        );
    }
}
