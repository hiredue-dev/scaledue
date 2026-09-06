/**
 * ScaleDue Instagram session runner.
 *
 * Opens the headful login flow so the person can sign in, then closes the
 * browser and reports the outcome on a sentinel line the Rust side parses.
 *
 * Same contract as scrape-runner.js: config JSON on argv[2], progress on
 * stdout, structured result on a sentinel.
 */

const path = require("path");

const SCALEDUE_ROOT = path.join(__dirname, "..");
const runContext = require(path.join(SCALEDUE_ROOT, "utils", "run-context"));
const metrics = require(path.join(SCALEDUE_ROOT, "utils", "metrics"));
const { pool } = require(path.join(SCALEDUE_ROOT, "browser"));
const instagramLogin = require(path.join(SCALEDUE_ROOT, "scripts", "instagram-login"));

/** Kept in sync with src-tauri/src/scraper.rs. */
const LOGIN_PREFIX = "@@SCALEDUE_LOGIN@@";
const ERROR_PREFIX = "@@SCALEDUE_ERROR@@";

const emit = (line) => process.stdout.write(`${line}\n`);

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

  const result = await instagramLogin(config);

  if (!result.success) {
    emit(`${ERROR_PREFIX}${JSON.stringify({ error: result.error || "login failed" })}`);
    return 1;
  }

  emit(
    `${LOGIN_PREFIX}${JSON.stringify({
      connected: true,
      alreadyLoggedIn: !!result.alreadyLoggedIn,
      username: result.username || "",
      fullName: result.fullName || "",
    })}`,
  );
  return 0;
}

main()
  .then(async (code) => {
    // Closes the headful window — instagramLogin only closes its page.
    await pool.destroyAll().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    emit(`${ERROR_PREFIX}${JSON.stringify({ error: String((err && err.message) || err) })}`);
    await pool.destroyAll().catch(() => {});
    process.exit(1);
  });
