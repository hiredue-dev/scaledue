const fs = require("fs");
const path = require("path");

/**
 * Stable per-profile Camoufox identity.
 *
 * Camoufox generates a brand-new random fingerprint on every launch (random OS
 * → random UA/platform/screen/canvas, and a weighted-random WebGL GPU). That's
 * great for throwaway/ephemeral sessions, but catastrophic for a *logged-in*
 * persistent profile: each relaunch looks like a different device, so sites like
 * LinkedIn treat the existing session cookie as a hijack and force a logout.
 *
 * To keep a logged-in profile stable we generate ONE fingerprint + WebGL pair
 * the first time the profile launches, persist it inside the profile dir, and
 * feed it back to camoufox-js (`fingerprint` + `webgl_config`) on every launch
 * thereafter — so the profile always presents the exact same device.
 */

function hostOS() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}
const OS_SHORT = { macos: "mac", windows: "win", linux: "lin" };

const IDENTITY_FILE = "camoufox-identity.json";

/**
 * Returns `{ os, fingerprint, webgl }` for a profile, generating + persisting it
 * on first use. `os` defaults to the host OS (most plausible for the real
 * machine) unless a specific one is passed.
 */
async function getStableIdentity(userDataDir, { os } = {}) {
  const targetOS = os || hostOS();
  const file = path.join(userDataDir, IDENTITY_FILE);

  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch (err) {
    console.warn(`[fingerprint] could not read ${file}; regenerating`, err);
  }

  const { generateFingerprint } = await import("camoufox-js/dist/fingerprints.js");
  const fingerprint = generateFingerprint(undefined, { operatingSystems: [targetOS] });

  let webgl;
  try {
    const { getPossiblePairs } = await import("camoufox-js/dist/webgl/sample.js");
    const pairs = await getPossiblePairs();
    const top = pairs[OS_SHORT[targetOS]]?.[0];
    if (top) webgl = [top.vendor, top.renderer];
  } catch (err) {
    console.warn("[fingerprint] WebGL pinning unavailable; GPU may vary per launch", err);
  }

  const identity = { os: targetOS, fingerprint, webgl };
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(identity));
    console.log(`[fingerprint] pinned stable identity for profile`, {
      userDataDir,
      os: targetOS,
      ua: fingerprint?.navigator?.userAgent,
      webgl,
    });
  } catch (err) {
    console.warn(`[fingerprint] could not persist ${file}`, err);
  }
  return identity;
}

module.exports = { getStableIdentity, hostOS };
