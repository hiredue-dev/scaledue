const { EphemeralInstance } = require("./ephemeral/EphemeralInstance");
const { PersistentInstance } = require("./persistent/PersistentInstance");

class BrowserPool {
  constructor() {
    /** @type {Map<string, EphemeralInstance | PersistentInstance>} */
    this._instances = new Map();
    /** @type {Set<string>} resolved user-data dirs in use */
    this._userDataDirs = new Set();
  }

  createEphemeral(id, configOverrides = {}) {
    if (this._instances.has(id)) throw new Error(`Instance "${id}" already exists`);
    const instance = new EphemeralInstance(id, configOverrides);
    this._instances.set(id, instance);
    console.log(`pool: created ephemeral instance "${id}"`);
    return instance;
  }

  createPersistent(id, userDataDir, configOverrides = {}) {
    if (this._instances.has(id)) throw new Error(`Instance "${id}" already exists`);
    const resolved = require("path").resolve(userDataDir);
    if (this._userDataDirs.has(resolved)) {
      throw new Error(`User-data directory "${resolved}" is already in use by another instance`);
    }
    const instance = new PersistentInstance(id, userDataDir, configOverrides);
    this._userDataDirs.add(resolved);
    this._instances.set(id, instance);
    console.log(`pool: created persistent instance "${id}"`, { userDataDir });
    return instance;
  }

  get(id) {
    return this._instances.get(id);
  }

  has(id) {
    return this._instances.has(id);
  }

  async destroy(id) {
    const inst = this._instances.get(id);
    if (!inst) return;
    await inst.close();
    if (inst.mode === "persistent") this._userDataDirs.delete(inst.userDataDir);
    this._instances.delete(id);
    console.log(`pool: destroyed instance "${id}"`);
  }

  async destroyAll() {
    await Promise.allSettled([...this._instances.keys()].map((id) => this.destroy(id)));
  }

  async status() {
    const instances = await Promise.all(
      [...this._instances.values()].map((inst) => inst.status()),
    );
    return {
      ephemeral: instances.filter((i) => i.mode === "ephemeral"),
      persistent: instances.filter((i) => i.mode === "persistent"),
    };
  }

  get size() {
    return this._instances.size;
  }
}

const pool = new BrowserPool();

module.exports = { BrowserPool, pool };
