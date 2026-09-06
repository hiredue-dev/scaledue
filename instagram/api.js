/**
 * Instagram web API client.
 *
 * Every call runs *inside the page* via page.evaluate, so it is same-origin and
 * carries the logged-in session cookies, CSRF token and Referer exactly like the
 * real site. That beats DOM scraping — Instagram ships obfuscated, rotating
 * class names, but these JSON payloads are stable and give us followers, bio
 * and contact details in one hop.
 *
 * Endpoint choices are empirical (probed against a live session):
 *   /web/search/topsearch/          200 — accounts matching a keyword
 *   /api/v1/fbsearch/web/top_serp/  200 — the reel/post grid for a keyword
 *   /api/v1/users/<pk>/info/        200 — full profile, incl. public email
 *   /api/v1/users/web_profile_info/ 429 — hard-throttled, do not use
 *   /api/v1/fbsearch/topsearch/     404 — not a web route
 *
 * The page MUST already be on an instagram.com origin before calling these.
 */

const { IG_APP_ID, IG_BASE } = require("./constants");
const { parseCount, formatCount, normalizeUser, normalizeMedia } = require("./normalize");

/**
 * Fetch JSON from an Instagram endpoint from within the page context.
 * Never throws — returns { ok, status, json, error } so callers can branch on
 * throttling (429) and session loss (401) instead of unwinding the whole run.
 */
async function igFetchJson(page, url) {
  return page.evaluate(
    async ({ url, appId }) => {
      try {
        const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || "";
        const res = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers: {
            "X-IG-App-ID": appId,
            "X-CSRFToken": csrf,
            "X-Requested-With": "XMLHttpRequest",
            "X-ASBD-ID": "129477",
            Accept: "*/*",
          },
        });
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* an HTML error/login page rather than JSON */
        }
        return {
          ok: res.ok && !!json,
          status: res.status,
          json,
          error: json ? null : `non-JSON response: ${text.slice(0, 120).replace(/\s+/g, " ")}`,
        };
      } catch (e) {
        return { ok: false, status: 0, json: null, error: String((e && e.message) || e) };
      }
    },
    { url, appId: IG_APP_ID },
  );
}

/**
 * Blended account search — what the search box calls. These accounts match the
 * niche by name/bio, which makes it the highest-signal creator source we have,
 * and it costs a single request.
 */
async function searchAccounts(page, query) {
  const url = `${IG_BASE}/web/search/topsearch/?context=blended&query=${encodeURIComponent(query)}`;
  const res = await igFetchJson(page, url);

  const users = [];
  const hashtags = [];
  if (res.json) {
    for (const entry of res.json.users || []) {
      const u = entry && (entry.user || entry);
      if (u && u.username) users.push(normalizeUser(u));
    }
    for (const entry of res.json.hashtags || []) {
      const h = entry && (entry.hashtag || entry);
      if (h && h.name) hashtags.push({ name: h.name, mediaCount: parseCount(h.media_count) });
    }
  }
  return { ok: res.ok, status: res.status, users, hashtags, error: res.error };
}

/**
 * One page of the keyword search grid — the reels and posts Instagram ranks for
 * a query. Pass `nextMaxId`/`rankToken` from the previous page to paginate;
 * this is why we don't have to scroll the UI to go deep.
 */
async function searchMedia(page, query, { nextMaxId = "", rankToken = "" } = {}) {
  let url =
    `${IG_BASE}/api/v1/fbsearch/web/top_serp/?enable_metadata=true` +
    `&query=${encodeURIComponent(query)}&search_surface=web_top_serp`;
  if (nextMaxId) url += `&next_max_id=${encodeURIComponent(nextMaxId)}`;
  if (rankToken) url += `&rank_token=${encodeURIComponent(rankToken)}`;

  const res = await igFetchJson(page, url);
  const grid = (res.json && res.json.media_grid) || {};
  const medias = [];

  for (const section of grid.sections || []) {
    const content = section.layout_content || {};
    // Layouts vary (one_by_two vs plain grid); collect every bucket present.
    const buckets = [content.medias, content.fill_items, content.one_by_two_item].filter(Array.isArray);
    for (const bucket of buckets) {
      for (const item of bucket) {
        const media = (item && item.media) || item;
        if (!media) continue;
        const normalized = normalizeMedia(media, query);
        if (normalized) medias.push(normalized);
      }
    }
  }

  return {
    ok: res.ok,
    status: res.status,
    error: res.error,
    medias,
    nextMaxId: grid.next_max_id ? String(grid.next_max_id) : "",
    rankToken: grid.rank_token ? String(grid.rank_token) : rankToken,
    hasMore: !!grid.has_more,
  };
}

