/**
 * Run logging.
 *
 * Everything already narrates itself through console.log, so rather than
 * rewriting hundreds of call sites this tees the console to a file inside the
 * run directory and stamps each line with a timestamp and elapsed time.
 *
 * The elapsed column is the point: the reason a stuck run was hard to diagnose
 * was that nothing recorded *when* each step happened, so a slow step and a
 * hung one looked identical.
 */

const fs = require("fs");
const path = require("path");

let stream = null;
let startedAt = 0;
let installed = false;

function stamp() {
  const now = new Date();
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(7);
  return `${now.toISOString()} +${elapsed}s`;
}

function format(args) {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack || a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

/**
 * Tee console output into `<dir>/run.log`. Safe to call twice; the second call
 * is a no-op so nested entry points don't double-wrap the console.
 */
function install(dir) {
  if (installed) return logPath();
  startedAt = Date.now();

  const file = path.join(dir, "run.log");
  fs.mkdirSync(dir, { recursive: true });
  stream = fs.createWriteStream(file, { flags: "a" });

  for (const level of ["log", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      const line = format(args);
      // stdout keeps the plain text the runners' sentinels rely on.
      original(...args);
      try {
        stream.write(`${stamp()} [${level}] ${line}\n`);
      } catch {
        // A broken log file must never take the run down with it.
      }
    };
  }

  installed = true;
  console.log(`[logger] run log: ${file}`);
  return file;
}

function logPath() {
  return stream && stream.path;
}

/** Time an async step and log how long it took. */
async function timed(label, fn) {
  const t0 = Date.now();
  console.log(`[timing] ${label}…`);
  try {
    const result = await fn();
    console.log(`[timing] ${label} took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return result;
  } catch (err) {
    console.error(`[timing] ${label} FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${err.message}`);
    throw err;
  }
}

module.exports = { install, logPath, timed };
