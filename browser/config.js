/**
 * Browser config for the Camoufox engine.
 *
 * Camoufox is a hardened Firefox build made for automation/agents. It spoofs
 * the fingerprint (UA, navigator, canvas, WebGL, fonts, screen, timezone…)
 * natively at the C++ level, so we do NOT inject a JS stealth script and we do
 * NOT probe the system Chrome UA — Camoufox owns that surface now. We just pick
 * sensible defaults and translate them into Playwright `firefox` launch options
 * via camoufox-js `launchOptions`.
 */

const SUPPORTED_OS = ["windows", "macos", "linux"];

const DEFAULTS = {
  headless: true,

  // ── Camoufox anti-detection / fingerprint ──────────────────────────────
  // Hybrid humanization: Camoufox handles CURSOR motion natively at the browser
  // level (more authentic than JS-synthesized paths), while humanize.js handles
  // TYPING rhythm and SCROLLING (which Camoufox doesn't). To avoid the two
  // stacking, humanize.js issues a single mouse.move to the target and lets
  // Camoufox curve it — see moveMouse there. `true`, or a max duration (seconds).
  humanize: true,
  // OS to spoof the fingerprint as. Array → randomly chosen per launch (used by
  // ephemeral/throwaway sessions). Persistent profiles ignore this in favour of
  // a stable per-profile identity (see fingerprint.js) unless you pass a single
  // OS string (or a full cfg.fingerprint) to pin it explicitly.
  os: [...SUPPORTED_OS],
  // Align timezone/locale/geo to the (proxy) IP. Off by default to avoid an
  // outbound IP-lookup on every launch; turn on when running behind a proxy.
  geoip: false,
  // Block WebRTC so the real LAN/public IP can't leak past a proxy.
  block_webrtc: true,
  // Locale(s) for the Intl API + Accept-Language. undefined → Camoufox picks.
  locale: undefined,
  // Constrain generated screen dimensions, e.g. { maxWidth, maxHeight }.
  screen: undefined,
  // Fixed window size [w, h]. undefined → Camoufox generates a realistic one.
  window: undefined,
  // Override the bundled Camoufox binary. Set this in packaged builds where the
  // binary ships as an app resource rather than the user cache.
  executablePath: process.env.CAMOUFOX_EXECUTABLE_PATH || undefined,
  // Extra args passed straight to Firefox.
  args: [],
  // Escape hatch: raw camoufox-js LaunchOptions merged last, wins over the above.
  camoufox: {},

  // ── Lifecycle / resource limits ────────────────────────────────────────
  // Firefox/Camoufox cold-starts slower than Chromium, so give it more room.
  launchTimeout: 60_000,
  navigationTimeout: 20_000,
  maxContexts: 5,
  maxPagesPerContext: 3,
  restartOnCrash: true,
  restartDelay: 2_000,

  // Camoufox handles fingerprint spoofing natively; the old Chromium stealth
  // init script injects a fake `window.chrome`, which is itself a *tell* on
  // Firefox. Keep this off unless you really know why you're enabling it.
  stealth: false,

  // null → no fixed viewport; use the real Camoufox window size. This keeps the
  // viewport consistent with the spoofed screen instead of a Playwright default.
  viewport: null,
  proxy: undefined,
};

function createConfig(overrides = {}) {
  return Object.freeze({ ...DEFAULTS, ...overrides });
}

/**
 * Translate our config into Playwright `firefox` launch options via camoufox-js.
 * The returned object ({ executablePath, args, env, firefoxUserPrefs, proxy,
 * headless, … }) is spread straight into `firefox.launch` /
 * `firefox.launchPersistentContext`.
 *
 * Pass a pinned `identity` ({ os, fingerprint, webgl }) — e.g. from
 * fingerprint.js for a persistent/logged-in profile — to keep the device
 * stable across launches. Without it, Camoufox generates a fresh random
 * fingerprint each launch (fine for throwaway/ephemeral sessions).
 */
/**
 * Cache key for a profile's launch options: everything that would change them.
 * The pinned fingerprint is the bulk of it, so this only misses when the
 * identity or a launch-shaping option actually changes.
 */
