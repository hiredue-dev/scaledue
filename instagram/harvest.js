/**
 * Network harvester — the fallback/supplementary discovery surface.
 *
 * The API client (api.js) is the primary path, but while we drive the UI the
 * page downloads plenty of extra payloads — related reels, suggested creators,
 * hashtag sections. This listens to that traffic and pulls creators + reels out
 * of it, so a scroll pass costs nothing extra.
 *
 * Reading the JSON rather than the rendered grid also sidesteps the fact that
 * Instagram deliberately omits the author from each tile and rotates every
 * class name.
 */

const { isUserNode, isMediaNode, normalizeUser, normalizeMedia } = require("./normalize");

/** Only these carry search/reel data; everything else is images and beacons. */
const INTERESTING_URL = /instagram\.com\/(api\/v1\/|graphql\/query|api\/graphql)/;

/**
 * Usernames that are Instagram surfaces, not creators.
 *
 * Also matches identifiers that would become invalid Firestore document ids:
 *   • starts or ends with `__`                     → __divyabansal__
 *   • contains `..` or `#` or `[` or `]` or `/`   → very rare on IG but guard anyway
 *   • empty after trimming
 * The Rust side's `doc_id()` handles the same rules, but rejecting early here
 * avoids wasting enrichment calls on creators that would fail to store.
 */
function isReserved(username) {
  if (!username) return true;
  const lower = username.toLowerCase();
  if (RESERVED.has(lower)) return true;
  if (lower.startsWith("__") || lower.endsWith("__")) return true;
  if (/\.\.|[#\[\]\/]/.test(lower)) return true;
  if (lower.replace(/[_\.]/g, "") === "") return true; // nothing but _ and .
  return false;
}

/** Instagram surface names — not creators. */
const RESERVED = new Set([
  "explore", "accounts", "direct", "reels", "stories", "p", "tv", "about",
  "legal", "privacy", "terms", "developer", "directory", "challenge", "session",
]);

/** Guard rails so one huge GraphQL blob can't stall the run. */
const MAX_DEPTH = 12;
const MAX_NODES = 60_000;

/**
 * Attach listeners to a page and start collecting. Returns { creators, reels,
 * note, detach } — creators/reels are live Maps that fill as the caller
 * navigates and scrolls.
 */
function attachHarvester(page) {
  /** @type {Map<string, object>} lowercased username → creator */
  const creators = new Map();
  /** @type {Map<string, object>} shortcode → reel */
  const reels = new Map();

  /** Which keyword we're currently on; stamped onto everything collected. */
  let currentSource = "";
  const note = (source) => {
    currentSource = source;
  };

  function recordCreator(rawUser) {
    if (isReserved(rawUser.username)) return null;
    const key = rawUser.username.toLowerCase();
    const incoming = normalizeUser(rawUser);
    const existing = creators.get(key);

    if (existing) {
      // Later payloads are often richer — a bare {username} first, a full node
      // later — so fill gaps rather than overwrite.
      if (!existing.fullName && incoming.fullName) existing.fullName = incoming.fullName;
      if (!existing.userId && incoming.userId) existing.userId = incoming.userId;
      if (incoming.isVerified) existing.isVerified = true;
      existing.sources.add(currentSource);
      return existing;
    }

    const created = { ...incoming, sources: new Set([currentSource]), reelCount: 0 };
    creators.set(key, created);
    return created;
  }

  function recordMedia(raw) {
    const shortcode = raw.code || raw.shortcode;
    if (reels.has(shortcode)) return;
    const media = normalizeMedia(raw, currentSource);
    if (!media) return;

    const creator = recordCreator(raw.user || raw.owner);
    if (!creator) return; // reserved/system account

    reels.set(shortcode, media);
    creator.reelCount += 1;
  }

  function walk(node, depth, budget) {
    if (node == null || budget.n++ > MAX_NODES || depth > MAX_DEPTH) return;

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1, budget);
      return;
    }
    if (typeof node !== "object") return;

    if (isMediaNode(node)) recordMedia(node);
    else if (isUserNode(node)) recordCreator(node);

    for (const key in node) {
      const value = node[key];
      if (value && typeof value === "object") walk(value, depth + 1, budget);
    }
  }

  const onResponse = async (res) => {
    try {
      const url = res.url();
      if (!INTERESTING_URL.test(url)) return;
      const contentType = res.headers()["content-type"] || "";
      if (!contentType.includes("json") && !contentType.includes("javascript")) return;
      const json = await res.json().catch(() => null);
      if (json) walk(json, 0, { n: 0 });
    } catch {
      // A response body is gone if the page navigated away mid-flight.
    }
  };

  page.on("response", onResponse);

  return { creators, reels, note, detach: () => page.off("response", onResponse) };
}

module.exports = { attachHarvester };
