const { firefox } = require("playwright");
const { createConfig, buildLaunchOptions } = require("../config");
const { attachToPage } = require("../humanize");

class EphemeralInstance {
  constructor(id, configOverrides = {}) {
    this.id = id;
    this.mode = "ephemeral";
    this.config = createConfig(configOverrides);
    this._browser = null;
    this._launching = null;
    /** @type {Map<import('playwright').BrowserContext, Set<import('playwright').Page>>} */
    this._contexts = new Map();
  }

  async init() {
    await this._getBrowser();
  }

  async _getBrowser() {
    if (this._browser?.isConnected()) return this._browser;
    if (this._launching) return this._launching;
    this._launching = this._launch();
    return this._launching;
  }

  async _launch() {
    const cfg = this.config;
    console.log(`ephemeral[${this.id}]: launching`, { headless: cfg.headless });
    try {
      const browser = await firefox.launch(await buildLaunchOptions(cfg));
      this._browser = browser;
      browser.on("disconnected", () => this._onDisconnected());
      return browser;
    } catch (err) {
      console.error(`ephemeral[${this.id}]: launch failed`, err);
      throw err;
    } finally {
      this._launching = null;
    }
  }

  _onDisconnected() {
    console.error(`ephemeral[${this.id}]: disconnected`);
    this._browser = null;
    this._contexts.clear();
    if (this.config.restartOnCrash) {
      setTimeout(
        () => this._getBrowser().catch((e) => console.error(`ephemeral[${this.id}]: restart failed`, e)),
        this.config.restartDelay,
      );
    }
  }

  async createContext() {
    const cfg = this.config;
    if (this._contexts.size >= cfg.maxContexts) {
      throw new Error(`Resource limit reached: max contexts is ${cfg.maxContexts}`);
    }
    const browser = await this._getBrowser();
    // No userAgent / proxy / stealth overrides here: Camoufox sets the UA and
    // fingerprint at launch, and the proxy is applied browser-wide via
    // buildLaunchOptions. viewport: null keeps the real Camoufox window size.
    const context = await browser.newContext({ viewport: cfg.viewport });
    this._contexts.set(context, new Set());
    context.on("close", () => this._contexts.delete(context));
    return context;
  }

  async createPage() {
    const cfg = this.config;
    const context = await this.createContext();
    const page = await context.newPage();
    page.setDefaultTimeout(cfg.navigationTimeout);
    page.setDefaultNavigationTimeout(cfg.navigationTimeout);
    attachToPage(page);
    const pages = this._contexts.get(context);
    if (pages) pages.add(page);
    page.on("close", () => { if (pages) pages.delete(page); });
    return { page, context, close: () => context.close() };
  }

  async status() {
    return {
      id: this.id,
      mode: this.mode,
      running: this.isRunning(),
      contexts: await Promise.all(
        [...this._contexts].map(async ([, pages]) => ({
          pages: await Promise.all(
            [...pages].map(async (p) => ({
              url: p.url(),
              title: await p.title().catch(() => ""),
            })),
          ),
        })),
      ),
    };
  }

  async close() {
    await Promise.allSettled([...this._contexts.keys()].map((c) => c.close()));
    this._contexts.clear();
    if (!this._browser) return;
    try { await this._browser.close(); } catch { /* already dead */ }
    this._browser = null;
  }

  isRunning() {
    return !!this._browser?.isConnected();
  }

  get activeContexts() {
    return this._contexts.size;
  }
}

module.exports = { EphemeralInstance };
