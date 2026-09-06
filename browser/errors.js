class BrowserError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "BrowserError";
    this.cause = cause;
  }
}

class BrowserLaunchError extends BrowserError {
  constructor(cause) {
    super("Failed to launch browser", cause);
    this.name = "BrowserLaunchError";
  }
}

class BrowserCrashedError extends BrowserError {
  constructor() {
    super("Browser disconnected unexpectedly");
    this.name = "BrowserCrashedError";
  }
}

class ResourceLimitError extends BrowserError {
  constructor(resource, limit) {
    super(`Resource limit reached: max ${resource} is ${limit}`);
    this.name = "ResourceLimitError";
  }
}

module.exports = { BrowserError, BrowserLaunchError, BrowserCrashedError, ResourceLimitError };
