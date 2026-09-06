/**
 * Instagram session setup.
 *
 * Opens a real (headful) browser against the shared Instagram profile. If the
 * saved session is still good it confirms and closes immediately; otherwise it
 * parks on the login page and waits for the person to sign in by hand, then
 * confirms who connected and closes.
 *
 * The scrape flow reuses the same profile directory, so this only has to run
 * when the session actually lapses.
 */

const path = require("path");
const { pool } = require("../../browser");
const { screenshotsDir } = require("../../utils/run-context");
const metrics = require("../../utils/metrics");
const {
  INSTAGRAM_PROFILE_DIR,
  INSTAGRAM_INSTANCE_ID,
  IG_BASE,
  LOGGED_IN_SELECTORS,
} = require("../../instagram/constants");
const { currentUser } = require("../../instagram/api");

// ── Config ──────────────────────────────────────────────────────────────────

const LOGIN_URL = `${IG_BASE}/accounts/login/`;

/** How long to wait for a manual login before giving up. */
const DEFAULT_TIMEOUT_SEC = 240;

// ── Helpers ─────────────────────────────────────────────────────────────────

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.random() * (max - min) + min;

/** True as soon as any logged-in chrome is on screen. */
async function detectLoggedIn(page, timeoutMs) {
  for (const sel of LOGGED_IN_SELECTORS) {
    const visible = await page
      .locator(sel)
      .first()
      .waitFor({ state: "visible", timeout: timeoutMs })
      .then(() => true)
      .catch(() => false);
    if (visible) return sel;
  }
  return null;
}

/**
 * Dismiss the "Save your login info?" / "Turn on notifications" interstitials.
 * Both are plain buttons; neither is guaranteed to appear.
 */
async function dismissPrompts(page) {
  for (let i = 0; i < 2; i++) {
    const button = page
      .locator('button:has-text("Not Now"), div[role="button"]:has-text("Not Now")')
      .first();
    const found = await button
      .waitFor({ state: "visible", timeout: 4_000 })
      .then(() => true)
      .catch(() => false);
    if (!found) return;
    const handle = await button.elementHandle().catch(() => null);
    if (!handle) return;
    await page.humanClick(handle).catch(() => {});
    await wait(rand(600, 1_400));
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

module.exports = async function instagramLogin(options = {}) {
  const timeoutSec = options.timeoutSec || DEFAULT_TIMEOUT_SEC;
  const id = INSTAGRAM_INSTANCE_ID;

  // Shared with instagram-scrape: BrowserPool allows one instance per
  // user-data dir, so both flows must address the same instance.
  if (!pool.has(id)) {
    // Always headful — the whole point is for a person to sign in.
    pool.createPersistent(id, INSTAGRAM_PROFILE_DIR, { headless: false });
    await pool.get(id).init();
  }

  const instance = pool.get(id);
  const { page, close } = await instance.createPage();

  try {
    metrics.inc("igLoginAttempts");
    console.log("[instagram-login] opening Instagram...");

    await page.goto(IG_BASE, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await wait(rand(2_000, 4_000));

    // ── Already signed in? ──────────────────────────────────────────────────
    let via = await detectLoggedIn(page, 4_000);

    if (via) {
      console.log(`[instagram-login] session already active (${via})`);
      metrics.inc("igLoginAlreadyLoggedIn");
      const who = await currentUser(page).catch(() => ({ ok: false }));
      return {
        success: true,
        alreadyLoggedIn: true,
        username: who.ok ? who.username : "",
        fullName: who.ok ? who.fullName : "",
      };
    }

    // ── Wait for a manual sign-in ───────────────────────────────────────────
    // Land on the login form rather than the marketing splash.
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});

    console.log("━".repeat(62));
    console.log("[instagram-login] PLEASE SIGN IN IN THE BROWSER WINDOW.");
    console.log(`[instagram-login] Waiting up to ${timeoutSec}s — the window closes automatically.`);
    console.log("━".repeat(62));

    const deadline = Date.now() + timeoutSec * 1_000;
    let remaining = 0;

    while (Date.now() < deadline) {
      via = await detectLoggedIn(page, 2_000);
      if (via) break;

      // A gentle heartbeat so the UI log shows the wait is still alive.
      const next = Math.round((deadline - Date.now()) / 1000);
      if (next !== remaining && next % 30 === 0) {
        console.log(`[instagram-login] still waiting... ${next}s left`);
        remaining = next;
      }
      await wait(1_500);
    }

    if (!via) {
      metrics.inc("igLoginFailures");
      console.error("[instagram-login] TIMEOUT — no sign-in detected.");
      await page
        .screenshot({ path: path.join(screenshotsDir(), "ig-login-timeout.png"), fullPage: true })
        .catch(() => {});
      return { success: false, error: "manual-login-timeout" };
    }

    console.log(`[instagram-login] signed in (${via}) — saving session...`);
    await dismissPrompts(page);

    const who = await currentUser(page).catch(() => ({ ok: false }));
    if (who.ok) console.log(`[instagram-login] connected as @${who.username}`);

    await page
      .screenshot({ path: path.join(screenshotsDir(), "ig-login-success.png") })
      .catch(() => {});

    metrics.inc("igLoginSuccesses");
    return {
      success: true,
      alreadyLoggedIn: false,
      username: who.ok ? who.username : "",
      fullName: who.ok ? who.fullName : "",
    };
  } catch (err) {
    metrics.inc("igLoginFailures");
    console.error("[instagram-login] error:", err.message);
    await page
      .screenshot({ path: path.join(screenshotsDir(), `ig-login-error-${Date.now()}.png`), fullPage: true })
      .catch(() => {});
    return { success: false, error: err.message };
  } finally {
    await close();
    metrics.flush();
  }
};