/**
 * Full profile by numeric user id. `web_profile_info` (the username-keyed
 * variant) is hard-throttled to 429, but this id-keyed one still serves — and
 * every media/search payload already hands us the id, so we never need to
 * resolve a username first.
 */
async function userInfo(page, userId) {
  const res = await igFetchJson(page, `${IG_BASE}/api/v1/users/${encodeURIComponent(userId)}/info/`);
  const u = res.json && res.json.user;
  if (!u) {
    return { ok: false, status: res.status, profile: null, error: res.error || "no user in payload" };
  }

  const followers = parseCount(u.follower_count);
  const following = parseCount(u.following_count);
  const posts = parseCount(u.media_count);

  return {
    ok: true,
    status: res.status,
    error: null,
    profile: {
      userId: String(userId),
      username: u.username || "",
      fullName: u.full_name || "",
      bio: u.biography || "",
      followers,
      followersFormatted: formatCount(followers),
      following,
      followingFormatted: formatCount(following),
      posts,
      postsFormatted: formatCount(posts),
      isVerified: !!u.is_verified,
      isPrivate: !!u.is_private,
      isBusinessAccount: !!u.is_business,
      // account_type 2 = business, 3 = creator; both are partnership-ready.
      isProfessionalAccount: u.account_type === 2 || u.account_type === 3,
      category: u.category || u.category_name || "",
      externalUrl: u.external_url || "",
      // Only professional accounts choose to expose these publicly.
      businessEmail: u.public_email || u.business_email || "",
      businessPhone: u.public_phone_number || u.contact_phone_number || "",
      // Bio links are where creators put Linktree/booking pages — outreach gold.
      bioLinks: Array.isArray(u.bio_links) ? u.bio_links.map((l) => l && l.url).filter(Boolean) : [],
      profilePicUrl: u.hd_profile_pic_url_info ? u.hd_profile_pic_url_info.url : u.profile_pic_url || "",
    },
  };
}

/**
 * Who is this session logged in as?
 *
 * The `ds_user_id` cookie carries the numeric id of the signed-in account, and
 * we already have an id-keyed profile endpoint — so this doubles as a live
 * check that the session is genuinely usable, not merely that a cookie exists.
 * Read through the browser context rather than document.cookie so httpOnly
 * cookies are visible too.
 */
async function currentUser(page) {
  let cookies = [];
  try {
    cookies = await page.context().cookies("https://www.instagram.com");
  } catch (err) {
    return { ok: false, error: `could not read cookies: ${err.message}` };
  }

  const idCookie = cookies.find((c) => c.name === "ds_user_id");
  const hasSession = cookies.some((c) => c.name === "sessionid" && c.value);
  if (!idCookie || !idCookie.value) {
    return { ok: false, error: hasSession ? "no ds_user_id cookie" : "no session cookie" };
  }

  const res = await userInfo(page, idCookie.value);
  if (!res.ok) return { ok: false, error: res.error || `status ${res.status}` };

  return {
    ok: true,
    userId: idCookie.value,
    username: res.profile.username,
    fullName: res.profile.fullName,
    followers: res.profile.followers,
  };
}

/** Last-resort username → numeric id, for creators we only saw by name. */
async function resolveUserId(page, username) {
  const { users } = await searchAccounts(page, username);
  const hit = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  return hit ? hit.userId : "";
}

module.exports = {
  igFetchJson,
  searchAccounts,
  searchMedia,
  userInfo,
  currentUser,
  resolveUserId,
  parseCount,
  formatCount,
};
