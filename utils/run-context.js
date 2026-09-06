const path = require("path");
const fs = require("fs");

const LOCAL_DIR = path.join(__dirname, "..", ".local");
const DEFAULT_CHROME_PROFILE = path.join(LOCAL_DIR, "chrome-profiles", "default");

let _runDir = null;
let _screenshotsDir = null;

function init() {
  _runDir = path.join(
    LOCAL_DIR, "runs",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  _screenshotsDir = path.join(_runDir, "screenshots");
  fs.mkdirSync(_screenshotsDir, { recursive: true });
  // Tee console output to <runDir>/run.log from here on.
  require("./logger").install(_runDir);
  return _runDir;
}

function runDir() {
  if (!_runDir) throw new Error("run context not initialized — call init() first");
  return _runDir;
}

function screenshotsDir() {
  if (!_screenshotsDir) throw new Error("run context not initialized — call init() first");
  return _screenshotsDir;
}

/**
 * Save a file inside the run directory under a subfolder.
 *
 *   saveOutput("reports", "summary.json", JSON.stringify(data));
 *   saveOutput("logs", "debug.txt", logText);
 */
function saveOutput(subfolder, filename, content) {
  const dir = path.join(runDir(), subfolder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, filename);
  fs.writeFileSync(file, content);
  console.log("saved", file);
  return file;
}

module.exports = { DEFAULT_CHROME_PROFILE, init, runDir, screenshotsDir, saveOutput };
