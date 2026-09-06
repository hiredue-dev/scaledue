/**
 * Instagram creator discovery for the HireDue creator program.
 *
 * For each niche keyword it pulls the reels Instagram ranks for that query plus
 * the accounts that match it by name/bio, resolves every author to a full
 * profile (followers, bio, category, public email), scores them for partnership
 * fit and writes JSON + CSV into the run directory.
 *
 * Discovery is API-first: Instagram's own search endpoints paginate, so we go
 * deep without scrolling. Driving the UI is kept as a fallback for the day an
 * endpoint changes shape — see api.js for the endpoint survey.
 *
 * Requires a logged-in session: run `instagramLogin()` once first. Both flows
 * share the same browser profile.
 */

const path = require("path");
const { pool } = require("../../browser");
const { screenshotsDir, saveOutput } = require("../../utils/run-context");
const metrics = require("../../utils/metrics");
const {
  INSTAGRAM_PROFILE_DIR,
  INSTAGRAM_INSTANCE_ID,
  IG_BASE,
  LOGGED_IN_SELECTORS,
} = require("../../instagram/constants");
const { searchAccounts, searchMedia, userInfo, resolveUserId } = require("../../instagram/api");
const { attachHarvester } = require("../../instagram/harvest");

// ── Tune these ───────────────────────────────────────────────────────────────

const CONFIG = {
  /** Niches to search. */
  keywords: [
    "job search tips",
    "career advice",
    "resume tips",
    "interview tips",
    "job hunting",
    "tech jobs",
    "career coach",
    "linkedin tips",
  ],

  /** Terms that mark a creator as on-topic. Matched against bio, name, captions. */
  relevanceTerms: [
    "job", "career", "resume", "cv", "interview", "hiring", "recruit",
    "hr", "placement", "internship", "fresher", "salary", "linkedin",
    "coach", "mentor", "student", "graduate", "workplace", "employability",
  ],

  /** Stop paginating a keyword once we have this many reels for it. */
  maxReelsPerKeyword: 120,
  /** Search pages fetched per keyword in each round (each is ~15-30 reels). */
  maxSearchPagesPerKeyword: 3,
  /** Scroll rounds for the UI fallback, only used if the API path comes up dry. */
  maxScrollsPerKeyword: 10,

  /**
   * How many profiles a run should actually resolve — a target, not a cap.
   * The run keeps discovering and enriching in rounds until it hits this many
   * resolved profiles (or genuinely runs out of new creators to try).
   */
  targetResolved: 200,

  /**
   * Safety valve. Lookups fail for private/deleted accounts, so attempts always
   * exceed successes; without a ceiling a niche with little left to find would
   * loop until Instagram throttles us.
   */
  maxEnrichAttempts: 600,
  /** Discovery/enrichment rounds before giving up on reaching the target. */
  maxRounds: 15,

  /**
   * Usernames already in the caller's database. Anyone here is dropped the
   * moment they are discovered, so a run never re-surfaces a creator you have
   * seen before and the enrichment budget goes entirely to new people.
   */
  excludeUsernames: [],

  /** Partnership fit: ignore accounts outside this follower band. */
  minFollowers: 2_000,
  maxFollowers: 1_500_000,
  /** Private accounts can't be evaluated or realistically partnered with. */
  skipPrivate: true,
  /** Mark creators whose bio/name/captions match none of `relevanceTerms`. */
  requireRelevance: true,

  /** Politeness. Instagram throttles hard above roughly one call per second. */
  delayBetweenProfilesMs: [1_400, 3_000],
  delayBetweenSearchPagesMs: [1_200, 2_600],
  delayBetweenKeywordsMs: [3_000, 6_000],
  delayAfterNavMs: [2_000, 4_000],

  headless: false,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.random() * (max - min) + min;
const randWait = ([min, max]) => wait(rand(min, max));

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** "job search tips" → "jobsearchtips", for the hashtag fallback surface. */
const toTag = (keyword) => keyword.toLowerCase().replace(/[^a-z0-9]/g, "");

// ── Session check ────────────────────────────────────────────────────────────

async function verifyLoggedIn(page) {
  await page.goto(IG_BASE, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await randWait(CONFIG.delayAfterNavMs);

  for (const sel of LOGGED_IN_SELECTORS) {
    const visible = await page
      .locator(sel)
      .first()
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (visible) return { loggedIn: true, via: sel };
  }
  const hasLoginForm = await page
    .locator('input[name="username"], a[href*="/accounts/login"]')
    .first()
    .waitFor({ state: "visible", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);

  return { loggedIn: false, via: hasLoginForm ? "login-form-visible" : "no-indicator" };
}

// ── UI fallback ──────────────────────────────────────────────────────────────

/**
 * Click a tab on the search-results page. Instagram renders these as roled tabs
 * on some builds and plain links on others, so try both — a missing Reels tab
 * is not fatal, the Top tab already contains reels.
 */
async function clickTab(page, name) {
  const candidates = [
    page.getByRole("tab", { name, exact: true }).first(),
    page.locator(`div[role="tablist"] a:has-text("${name}")`).first(),
    page.locator(`a[href*="/explore/search/"]:has-text("${name}")`).first(),
    page.getByText(name, { exact: true }).first(),
  ];

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: "visible", timeout: 1_500 });
      const handle = await locator.elementHandle({ timeout: 1_500 });
      if (!handle) continue;
      await page.humanClick(handle);
      await randWait(CONFIG.delayAfterNavMs);
      return true;
    } catch {
      // try the next strategy
    }
  }
  return false;
}

