//! Verify the Firebase service-account key and the Firestore connection,
//! without launching the app.
//!
//!   npm run check-firebase
//!
//! Reports what it found, what it read from the key, and whether a real
//! Firestore read succeeded — so a setup problem is distinguishable from a
//! connection problem.

#[tokio::main]
async fn main() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    println!("Looking for a service-account key…");
    for path in scaledue_lib::store::key_candidates() {
        let mark = if path.exists() { "found  " } else { "missing" };
        println!("  [{mark}] {}", path.display());
    }

    match scaledue_lib::store::find_key() {
        None => {
            eprintln!(
                "\n✗ No key file. Firebase console → Project settings → Service accounts\n\
                   → Generate new private key, then save it as the first path above."
            );
            std::process::exit(1);
        }
        Some(p) => println!("\nUsing: {}", p.display()),
    }

    println!("Connecting to Firestore…");
    match scaledue_lib::store::Store::connect().await {
        Err(e) => {
            eprintln!("\n✗ {e}");
            std::process::exit(1);
        }
        Ok(store) => {
            println!("✓ Connected to project: {}", store.project_id);

            // A real read proves the credential works and the database exists —
            // connecting alone does not contact Firestore.
            match store.creators().await {
                Ok(creators) => {
                    println!("✓ Read the creators collection: {} document(s)", creators.len());
                    match store.list_runs().await {
                        Ok(runs) => println!("✓ Read the runs collection: {} document(s)", runs.len()),
                        Err(e) => eprintln!("! runs collection: {e}"),
                    }
                    println!("\nAll good — start the app with `npm run dev`.");
                }
                Err(e) => {
                    eprintln!("\n✗ Connected, but reading failed:\n  {e}");
                    eprintln!(
                        "\nUsual causes:\n\
                         • Firestore isn't enabled yet — console → Build → Firestore Database → Create database\n\
                         • The database was created in Datastore mode (needs Native mode)\n\
                         • The service account lacks the Cloud Datastore User role"
                    );
                    std::process::exit(1);
                }
            }
        }
    }
}
