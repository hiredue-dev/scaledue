/**
 * Shape-normalisers shared by the API client and the network harvester.
 *
 * Instagram returns the same entities in two dialects — the /api/v1 REST shape
 * (snake_case, `code`, `play_count`) and the /graphql shape (`shortcode`,
 * `edge_liked_by.count`). Everything downstream should see one shape, so both
 * dialects get folded together here.
 */

const { IG_BASE } = require("./constants");

/** Instagram media_type 2 (+ product_type "clips") is a reel. */
const MEDIA_TYPE_VIDEO = 2;

function parseCount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (value == null) return 0;
  const raw = String(value).replace(/,/g, "").trim().toLowerCase();
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return 0;
  if (raw.includes("k")) return Math.round(n * 1_000);
  if (raw.includes("m")) return Math.round(n * 1_000_000);
  if (raw.includes("b")) return Math.round(n * 1_000_000_000);
  return Math.round(n);
}

/** Compact a number the way Instagram displays it (12.4K, 1.2M). */
function formatCount(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

function captionOf(m) {
  if (m.caption && typeof m.caption.text === "string") return m.caption.text;
  if (typeof m.caption === "string") return m.caption;
  const edges = m.edge_media_to_caption && m.edge_media_to_caption.edges;
  if (Array.isArray(edges) && edges[0] && edges[0].node) return edges[0].node.text || "";
  return "";
}

function isUserNode(o) {
  return (
    o &&
    typeof o === "object" &&
    typeof o.username === "string" &&
    o.username.length >= 1 &&
    o.username.length <= 30 &&
    // A real user node always carries an identifier or profile field with the name.
    (o.pk != null || o.id != null || o.full_name != null || o.is_private != null)
  );
}

function normalizeUser(u) {
  const userId = u.pk != null ? String(u.pk) : u.id != null ? String(u.id) : "";
  return {
    username: u.username,
    userId,
    fullName: u.full_name || "",
    isVerified: !!u.is_verified,
    isPrivate: !!u.is_private,
    profileUrl: `${IG_BASE}/${u.username}/`,
  };
}

function isMediaNode(o) {
  if (!o || typeof o !== "object") return false;
  const code = o.code || o.shortcode;
  if (typeof code !== "string" || code.length < 5) return false;
  // Needs an author, and a marker that distinguishes a post from e.g. a hashtag.
  return (
    !!(o.user || o.owner) &&
    (o.media_type != null || o.taken_at != null || o.taken_at_timestamp != null ||
      o.__typename != null || o.image_versions2 != null)
  );
}

/** Fold either media dialect into one record. Returns null if there's no author. */
function normalizeMedia(m, source = "") {
  const owner = m.user || m.owner;
  if (!owner || typeof owner.username !== "string") return null;

  const shortcode = m.code || m.shortcode;
  const isReel =
    m.product_type === "clips" ||
    m.media_type === MEDIA_TYPE_VIDEO ||
    m.is_video === true ||
    /video|clip/i.test(m.__typename || "");

  // play_count is the public "views" number; ig_play_count is the narrower
  // in-app count. Prefer whichever is larger so sorting by reach is stable.
  const plays = Math.max(
    parseCount(m.play_count),
    parseCount(m.ig_play_count),
    parseCount(m.view_count),
    parseCount(m.video_view_count),
    parseCount(m.video_play_count),
  );
  const takenAtSec = m.taken_at || m.taken_at_timestamp || 0;

  return {
    shortcode,
    url: `${IG_BASE}/${isReel ? "reel" : "p"}/${shortcode}/`,
    username: owner.username,
    userId: owner.pk != null ? String(owner.pk) : owner.id != null ? String(owner.id) : "",
    isReel,
    caption: captionOf(m).slice(0, 500),
    plays,
    playsFormatted: formatCount(plays),
    likes: parseCount(
      m.like_count ??
        (m.edge_liked_by && m.edge_liked_by.count) ??
        (m.edge_media_preview_like && m.edge_media_preview_like.count),
    ),
    comments: parseCount(
      m.comment_count ?? (m.edge_media_to_comment && m.edge_media_to_comment.count),
    ),
    takenAt: takenAtSec ? new Date(takenAtSec * 1000).toISOString() : "",
    source,
  };
}

module.exports = {
  parseCount,
  formatCount,
  captionOf,
  isUserNode,
  isMediaNode,
  normalizeUser,
  normalizeMedia,
};
