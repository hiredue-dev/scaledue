#!/usr/bin/env node

/**
 * Tauri pre-bundle script — downloads Camoufox + Playwright Firefox into
 * ./browser-bin/ so they can be shipped inside the app bundle.
 *
 * This runs automatically before bundling (via tauri.conf.json
 * `build.beforeBundleCommand`). It skips the download if the browsers are
 * already present, keeping incremental builds fast.
 *
 * The resulting directory layout:
 *   browser-bin/
 *     camoufox/        ← CAMOUFOX_INSTALL_DIR
 *     playwright/      ← PLAYWRIGHT_BROWSERS_PATH
 *
 * Node must be >= 22 (Camoufox requirement). The browsers are ~400 MB total.
 */

"use strict";

const { execFileSync, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BIN_DIR = path.join(ROOT, "browser-bin");

function log(msg) {
  process.stdout.write(`[bundle-browsers] ${msg}\n`);
}

function exists(dir) {
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if a node module is installed.
 */
function pkgRoot(name) {
  const candidate = path.join(ROOT, "node_modules", name);
  return fs.existsSync(candidate) ? candidate : null;
}

// ── Camoufox ──────────────────────────────────────────────────────────────────

function installCamoufox() {
  const targetDir = path.join(BIN_DIR, "camoufox");

  if (exists(targetDir)) {
    log(`Camoufox already cached at ${targetDir} — skipping download`);
    return targetDir;
  }

  const camouRoot = pkgRoot("camoufox-js");
  if (!camouRoot) {
    log("WARNING: camoufox-js not installed — run `npm ci` first");
    return null;
  }

  // Camoufox ships a CLI to download its own binary.
  //   node dist/__main__.js fetch
  // It respects CAMOUFOX_INSTALL_DIR to choose the destination.
  log("downloading Camoufox (this may take a minute)…");

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    execSync(
      `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(camouRoot, "dist", "__main__.js"))} fetch`,
      {
        cwd: ROOT,
        stdio: "inherit",
        env: { ...process.env, CAMOUFOX_INSTALL_DIR: targetDir },
        timeout: 5 * 60_000, // 5 minutes
      },
    );
    log(`Camoufox installed to ${targetDir}`);
  } catch (err) {
    log(`WARNING: Camoufox download failed: ${err.message}`);
    // Non-fatal: the app can still run if CAMOUFOX_EXECUTABLE_PATH is set
    // manually, or if CAMOUFOX_INSTALL_DIR points to an existing install.
    try { fs.rmSync(targetDir, { recursive: true }); } catch {}
    return null;
  }

  return targetDir;
}

// ── Playwright Firefox ────────────────────────────────────────────────────────

function installPlaywrightFirefox() {
  const targetDir = path.join(BIN_DIR, "playwright");

  if (exists(targetDir)) {
    log(`Playwright Firefox already cached at ${targetDir} — skipping download`);
    return targetDir;
  }

  const pwCore = pkgRoot("playwright-core");
  if (!pwCore) {
    log("WARNING: playwright-core not installed — run `npm ci` first");
    return null;
  }

  // `npx playwright install firefox` downloads Firefox to the default cache
  // directory. We then copy it to our bundle directory.
  const cacheDir = path.join(process.env.HOME || "~", ".cache", "ms-playwright");
  const camoRoot = pkgRoot("camoufox-js");

  log("downloading Playwright Firefox…");

  try {
    // Use the Camoufox-provided installer path if available, otherwise the
    // Playwright CLI. Camoufox's fetch command also sets up Firefox.
    if (camoRoot) {
      execSync(
        `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(camoRoot, "dist", "__main__.js"))} fetch`,
        { cwd: ROOT, stdio: "inherit", timeout: 5 * 60_000 },
      );
    } else {
      execSync(`npx playwright install firefox`, {
        cwd: ROOT,
        stdio: "inherit",
        timeout: 5 * 60_000,
      });
    }

    // Find the Firefox directory that Playwright / Camoufox just downloaded.
    const ffDirs = fs.readdirSync(cacheDir).filter((d) => d.startsWith("firefox-"));
    if (ffDirs.length === 0) {
      throw new Error("Firefox not found in Playwright cache after install");
    }

    // Copy the newest Firefox version to our bundle directory.
    const latest = ffDirs.sort().at(-1);
    const src = path.join(cacheDir, latest);
    log(`copying ${src} → ${targetDir}`);

    // cp -R the firefox directory.
    fs.cpSync(src, path.join(targetDir, latest), { recursive: true });

    // Write a marker file so Playwright knows where to find this later.
    fs.writeFileSync(
      path.join(targetDir, ".playwright-browsers"),
      JSON.stringify({ browsers: [{ name: "firefox", path: path.join(targetDir, latest) }] }),
    );

    log(`Playwright Firefox installed to ${targetDir}`);
  } catch (err) {
    log(`WARNING: Playwright Firefox download failed: ${err.message}`);
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch {}
    return null;
  }

  return targetDir;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  // Ensure browser-bin/ exists.
  fs.mkdirSync(BIN_DIR, { recursive: true });

  const camDir = installCamoufox();
  const pwDir = installPlaywrightFirefox();

  // Print the environment variables consumers should set.
  if (camDir) {
    console.log(`\n  CAMOUFOX_INSTALL_DIR=${camDir}`);
  }
  if (pwDir) {
    console.log(`  PLAYWRIGHT_BROWSERS_PATH=${pwDir}`);
  }

  const ok = [camDir, pwDir].filter(Boolean).length;
  log(`done: ${ok}/2 browser bundles ready`);
}

main();