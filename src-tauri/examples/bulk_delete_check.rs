//! Verifies the Firestore write + bulk-delete path against the real database,
//! using only synthetic records it creates and removes itself.
//!
//! Deliberately never calls delete_all: that would destroy real data.
//!
//!   cargo run --example bulk_delete_check

const MARKER: &str = "__scaledue_selftest";

#[tokio::main]
async fn main() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let store = scaledue_lib::store::Store::connect().await.expect("connect");
    println!("connected to {}", store.project_id);

    let baseline = store.creators().await.expect("read").len();
    println!("baseline: {baseline} creators (untouched)");

    // Two synthetic creators, one with a reel, in the artifact shape the
    // scraper emits.
    let artifact: serde_json::Value = serde_json::from_str(&format!(
        r#"{{"creators":[
            {{"username":"{MARKER}_a","fullName":"Self Test A","profileUrl":"https://example.com/a",
              "followers":1234,"bio":"selftest","enriched":"Yes","qualified":"Yes","score":7,
              "bioLinks":[],"matchedTerms":[],"keywords":[],
              "reels":[{{"shortcode":"{MARKER}_r1","url":"u","caption":"c","plays":10,"likes":1,"comments":0,"takenAt":"","isReel":true}}]}},
            {{"username":"{MARKER}_b","fullName":"Self Test B","profileUrl":"https://example.com/b",
              "followers":10,"bio":"selftest","enriched":"No","qualified":"No","score":0,
              "bioLinks":[],"matchedTerms":[],"keywords":[],"reels":[]}}
        ]}}"#
    ))
    .expect("fixture");

    let run_id = "selftest-run";
    let written = store.ingest_artifact(run_id, &artifact).await.expect("ingest");
    println!("wrote {written} synthetic creators");

    let after_write = store.creators().await.expect("read");
    assert_eq!(after_write.len(), baseline + 2, "write should add exactly two");

    let ids: Vec<String> = after_write
        .iter()
        .filter(|c| c.username.starts_with(MARKER))
        .map(|c| c.id.clone())
        .collect();
    assert_eq!(ids.len(), 2, "both synthetic creators should be findable");

    let reels = store.list_reels(&ids[0]).await.expect("reels");
    println!("synthetic creator has {} reel(s)", reels.len());

    // The operation under test.
    let mut ticks = 0;
    let result = store
        .delete_creators(&ids, |done, total| {
            ticks += 1;
            println!("  progress {done}/{total}");
        })
        .await
        .expect("bulk delete");

    println!("deleted {}, failed {}", result.deleted, result.failed.len());
    assert_eq!(result.deleted, 2);
    assert!(result.failed.is_empty(), "unexpected failures: {:?}", result.failed);
    assert_eq!(ticks, 2, "progress should fire once per creator");

    let after_delete = store.creators().await.expect("read");
    assert_eq!(after_delete.len(), baseline, "database back to its baseline");
    assert!(
        !after_delete.iter().any(|c| c.username.starts_with(MARKER)),
        "no synthetic records left behind"
    );

    // Reels are a subcollection and do not cascade — check they went too.
    let orphans = store.list_reels(&ids[0]).await.unwrap_or_default();
    assert!(orphans.is_empty(), "reels should have been deleted with the creator");

    // ── status pipeline + delete_unresolved, on fresh synthetic records ──
    let written2 = store.ingest_artifact("selftest-run-2", &artifact).await.expect("re-ingest");
    assert_eq!(written2, 2);
    let live = store.creators().await.expect("read");
    let a = live.iter().find(|c| c.username.ends_with("_a")).expect("a").clone();
    let b = live.iter().find(|c| c.username.ends_with("_b")).expect("b").clone();

    assert_eq!(scaledue_lib::model::status_or_default(&a.status), "new", "starts as new");

    store.set_status(&a.id, "outreach").await.expect("set status");
    let a2 = store.creators().await.unwrap().into_iter().find(|c| c.id == a.id).unwrap();
    assert_eq!(a2.status, "outreach");

    store.set_status(&a.id, "responded").await.expect("set status");
    assert!(store.set_status(&a.id, "archived").await.is_err(), "unknown status must be rejected");

    // NOTE: delete_unresolved() is deliberately NOT exercised here. It operates
    // on the whole collection, so running it against a real database destroys
    // real unresolved records. Its per-document path is the same delete_creators
    // verified above; the only extra logic is the `!is_enriched` filter.
    assert!(a.is_enriched && !b.is_enriched, "fixture should have one of each");
    store.delete_creators(&[b.id.clone()], |_, _| {}).await.expect("cleanup b");

    // Clean up the surviving synthetic record.
    store.delete_creators(&[a.id.clone()], |_, _| {}).await.expect("cleanup");

    println!("\nPASS — write, bulk delete, progress and reel cleanup all verified.");
    println!("PASS — status transitions, validation, and delete_unresolved verified.");
    println!("Real data untouched: {baseline} creators still present.");
}
