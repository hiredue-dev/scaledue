# ScaleDue

A lightweight Tauri desktop app for the HireDue Instagram creator-discovery flow:
press a button, watch the scrape run live, and browse the creators it found —
all persisted to Cloud Firestore.

## How it fits together

```
ui/                     vanilla HTML/CSS/JS — no bundler, no build step
  └── invoke() ─────────┐
src-tauri/              │  Rust: owns the database and the child process
  ├── lib.rs            ├─ commands + event streaming
  ├── store.rs          ├─ Firestore I/O (service-account auth)
  ├── model.rs          ├─ data model + all logic that needs no network
  ├── session.rs        ├─ Instagram session check
  └── scraper.rs           spawns and supervises the Node runner
runner/
  └── scrape-runner.js  thin bridge into ../../src (the existing scraper)
```

All scraping logic stays in the parent HireDue Browser project. The runner is
deliberately thin so the CLI flow (`node src/index.js`) and this app can never
drift apart — they run the same code.

**Data flow:** button → `start_scrape` → Node child process → stdout streamed
live to the UI → the scraper writes its usual JSON artifact → Rust reads that
file and upserts it into Firestore → the UI refreshes.

The artifact path is passed back on a sentinel line (`@@SCALEDUE_RESULT@@`)
rather than piping a few hundred KB of JSON through stdout.

## Running it

```
npm install         # first time only
npm run dev         # dev build with hot reload of the UI
npm run build       # produces a distributable .app / .dmg
```

## Using it

1. **Connect Instagram** opens a real browser window. If the saved session is
   still good it confirms and closes immediately; otherwise it lands on the
   login page and waits (up to 4 minutes) for you to sign in, then closes
   itself. The status pill shows which account is connected.
2. **Run scrape** discovers creators for your keywords and writes them to
   Firestore. Progress streams into the live log; the table fills in when it ends.
   Every handle already in the database is excluded at discovery, so each run
   surfaces genuinely new profiles and spends its whole enrichment budget on
   people you haven't seen. If a run reports finding nothing new, widen the
   keywords or raise *Search pages / keyword*.
3. **Every discovered profile is stored**, not just the ones meeting the
   follower/relevance criteria. Those that pass are flagged as leads and sort to
   the top; the rest are kept as handles (shown dimmed, "not resolved yet")
   because enrichment is rate-limited and can only resolve so many per run.
   The **Leads only** checkbox filters the view; the **All runs** dropdown
   filters by run.
4. **Click a row** to open the detail drawer: reels, bio links, and an editable
   **Contact** section. Saved edits go to separate `email_override` /
   `phone_override` columns, so the next scrape's upsert cannot overwrite them;
   clearing a field falls back to the scraped value. The drawer also has
   **Delete creator** (two-click confirm), which cascades to that creator's
   reels and run links but leaves the runs themselves alone.
5. **Bulk delete.** Tick rows to select them (the header checkbox selects
   everything currently *shown*, respecting the run filter and search), then
   **Delete selected**. **Delete all** wipes every creator, reel and run from
   Firestore. Both go through a native confirmation, and progress is reported
   per document since Firestore deletes one at a time.
6. **Export CSV** saves the current view — the same run filter and search the
   table is showing — via a save dialog. The file carries a UTF-8 BOM so Excel
   renders emoji bios correctly.

Both flows drive the same browser profile, so the backend allows only one at a
time — the buttons disable each other accordingly.

The connection pill is read from the profile's cookie store, which is a signal
rather than proof: a cookie can be present but revoked server-side. Connecting
is always offered even when it reports connected.

## Firebase setup

The app stores everything in **Cloud Firestore**, so the data is visible and
editable in the Firebase console.

1. Firebase console → your project → ⚙ **Project settings** → **Service accounts**
   → **Generate new private key**. That downloads a JSON file.
2. Save it as `scaledue/firebase-service-account.json` (already gitignored), or
   point `SCALEDUE_FIREBASE_KEY` at it anywhere on disk.
3. Firestore must be enabled: console → **Build → Firestore Database → Create
   database**. Production mode is fine — a service account bypasses rules.
