const path = require("path");
const { firefox } = require("playwright");
const { createConfig, buildLaunchOptions } = require("../config");
const { getStableIdentity } = require("../fingerprint");
const { attachToPage } = require("../humanize");

class PersistentInstance {
  constructor(id, userDataDir, configOverrides = {}) {
    this.id = id;
    this.mode = "persistent";
    this.userDataDir = path.resolve(userDataDir);
    this.config = createConfig(configOverrides);
    this._context = null;
    this._launching = null;
    this._intentionalClose = false;
    this._pages = new Set();
  }

  async init() {
    await this._getContext();
  }

  async _getContext() {
    if (this._context) return this._context;
    if (this._launching) return this._launching;
    this._launching = this._launch();
    return this._launching;
  }

  async _launch() {
    const cfg = this.config;
    console.log(`persistent[${this.id}]: launching`, { userDataDir: this.userDataDir });
    try {
      // A persistent profile is (usually) logged in, so it MUST present the same
      // device on every launch — otherwise the site invalidates the session.
      // Pin a stable fingerprint + WebGL pair per profile. A caller can override
      // by passing cfg.fingerprint (and cfg.os/cfg.webgl) directly.
      const identity = cfg.fingerprint
        ? { os: typeof cfg.os === "string" ? cfg.os : undefined, fingerprint: cfg.fingerprint, webgl: cfg.webgl }
        : await getStableIdentity(this.userDataDir, {
            os: typeof cfg.os === "string" ? cfg.os : undefined,
          });

      // Camoufox owns the UA/fingerprint and proxy (set via buildLaunchOptions),
      // so the only context-level option we add is viewport (null → use the real
      // Camoufox window size). No stealth script: it's Chromium-specific and a
      // tell on Firefox.
      const context = await firefox.launchPersistentContext(this.userDataDir, {
        ...(await buildLaunchOptions(cfg, identity, { cacheDir: this.userDataDir })),
        viewport: cfg.viewport,
      });
      this._context = context;
      context.on("close", () => this._onDisconnected());
      return context;
    } catch (err) {
      console.error(`persistent[${this.id}]: launch failed`, err);
      throw err;
    } finally {
      this._launching = null;
    }
  }

  _onDisconnected() {
    this._context = null;
    if (this._intentionalClose) {
      this._intentionalClose = false;
      console.log(`persistent[${this.id}]: closed gracefully`);
      return;
    }
    console.error(`persistent[${this.id}]: disconnected`);
    if (this.config.restartOnCrash) {
      setTimeout(
        () => this._getContext().catch((e) => console.error(`persistent[${this.id}]: restart failed`, e)),
        this.config.restartDelay,
      );
    }
  }

  async createPage() {
    const cfg = this.config;
    const context = await this._getContext();
    const page = await context.newPage();
    page.setDefaultTimeout(cfg.navigationTimeout);
    page.setDefaultNavigationTimeout(cfg.navigationTimeout);
    attachToPage(page);
    this._pages.add(page);
    page.on("close", () => this._pages.delete(page));
    return { page, context, close: () => page.close() };
  }

  getPages() {
    return [...this._pages];
  }

  async close() {
    if (!this._context) return;
    this._intentionalClose = true;
    await Promise.allSettled([...this._pages].map((p) => p.close()));
    this._pages.clear();
    try { await this._context.close(); } catch { /* already dead */ }
    this._context = null;
  }

  async status() {
    return {
      id: this.id,
      mode: this.mode,
      running: this.isRunning(),
      userDataDir: this.userDataDir,
      contexts: this._context
        ? [{
            pages: await Promise.all(
              [...this._pages].map(async (p) => ({
                url: p.url(),
                title: await p.title().catch(() => ""),
              })),
            ),
          }]
        : [],
    };
  }

  isRunning() {
    return !!this._context;
  }
}

module.exports = { PersistentInstance };
