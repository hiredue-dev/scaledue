/**
 * ScaleDue Instagram creator scraper runner.
 *
 * Runs the Instagram creator scraper as a child process of the Tauri app.
 * Config arrives as JSON on argv[2]; progress goes to stdout so the Rust side
 * can stream it into the UI live; the final artifact path is announced on a
 * sentinel line that Rust parses and ingests into SQLite.
 *
 * All dependencies are self-contained within the scaledue/ folder.
 */

const path = require("path");

const SCALEDUE_ROOT = path.join(__dirname, "..");
const runContext = require(path.join(SCALEDUE_ROOT, "utils", "run-context"));
const metrics = require(path.join(SCALEDUE_ROOT, "utils", "metrics"));
const { pool } = require(path.join(SCALEDUE_ROOT, "browser"));
const instagramScrape = require(path.join(SCALEDUE_ROOT, "scripts", "instagram-scrape"));

/** Sentinels the Rust side greps for. Keep in sync with src-tauri/src/scraper.rs. */
const RESULT_PREFIX = "@@SCALEDUE_RESULT@@";
const ERROR_PREFIX = "@@SCALEDUE_ERROR@@";

// stdout is a pipe here, not a TTY, so Node buffers it. Flush every line so the
// UI log stays live instead of arriving in one lump at exit.
function emit(line) {
  process.stdout.write(`${line}\n`);
}

function parseConfig() {
  const raw = process.argv[2];
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid config JSON: ${err.message}`);
  }
}

async function main() {
  const config = parseConfig();

  const runDir = runContext.init();
  metrics.init(runDir);
  emit(`[scaledue] run dir: ${runDir}`);

  const result = await instagramScrape(config);

  if (!result.success) {
    emit(`${ERROR_PREFIX}${JSON.stringify({ error: result.error || "unknown failure" })}`);
    return 1;
  }

  // The scraper already wrote a fully serialized JSON artifact — hand Rust the
  // path rather than pushing a few hundred KB back through the pipe.
  const jsonPath = result.meta && result.meta.jsonPath;
  if (!jsonPath) {
    emit(`${ERROR_PREFIX}${JSON.stringify({ error: "scraper returned no jsonPath" })}`);
    return 1;
  }

  emit(`${RESULT_PREFIX}${JSON.stringify({ jsonPath, csvPath: result.meta.csvPath || "" })}`);
  return 0;
}

main()
  .then(async (code) => {
    await pool.destroyAll().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    emit(`${ERROR_PREFIX}${JSON.stringify({ error: String((err && err.message) || err) })}`);
    await pool.destroyAll().catch(() => {});
    process.exit(1);
  });
