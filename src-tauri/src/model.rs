//! Data model and all the logic that doesn't touch the network.
//!
//! Firestore can't do substring search or arbitrary aggregation, so filtering,
//! ranking, stats and CSV all happen here over an in-memory creator set. Keeping
//! that logic free of I/O means it's directly testable without credentials.

use serde::{Deserialize, Serialize};

/// One creator. The Firestore document id is the lowercased username, which is
/// what makes duplicate profiles impossible: re-storing the same handle
/// addresses the same document.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Creator {
    pub id: String,
    pub username: String,
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub full_name: String,
    #[serde(default)]
    pub profile_url: String,
    #[serde(default)]
    pub followers: i64,
    #[serde(default)]
    pub following: i64,
    #[serde(default)]
    pub posts: i64,
    #[serde(default)]
    pub bio: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub is_verified: bool,
    #[serde(default)]
    pub is_business: bool,
    /// The profile lookup resolved, so followers/bio are real.
    #[serde(default)]
    pub is_enriched: bool,
    /// Met the partnership criteria at scrape time.
    #[serde(default)]
    pub is_qualified: bool,

    /// As scraped from Instagram.
    #[serde(default)]
    pub business_email: String,
    #[serde(default)]
    pub business_phone: String,
    /// Hand-entered. Kept apart so a re-scrape can't overwrite an edit.
    #[serde(default)]
    pub email_override: String,
    #[serde(default)]
    pub phone_override: String,
    /// Override-or-scraped, denormalised so the Firebase console shows the
    /// effective contact too. Always rebuilt by `recompute` before a write.
    #[serde(default)]
    pub contact_email: String,
    #[serde(default)]
    pub contact_phone: String,

    #[serde(default)]
    pub external_url: String,
    #[serde(default)]
    pub bio_links: Vec<String>,
    #[serde(default)]
    pub reel_count: i64,
    #[serde(default)]
    pub avg_plays: i64,
    #[serde(default)]
    pub score: i64,
    #[serde(default)]
    pub matched_terms: Vec<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub top_reel_url: String,

    /// Every run that surfaced this creator. Filtering by run happens in memory,
    /// which avoids needing a composite Firestore index.
    #[serde(default)]
    pub run_ids: Vec<String>,
    /// Where this creator is in the outreach pipeline. One of the values in
    /// `STATUSES`; empty is treated as "new" so records predating the field
    /// don't need a migration.
    #[serde(default)]
    pub status: String,
    /// Outreach: when we last emailed, and to which address. Empty until sent.
    #[serde(default)]
    pub emailed_at: String,
    #[serde(default)]
    pub emailed_to: String,
    #[serde(default)]
    pub email_message_id: String,
    #[serde(default)]
    pub times_seen: i64,
    #[serde(default)]
    pub first_seen_at: String,
    #[serde(default)]
    pub last_seen_at: String,
}