function launchCacheKey(cfg, identity) {
  return JSON.stringify({
    os: identity.os || cfg.os,
    ua: identity.fingerprint && identity.fingerprint.navigator
      ? identity.fingerprint.navigator.userAgent
      : null,
    webgl: identity.webgl || null,
    locale: cfg.locale || null,
    screen: cfg.screen || null,
    window: cfg.window || null,
    proxy: cfg.proxy ? cfg.proxy.server : null,
    executablePath: cfg.executablePath || null,
    args: cfg.args || [],
    geoip: cfg.geoip,
    block_webrtc: cfg.block_webrtc,
    humanize: cfg.humanize,
  });
}

const LAUNCH_CACHE_FILE = "camoufox-launch-options.json";

/**
 * Build the Camoufox launch options, caching them per profile.
 *
 * `launchOptions()` calls camoufox's `sampleWebGL`, which loads a large WebGL
 * dataset on every launch — measured at ~30s on an idle machine and minutes
 * when the box is busy, with the process sitting at 0% CPU looking hung. The
 * result is fully determined by the pinned identity, so a persistent profile
 * computes it once and reuses it.
 *
 * A side effect: the per-launch randomised bits (canvas AA offset, font spacing
 * seed) get frozen too. For a logged-in persistent profile that is desirable —
 * the whole point of a pinned identity is presenting the same device each time.
 * Ephemeral instances pass no cacheDir and keep fresh randomisation.
 */
async function buildLaunchOptions(cfg, identity = {}, { cacheDir } = {}) {
  const fs = require("fs");
  const path = require("path");
  const cacheFile = cacheDir ? path.join(cacheDir, LAUNCH_CACHE_FILE) : null;
  const key = launchCacheKey(cfg, identity);

  if (cacheFile) {
    try {
      if (fs.existsSync(cacheFile)) {
        const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
        if (cached.key === key) {
          console.log("[camoufox] reusing cached launch options (skips the ~30s WebGL sample)");
          return {
            ...cached.options,
            // Current environment wins for ordinary vars; camoufox's own
            // additions (CAMOU_CONFIG et al) aren't in process.env, so survive.
            env: { ...cached.options.env, ...process.env },
            headless: cfg.headless,
          };
        }
        console.log("[camoufox] launch-options cache is stale (identity or options changed)");
      }
    } catch (err) {
      console.warn(`[camoufox] could not read ${cacheFile}; rebuilding`, err.message);
    }
  }

  // camoufox-js is ESM-only ("type": "module"); use dynamic import so this works
  // from CJS regardless of the Node `require(ESM)` support level.
  const { launchOptions } = await import("camoufox-js");
  const t0 = Date.now();
  const built = await launchOptions({
    headless: cfg.headless,
    humanize: cfg.humanize,
    // A pinned fingerprint carries its own OS, but webgl_config requires `os` to
    // be set explicitly, so always pass the identity's OS when we have one.
    os: identity.os || cfg.os,
    geoip: cfg.geoip,
    block_webrtc: cfg.block_webrtc,
    ...(identity.fingerprint ? { fingerprint: identity.fingerprint } : {}),
    ...(identity.webgl ? { webgl_config: identity.webgl } : {}),
    ...(cfg.locale ? { locale: cfg.locale } : {}),
    ...(cfg.screen ? { screen: cfg.screen } : {}),
    ...(cfg.window ? { window: cfg.window } : {}),
    ...(cfg.proxy ? { proxy: cfg.proxy } : {}),
    ...(cfg.executablePath ? { executable_path: cfg.executablePath } : {}),
    ...(cfg.args && cfg.args.length ? { args: cfg.args } : {}),
    // `timeout` is passed through to Playwright's launch call.
    timeout: cfg.launchTimeout,
    ...cfg.camoufox,
  });
  console.log(`[camoufox] built launch options in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (cacheFile) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ key, options: built }));
      console.log(`[camoufox] cached launch options at ${cacheFile}`);
    } catch (err) {
      console.warn(`[camoufox] could not cache launch options`, err.message);
    }
  }
  return built;
}

module.exports = {
  DEFAULTS,
  SUPPORTED_OS,
  createConfig,
  buildLaunchOptions,
};