4. Start the app. The top bar shows `Firestore · <project-id>` when connected;
   **Retry connection** picks up a key added while it's running.

The project id is read from the key file, so there is nothing else to configure.

> **The key grants full database access and bypasses security rules.** It is
> fine for an internal tool on your own machine; do not commit it or ship it in
> a distributed build. For that you'd want Firebase Auth plus rules instead.

## Gmail setup (outreach)

ScaleDue sends creator-outreach mail through **the same Google OAuth client as
the HireDue desktop app** — identical scopes (`userinfo.email`, `gmail.send`)
and the identical redirect `http://localhost:3000/oauth2callback`, which is
already registered on that client. So there is no new consent screen to publish
and no re-verification.

The one difference: HireDue fetches the client id/secret per-user from its
backend, which ScaleDue can't call. Supply them directly, either way round:

**Env vars** — create `scaledue/.env`:

```
GOOGLE_CLIENT_ID=<the same client id the desktop app uses>
GOOGLE_CLIENT_SECRET=<its secret>
```

**Or a file** — Google Cloud Console → the **same project** as HireDue →
**APIs & Services → Credentials** → that OAuth 2.0 Client ID → **Download JSON**,
saved as `scaledue/google-oauth-client.json`.

Resolution order: `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` → the path in
`SCALEDUE_GOOGLE_CLIENT` → `scaledue/google-oauth-client.json`. Real environment
variables beat the `.env` file, so a shell export overrides a committed default.
Setting only one of the two pair is reported as a mistake rather than silently
falling through to a stale file.

Then click **Connect Gmail**. A browser tab opens for consent; the refresh token
is written to `scaledue/.gmail-token.json` (gitignored, mode 0600). The status
line shows a truncated client id, so you can confirm it's the same OAuth client
as HireDue.

Then open any creator with an email address and use **Send email** in the
drawer. The draft is editable per creator, sending is a two-click confirm, and
the send is recorded on the creator (`emailed_at`, `emailed_to`) so the list
marks who has been contacted and you can't double-send by accident.

Port 3000 is shared with the HireDue desktop app — if that's running, connect
reports the clash rather than failing obscurely.

## Data model

| Collection | Holds |
|---|---|
| `creators/{handle}` | one document per profile, **document id = lowercased username** |
| `creators/{handle}/reels/{shortcode}` | that creator's reels, with play/like/comment counts |
| `runs/{run-id}` | one document per scrape: keywords, counts, status, errors |

Outreach state (`emailed_at`, `emailed_to`, `email_message_id`) lives on the
creator document and, like the hand-edited contact, is never touched by a
re-scrape.

Using the lowercased handle as the document id is what makes duplicate profiles
structurally impossible — re-storing a handle addresses the same document rather
than adding a row. Each creator carries a `run_ids` array, so the run filter
works without a second collection.

Volatile fields (followers, bio) take the newest scrape's value, while
`first_seen_at`, `times_seen` and `run_ids` accumulate. Hand-edited contacts
live in `email_override` / `phone_override`, which a re-scrape never touches;
`contact_email` / `contact_phone` are the resolved values, denormalised so the
console shows them too.

### Reads and quota

Firestore cannot do substring search, and charges per document read. The app
therefore reads the `creators` collection once and answers list, search, sort,
stats and export from that in-memory snapshot, dropping it whenever it writes.
Nothing is persisted to disk. **Reload from cloud** forces a re-read — use it
after editing rows directly in the Firebase console.

## Logs

Two log files, both timestamped with elapsed time — the elapsed column is what
makes a *slow* step distinguishable from a *stuck* one:

| File | Covers |
|---|---|
| `~/Library/Application Support/com.hiredue.scaledue/scaledue.log` | the app: startup, resolved node path, Firestore connection, every child spawn with its pid, scrape lifecycle, Gmail actions, failures |
| `<repo>/.local/runs/<timestamp>/run.log` | one per scrape or login: the full scraper narration, teed from the console |