impl Creator {
    /// Rebuild the denormalised contact fields. Call before every write.
    pub fn recompute(&mut self) {
        self.contact_email = if self.email_override.trim().is_empty() {
            self.business_email.clone()
        } else {
            self.email_override.trim().to_string()
        };
        self.contact_phone = if self.phone_override.trim().is_empty() {
            self.business_phone.clone()
        } else {
            self.phone_override.trim().to_string()
        };
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Run {
    pub id: String,
    pub started_at: String,
    #[serde(default)]
    pub finished_at: String,
    pub status: String,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub discovered: i64,
    #[serde(default)]
    pub reels_seen: i64,
    #[serde(default)]
    pub enrich_attempted: i64,
    #[serde(default)]
    pub enrich_resolved: i64,
    #[serde(default)]
    pub qualified: i64,
    #[serde(default)]
    pub stored: i64,
    #[serde(default)]
    pub skipped_known: i64,
    #[serde(default)]
    pub rate_limited: bool,
    #[serde(default)]
    pub error: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Reel {
    pub id: String,
    #[serde(default)]
    pub creator_id: String,
    pub shortcode: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub caption: String,
    #[serde(default)]
    pub plays: i64,
    #[serde(default)]
    pub likes: i64,
    #[serde(default)]
    pub comments: i64,
    #[serde(default)]
    pub taken_at: String,
    #[serde(default)]
    pub is_reel: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Stats {
    pub total_creators: i64,
    pub total_runs: i64,
    pub total_reels: i64,
    pub with_email: i64,
    pub total_reach: i64,
    pub qualified: i64,
}

// ── Artifact mapping ────────────────────────────────────────────────────────

fn s(v: &serde_json::Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

fn yes(v: &serde_json::Value) -> bool {
    v.as_str().unwrap_or("No") == "Yes"
}

fn list(v: &serde_json::Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

pub const STATUS_NEW: &str = "new";
pub const STATUS_OUTREACH: &str = "outreach";
pub const STATUS_RESPONDED: &str = "responded";

/// The pipeline statuses a creator can be in, in order.
pub const STATUSES: [&str; 3] = [STATUS_NEW, STATUS_OUTREACH, STATUS_RESPONDED];

pub fn is_valid_status(s: &str) -> bool {
    STATUSES.contains(&s)
}

/// Empty (a record written before the field existed) reads as "new".
pub fn status_or_default(s: &str) -> &str {
    if s.is_empty() { STATUS_NEW } else { s }
}

/// Document id for a handle. Lowercasing is what enforces "one row per profile"
/// no matter how Instagram cases the username between runs.
///
/// Firestore rejects ids that start/end with `__`, contain `..`, `#`, `[`, `]`,
/// `/`, or exceed 1500 bytes.  This is not an Instagram-enforced naming rule —
/// people really choose handles like `__divyabansal__` — so we mangle the
/// offending characters into a form that is both safe and stable across runs.
pub fn doc_id(username: &str) -> String {
    let lower = username.trim().to_lowercase();

    // Fast path: the vast majority of handles are already clean.
    if lower.len() <= 1500
        && !lower.contains("__")
        && !lower.contains("..")
        && !lower.contains('#')
        && !lower.contains('[')
        && !lower.contains(']')
        && !lower.contains('/')
    {
        return lower;
    }

    // Replace reserved substrings/characters with safe equivalents.
    let mut sanitized = String::with_capacity(lower.len());
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'#' | b'[' | b']' | b'/' => sanitized.push('_'),
            b'_' => {
                let start = i;
                while i < bytes.len() && bytes[i] == b'_' {
                    i += 1;
                }
                if start > 0 && i < bytes.len() {
                    sanitized.push('_');
                }
                continue;
            }
            b'.' => {
                let start = i;
                while i < bytes.len() && bytes[i] == b'.' {
                    i += 1;
                }
                if start > 0 && i < bytes.len() {
                    sanitized.push('.');
                }
                continue;
            }
            other => sanitized.push(other as char),
        }
        i += 1;
    }

    // Trim leading/trailing underscores and dots.
    let trimmed = sanitized.trim_matches(|c: char| c == '_' || c == '.');

    if trimmed.is_empty() {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        lower.hash(&mut hasher);
        format!("u{}", hasher.finish())
    } else if trimmed.len() > 1500 {
        trimmed[..1500].to_string()
    } else {
        trimmed.to_string()
    }
}

/// Build a creator from one entry of a scraper artifact.
///
/// `existing` carries anything that must not be lost on a re-scrape: the
/// hand-edited contact, the first-seen timestamp, and the accumulated run list.
pub fn creator_from_artifact(
    c: &serde_json::Value,
    run_id: &str,
    now: &str,
    existing: Option<&Creator>,
) -> Option<Creator> {
    let username = s(&c["username"]);
    if username.trim().is_empty() {
        return None;
    }

    let mut run_ids = existing.map(|e| e.run_ids.clone()).unwrap_or_default();
    if !run_ids.iter().any(|r| r == run_id) {
        run_ids.push(run_id.to_string());
    }

    let mut creator = Creator {
        id: doc_id(&username),
        username: username.clone(),
        user_id: s(&c["userId"]),
        full_name: s(&c["fullName"]),
        profile_url: s(&c["profileUrl"]),
        followers: c["followers"].as_i64().unwrap_or(0),
        following: c["following"].as_i64().unwrap_or(0),
        posts: c["posts"].as_i64().unwrap_or(0),
        bio: s(&c["bio"]),
        category: s(&c["category"]),
        is_verified: yes(&c["isVerified"]),
        is_business: yes(&c["isBusinessAccount"]),
        is_enriched: yes(&c["enriched"]),
        is_qualified: yes(&c["qualified"]),
        business_email: s(&c["businessEmail"]),
        business_phone: s(&c["businessPhone"]),
        // Manual edits belong to the operator, never to the scrape.
        email_override: existing.map(|e| e.email_override.clone()).unwrap_or_default(),
        phone_override: existing.map(|e| e.phone_override.clone()).unwrap_or_default(),
        contact_email: String::new(),
        contact_phone: String::new(),
        external_url: s(&c["externalUrl"]),
        bio_links: list(&c["bioLinks"]),
        reel_count: c["reelCount"].as_i64().unwrap_or(0),
        avg_plays: c["avgPlays"].as_i64().unwrap_or(0),
        score: c["score"].as_i64().unwrap_or(0),
        matched_terms: list(&c["matchedTerms"]),
        keywords: list(&c["keywords"]),
        top_reel_url: s(&c["topReelUrl"]),
        run_ids,
        // Outreach state belongs to the operator, not the scrape.
        status: existing
            .map(|e| e.status.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| STATUS_NEW.to_string()),
        emailed_at: existing.map(|e| e.emailed_at.clone()).unwrap_or_default(),
        emailed_to: existing.map(|e| e.emailed_to.clone()).unwrap_or_default(),
        email_message_id: existing.map(|e| e.email_message_id.clone()).unwrap_or_default(),
        times_seen: existing.map(|e| e.times_seen + 1).unwrap_or(1),
        first_seen_at: existing
            .map(|e| e.first_seen_at.clone())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| now.to_string()),
        last_seen_at: now.to_string(),
    };
    creator.recompute();
    Some(creator)
}

/// Reels attached to one creator entry of an artifact.
pub fn reels_from_artifact(c: &serde_json::Value, creator_id: &str) -> Vec<Reel> {
    c["reels"]
        .as_array()
        .map(|reels| {
            reels
                .iter()
                .filter_map(|r| {
                    let shortcode = s(&r["shortcode"]);
                    if shortcode.is_empty() {
                        return None;
                    }
                    Some(Reel {
                        id: shortcode.clone(),
                        creator_id: creator_id.to_string(),
                        shortcode,
                        url: s(&r["url"]),
                        caption: s(&r["caption"]),
                        plays: r["plays"].as_i64().unwrap_or(0),
                        likes: r["likes"].as_i64().unwrap_or(0),
                        comments: r["comments"].as_i64().unwrap_or(0),
                        taken_at: s(&r["takenAt"]),
                        is_reel: r["isReel"].as_bool().unwrap_or(true),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

// ── In-memory querying ──────────────────────────────────────────────────────

/// Filter and rank a creator set.
///
/// Firestore offers no substring matching, so search runs here across handle,
/// name and bio. Run filtering is in memory too, which keeps the Firestore side
/// to a single collection read and avoids needing a composite index.
pub fn query(creators: &[Creator], run_id: Option<&str>, search: Option<&str>) -> Vec<Creator> {
    let needle = search.unwrap_or("").trim().to_lowercase();

    let mut out: Vec<Creator> = creators
        .iter()
        .filter(|c| match run_id {
            Some(r) => c.run_ids.iter().any(|x| x == r),
            None => true,
        })
        .filter(|c| {
            needle.is_empty()
                || c.username.to_lowercase().contains(&needle)
                || c.full_name.to_lowercase().contains(&needle)
                || c.bio.to_lowercase().contains(&needle)
        })
        .cloned()
        .collect();

    out.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then(b.followers.cmp(&a.followers))
            .then(a.username.cmp(&b.username))
    });
    out
}

pub fn compute_stats(creators: &[Creator], total_runs: i64) -> Stats {
    Stats {
        total_creators: creators.len() as i64,
        total_runs,
        total_reels: creators.iter().map(|c| c.reel_count).sum(),
        with_email: creators.iter().filter(|c| !c.contact_email.is_empty()).count() as i64,
        total_reach: creators.iter().map(|c| c.followers).sum(),
        qualified: creators.iter().filter(|c| c.is_qualified).count() as i64,
    }
}

pub fn known_usernames(creators: &[Creator]) -> Vec<String> {
    creators.iter().map(|c| c.username.clone()).collect()
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/// Quote a field only when it needs it (commas, quotes, newlines, edge spaces).
fn csv_cell(v: &str) -> String {
    if v.contains([',', '"', '\n', '\r']) || v.trim() != v {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

pub const CSV_HEADER: &[&str] = &[
    "username", "fullName", "profileUrl", "followers", "following", "posts",
    "bio", "category", "isVerified", "isBusinessAccount", "contactEmail",
    "contactPhone", "contactIsManual", "scrapedEmail", "scrapedPhone",
    "externalUrl", "bioLinks", "reelCount", "avgPlays", "score", "enriched",
    "qualified", "status", "emailedAt", "emailedTo", "matchedTerms", "keywords", "topReelUrl", "timesSeen",
    "firstSeenAt", "lastSeenAt",
];

/// Render creators as CSV.
///
/// Prefixed with a UTF-8 BOM: bios are full of emoji, and without it Excel
/// decodes the file as the local codepage and mangles them.
pub fn creators_to_csv(creators: &[Creator]) -> String {
    let mut out = String::from("\u{feff}");
    out.push_str(&CSV_HEADER.join(","));
    out.push('\n');

    for c in creators {
        let fields = [
            c.username.clone(),
            c.full_name.clone(),
            c.profile_url.clone(),
            c.followers.to_string(),
            c.following.to_string(),
            c.posts.to_string(),
            c.bio.replace(['\n', '\r'], " "),
            c.category.clone(),
            yn(c.is_verified),
            yn(c.is_business),
            c.contact_email.clone(),
            c.contact_phone.clone(),
            yn(!c.email_override.is_empty() || !c.phone_override.is_empty()),
            c.business_email.clone(),
            c.business_phone.clone(),
            c.external_url.clone(),
            c.bio_links.join(" | "),
            c.reel_count.to_string(),
            c.avg_plays.to_string(),
            c.score.to_string(),
            yn(c.is_enriched),
            yn(c.is_qualified),
            status_or_default(&c.status).to_string(),
            c.emailed_at.clone(),
            c.emailed_to.clone(),
            c.matched_terms.join(" | "),
            c.keywords.join(" | "),
            c.top_reel_url.clone(),
            c.times_seen.to_string(),
            c.first_seen_at.clone(),
            c.last_seen_at.clone(),
        ];
        out.push_str(&fields.iter().map(|f| csv_cell(f)).collect::<Vec<_>>().join(","));
        out.push('\n');
    }
    out
}

fn yn(b: bool) -> String {
    if b { "Yes" } else { "No" }.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Byte-for-byte the shape `saveResults` writes in instagram-scrape.
    const RAW: &str = r#"{
      "discovered": 182, "reelsSeen": 98, "enrichAttempted": 25,
      "enrichResolved": 25, "qualified": 1, "stored": 2, "skippedKnown": 40,
      "creators": [
        {
          "username": "WorkLifeWithPriya", "userId": "72023999605",
          "fullName": "Priya Singh", "profileUrl": "https://www.instagram.com/worklifewithpriya/",
          "followers": 128924, "following": 67, "posts": 160,
          "bio": "Jobs . Interview . Career", "category": "",
          "isVerified": "Yes", "isBusinessAccount": "No",
          "businessEmail": "priya@example.com", "businessPhone": "",
          "externalUrl": "https://topmate.io/x", "bioLinks": ["https://topmate.io/x"],
          "reelCount": 1, "avgPlays": 1166207, "score": 36,
          "matchedTerms": ["job","career"], "keywords": ["resume tips"],
          "topReelUrl": "https://www.instagram.com/reel/DY9zqcmSVQ4/",
          "enriched": "Yes", "qualified": "Yes",
          "reels": [{"shortcode":"DY9zqcmSVQ4","url":"https://www.instagram.com/reel/DY9zqcmSVQ4/",
                     "caption":"resume hack","plays":1166207,"likes":14833,"comments":10197,
                     "takenAt":"2026-05-30T14:14:54.000Z","isReel":true}]
        },
        {
          "username": "barehandle", "profileUrl": "https://www.instagram.com/barehandle/",
          "followers": 0, "bio": "", "enriched": "No", "qualified": "No",
          "score": 0, "bioLinks": [], "matchedTerms": [], "keywords": [], "reels": []
        }
      ]
    }"#;

    fn artifact() -> serde_json::Value {
        serde_json::from_str(RAW).expect("fixture must parse")
    }

    fn ingest(run: &str) -> Vec<Creator> {
        artifact()["creators"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|c| creator_from_artifact(c, run, "2026-09-05T00:00:00Z", None))
            .collect()
    }

    #[test]
    fn document_id_is_the_lowercased_handle() {
        // This is what makes duplicate profiles impossible across runs.
        assert_eq!(doc_id("WorkLifeWithPriya"), "worklifewithpriya");
        assert_eq!(doc_id("  Spaced  "), "spaced");
        assert_eq!(doc_id("worklifewithpriya"), doc_id("WORKLIFEWITHPRIYA"));
    }

    #[test]
    fn strips_leading_trailing_double_underscores() {
        // __divyabansal__ → divyabansal  (the exact error case from prod)
        assert_eq!(doc_id("__divyabansal__"), "divyabansal");
        // Plain handle is unchanged.
        assert_eq!(doc_id("divyabansal"), "divyabansal");
        // Interior underscores are kept.
        assert_eq!(doc_id("some_user"), "some_user");
    }

    #[test]
    fn collapses_reserved_characters() {
        // #, [, ], / → each replaced with a single _
        assert_eq!(doc_id("user#name"), "user_name");
        assert_eq!(doc_id("[test]"), "test");

        // .. → single .
        assert_eq!(doc_id("user..name"), "user.name");

        // Single dots and single underscores are fine (valid Firestore ids).
        assert_eq!(doc_id(".leading"), ".leading");
        assert_eq!(doc_id("trailing."), "trailing.");

        // # / [ ] at edges get stripped by trim.
        assert_eq!(doc_id("#user"), "user");
        assert_eq!(doc_id("user/"), "user");
    }

    #[test]
    fn all_reserved_chars_is_not_panicky() {
        // A username that is nothing but _ . [ ] # / → stable fallback.
        let id = doc_id("__..#__");
        assert!(!id.is_empty());
        assert!(!id.starts_with("__"));
        assert!(!id.ends_with("__"));
        // Same input gives the same id every time.
        assert_eq!(doc_id("__..#__"), id);
    }

    #[test]
    fn identical_usernames_produce_the_same_id() {
        // The whole point: re-scraping the same handle hits the same document.
        assert_eq!(doc_id("__divyabansal__"), doc_id("__divyabansal__"));
        assert_eq!(doc_id("user__"), doc_id("user__"));
    }

    #[test]
    fn maps_an_artifact_entry_to_a_creator() {
        let c = &ingest("run-1")[0];
        assert_eq!(c.id, "worklifewithpriya");
        assert_eq!(c.username, "WorkLifeWithPriya", "display case is preserved");
        assert_eq!(c.followers, 128_924);
        assert!(c.is_verified);
        assert!(!c.is_business);
        assert!(c.is_enriched && c.is_qualified);
        assert_eq!(c.bio_links, vec!["https://topmate.io/x"]);
        assert_eq!(c.matched_terms, vec!["job", "career"]);
        assert_eq!(c.contact_email, "priya@example.com", "falls back to the scraped value");
        assert_eq!(c.run_ids, vec!["run-1"]);
        assert_eq!(c.times_seen, 1);
    }

    #[test]
    fn unresolved_handles_are_kept_and_flagged() {
        let c = &ingest("run-1")[1];
        assert_eq!(c.id, "barehandle");
        assert!(!c.is_enriched);
        assert!(!c.is_qualified);
        assert_eq!(c.followers, 0);
    }

    #[test]
    fn rescraping_keeps_manual_edits_and_first_seen() {
        let mut first = ingest("run-1").remove(0);
        first.email_override = "hand@typed.com".into();
        first.first_seen_at = "2026-01-01T00:00:00Z".into();
        first.recompute();

        let entry = &artifact()["creators"][0];
        let again = creator_from_artifact(entry, "run-2", "2026-09-06T00:00:00Z", Some(&first)).unwrap();

        assert_eq!(again.contact_email, "hand@typed.com", "the edit must survive");
        assert_eq!(again.email_override, "hand@typed.com");
        assert_eq!(again.business_email, "priya@example.com", "scraped value still recorded");
        assert_eq!(again.first_seen_at, "2026-01-01T00:00:00Z");
        assert_eq!(again.last_seen_at, "2026-09-06T00:00:00Z");
        assert_eq!(again.times_seen, 2);
        assert_eq!(again.run_ids, vec!["run-1", "run-2"], "run history accumulates");
    }

    #[test]
    fn a_repeated_run_id_is_not_duplicated() {
        let first = ingest("run-1").remove(0);
        let again =
            creator_from_artifact(&artifact()["creators"][0], "run-1", "later", Some(&first)).unwrap();
        assert_eq!(again.run_ids, vec!["run-1"]);
    }

    #[test]
    fn recompute_prefers_the_override_and_clears_back() {
        let mut c = ingest("r").remove(0);
        c.email_override = "  better@example.com  ".into();
        c.recompute();
        assert_eq!(c.contact_email, "better@example.com", "trimmed");

        c.email_override = "".into();
        c.recompute();
        assert_eq!(c.contact_email, "priya@example.com", "falls back once cleared");
    }

    #[test]
    fn reels_map_with_the_creator_as_parent() {
        let reels = reels_from_artifact(&artifact()["creators"][0], "worklifewithpriya");
        assert_eq!(reels.len(), 1);
        assert_eq!(reels[0].shortcode, "DY9zqcmSVQ4");
        assert_eq!(reels[0].plays, 1_166_207);
        assert_eq!(reels[0].creator_id, "worklifewithpriya");
        assert!(reels_from_artifact(&artifact()["creators"][1], "barehandle").is_empty());
    }

    #[test]
    fn new_creators_start_in_the_new_status() {
        let c = &ingest("run-1")[0];
        assert_eq!(c.status, STATUS_NEW);
    }

    #[test]
    fn a_rescrape_never_resets_outreach_status() {
        let mut first = ingest("run-1").remove(0);
        first.status = STATUS_RESPONDED.into();
        first.emailed_at = "2026-09-01T00:00:00Z".into();

        let again =
            creator_from_artifact(&artifact()["creators"][0], "run-2", "now", Some(&first)).unwrap();
        assert_eq!(again.status, STATUS_RESPONDED, "a scrape must not undo pipeline state");
        assert_eq!(again.emailed_at, "2026-09-01T00:00:00Z");
    }

    #[test]
    fn a_blank_status_reads_as_new() {
        // Records written before the field existed carry an empty string.
        assert_eq!(status_or_default(""), STATUS_NEW);
        assert_eq!(status_or_default(STATUS_OUTREACH), STATUS_OUTREACH);
    }

    #[test]
    fn only_known_statuses_are_accepted() {
        assert!(is_valid_status("new") && is_valid_status("outreach") && is_valid_status("responded"));
        assert!(!is_valid_status("") && !is_valid_status("archived"));
    }

    #[test]
    fn csv_carries_the_status() {
        let mut all = ingest("run-1");
        all[1].status = STATUS_OUTREACH.into();
        let csv = creators_to_csv(&all);
        assert!(csv.lines().next().unwrap().contains("status"));
        assert!(csv.lines().find(|l| l.starts_with("barehandle")).unwrap().contains("outreach"));
    }

    #[test]
    fn query_searches_handle_name_and_bio() {
        let all = ingest("run-1");
        assert_eq!(query(&all, None, None).len(), 2);
        assert_eq!(query(&all, None, Some("interview")).len(), 1, "matches the bio");
        assert_eq!(query(&all, None, Some("PRIYA")).len(), 1, "case-insensitive");
        assert_eq!(query(&all, None, Some("bare")).len(), 1, "matches the handle");
        assert_eq!(query(&all, None, Some("nothing")).len(), 0);
    }

    #[test]
    fn query_filters_by_run_and_ranks_by_score() {
        let mut all = ingest("run-1");
        all[1].run_ids = vec!["run-2".into()];

        assert_eq!(query(&all, Some("run-1"), None).len(), 1);
        assert_eq!(query(&all, Some("run-2"), None)[0].username, "barehandle");
        assert_eq!(query(&all, Some("run-3"), None).len(), 0);

        let ranked = query(&all, None, None);
        assert_eq!(ranked[0].score, 36, "highest score first");
        assert_eq!(ranked[1].score, 0);
    }

    #[test]
    fn stats_come_from_the_in_memory_set() {
        let s = compute_stats(&ingest("run-1"), 3);
        assert_eq!(s.total_creators, 2);
        assert_eq!(s.qualified, 1);
        assert_eq!(s.with_email, 1);
        assert_eq!(s.total_reach, 128_924);
        assert_eq!(s.total_reels, 1);
        assert_eq!(s.total_runs, 3);
    }

    #[test]
    fn stats_count_a_hand_typed_email() {
        let mut all = ingest("run-1");
        all[1].email_override = "typed@example.com".into();
        all[1].recompute();
        assert_eq!(compute_stats(&all, 0).with_email, 2);
    }

    #[test]
    fn csv_quotes_only_what_needs_it() {
        assert_eq!(csv_cell("plain"), "plain");
        assert_eq!(csv_cell("has,comma"), "\"has,comma\"");
        assert_eq!(csv_cell("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_cell(" padded "), "\" padded \"");
    }

    #[test]
    fn csv_has_bom_flattens_lists_and_one_row_each() {
        let csv = creators_to_csv(&ingest("run-1"));
        assert!(csv.starts_with('\u{feff}'), "Excel needs the BOM for emoji bios");

        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines.len(), 3, "header + 2 creators");
        assert!(lines[0].contains("contactEmail"));
        assert!(lines[0].ends_with("lastSeenAt"));
        assert!(csv.contains("https://www.instagram.com/worklifewithpriya/"));
        assert!(csv.contains("job | career"), "lists flatten, not JSON");
        assert!(!csv.contains("[\"job\""));
    }

    #[test]
    fn csv_survives_a_newline_in_a_bio() {
        let mut all = ingest("run-1");
        all[0].bio = "line one\nline two".into();
        assert_eq!(creators_to_csv(&all).lines().count(), 3, "must not add a row");
    }

    #[test]
    fn csv_flags_manual_contacts() {
        let mut all = ingest("run-1");
        all[1].email_override = "typed@example.com".into();
        all[1].recompute();

        let csv = creators_to_csv(&all);
        let bare = csv.lines().find(|l| l.starts_with("barehandle")).unwrap();
        assert!(bare.contains("typed@example.com"));
        assert!(bare.contains(",Yes,"), "contactIsManual = Yes");

        let priya = csv.lines().find(|l| l.starts_with("WorkLifeWithPriya")).unwrap();
        assert!(priya.contains(",No,"), "unedited rows are not manual");
    }

    #[test]
    fn known_usernames_returns_display_case() {
        // The scraper lowercases when comparing, so display case is fine here.
        let mut names = known_usernames(&ingest("run-1"));
        names.sort();
        assert_eq!(names, vec!["WorkLifeWithPriya", "barehandle"]);
    }
}
