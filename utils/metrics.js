const path = require("path");
const fs = require("fs");

let _file = null;
let _startedAt = null;
const _counters = {};

function init(runDir) {
  _file = path.join(runDir, "metrics.json");
  _startedAt = new Date().toISOString();
  process.on("exit", save);
}

function save() {
  if (!_file) return;
  try {
    fs.writeFileSync(_file, JSON.stringify({ startedAt: _startedAt, endedAt: new Date().toISOString(), counters: _counters }, null, 2));
  } catch {}
}

function inc(key, amount = 1) {
  _counters[key] = (_counters[key] || 0) + amount;
}

function flush() {
  console.log("metrics", _counters);
  save();
}

module.exports = { init, inc, flush };
