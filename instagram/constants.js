const path = require("path");

/** Shared browser profile for every Instagram flow (login writes it, scrape reads it). */
const LOCAL_DIR = path.join(__dirname, "..", ".local");
const INSTAGRAM_PROFILE_DIR = path.join(LOCAL_DIR, "instagram-profile");

/**
 * One pool instance id for all Instagram flows. BrowserPool refuses two
 * instances on the same user-data dir, so login and scrape MUST share an id.
 */
const INSTAGRAM_INSTANCE_ID = "instagram";

const IG_BASE = "https://www.instagram.com";

/**
 * Public web app id the Instagram site itself sends on every /api/v1 call.
 * Without this header those endpoints return 401 even with a valid session.
 */
const IG_APP_ID = "936619743392459";

/** Selectors that only appear once the feed has rendered for a logged-in user. */
const LOGGED_IN_SELECTORS = [
  'svg[aria-label="Home"]',
  'svg[aria-label="Search"]',
  'svg[aria-label="Search Input"]',
  'svg[aria-label="Reels"]',
  'svg[aria-label="New post"]',
  'a[href="/explore/"]',
];

module.exports = {
  LOCAL_DIR,
  INSTAGRAM_PROFILE_DIR,
  INSTAGRAM_INSTANCE_ID,
  IG_BASE,
  IG_APP_ID,
  LOGGED_IN_SELECTORS,
};
