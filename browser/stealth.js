/**
 * Stealth Module — makes Playwright look like a real browser.
 *
 * Unlike HeadlessX (which fakes everything for datacenter servers), we run on
 * real user machines so we keep genuine hardware/platform values and only
 * remove the automation *tells* that bot-detectors look for.
 */

/** Init-script injected into every new context via addInitScript. */
const STEALTH_INIT_SCRIPT = () => {
  // ── 1. Remove webdriver / automation flags ──────────────────────────
  [
    "webdriver",
    "__webdriver_evaluate",
    "__selenium_evaluate",
    "__webdriver_script_function",
    "__webdriver_script_func",
    "__webdriver_script_fn",
    "__fxdriver_evaluate",
    "__driver_unwrapped",
    "__webdriver_unwrapped",
    "__driver_evaluate",
    "__selenium_unwrapped",
    "__fxdriver_unwrapped",
  ].forEach((p) => {
    try { delete window[p]; } catch {}
    try { delete navigator[p]; } catch {}
    try { delete document[p]; } catch {}
  });

  // Real Chrome leaves navigator.webdriver === false; we hide it entirely
  // (SannySoft's "WebDriver (New)" test wants `undefined` for the "missing
  // (passed)" result). configurable:true so re-entrant init can redefine,
  // and the whole thing is wrapped so a throw doesn't halt the rest of the
  // stealth script.
  try { delete Navigator.prototype.webdriver; } catch {}
  try { delete navigator.webdriver; } catch {}
  try {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
      configurable: true,
      enumerable: false,
    });
  } catch {}
  try {
    Object.defineProperty(Navigator.prototype, "webdriver", {
      get: () => undefined,
      configurable: true,
      enumerable: false,
    });
  } catch {}

  // ── 2. Remove Playwright / CDP markers ──────────────────────────────
  [
    "__playwright", "__pw_manual", "__pw_originals", "_playwright",
    "cdc_adoQpoasnfa76pfcZLmcfl_Array", "cdc_adoQpoasnfa76pfcZLmcfl_Promise",
    "cdc_adoQpoasnfa76pfcZLmcfl_Symbol", "cdc_adoQpoasnfa76pfcZLmcfl_JSON",
    "cdc_adoQpoasnfa76pfcZLmcfl_Object", "$cdc_asdjflasutopfhvcZLmcfl_",
  ].forEach((p) => { try { delete window[p]; } catch {} });

  // ── 3. chrome runtime object (must exist in real Chrome) ────────────
  if (!window.chrome) {
    window.chrome = {};
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      onConnect: undefined,
      onMessage: undefined,
      connect() {
        return { postMessage() {}, disconnect() {}, name: "", sender: undefined };
      },
      sendMessage() {},
      id: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
      getManifest() { return { name: "Chrome PDF Viewer", version: "1.0.0.0" }; },
    };
  }
  if (!window.chrome.app) {
    window.chrome.app = {
      isInstalled: false,
      InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
      RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
      getDetails() { return null; },
      getIsInstalled() { return false; },
    };
  }
  if (!window.chrome.csi) {
    window.chrome.csi = () => ({
      startE: Date.now() - Math.random() * 1000,
      onloadT: Date.now() - Math.random() * 500,
      tran: Math.floor(Math.random() * 20) + 10,
    });
  }
  if (!window.chrome.loadTimes) {
    window.chrome.loadTimes = () => {
      const now = Date.now() / 1000;
      const ns = now - Math.random() * 2;
      return {
        requestTime: ns, startLoadTime: ns + 0.1, commitLoadTime: ns + 0.2,
        finishDocumentLoadTime: ns + 0.5, finishLoadTime: ns + 0.8,
        firstPaintTime: ns + 0.6, firstPaintAfterLoadTime: 0,
        navigationType: "Navigation", wasFetchedViaSpdy: false,
        wasNpnNegotiated: false, npnNegotiatedProtocol: "unknown",
        wasAlternateProtocolAvailable: false, connectionInfo: "http/1.1",
      };
    };
  }

  // ── 4. Plugins & MimeTypes (headless Chrome ships with 0) ───────────
  // Only fake these when the runtime has none — real Chrome already exposes
  // proper PluginArray / MimeTypeArray instances, and replacing them with
  // plain Arrays breaks `instanceof PluginArray` checks (SannySoft etc.).
  if (!navigator.plugins || navigator.plugins.length === 0) {
    const mimeTypes = [
      { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null },
      { type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null },
    ];
    const plugins = [
      { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format", length: 1, 0: mimeTypes[1] },
      { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "", length: 1, 0: mimeTypes[0] },
      { name: "Native Client", filename: "internal-nacl-plugin", description: "", length: 0 },
      { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format", length: 1, 0: mimeTypes[0] },
      { name: "WebKit built-in PDF", filename: "internal-pdf-viewer", description: "Portable Document Format", length: 1, 0: mimeTypes[0] },
    ];
    mimeTypes[0].enabledPlugin = plugins[1];
    mimeTypes[1].enabledPlugin = plugins[0];
    plugins.item = (i) => plugins[i] || null;
    plugins.namedItem = (n) => plugins.find((p) => p.name === n) || null;
    plugins.refresh = () => {};
    mimeTypes.item = (i) => mimeTypes[i] || null;
    mimeTypes.namedItem = (n) => mimeTypes.find((m) => m.type === n) || null;

    Object.defineProperty(navigator, "plugins", { get: () => plugins, configurable: false, enumerable: true });
    Object.defineProperty(navigator, "mimeTypes", { get: () => mimeTypes, configurable: false, enumerable: true });
  }

  // ── 5. Permissions API — return realistic defaults ──────────────────
  if (navigator.permissions?.query) {
    const _origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (params) =>
      _origQuery(params).catch(() => Promise.resolve({ state: "prompt" }));
  }

  // ── 6. Canvas fingerprint noise (subtle, consistent per session) ────
  const _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const _origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  const _seed = Math.floor(Math.random() * 1000);

  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    try {
      const ctx = this.getContext("2d");
      if (ctx) {
        const img = _origGetImageData.call(ctx, 0, 0, this.width, this.height);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] > 0) {
            const n = ((_seed + i) % 3) - 1;
            d[i] = Math.max(0, Math.min(255, d[i] + n));
          }
        }
        ctx.putImageData(img, 0, 0);
      }
    } catch {}
    return _origToDataURL.apply(this, args);
  };

  // ── 7. WebGL unmasked renderer — keep real GPU but add noise ────────
  const _origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...a) {
    const ctx = _origGetContext.call(this, type, ...a);
    if (ctx && (type === "webgl" || type === "experimental-webgl" || type === "webgl2")) {
      const _origGetParam = ctx.getParameter.bind(ctx);
      ctx.getParameter = function (p) {
        // Return real values — detection scripts check for *missing* values
        return _origGetParam(p);
      };
    }
    return ctx;
  };

  // ── 8. Patch Function.prototype.toString to hide overrides ──────────
  const _nativeToString = Function.prototype.toString;
  const _overridden = new Set();

  const patchToString = (fn, nativeName) => {
    _overridden.add(fn);
    return fn;
  };

  Function.prototype.toString = function () {
    if (_overridden.has(this)) return `function ${this.name || ""}() { [native code] }`;
    if (this === Function.prototype.toString) return "function toString() { [native code] }";
    return _nativeToString.call(this);
  };
  patchToString(Function.prototype.toString);
  patchToString(navigator.permissions?.query);

  // ── 9. Propagate chrome object into iframes ─────────────────────────
  const _origCreateElement = document.createElement.bind(document);
  document.createElement = function (tag) {
    const el = _origCreateElement(tag);
    if (tag.toLowerCase() === "iframe") {
      el.addEventListener("load", function () {
        try { if (this.contentWindow && !this.contentWindow.chrome) this.contentWindow.chrome = window.chrome; } catch {}
      });
    }
    return el;
  };
  patchToString(document.createElement);

  // ── 10. Connection API (missing in headless) ────────────────────────
  if (!navigator.connection) {
    Object.defineProperty(navigator, "connection", {
      get: () => ({
        effectiveType: "4g",
        rtt: 50 + Math.floor(Math.random() * 50),
        downlink: 8 + Math.random() * 4,
        saveData: false,
        onchange: null,
      }),
      configurable: true,
    });
  }
};

/**
 * Apply stealth to a Playwright BrowserContext.
 * Call once right after context creation, before any navigation.
 */
async function applyStealth(context) {
  await context.addInitScript(STEALTH_INIT_SCRIPT);
}

module.exports = { applyStealth };
