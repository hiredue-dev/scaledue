const { createConfig, DEFAULTS, buildLaunchOptions } = require("./config");
const { EphemeralInstance } = require("./ephemeral/EphemeralInstance");
const { PersistentInstance } = require("./persistent/PersistentInstance");
const { BrowserPool, pool } = require("./BrowserPool");
const { getStableIdentity, hostOS } = require("./fingerprint");
const { moveMouse, humanClick, humanType, humanScroll, attachToPage } = require("./humanize");

module.exports = {
  createConfig,
  DEFAULTS,
  buildLaunchOptions,
  EphemeralInstance,
  PersistentInstance,
  BrowserPool,
  pool,
  getStableIdentity,
  hostOS,
  moveMouse,
  humanClick,
  humanType,
  humanScroll,
  attachToPage,
};
