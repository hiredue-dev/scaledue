/**
 * ScaleDue → Gmail bridge.
 *
 * Mirrors the HireDue desktop app's Gmail integration (electron/platforms/gmail)
 * so the same Google Cloud OAuth client works for both: identical scopes
 * (userinfo.email + gmail.send) and the identical loopback redirect
 * http://localhost:3000/oauth2callback, which is already registered on that
 * client. The one difference is where the client id/secret come from — HireDue
 * fetches them per-user from its backend; ScaleDue reads the OAuth client JSON
 * you download from Google Cloud Console.
 *
 * Credentials are resolved in this order:
 *   1. GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET  (env, or a .env file)
 *   2. SCALEDUE_GOOGLE_CLIENT                    (path to an OAuth client JSON)
 *   3. scaledue/google-oauth-client.json         (the default location)
 *
 * Commands (argv[2] is a JSON payload with `action`):
 *   connect  — run the consent flow, save the refresh token
 *   send     — send one email
 *   status   — report whether a usable token exists
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFile } = require("child_process");

/**
 * googleapis is a very large package — requiring it costs seconds, and the app
 * polls `status` on every refresh. Load it only in the actions that actually
 * talk to Google, so a status check stays a couple of file reads.
 */
let _google = null;
function google() {
  if (!_google) _google = require("googleapis").google;
  return _google;
}

// Same values as the desktop app's gmail.config.cjs, so the redirect URI
// already registered on the shared OAuth client keeps working.
const REDIRECT_PORT = Number(process.env.GOOGLE_OAUTH_REDIRECT_PORT || 3000);
const REDIRECT_ENDPOINT = process.env.OAUTH_REDIRECT_ENDPOINT || "oauth2callback";
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/${REDIRECT_ENDPOINT}`;
const SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.send",
];

const SCALEDUE_DIR = path.join(__dirname, "..");

/**
 * Minimal .env reader.
 *
 * Deliberately hand-rolled rather than pulling in dotenv: it is a dozen lines,
 * and it lets real environment variables win over the file, which is the
 * precedence you want when overriding a committed default from a shell.
 */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in process.env) continue; // a real env var wins
    let value = trimmed.slice(eq + 1).trim();
    // Strip one matching pair of surrounding quotes.
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

// Load scaledue/.env (self-contained).
loadEnvFile(path.join(SCALEDUE_DIR, ".env"));

const CLIENT_FILE = process.env.SCALEDUE_GOOGLE_CLIENT || path.join(SCALEDUE_DIR, "google-oauth-client.json");
const TOKEN_FILE = process.env.SCALEDUE_GMAIL_TOKEN || path.join(SCALEDUE_DIR, ".gmail-token.json");

/** Kept in sync with src-tauri/src/scraper.rs. */
const GMAIL_PREFIX = "@@SCALEDUE_GMAIL@@";
const ERROR_PREFIX = "@@SCALEDUE_ERROR@@";

const emit = (line) => process.stdout.write(`${line}\n`);
const ok = (payload) => emit(`${GMAIL_PREFIX}${JSON.stringify(payload)}`);
const fail = (error) => emit(`${ERROR_PREFIX}${JSON.stringify({ error: String(error) })}`);

// ── credentials ─────────────────────────────────────────────────────────────

/**
 * Read the OAuth client id/secret.
 *
 * Env vars win, so `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in a .env file is
 * enough — no downloaded JSON needed. Otherwise accepts the file exactly as
 * Google Cloud Console downloads it: `{"web":{…}}` for a Web application client,
 * `{"installed":{…}}` for a Desktop client, or a flat
 * `{client_id, client_secret}` written by hand.
 */
function loadClient() {
  const envId = (process.env.GOOGLE_CLIENT_ID || "").trim();
  const envSecret = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret, source: "env" };
  }
  // Half-configured is a typo, not a fallback — say so rather than silently
  // falling through to a stale file.
  if (envId || envSecret) {
    throw new Error(
      `Only ${envId ? "GOOGLE_CLIENT_ID" : "GOOGLE_CLIENT_SECRET"} is set — both are required.`,
    );
  }

  if (!fs.existsSync(CLIENT_FILE)) {
    throw new Error(
      `No Google OAuth credentials. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET ` +
        `(in scaledue/.env), or download the OAuth client JSON to ${CLIENT_FILE}.`,
    );
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(CLIENT_FILE, "utf8"));
  } catch (err) {
    throw new Error(`${CLIENT_FILE} is not valid JSON: ${err.message}`);
  }
  const cfg = json.web || json.installed || json;
  if (!cfg.client_id || !cfg.client_secret) {
    throw new Error(
      `${CLIENT_FILE} has no client_id/client_secret. ` +
        `Download the OAuth *client* JSON, not the service-account key or the web app config.`,
    );
  }
  return { clientId: cfg.client_id, clientSecret: cfg.client_secret, source: CLIENT_FILE };
}

function readToken() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeToken(token) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 });
}

function makeOAuthClient() {
  const { clientId, clientSecret } = loadClient();
  return new (google().auth.OAuth2)(clientId, clientSecret, REDIRECT_URI);
}

/** An authorised client, or null when Gmail has never been connected. */
function authorisedClient() {
  const saved = readToken();
  if (!saved || !saved.tokens || !saved.tokens.refresh_token) return null;
  const client = makeOAuthClient();
  client.setCredentials(saved.tokens);
  // googleapis refreshes automatically; persist the rotated token when it does.
  client.on("tokens", (fresh) => {
    const merged = { ...saved, tokens: { ...saved.tokens, ...fresh } };
    writeToken(merged);
  });
  return client;
}

function openInBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(cmd, args, () => {});
}

// ── actions ─────────────────────────────────────────────────────────────────

const CALLBACK_HTML = (heading, detail) => `<!doctype html><meta charset="utf-8">
<title>ScaleDue</title>
<body style="font:15px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#e6edf3;
display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2 style="margin:0 0 8px">${heading}</h2>
<p style="color:#8b98a5;margin:0">${detail}</p></div>`;

async function connect(timeoutSec) {
  const client = makeOAuthClient();
  const url = client.generateAuthUrl({
    access_type: "offline",   // needed for a refresh token
    scope: SCOPES,
    prompt: "consent",        // force a refresh token even on re-consent
  });

  emit("[gmail] opening Google consent screen in your browser…");

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(() => fn(arg));
    };

    const server = http.createServer(async (req, res) => {
      if (!req.url.startsWith(`/${REDIRECT_ENDPOINT}`)) {
        res.writeHead(404).end();
        return;
      }
      const params = new URL(req.url, REDIRECT_URI).searchParams;
      const error = params.get("error");
      const code = params.get("code");

      if (error || !code) {
        res.writeHead(200, { "Content-Type": "text/html" })
          .end(CALLBACK_HTML("Couldn't connect", error || "no authorisation code returned"));
        finish(reject, new Error(error || "no authorisation code returned"));
        return;
      }

      try {
        const { tokens } = await client.getToken(code);
        client.setCredentials(tokens);

        // Which mailbox did they actually authorise? Sending from the wrong
        // account is a silent, embarrassing failure, so surface it up front.
        const info = await google().oauth2({ version: "v2", auth: client }).userinfo.get();
        const email = (info.data && info.data.email) || "";

        writeToken({ email, connectedAt: new Date().toISOString(), tokens });
        res.writeHead(200, { "Content-Type": "text/html" })
          .end(CALLBACK_HTML("Gmail connected", `You can close this tab and return to ScaleDue.`));
        finish(resolve, { connected: true, email });
      } catch (err) {
        res.writeHead(200, { "Content-Type": "text/html" })
          .end(CALLBACK_HTML("Couldn't connect", err.message));
        finish(reject, err);
      }
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        finish(
          reject,
          new Error(
            `Port ${REDIRECT_PORT} is already in use — the HireDue desktop app may be running. ` +
              `Quit it and try again (both share this redirect URI).`,
          ),
        );
      } else {
        finish(reject, err);
      }
    });

    const timer = setTimeout(
      () => finish(reject, new Error(`no consent within ${timeoutSec}s`)),
      timeoutSec * 1000,
    );

    server.listen(REDIRECT_PORT, () => {
      emit(`[gmail] waiting for consent on ${REDIRECT_URI}`);
      openInBrowser(url);
    });
  });
}

/**
 * Build an RFC822 message. Mirrors the desktop app's prepareRawMessage, plus a
 * From header (so the display name is right) and base64 body encoding — the
 * desktop app declares 7bit, which corrupts any non-ASCII character, and creator
 * outreach is full of names and emoji that aren't ASCII.
 */
function buildRawMessage({ to, from, fromName, subject, body }) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const fromHeader = fromName ? `${fromName} <${from}>` : from;
  return [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf8").toString("base64"),
  ].join("\r\n");
}

const base64url = (s) =>
  Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function send({ to, subject, body, fromName }) {
  if (!to || !to.includes("@")) throw new Error(`invalid recipient: ${to || "(empty)"}`);
  if (!subject) throw new Error("subject is empty");

  loadClient(); // surfaces a credential misconfiguration before the token check
  const client = authorisedClient();
  if (!client) throw new Error("Gmail is not connected — use Connect Gmail first.");
  const saved = readToken();

  const raw = base64url(buildRawMessage({ to, from: saved.email, fromName, subject, body }));
  const gmail = google().gmail({ version: "v1", auth: client });
  const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });

  if (res.status !== 200) throw new Error(`Gmail returned status ${res.status}`);
  return { sent: true, to, messageId: res.data.id, threadId: res.data.threadId, from: saved.email };
}

function status() {
  const saved = readToken();
  let source = "";
  let clientConfigured = false;
  let clientError = "";
  let clientId = "";
  try {
    const c = loadClient();
    source = c.source;
    // Enough to confirm which OAuth client is in play (e.g. that it matches the
    // HireDue desktop app's) without putting a full credential on screen.
    clientId = c.clientId.length > 14 ? `${c.clientId.slice(0, 14)}…` : c.clientId;
    clientConfigured = true;
  } catch (err) {
    // Carry the reason: "half-configured" and "not configured at all" need
    // different fixes, and swallowing that difference hides a typo.
    clientError = err.message;
  }
  return {
    connected: !!(saved && saved.tokens && saved.tokens.refresh_token),
    email: (saved && saved.email) || "",
    connectedAt: (saved && saved.connectedAt) || "",
    clientConfigured,
    // Where the credentials came from, or where to put them.
    clientFile: source || CLIENT_FILE,
    clientId,
    clientError,
  };
}

// ── entry ───────────────────────────────────────────────────────────────────

async function main() {
  let payload = {};
  try {
    payload = JSON.parse(process.argv[2] || "{}");
  } catch (err) {
    throw new Error(`invalid payload JSON: ${err.message}`);
  }

  switch (payload.action) {
    case "connect":
      return ok(await connect(payload.timeoutSec || 180));
    case "send":
      return ok(await send(payload));
    case "status":
      return ok(status());
    default:
      throw new Error(`unknown action: ${payload.action}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    fail((err && err.message) || err);
    process.exit(1);
  });
