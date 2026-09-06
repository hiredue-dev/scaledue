/**
 * Humanize — utilities that make page interactions look human.
 *
 * Adapted from HeadlessX behavioral services (mouse-movement, keyboard-dynamics,
 * scroll-patterns, click-simulation) but stripped down to what matters on a real
 * user machine running headless.
 *
 * Every helper takes a Playwright `page` and returns a Promise.
 */

// ── helpers ───────────────────────────────────────────────────────────────────

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Box-Muller gaussian with mean 0, stddev 1. */
function gaussian() {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ── mouse ─────────────────────────────────────────────────────────────────────

// Hybrid model: issue a SINGLE move to the target and let Camoufox's native,
// browser-level humanize curve the path realistically. We deliberately do NOT
// build a bezier path here — doing so stacks with Camoufox and produces an
// erratic, wandering, slow cursor. (Requires `humanize` enabled in config.js.)
async function moveMouse(page, targetX, targetY) {
  await page.mouse.move(targetX, targetY);
}

/**
 * Human-like click: move to element via Bezier, pause, mousedown/up with
 * realistic hold time.
 */
async function humanClick(page, selectorOrEl, opts = {}) {
  const el = typeof selectorOrEl === 'string'
    ? await page.waitForSelector(selectorOrEl, { timeout: opts.timeout || 10_000 })
    : selectorOrEl;
  const box = await el.boundingBox();
  if (!box) throw new Error(`Element ${selectorOrEl} not visible`);

  // Click slightly off-center (gaussian distribution)
  const cx = box.x + box.width / 2 + gaussian() * box.width * 0.15;
  const cy = box.y + box.height / 2 + gaussian() * box.height * 0.15;
  const x = Math.max(box.x + 2, Math.min(box.x + box.width - 2, cx));
  const y = Math.max(box.y + 2, Math.min(box.y + box.height - 2, cy));

  await moveMouse(page, x, y);
  await wait(rand(40, 150)); // pre-click pause

  await page.mouse.down();
  await wait(rand(30, 80)); // hold
  await page.mouse.up();

  await wait(rand(80, 250)); // post-click settle
}

// ── keyboard ──────────────────────────────────────────────────────────────────

// Simplified QWERTY hand/finger map for timing adjustments.
const HAND = {};
"qwertasdfgzxcvb".split("").forEach((c) => (HAND[c] = "L"));
"yuiophjklnm".split("").forEach((c) => (HAND[c] = "R"));
HAND[" "] = "B";

/**
 * Type text character-by-character with realistic inter-key delays,
 * dwell times, and occasional micro-pauses.
 */
async function humanType(page, selectorOrEl, text) {
  const el = typeof selectorOrEl === 'string'
    ? await page.waitForSelector(selectorOrEl, { timeout: 10_000 })
    : selectorOrEl;
  await el.click();
  await wait(rand(80, 200));

  let prev = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const lower = ch.toLowerCase();

    // base inter-key delay (≈50-60 WPM)
    let flight = rand(70, 160);

    // same-hand penalty
    if (prev && HAND[lower] && HAND[prev] && HAND[lower] === HAND[prev] && HAND[lower] !== "B") {
      flight *= 1.4;
    }
    // space gets a longer pause
    if (ch === " ") flight += rand(40, 120);
    // capitals need shift
    if (ch !== lower) flight += rand(30, 70);
    // occasional thinking pause (~5 %)
    if (Math.random() < 0.05) flight += rand(300, 800);

    await wait(flight);

    const dwell = rand(40, 100);
    await page.keyboard.down(ch);
    await wait(dwell);
    await page.keyboard.up(ch);

    prev = lower;
  }
}

// ── scroll ────────────────────────────────────────────────────────────────────

/**
 * Scroll the page in a human-like pattern: variable distances, eased motion,
 * occasional pauses and small backtracks.
 *
 * @param {import('playwright').Page} page
 * @param {object} opts
 * @param {number} [opts.targetPct=0.8] — how far down the page to scroll (0-1)
 * @param {number} [opts.maxTime=30000]  — safety cap in ms
 */
async function humanScroll(page, opts = {}) {
  const targetPct = opts.targetPct ?? 0.8;
  const maxTime = opts.maxTime ?? 30_000;

  await page.evaluate(
    async ({ targetPct, maxTime }) => {
      await new Promise((resolve) => {
        const start = Date.now();
        let pos = window.scrollY;

        const step = () => {
          if (Date.now() - start > maxTime) return resolve();
          const docH = document.body.scrollHeight;
          const target = docH * targetPct;
          if (pos >= target) return resolve();

          // scroll distance: 60-200 px
          const dist = 60 + Math.random() * 140;
          const duration = 120 + Math.random() * 100;
          const startY = window.scrollY;
          const endY = Math.min(startY + dist, target);
          const t0 = performance.now();

          const animate = (now) => {
            const p = Math.min((now - t0) / duration, 1);
            const ease = 1 - Math.pow(1 - p, 2.5);
            window.scrollTo(0, startY + (endY - startY) * ease);
            if (p < 1) return requestAnimationFrame(animate);

            pos = endY;

            // ~10 % chance of small backtrack
            if (Math.random() < 0.1) {
              window.scrollTo(0, Math.max(0, pos - 20 - Math.random() * 40));
            }

            // reading pause: 150-600 ms, occasionally longer
            const pause = Math.random() < 0.15
              ? 600 + Math.random() * 1400
              : 150 + Math.random() * 450;

            setTimeout(step, pause);
          };

          requestAnimationFrame(animate);
        };

        step();
      });
    },
    { targetPct, maxTime },
  );
}

// ── page wrapper ──────────────────────────────────────────────────────────────

/**
 * Attach humanize helpers directly onto a Playwright Page so callers can do
 *   `page.humanClick(selector)` etc.
 */
function attachToPage(page) {
  page.humanClick = (selOrEl, o) => humanClick(page, selOrEl, o);
  page.humanType = (selOrEl, txt) => humanType(page, selOrEl, txt);
  page.humanScroll = (o) => humanScroll(page, o);
  page.moveMouse = (x, y) => moveMouse(page, x, y);
}

module.exports = { moveMouse, humanClick, humanType, humanScroll, attachToPage };