/**
 * Scroll until the harvester stops seeing new reels. Progress is read from the
 * network listener rather than the DOM — that's what actually tells us whether
 * more content arrived.
 */
async function scrollUntilStagnant(page, getCount, { target, maxScrolls, label }) {
  let stagnant = 0;
  let previous = getCount();

  for (let i = 0; i < maxScrolls; i++) {
    if (getCount() >= target) break;
    await page.humanScroll({ targetPct: 0.95, maxTime: 6_000 }).catch(() => {});
    await randWait([1_200, 2_600]);

    const current = getCount();
    if (current === previous) {
      if (++stagnant >= 3) {
        console.log(`    ${label}: no new items after 3 scrolls, moving on`);
        break;
      }
    } else {
      stagnant = 0;
      console.log(`    ${label}: ${current} reels seen`);
    }
    previous = current;
  }
}

/** Browse the search UI so the harvester can pick up whatever the page loads. */
async function browseSearchUi(page, harvester, keyword) {
  const before = harvester.reels.size;
  try {
    await page.goto(`${IG_BASE}/explore/search/keyword/?q=${encodeURIComponent(keyword)}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await randWait(CONFIG.delayAfterNavMs);
    const onReelsTab = await clickTab(page, "Reels");
    console.log(`  UI fallback: search page${onReelsTab ? " (Reels tab)" : " (Top tab)"}`);
    await scrollUntilStagnant(page, () => harvester.reels.size, {
      target: before + CONFIG.maxReelsPerKeyword,
      maxScrolls: CONFIG.maxScrollsPerKeyword,
      label: "search",
    });
  } catch (err) {
    console.warn(`  UI fallback error: ${err.message}`);
  }

  // Hashtag grid, if the keyword collapses to a usable tag.
  const tag = toTag(keyword);
  if (harvester.reels.size - before < CONFIG.maxReelsPerKeyword / 2 && tag.length >= 3) {
    try {
      console.log(`  UI fallback: #${tag}`);
      await page.goto(`${IG_BASE}/explore/tags/${encodeURIComponent(tag)}/`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await randWait(CONFIG.delayAfterNavMs);
      await scrollUntilStagnant(page, () => harvester.reels.size, {
        target: before + CONFIG.maxReelsPerKeyword,
        maxScrolls: Math.ceil(CONFIG.maxScrollsPerKeyword / 2),
        label: `#${tag}`,
      });
    } catch (err) {
      console.warn(`  hashtag fallback error: ${err.message}`);
    }
  }
  return harvester.reels.size - before;
}

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * Discover from one keyword, resuming where the last round left off.
 *
 * `cursor` carries the search pagination between rounds so a run that needs
 * more profiles keeps paging deeper instead of re-fetching page one.
 */
async function discoverKeyword(page, harvester, keyword, cursor) {
  harvester.note(keyword);

  const accounts = [];
  const medias = [];

  // Surface 1 — account search. Single request, and these accounts match the
  // niche by name/bio, so it's the highest-signal source we have. Only worth
  // doing once per keyword; the endpoint doesn't paginate.
  if (!cursor.accountsDone) {
    const accountRes = await searchAccounts(page, keyword);
    if (accountRes.ok) {
      accounts.push(...accountRes.users);
      console.log(`  accounts matched: ${accountRes.users.length}`);
    } else {
      console.warn(`  account search failed (${accountRes.status}): ${accountRes.error || "unknown"}`);
    }
    cursor.accountsDone = true;
    await randWait(CONFIG.delayBetweenSearchPagesMs);
  }

  // Surface 2 — the ranked reel/post grid, paginated straight off the API.
  let nextMaxId = cursor.nextMaxId || "";
  let rankToken = cursor.rankToken || "";
  let pages = 0;
  while (medias.length < CONFIG.maxReelsPerKeyword && pages < CONFIG.maxSearchPagesPerKeyword) {
    const res = await searchMedia(page, keyword, { nextMaxId, rankToken });
    if (!res.ok) {
      console.warn(`  media search failed (${res.status}): ${res.error || "unknown"}`);
      cursor.exhausted = true;
      break;
    }
    if (res.medias.length === 0) {
      cursor.exhausted = true;
      break;
    }

    medias.push(...res.medias);
    pages++;
    console.log(`  page ${pages}: +${res.medias.length} reels (${medias.length} this round)`);

    nextMaxId = res.nextMaxId;
    rankToken = res.rankToken;
    if (!res.hasMore || !res.nextMaxId) {
      cursor.exhausted = true;
      break;
    }
    await randWait(CONFIG.delayBetweenSearchPagesMs);
  }
  cursor.nextMaxId = nextMaxId;
  cursor.rankToken = rankToken;

  // Surface 3 — drive the UI, but only if the API path came up empty on the
  // first round. Insurance against an endpoint change, not a routine cost.
  if (medias.length === 0 && !cursor.usedUiFallback && !cursor.nextMaxId) {
    cursor.usedUiFallback = true;
    console.warn("  API search returned nothing — falling back to the UI");
    await browseSearchUi(page, harvester, keyword);
  }

  console.log(`  "${keyword}" → ${medias.length} reels, ${accounts.length} accounts`);
  return { accounts, medias };
}

// ── Enrichment ───────────────────────────────────────────────────────────────

/**
 * Resolve full profiles. Ordered so that if we run out of budget — or get
 * throttled — the budget went to the creators most likely to matter: the ones
 * whose reels keep surfacing across keywords.
 */
async function enrichCreators(page, creators, budget) {
  // The harvester also picks up incidental accounts (suggestions, commenters).
  // Only spend lookups on creators we actually found through a search surface,
  // and never re-resolve one an earlier round already did.
  const queue = creators
    .filter((c) => !c.enriched && !c.enrichError && (c.reels.length > 0 || c.fromAccountSearch))
    .sort(
      (a, b) =>
        b.reels.length - a.reels.length ||
        b.keywords.size - a.keywords.size ||
        Number(b.fromAccountSearch) - Number(a.fromAccountSearch),
    )
    .slice(0, Math.max(0, budget));

  if (queue.length === 0) return { attempted: 0, resolved: 0, rateLimited: false };
  console.log(`\n[ig-scrape] resolving up to ${queue.length} profiles...`);

  let consecutiveThrottles = 0;
  let rateLimited = false;
  let resolved = 0;
  let attempted = 0;

  for (let i = 0; i < queue.length; i++) {
    attempted++;
    const creator = queue[i];

    // Almost every creator arrives with a numeric id already; this is for the
    // few harvested from payloads that only carried a username.
    if (!creator.userId) {
      creator.userId = await resolveUserId(page, creator.username).catch(() => "");
      await randWait([800, 1_600]);
      if (!creator.userId) {
        creator.enrichError = "could not resolve user id";
        continue;
      }
    }

    const res = await userInfo(page, creator.userId);

    if (res.ok) {
      consecutiveThrottles = 0;
      resolved++;
      Object.assign(creator, res.profile);
      creator.enriched = true;
      console.log(
        `  [${i + 1}/${queue.length}] @${creator.username} — ${creator.followersFormatted} followers` +
          ` | ${(creator.bio || "").replace(/\s+/g, " ").slice(0, 55)}`,
      );
    } else {
      // 429 = throttled, 401 = session gone. Both mean back off hard.
      if (res.status === 429 || res.status === 401) {
        // Deliberately NOT recorded as enrichError: throttling says nothing
        // about this creator, and marking it would exclude them from every
        // later round. Leave them eligible for a retry.
        consecutiveThrottles++;
        const backoff = Math.min(60_000, 5_000 * 2 ** (consecutiveThrottles - 1));
        console.warn(
          `  [${i + 1}/${queue.length}] @${creator.username} — ${res.status}, backing off ${Math.round(backoff / 1000)}s`,
        );
        await wait(backoff);
        if (consecutiveThrottles >= 4) {
          rateLimited = true;
          console.error("  [ig-scrape] enrichment stopped — Instagram is throttling us.");
          break;
        }
        continue;
      }

      // A real per-creator failure (private, deleted, bad id): don't retry it.
      creator.enrichError = res.error || `status ${res.status}`;
      consecutiveThrottles = 0;
      console.warn(`  [${i + 1}/${queue.length}] @${creator.username} — failed (${res.status})`);
    }

    await randWait(CONFIG.delayBetweenProfilesMs);
  }

  return { attempted, resolved, rateLimited };
}

// ── Scoring ──────────────────────────────────────────────────────────────────

function scoreCreator(creator) {
  const haystack = [
    creator.fullName,
    creator.bio,
    creator.category,
    ...creator.reels.slice(0, 5).map((r) => r.caption),
  ]
    .join(" ")
    .toLowerCase();

  const matched = CONFIG.relevanceTerms.filter((t) => haystack.includes(t));

  let score = matched.length * 3;
  // Surfacing under several different keywords is a strong niche signal.
  score += (creator.keywords.size - 1) * 2;
  score += Math.min(creator.reels.length, 5);
  if (creator.followers >= CONFIG.minFollowers && creator.followers <= CONFIG.maxFollowers) score += 5;
  if (creator.isProfessionalAccount || creator.isBusinessAccount) score += 2;
  if (creator.businessEmail) score += 3; // reachable without a DM
  if (creator.isVerified) score += 1;

  // Reach relative to audience — a proxy for whether their posts actually travel.
  const withPlays = creator.reels.filter((r) => r.plays > 0);
  creator.avgPlays = withPlays.length
    ? Math.round(withPlays.reduce((s, r) => s + r.plays, 0) / withPlays.length)
    : 0;
  if (creator.followers > 0 && creator.avgPlays > creator.followers) score += 3;

  creator.matchedTerms = matched;
  creator.score = score;
  return creator;
}

/**
 * Does this creator meet the partnership criteria?
 *
 * Recorded as a flag rather than used to drop rows: every discovered profile is
 * saved, so the caller can see the full reach of a run and re-judge later
 * without re-scraping.
 */
function isQualified(creator) {
  if (!creator.enriched) return false;
  if (CONFIG.skipPrivate && creator.isPrivate) return false;
  if (creator.followers < CONFIG.minFollowers) return false;
  if (creator.followers > CONFIG.maxFollowers) return false;
  if (CONFIG.requireRelevance && creator.matchedTerms.length === 0) return false;
  return true;
}

/** Qualified first, then by score — unenriched handles settle at the bottom. */
function byRank(a, b) {
  return Number(b.qualified) - Number(a.qualified) || b.score - a.score || b.followers - a.followers;
}

// ── Output ───────────────────────────────────────────────────────────────────

const CSV_COLUMNS = [
  "username", "fullName", "profileUrl", "followers", "following", "posts",
  "bio", "category", "isVerified", "isBusinessAccount", "businessEmail",
  "businessPhone", "externalUrl", "bioLinks", "reelCount", "avgPlays",
  "score", "matchedTerms", "keywords", "topReelUrl", "enriched", "qualified",
];

function toRow(c) {
  return {
    username: c.username,
    fullName: c.fullName,
    profileUrl: c.profileUrl,
    followers: c.followers || 0,
    following: c.following || 0,
    posts: c.posts || 0,
    bio: (c.bio || "").replace(/\s+/g, " "),
    category: c.category || "",
    isVerified: c.isVerified ? "Yes" : "No",
    isBusinessAccount: c.isBusinessAccount ? "Yes" : "No",
    businessEmail: c.businessEmail || "",
    businessPhone: c.businessPhone || "",
    externalUrl: c.externalUrl || "",
    bioLinks: (c.bioLinks || []).join(" | "),
    reelCount: c.reels.length,
    avgPlays: c.avgPlays || 0,
    score: c.score || 0,
    matchedTerms: (c.matchedTerms || []).join(" "),
    keywords: [...c.keywords].join(" | "),
    topReelUrl: (c.reels[0] && c.reels[0].url) || "",
    enriched: c.enriched ? "Yes" : "No",
    qualified: c.qualified ? "Yes" : "No",
  };
}

/** Returns the paths written, so callers (e.g. the ScaleDue app) can ingest them. */
function saveResults(creators, meta) {
  const rows = creators.map(toRow);

  const jsonPath = saveOutput(
    "instagram",
    `creators-${meta.stamp}.json`,
    JSON.stringify(
      {
        ...meta,
        count: creators.length,
        creators: creators.map((c, i) => ({
          rank: i + 1,
          ...toRow(c),
          bioLinks: c.bioLinks || [],
          matchedTerms: c.matchedTerms || [],
          keywords: [...c.keywords],
          reels: c.reels.slice(0, 10),
        })),
      },
      null,
      2,
    ),
  );

  const csvPath = saveOutput(
    "instagram",
    `creators-${meta.stamp}.csv`,
    [CSV_COLUMNS.join(","), ...rows.map((r) => CSV_COLUMNS.map((k) => csvCell(r[k])).join(","))].join("\n"),
  );

  return { jsonPath, csvPath };
}

// ── Main ─────────────────────────────────────────────────────────────────────

module.exports = async function instagramScrape(overrides = {}) {
  Object.assign(CONFIG, overrides);

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║        INSTAGRAM CREATOR DISCOVERY — SCRAPER             ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`Keywords (${CONFIG.keywords.length}): ${CONFIG.keywords.join(", ")}`);
  console.log(
    `Follower band: ${CONFIG.minFollowers.toLocaleString()} – ${CONFIG.maxFollowers.toLocaleString()}\n`,
  );

  if (!pool.has(INSTAGRAM_INSTANCE_ID)) {
    pool.createPersistent(INSTAGRAM_INSTANCE_ID, INSTAGRAM_PROFILE_DIR, { headless: CONFIG.headless });
    await pool.get(INSTAGRAM_INSTANCE_ID).init();
  }

  const { page, close } = await pool.get(INSTAGRAM_INSTANCE_ID).createPage();
  const shotDir = screenshotsDir();
  const harvester = attachHarvester(page);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  /** Already in the caller's database — never re-surface these. */
  const excluded = new Set((CONFIG.excludeUsernames || []).map((u) => String(u).toLowerCase()));
  let skippedKnown = 0;

  /** @type {Map<string, object>} lowercased username → merged creator record */
  const master = new Map();
  /** Shortcodes already attached to a creator, so reels aren't double-counted. */
  const seenReels = new Set();

  function mergeCreator(base, keyword, { fromAccountSearch = false } = {}) {
    const key = base.username.toLowerCase();
    // Skip usernames that would produce invalid Firestore document ids.
    if (key.startsWith("__") || key.endsWith("__")) return null;
    if (/\.\.|[#\[\]\/]/.test(key)) return null;
    if (key.replace(/[_\.]/g, "") === "") return null;
    if (excluded.has(key)) {
      skippedKnown++;
      return null;
    }
    let record = master.get(key);
    if (!record) {
      record = {
        username: base.username,
        fullName: base.fullName || "",
        userId: base.userId || "",
        profileUrl: `${IG_BASE}/${base.username}/`,
        isVerified: !!base.isVerified,
        isPrivate: !!base.isPrivate,
        followers: 0,
        reels: [],
        keywords: new Set(),
        fromAccountSearch: false,
        enriched: false,
      };
      master.set(key, record);
    }
    if (!record.fullName && base.fullName) record.fullName = base.fullName;
    if (!record.userId && base.userId) record.userId = base.userId;
    if (base.isVerified) record.isVerified = true;
    if (fromAccountSearch) record.fromAccountSearch = true;
    if (keyword) record.keywords.add(keyword);
    return record;
  }

  function addMedia(media, keyword) {
    if (seenReels.has(media.shortcode)) return;
    const record = mergeCreator(
      { username: media.username, userId: media.userId, fullName: "" },
      keyword,
    );
    if (!record) return; // author is already known
    seenReels.add(media.shortcode);
    record.reels.push(media);
  }

  try {
    metrics.inc("igScrapeAttempts");

    console.log("[ig-scrape] verifying session...");
    const session = await verifyLoggedIn(page);
    if (!session.loggedIn) {
      console.error(`[ig-scrape] NOT LOGGED IN (${session.via}) — run \`instagramLogin()\` first.`);
      await page.screenshot({ path: path.join(shotDir, "ig-not-logged-in.png"), fullPage: true }).catch(() => {});
      metrics.inc("igScrapeNotLoggedIn");
      return { success: false, error: "not-logged-in", creators: [] };
    }
    console.log(`[ig-scrape] session active ✓ (${session.via})`);

    // ── Discovery + enrichment, in rounds ────────────────────────────────────
    // "Profiles to resolve" is a target, not a cap: keep discovering deeper and
    // resolving until we've actually resolved that many, or run out of new
    // creators to try. Discovery is cheap; the profile lookups are the
    // rate-limited part, so each round only enriches what it still needs.
    const target = Math.max(1, CONFIG.targetResolved);
    /** @type {Map<string, object>} keyword → pagination cursor, kept across rounds */
    const cursors = new Map(CONFIG.keywords.map((k) => [k, {}]));

    const enrichment = { attempted: 0, resolved: 0, rateLimited: false };
    let round = 0;

    while (
      enrichment.resolved < target &&
      round < CONFIG.maxRounds &&
      enrichment.attempted < CONFIG.maxEnrichAttempts &&
      !enrichment.rateLimited
    ) {
      round++;
      const before = master.size;
      const live = CONFIG.keywords.filter((k) => !cursors.get(k).exhausted);
      if (live.length === 0) {
        console.log("\n[ig-scrape] every keyword is exhausted — no more to discover.");
        break;
      }

      console.log(
        `\n══ round ${round} — resolved ${enrichment.resolved}/${target}, ` +
          `${live.length} keyword(s) still paging ══`,
      );

      for (const keyword of live) {
        console.log(`\n── "${keyword}" ──`);
        const cursor = cursors.get(keyword);
        const { accounts, medias } = await discoverKeyword(page, harvester, keyword, cursor);
        for (const account of accounts) mergeCreator(account, keyword, { fromAccountSearch: true });
        for (const media of medias) addMedia(media, keyword);
        await randWait(CONFIG.delayBetweenKeywordsMs);
      }

      // Fold in anything the network harvester caught alongside (related reels,
      // suggested creators). Free data — we were on those pages anyway.
      for (const harvested of harvester.creators.values()) {
        const record = mergeCreator(harvested, null);
        if (!record) continue;
        for (const src of harvested.sources) if (src) record.keywords.add(src);
      }
      for (const reel of harvester.reels.values()) addMedia(reel, reel.source);
      for (const record of master.values()) {
        record.reels.sort((a, b) => (b.plays || 0) - (a.plays || 0));
      }

      const found = master.size - before;
      console.log(
        `\n[ig-scrape] round ${round}: +${found} new creators ` +
          `(${master.size} total, skipped ${skippedKnown} already known)`,
      );

      const need = Math.min(
        target - enrichment.resolved,
        CONFIG.maxEnrichAttempts - enrichment.attempted,
      );
      const result = await enrichCreators(page, [...master.values()], need);
      enrichment.attempted += result.attempted;
      enrichment.resolved += result.resolved;
      enrichment.rateLimited = result.rateLimited;

      console.log(
        `[ig-scrape] round ${round} done — resolved ${enrichment.resolved}/${target} ` +
          `(${enrichment.attempted} attempts)`,
      );

      // Nothing new found and nothing left to resolve: further rounds would
      // just re-page the same exhausted searches.
      if (found === 0 && result.attempted === 0) {
        console.log("[ig-scrape] no new creators and nothing left to resolve — stopping.");
        break;
      }
    }

    const discovered = [...master.values()];
    if (enrichment.resolved < target) {
      console.warn(
        `[ig-scrape] resolved ${enrichment.resolved} of the ${target} requested — ` +
          (enrichment.rateLimited
            ? "Instagram throttled the run."
            : "ran out of new creators. Add keywords or raise maxRounds."),
      );
    }
    if (discovered.length === 0) {
      await page.screenshot({ path: path.join(shotDir, `ig-no-results-${stamp}.png`), fullPage: true }).catch(() => {});
      metrics.inc("igScrapeEmpty");
      return { success: false, error: "no-creators-discovered", creators: [] };
    }

    // ── Score and rank ───────────────────────────────────────────────────────
    // Every discovered profile is kept; `qualified` is a flag on the row rather
    // than a gate, so the run's full reach is visible and re-judgeable later.
    for (const creator of discovered) {
      scoreCreator(creator);
      creator.qualified = isQualified(creator);
    }
    const ranked = [...discovered].sort(byRank);
    const qualified = ranked.filter((c) => c.qualified);

    const meta = {
      stamp,
      scrapedAt: new Date().toISOString(),
      keywords: CONFIG.keywords,
      followerBand: [CONFIG.minFollowers, CONFIG.maxFollowers],
      discovered: discovered.length,
      reelsSeen: seenReels.size,
      rounds: round,
      targetResolved: target,
      enrichAttempted: enrichment.attempted,
      enrichResolved: enrichment.resolved,
      rateLimited: enrichment.rateLimited,
      skippedKnown,
      qualified: qualified.length,
      stored: ranked.length,
    };
    const saved = saveResults(ranked, meta);
    Object.assign(meta, saved);

    // ── Report ───────────────────────────────────────────────────────────────
    console.log("\n╔══════════════════════════════════════════════════════════╗");
    console.log("║                       RESULTS                            ║");
    console.log("╚══════════════════════════════════════════════════════════╝");
    console.log(`Discovered ${discovered.length} new creators from ${seenReels.size} reels`);
    if (skippedKnown) console.log(`Skipped ${skippedKnown} creators already in the database`);
    console.log(`Resolved ${enrichment.resolved}/${enrichment.attempted} profiles → ${qualified.length} qualified leads`);
    console.log(`Storing all ${ranked.length} discovered profiles`);
    if (enrichment.rateLimited) console.log("NOTE: enrichment stopped early — Instagram throttled the run.");

    if (qualified.length) {
      console.log("\nTop 25 by fit score:");
      for (const [i, c] of qualified.slice(0, 25).entries()) {
        console.log(
          `  ${String(i + 1).padStart(2)}. @${c.username.padEnd(26)}` +
            `${String(c.followersFormatted).padStart(8)}  score ${String(c.score).padStart(3)}  ` +
            `${(c.fullName || "").slice(0, 24).padEnd(24)} ${c.matchedTerms.slice(0, 4).join(",")}`,
        );
      }
    }

    metrics.inc("igScrapeSuccesses");
    metrics.inc("igCreatorsQualified", qualified.length);
    metrics.inc("igCreatorsStored", ranked.length);
    return { success: true, creators: ranked, discovered: discovered.length, meta };
  } catch (err) {
    metrics.inc("igScrapeFailures");
    console.error("[ig-scrape] fatal:", err.message);
    await page.screenshot({ path: path.join(shotDir, `ig-scrape-error-${stamp}.png`), fullPage: true }).catch(() => {});

    // Never throw away a partially completed run.
    const partial = [...master.values()];
    if (partial.length) {
      for (const creator of partial) {
        scoreCreator(creator);
        creator.qualified = isQualified(creator);
      }
      saveResults(partial.sort(byRank), {
        stamp: `${stamp}-partial`,
        scrapedAt: new Date().toISOString(),
        keywords: CONFIG.keywords,
        error: err.message,
        partial: true,
      });
      console.log(`[ig-scrape] saved ${partial.length} partial results before failing.`);
    }
    return { success: false, error: err.message, creators: partial };
  } finally {
    harvester.detach();
    await close();
    metrics.flush();
  }
};

module.exports.CONFIG = CONFIG;