The app log is truncated each launch, with the previous session kept as
`scaledue.prev.log`. The path is shown in the app footer.

## Notes

- **Capabilities are not optional.** `src-tauri/capabilities/default.json` must
  exist and grant `core:default`. Custom `invoke()` commands are not ACL-gated,
  but core plugin calls such as `event.listen` are — so without that file the
  app *appears* to work (buttons fire, flows run) while no backend event ever
  reaches the UI, leaving buttons stuck mid-flight.
- **The UI reconciles its own state.** Besides listening for events, it polls
  `running_job` while busy, so a missed event can't strand the buttons.
- **External links** go through `tauri-plugin-opener`. A plain `target="_blank"`
  click would otherwise navigate the app's own webview to instagram.com.
- **Deleting a creator removes its reels explicitly.** Firestore has no
  cascade, so deletes clear the subcollection first; otherwise the reels are
  orphaned — unreachable from the UI but still billed for storage.
- **Bulk deletes report partial failure.** A per-document error is collected
  rather than aborting the loop, so one bad document can't strand a delete
  halfway; the UI shows how many succeeded and how many didn't.
- **Selection is held by document id**, not row index, so it survives
  re-sorting, searching and refreshing — and any row that disappears is dropped
  from the selection rather than silently pointing at something else.
- **`jsonwebtoken` is pinned with `aws_lc_rs`.** Its defaults enable no crypto
  backend, so signing the service-account JWT panics at the first Firestore call.
  Installing a rustls provider does not fix it — jsonwebtoken uses a different
  rustls version, which has its own process-level static.
- **Browser launch options are cached per profile** in
  `camoufox-identity.json`'s sibling `camoufox-launch-options.json`. Camoufox's
  `sampleWebGL` loads a large dataset on every launch (~30s idle, minutes on a
  busy machine, sitting at 0% CPU looking hung). The result is fixed by the
  pinned identity, so a persistent profile computes it once. Delete that file to
  force a rebuild.
- **Keep build output out of Spotlight.** `src-tauri/target`, both
  `node_modules` and `.local/runs` carry a `.metadata_never_index` marker.
  Without it, indexing hundreds of thousands of build artifacts drives the load
  average past 20 and pushes the machine into swap, which makes the scraper look
  frozen.
- **googleapis is required lazily.** Loading it costs seconds (104s cold on
  one machine), and the app polls Gmail status on every refresh — so only
  `connect` and `send` pull it in. A status check is two file reads.
- **`.env` is read by the Gmail runner only**, from `scaledue/.env` then the
  repo root. Nothing else in this project loads `.env`.
- **rusqlite is still a dependency**, but only to read the browser profile's
  `cookies.sqlite` for the Instagram session check. No application data is
  stored on disk.
- **Deleting a creator is not a blocklist.** If a later scrape surfaces the same
  account it will be re-added. Say the word if it should stay gone.
- **Node resolution.** A GUI app inherits launchd's minimal PATH, not your
  shell's, so `scraper.rs` asks a login shell where `node` lives. Override with
  `SCALEDUE_NODE=/path/to/node` if that ever fails.
- **Bundled builds.** `runner_path()` resolves relative to `CARGO_MANIFEST_DIR`,
  which works in `tauri dev`. A packaged `.app` moved away from the repo needs
  `SCALEDUE_RUNNER=/path/to/runner/scrape-runner.js`.
- **Long runs.** The default 8 keywords × 150 profiles takes ~15 minutes. The
  window stays responsive; output streams as it happens.

## Tests

```
cd src-tauri && cargo test
```

39 tests covering artifact-to-document mapping, contact overrides surviving a
re-scrape, in-memory search/filter/rank, stats, CSV quoting and export, the
sentinel protocol, runner-script resolution, session-cookie lookup,
service-account key validation, Gmail payload shapes, and the exact JSON
payload the UI sends to `start_scrape`.

`npm run check-firebase` verifies the key and does a real Firestore read —
connecting alone proves nothing, since auth is lazy.

Everything except the Firestore round trip itself is covered; the network layer
needs real credentials to exercise.
