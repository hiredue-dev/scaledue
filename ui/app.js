/**
 * ScaleDue UI.
 *
 * Talks to the Rust backend through the global Tauri bridge (enabled by
 * `withGlobalTauri`), so there is no bundler and no build step for the frontend.
 */

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);

/**
 * Hand http(s) links to the system browser. Without this the click would
 * navigate the app's own webview to instagram.com, replacing the UI entirely.
 */
document.addEventListener("click", (e) => {
  const link = e.target.closest('a[href^="http"]');
  if (!link) return;
  e.preventDefault();
  const opener = window.__TAURI__ && window.__TAURI__.opener;
  if (opener) opener.openUrl(link.href).catch(() => {});
});

const el = {
  stats: $("stats"), status: $("status"), hint: $("hint"),
  runBtn: $("runBtn"), cancelBtn: $("cancelBtn"),
  configBody: $("configBody"), toggleConfig: $("toggleConfig"),
  logPanel: $("logPanel"), log: $("log"), clearLog: $("clearLog"),
  runFilter: $("runFilter"), search: $("search"), rowCount: $("rowCount"),
  tbody: $("tbody"), empty: $("empty"),
  drawer: $("drawer"), drawerTitle: $("drawerTitle"), drawerBody: $("drawerBody"),
  closeDrawer: $("closeDrawer"), dbPath: $("dbPath"),
  connDot: $("connDot"), connTitle: $("connTitle"), connDetail: $("connDetail"),
  connectBtn: $("connectBtn"), cancelConnectBtn: $("cancelConnectBtn"),
  exportBtn: $("exportBtn"), qualifiedOnly: $("qualifiedOnly"),
  fbDot: $("fbDot"), fbTitle: $("fbTitle"), fbDetail: $("fbDetail"),
  fbRetry: $("fbRetry"), fbRefresh: $("fbRefresh"),
  selectAll: $("selectAll"), deleteSelectedBtn: $("deleteSelectedBtn"),
  deleteAllBtn: $("deleteAllBtn"), deleteUnresolvedBtn: $("deleteUnresolvedBtn"),
  gmDot: $("gmDot"), gmTitle: $("gmTitle"), gmDetail: $("gmDetail"),
  gmConnectBtn: $("gmConnectBtn"),
};

/** Latest Gmail status, so the drawer knows whether sending is possible. */
let gmail = { connected: false, email: "" };

/**
 * Selected creator ids. Held by id rather than row index so a selection
 * survives re-sorting, searching and refreshing.
 */
const selected = new Set();

/** Pipeline statuses, in order. Keys match the Rust model. */
const STATUSES = [
  ["new", "New"],
  ["outreach", "Outreach sent"],
  ["responded", "Responded"],
];
const statusOf = (c) => c.status || "new";

let creators = [];
/** Mirrors the backend's one-job-at-a-time rule so buttons disable correctly. */
let busy = null;

// ── formatting ──────────────────────────────────────────────────────────────

function compact(n) {
  if (!n) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(n);
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );

/** Firestore stores these as real arrays; tolerate a missing field. */
function parseList(v) {
  return Array.isArray(v) ? v : [];
}

const shortTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

// ── data loading ────────────────────────────────────────────────────────────

async function refreshStats() {
  const s = await invoke("stats");
  el.stats.innerHTML = [
    ["Profiles", s.total_creators],
    ["Leads", s.qualified],
    ["With email", s.with_email],
    ["Reels", s.total_reels],
    ["Reach", compact(s.total_reach)],
    ["Runs", s.total_runs],
  ]
    .map(([label, value]) => `<div class="stat"><b>${esc(typeof value === "number" ? value.toLocaleString() : value)}</b><span>${label}</span></div>`)
    .join("");
}

async function refreshRuns() {
  const runs = await invoke("list_runs");
  const current = el.runFilter.value;
  el.runFilter.innerHTML =
    `<option value="">All runs</option>` +
    runs
      .map((r) => {
        const kw = parseList(r.keywords).slice(0, 2).join(", ");
        const flag = r.status === "failed" ? " ✕" : r.status === "running" ? " …" : "";
        return `<option value="${esc(r.id)}">${esc(shortTime(r.started_at))}${flag} · ${esc(kw)}</option>`;
      })
      .join("");
  // Keep the user's selection across refreshes when it still exists.
  if ([...el.runFilter.options].some((o) => o.value === current)) el.runFilter.value = current;
}

async function refreshCreators() {
  const runId = el.runFilter.value || null;
  const search = el.search.value.trim() || null;
  const all = await invoke("list_creators", { runId, search });
  creators = el.qualifiedOnly.checked ? all.filter((c) => c.is_qualified) : all;

  // Drop selections for rows that no longer exist (deleted, or filtered away
  // by a different run) so the count can never exceed what's on screen.
  const visible = new Set(creators.map((c) => c.id));
  for (const id of [...selected]) if (!visible.has(id)) selected.delete(id);

  el.rowCount.textContent = creators.length
    ? `${creators.length} shown${creators.length !== all.length ? ` of ${all.length}` : ""}`
    : "";
  el.empty.hidden = creators.length > 0;
  el.exportBtn.disabled = creators.length === 0;
  el.deleteAllBtn.disabled = all.length === 0;
  syncSelectionUi();

  el.tbody.innerHTML = creators
    .map((c, i) => {
      // Effective contact: a hand-typed override beats the scraped value.
      const email = c.contact_email
        ? `<a class="mail" href="#" data-copy="${esc(c.contact_email)}">${esc(c.contact_email)}</a>` +
          (c.email_override ? '<span class="badge" title="edited by hand">✎</span>' : "")
        : `<span class="name">—</span>`;
      const rowClass = [c.is_enriched ? "" : "unenriched", c.emailed_at ? "contacted" : ""]
        .filter(Boolean)
        .join(" ");
      const isSel = selected.has(c.id);
      return `<tr data-i="${i}" data-id="${esc(c.id)}" class="${rowClass}${isSel ? " selected" : ""}">
        <td class="pick"><input type="checkbox" class="rowPick"${isSel ? " checked" : ""} /></td>
        <td class="num name">${i + 1}</td>
        <td>
          <div class="handle">@${esc(c.username)}${c.is_verified ? '<span class="badge">✓</span>' : ""}</div>
          <div class="name">${esc(c.full_name)}</div>
        </td>
        <td>
          <a class="profile-link" href="${esc(c.profile_url)}" title="${esc(c.profile_url)}">instagram.com/${esc(c.username)} ↗</a>
        </td>
        <td class="num">${c.is_enriched ? compact(c.followers) : "—"}</td>
        <td class="num"><span class="pill ${c.is_qualified ? "hot" : ""}">${c.score}</span></td>
        <td class="num">${c.reel_count}</td>
        <td class="num">${compact(c.avg_plays)}</td>
        <td>${email}</td>
        <td><div class="bio">${c.is_enriched ? esc(c.bio) : "<em>not resolved yet</em>"}</div></td>
        <td>
          <select class="status s-${esc(statusOf(c))}" data-status-for="${esc(c.id)}">
            ${STATUSES.map(([v, label]) =>
              `<option value="${v}"${statusOf(c) === v ? " selected" : ""}>${label}</option>`).join("")}
          </select>
        </td>
      </tr>`;
    })
    .join("");
}

async function refreshAll() {
  if (!(await refreshFirebase())) {
    el.tbody.innerHTML = "";
    el.empty.hidden = false;
    el.empty.textContent = "Connect Firestore to load creators.";
    return;
  }
  el.empty.textContent = "No creators yet — run a scrape to populate the database.";
  await Promise.all([refreshStats(), refreshRuns()]);
  await refreshCreators();
}

// ── bulk selection ──────────────────────────────────────────────────────────

function syncSelectionUi() {
  const n = selected.size;
  el.deleteSelectedBtn.hidden = n === 0;
  el.deleteSelectedBtn.textContent = `Delete ${n} selected`;
  el.selectAll.checked = n > 0 && n === creators.length;
  // Partially selected reads as neither on nor off.
  el.selectAll.indeterminate = n > 0 && n < creators.length;
}

function setRowSelected(id, on) {
  if (on) selected.add(id);
  else selected.delete(id);
  const row = el.tbody.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
  if (row) {
    row.classList.toggle("selected", on);
    const box = row.querySelector(".rowPick");
    if (box) box.checked = on;
  }
  syncSelectionUi();
}

/** Report a bulk result, being explicit when some documents failed. */
function reportBulk(res, label) {
  const note = el.rowCount;
  if (res.failed && res.failed.length) {
    note.textContent = `${label}: ${res.deleted} removed, ${res.failed.length} failed`;
    note.className = "count error";
    appendLog(`[scaledue] ${res.failed.length} deletion failure(s):`);
    res.failed.slice(0, 10).forEach((f) => appendLog(`  ${f}`));
  } else {
    note.textContent = `${label}: ${res.deleted} removed`;
    note.className = "count saved";
  }
  setTimeout(() => (note.className = "count"), 4000);
}

async function confirmDestructive(message, title) {
  const dialog = window.__TAURI__ && window.__TAURI__.dialog;
  if (!dialog || !dialog.confirm) return false; // never delete without a gate
  return dialog.confirm(message, { title, kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" });
}

async function runBulk(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  el.logPanel.hidden = false;
  try {
    const res = await fn();
    reportBulk(res, label);
    selected.clear();
    await refreshAll();
  } catch (err) {
    el.rowCount.textContent = String(err);
    el.rowCount.className = "count error";
    appendLog(`[scaledue] ${err}`);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function deleteSelected() {
  const ids = [...selected];
  if (!ids.length) return;
  const ok = await confirmDestructive(
    `Permanently delete ${ids.length} creator${ids.length === 1 ? "" : "s"} and their reels from Firestore?\n\nThis cannot be undone.`,
    "Delete selected creators",
  );
  if (!ok) return;
  await runBulk(el.deleteSelectedBtn, "Deleted", () => invoke("delete_creators", { creatorIds: ids }));
}

async function deleteUnresolved() {
  const n = creators.filter((c) => !c.is_enriched).length;
  const ok = await confirmDestructive(
    `Delete every creator whose profile never resolved — the ones with no follower count or bio?\n\n` +
      `At least ${n} in the current view; the operation covers the whole database.\n\nThis cannot be undone.`,
    "Delete unresolved creators",
  );
  if (!ok) return;
  await runBulk(el.deleteUnresolvedBtn, "Deleted", () => invoke("delete_unresolved"));
}

async function deleteAll() {
  const ok = await confirmDestructive(
    `Permanently delete EVERYTHING from Firestore — every creator, every reel and the full run history.\n\nThis cannot be undone.`,
    "Delete all data",
  );
  if (!ok) return;
  await runBulk(el.deleteAllBtn, "Deleted", () => invoke("delete_all_data"));
}

// ── detail drawer ───────────────────────────────────────────────────────────

async function openCreator(index) {
  const c = creators[index];
  if (!c) return;

  el.drawerTitle.innerHTML = `<div class="handle">@${esc(c.username)}${c.is_verified ? '<span class="badge">✓</span>' : ""}</div><div class="name">${esc(c.full_name)}</div>`;

  const draft = draftEmail(c);
  const links = parseList(c.bio_links);
  const terms = parseList(c.matched_terms);
  const kws = parseList(c.keywords);

  const rows = [
    ["Profile", `<a href="${esc(c.profile_url)}" target="_blank" rel="noreferrer">${esc(c.profile_url)}</a>`],
    ["Followers", c.followers.toLocaleString()],
    ["Following", c.following.toLocaleString()],
    ["Posts", c.posts.toLocaleString()],
    ["Fit score", String(c.score)],
    ["Avg plays", c.avg_plays.toLocaleString()],
    ["Category", esc(c.category) || "—"],
    ["Scraped email", c.business_email ? esc(c.business_email) : "—"],
    ["Scraped phone", c.business_phone ? esc(c.business_phone) : "—"],
    ["Matched", terms.length ? esc(terms.join(", ")) : "—"],
    ["Keywords", kws.length ? esc(kws.join(", ")) : "—"],
    ["Seen", `${c.times_seen}× · first ${esc(shortTime(c.first_seen_at))}`],
    ["Emailed", c.emailed_at ? `${esc(shortTime(c.emailed_at))} → ${esc(c.emailed_to)}` : "—"],
  ];

  const linkList = links.length
    ? `<div><div class="section-title">Bio links</div><dl class="kv">${links
        .map((l, i) => `<dt>${i + 1}</dt><dd><a href="${esc(l)}" target="_blank" rel="noreferrer">${esc(l)}</a></dd>`)
        .join("")}</dl></div>`
    : "";

  el.drawerBody.innerHTML = `
    <div><div class="section-title">Bio</div><p style="margin:6px 0 0;font-size:12px;white-space:pre-wrap">${esc(c.bio) || "—"}</p></div>
    <div><div class="section-title">Details</div>
      <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    </div>
    ${linkList}
    <div>
      <div class="section-title">Contact</div>
      <div class="edit-grid">
        <label><span>Email</span><input id="editEmail" type="email" value="${esc(c.contact_email)}" placeholder="name@example.com" /></label>
        <label><span>Phone</span><input id="editPhone" type="text" value="${esc(c.contact_phone)}" placeholder="+1 555 0100" /></label>
        <div class="edit-actions">
          <button class="primary" id="saveContact" type="button">Save contact</button>
          <span class="edit-note" id="editNote">${
            c.email_override || c.phone_override
              ? "Edited by hand — a re-scrape won't overwrite this."
              : "Saving replaces the scraped value; clear a field to fall back to it."
          }</span>
        </div>
      </div>
    </div>
    <div><div class="section-title">Reels</div><div id="reels" style="display:flex;flex-direction:column;gap:8px;margin-top:8px">Loading…</div></div>
    <div>
      <div class="section-title">Send email</div>
      <div class="mail-grid">
        <label><span>To</span><input id="mailTo" type="email" value="${esc(c.contact_email)}" placeholder="no address on file" /></label>
        <label><span>Subject</span><input id="mailSubject" type="text" value="${esc(draft.subject)}" /></label>
        <label><span>Message</span><textarea id="mailBody">${esc(draft.body)}</textarea></label>
        <div class="edit-actions">
          <button class="primary" id="sendMail" type="button">Send email</button>
          <span class="edit-note" id="mailNote"></span>
        </div>
      </div>
    </div>
    <div class="danger-zone">
      <button class="danger" id="deleteCreator" type="button">Delete creator</button>
      <span class="edit-note" id="deleteNote"></span>
    </div>`;

  el.drawer.hidden = false;
  wireContactEditor(c);
  wireMailer(c);

  const reels = await invoke("list_reels", { creatorId: c.id });
  const box = $("reels");
  box.innerHTML = reels.length
    ? reels
        .map(
          (r) => `<div class="reel">
            <div class="reel-meta">
              <span>▶ ${compact(r.plays)}</span><span>♥ ${compact(r.likes)}</span>
              <span>💬 ${compact(r.comments)}</span><span>${esc(shortTime(r.taken_at))}</span>
            </div>
            <div class="reel-cap">${esc(r.caption) || "<em>no caption</em>"}</div>
            <a class="mail" href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.url)}</a>
          </div>`,
        )
        .join("")
    : '<p class="name">No reels stored for this creator.</p>';
}

// ── Firestore ───────────────────────────────────────────────────────────────

async function refreshFirebase() {
  try {
    const f = await invoke("firebase_status");
    el.fbDot.className = `dot ${f.connected ? "on" : "off"}`;
    el.fbTitle.textContent = f.connected
      ? `Firestore · ${f.projectId}`
      : "Firestore not configured";
    el.fbDetail.textContent = f.connected
      ? `key: ${f.keyPath}`
      : f.detail;
    el.fbRefresh.hidden = !f.connected;
    // Without a database there is nothing any other control can usefully do.
    el.runBtn.disabled = !f.connected || !!busy;
    el.exportBtn.disabled = !f.connected;
    return f.connected;
  } catch (err) {
    el.fbDot.className = "dot off";
    el.fbTitle.textContent = "Firestore unavailable";
    el.fbDetail.textContent = String(err);
    return false;
  }
}

// ── Gmail ───────────────────────────────────────────────────────────────────

/** Default outreach copy. Editable before every send. */
function draftEmail(c) {
  const name = (c.full_name || "").split(/\s+/)[0] || c.username;
  return {
    subject: `Partner with HireDue — for your audience, ${name}`,
    body: `Hi ${name},

I came across your Instagram (@${c.username}) and really liked how you talk about careers and job hunting — your audience is exactly who we built HireDue for.

We're starting a creator program for HireDue, an AI job-search agent that finds roles, tailors applications and applies on your behalf. We'd love to partner with you to share it with your followers.

What that looks like:
• Free lifetime access to HireDue for you
• Paid collaboration for a reel or story
• An affiliate link so you earn on every signup

If that sounds interesting, just reply and I'll send the details.

Best,
Sanglap
HireDue`,
  };
}

async function refreshGmail() {
  try {
    const g = await invoke("gmail_status");
    gmail = { connected: g.connected, email: g.email };
    el.gmDot.className = `dot ${g.connected ? "on" : "off"}`;
    el.gmTitle.textContent = g.connected
      ? `Gmail connected${g.email ? ` · ${g.email}` : ""}`
      : "Gmail not connected";
    el.gmConnectBtn.textContent = g.connected ? "Reconnect Gmail" : "Connect Gmail";
    const from = g.clientFile === "env" ? "GOOGLE_CLIENT_ID / _SECRET" : g.clientFile;
    el.gmDetail.textContent = g.detail
      ? g.detail
      : g.connected
        ? `sending as ${g.email} · client ${g.clientId}`
        : g.clientConfigured
          ? `Client ${g.clientId} from ${from}. Connect to authorise sending.`
          : `No OAuth credentials. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in scaledue/.env, or save the client JSON to:\n${g.clientFile}`;
    return g.connected;
  } catch (err) {
    el.gmDot.className = "dot off";
    el.gmTitle.textContent = "Gmail unavailable";
    el.gmDetail.textContent = String(err);
    return false;
  }
}

// ── connection ──────────────────────────────────────────────────────────────

/**
 * Both flows drive the same browser profile, so the backend allows only one at
 * a time. `busy` mirrors that here: "connect", "scrape", or null.
 */
function setBusy(kind) {
  busy = kind;
  if (kind) startReconcile();
  else stopReconcile();
  const connecting = kind === "connect";
  const scraping = kind === "scrape";

  el.connectBtn.disabled = !!kind;
  el.connectBtn.textContent = connecting ? "Waiting for sign-in…" : "Connect Instagram";
  el.cancelConnectBtn.hidden = !connecting;

  el.runBtn.disabled = !!kind;
  el.runBtn.textContent = scraping ? "Running…" : "Run scrape";
  el.cancelBtn.hidden = !scraping;
}

/**
 * Safety net for the busy state.
 *
 * The UI normally learns a flow finished from a backend event. If one is ever
 * missed the buttons would stay disabled forever, so poll the authoritative
 * answer — "is a job still holding the browser?" — and reconcile when it says
 * no. Cheap, and it means event delivery is no longer a single point of failure.
 */
let reconcileTimer = null;

function stopReconcile() {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
}

function startReconcile() {
  stopReconcile();
  reconcileTimer = setInterval(async () => {
    const job = await invoke("running_job").catch(() => undefined);
    if (job === undefined || job) return; // errored, or genuinely still running

    const wasConnecting = busy === "connect";
    setBusy(null); // clears the timer
    const connected = await refreshConnection();
    await refreshAll();

    if (wasConnecting) {
      appendLog("[scaledue] finished");
    } else {
      setRunning(false, connected ? "Finished" : "Finished — check the log", "done");
    }
  }, 2_500);
}

function paintConnection({ connected, username, detail, connectedAt }) {
  el.connDot.className = `dot ${connected ? "on" : "off"}`;
  el.connTitle.textContent = connected
    ? username
      ? `Connected as @${username}`
      : "Instagram connected"
    : "Instagram not connected";

  const bits = [];
  if (detail) bits.push(detail);
  if (connected && connectedAt) bits.push(`verified ${shortTime(connectedAt)}`);
  if (!connected) bits.push("Connect to open a browser window and sign in.");
  el.connDetail.textContent = bits.join(" · ");

  // A scrape without a session just fails, so steer toward connecting first.
  el.hint.hidden = connected;
}

async function refreshConnection() {
  try {
    const s = await invoke("session_status");
    paintConnection(s);
    return s.connected;
  } catch (err) {
    el.connDot.className = "dot off";
    el.connTitle.textContent = "Could not check session";
    el.connDetail.textContent = String(err);
    return false;
  }
}

async function connectInstagram() {
  el.logPanel.hidden = false;
  setBusy("connect");
  el.connDot.className = "dot busy";
  el.connTitle.textContent = "Opening browser…";
  el.connDetail.textContent = "Sign in to Instagram in the window that appears; it closes itself.";

  try {
    await invoke("connect_instagram", { timeoutSec: 240 });
  } catch (err) {
    setBusy(null);
    appendLog(`[scaledue] ${err}`);
    await refreshConnection();
  }
}

// ── editing / deleting one creator ──────────────────────────────────────────

/**
 * Wire up the drawer's contact editor and delete button for creator `c`.
 * Re-run on every drawer open, since the markup is rebuilt each time.
 */
function wireContactEditor(c) {
  const note = $("editNote");

  $("saveContact").addEventListener("click", async () => {
    const email = $("editEmail").value.trim();
    const phone = $("editPhone").value.trim();
    try {
      await invoke("update_contact", { creatorId: c.id, email, phone });
      note.textContent = email || phone ? "Saved." : "Cleared — using the scraped value.";
      note.className = "edit-note saved";
      await refreshCreators();
      // Keep the open drawer in step with what was just written.
      const fresh = creators.find((x) => x.id === c.id);
      if (fresh) Object.assign(c, fresh);
    } catch (err) {
      note.textContent = String(err);
      note.className = "edit-note error";
    }
  });

  // Deleting is irreversible, so make it a two-step click rather than a
  // confirm() dialog, which the webview renders inconsistently.
  const btn = $("deleteCreator");
  const deleteNote = $("deleteNote");
  let armed = false;
  let disarm;

  btn.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      btn.textContent = "Click again to confirm";
      deleteNote.textContent = `@${c.username} and its reels will be removed.`;
      deleteNote.className = "edit-note error";
      disarm = setTimeout(() => {
        armed = false;
        btn.textContent = "Delete creator";
        deleteNote.textContent = "";
      }, 4000);
      return;
    }
    clearTimeout(disarm);
    try {
      await invoke("delete_creator", { creatorId: c.id });
      el.drawer.hidden = true;
      await refreshAll();
    } catch (err) {
      deleteNote.textContent = String(err);
      armed = false;
      btn.textContent = "Delete creator";
    }
  });
}

/** Wire the drawer's send-email panel for creator `c`. */
function wireMailer(c) {
  const note = $("mailNote");
  const btn = $("sendMail");
  const to = $("mailTo");

  const explain = () => {
    if (!gmail.connected) {
      note.textContent = "Connect Gmail first.";
      note.className = "edit-note error";
      return false;
    }
    if (!to.value.trim()) {
      note.textContent = "No email address for this creator — add one under Contact.";
      note.className = "edit-note error";
      return false;
    }
    return true;
  };

  if (c.emailed_at) {
    note.textContent = `Already emailed ${shortTime(c.emailed_at)}.`;
    note.className = "edit-note";
  } else {
    explain();
  }

  let armed = false;
  let disarm;
  btn.addEventListener("click", async () => {
    if (!explain()) return;

    // Sending is irreversible and goes to a real person, so confirm first.
    if (!armed) {
      armed = true;
      btn.textContent = "Click again to send";
      note.textContent = `Will send from ${gmail.email} to ${to.value.trim()}.`;
      note.className = "edit-note";
      disarm = setTimeout(() => {
        armed = false;
        btn.textContent = "Send email";
      }, 5000);
      return;
    }
    clearTimeout(disarm);
    armed = false;

    btn.disabled = true;
    btn.textContent = "Sending…";
    note.textContent = "";
    try {
      const res = await invoke("send_email", {
        creatorId: c.id,
        request: {
          to: to.value.trim(),
          subject: $("mailSubject").value,
          body: $("mailBody").value,
          fromName: "Sanglap · HireDue",
        },
      });
      note.textContent = `Sent to ${res.to}.`;
      note.className = "edit-note saved";
      await refreshCreators();
      const fresh = creators.find((x) => x.id === c.id);
      if (fresh) Object.assign(c, fresh);
    } catch (err) {
      note.textContent = String(err);
      note.className = "edit-note error";
    } finally {
      btn.disabled = false;
      btn.textContent = "Send email";
    }
  });
}

// ── export ──────────────────────────────────────────────────────────────────

/**
 * Save the current view — same run filter and search as the table — to CSV.
 * Exporting what you're looking at is more useful than always dumping the
 * whole database, and "All runs" with an empty search is exactly that anyway.
 */
async function exportCsv() {
  if (!creators.length) return;

  const dialog = window.__TAURI__ && window.__TAURI__.dialog;
  const stamp = new Date().toISOString().slice(0, 10);
  const suggested = `scaledue-creators-${stamp}.csv`;

  let path;
  try {
    path = dialog
      ? await dialog.save({
          defaultPath: suggested,
          filters: [{ name: "CSV", extensions: ["csv"] }],
        })
      : null;
  } catch (err) {
    el.rowCount.textContent = `export failed: ${err}`;
    return;
  }
  if (!path) return; // cancelled

  const label = el.rowCount.textContent;
  el.exportBtn.disabled = true;
  el.exportBtn.textContent = "Saving…";
  try {
    const res = await invoke("export_csv", {
      runId: el.runFilter.value || null,
      search: el.search.value.trim() || null,
      path,
    });
    el.rowCount.textContent = `exported ${res.rows} rows`;
    setTimeout(() => (el.rowCount.textContent = label), 2500);
  } catch (err) {
    el.rowCount.textContent = `export failed: ${err}`;
  } finally {
    el.exportBtn.disabled = false;
    el.exportBtn.textContent = "Export CSV";
  }
}

// ── run control ─────────────────────────────────────────────────────────────

function setRunning(running, text, tone = "") {
  setBusy(running ? "scrape" : null);
  el.status.textContent = text;
  el.status.className = `status ${tone}`;
}

function appendLog(line) {
  const cls = /error|fatal|NOT LOGGED IN|failed/i.test(line)
    ? "err"
    : /warn|throttl|backing off/i.test(line)
      ? "warn"
      : /^──|^\[ig-scrape\]|^\s+page \d|RESULTS/.test(line)
        ? "hl"
        : "";
  const span = document.createElement("span");
  span.className = cls;
  span.textContent = `${line}\n`;
  el.log.appendChild(span);
  el.log.scrollTop = el.log.scrollHeight;
}

async function startScrape() {
  const keywords = el.keywords.value
    .split("\n")
    .map((k) => k.trim())
    .filter(Boolean);

  if (!keywords.length) {
    setRunning(false, "Add at least one keyword", "failed");
    return;
  }

  el.log.textContent = "";
  el.logPanel.hidden = false;
  setRunning(true, "Starting…", "running");

  try {
    const runId = await invoke("start_scrape", {
      config: {
        keywords,
        minFollowers: Number($("minFollowers").value) || 0,
        maxFollowers: Number($("maxFollowers").value) || 100000000,
        targetResolved: Number($("maxEnrich").value) || 200,
        maxSearchPagesPerKeyword: Number($("maxPages").value) || 4,
        requireRelevance: $("requireRelevance").checked,
        headless: $("headless").checked,
      },
    });
    appendLog(`[scaledue] run #${runId} started`);
  } catch (err) {
    setRunning(false, String(err), "failed");
    appendLog(`[scaledue] ${err}`);
  }
}

// ── wiring ──────────────────────────────────────────────────────────────────

el.keywords = $("keywords");
el.runBtn.addEventListener("click", startScrape);
el.cancelBtn.addEventListener("click", async () => {
  await invoke("cancel_job");
  setRunning(false, "Cancelled");
});
el.connectBtn.addEventListener("click", connectInstagram);
el.exportBtn.addEventListener("click", exportCsv);
el.deleteSelectedBtn.addEventListener("click", deleteSelected);
el.deleteAllBtn.addEventListener("click", deleteAll);
el.deleteUnresolvedBtn.addEventListener("click", deleteUnresolved);

el.tbody.addEventListener("change", async (e) => {
  const select = e.target.closest("select.status");
  if (!select) return;
  const id = select.dataset.statusFor;
  const previous = select.dataset.previous || "new";
  try {
    await invoke("set_status", { creatorId: id, status: select.value });
    select.className = `status s-${select.value}`;
    select.dataset.previous = select.value;
    const row = creators.find((c) => c.id === id);
    if (row) row.status = select.value;
  } catch (err) {
    // Put the control back where it was rather than showing a state we failed
    // to save.
    select.value = previous;
    el.rowCount.textContent = String(err);
    el.rowCount.className = "count error";
  }
});
el.selectAll.addEventListener("change", () => {
  // Select-all applies to what is currently shown, not the whole database.
  if (el.selectAll.checked) creators.forEach((c) => selected.add(c.id));
  else selected.clear();
  refreshCreators();
});

listen("bulk://progress", (e) => {
  const { done, total } = e.payload;
  el.rowCount.textContent = `deleting ${done}/${total}…`;
});
el.gmConnectBtn.addEventListener("click", async () => {
  el.gmDot.className = "dot busy";
  el.gmTitle.textContent = "Waiting for Google consent…";
  el.gmDetail.textContent = "A browser tab has opened — approve access there.";
  el.gmConnectBtn.disabled = true;
  el.logPanel.hidden = false;
  await invoke("connect_gmail", { timeoutSec: 180 }).catch((e) => appendLog(`[scaledue] ${e}`));
});

listen("gmail://status", async (e) => {
  const { running, stage, message } = e.payload;
  appendLog(`[gmail] ${stage}: ${message}`);
  if (running) return;
  el.gmConnectBtn.disabled = false;
  await refreshGmail();
});

el.fbRetry.addEventListener("click", async () => {
  el.fbDot.className = "dot busy";
  el.fbTitle.textContent = "Connecting…";
  await invoke("reconnect_firebase").catch(() => {});
  await refreshAll();
});
el.fbRefresh.addEventListener("click", async () => {
  // Picks up rows edited directly in the Firebase console.
  el.fbRefresh.disabled = true;
  el.fbRefresh.textContent = "Reloading…";
  try {
    const n = await invoke("refresh_from_cloud");
    el.fbDetail.textContent = `reloaded ${n} creators from Firestore`;
    await Promise.all([refreshStats(), refreshRuns()]);
    await refreshCreators();
  } catch (err) {
    el.fbDetail.textContent = String(err);
  } finally {
    el.fbRefresh.disabled = false;
    el.fbRefresh.textContent = "Reload from cloud";
  }
});
el.cancelConnectBtn.addEventListener("click", async () => {
  await invoke("cancel_job");
  setBusy(null);
  await refreshConnection();
});
el.clearLog.addEventListener("click", () => (el.log.textContent = ""));
el.toggleConfig.addEventListener("click", () => {
  const hidden = el.configBody.hidden;
  el.configBody.hidden = !hidden;
  el.toggleConfig.textContent = hidden ? "Hide" : "Show";
});
el.runFilter.addEventListener("change", refreshCreators);
el.qualifiedOnly.addEventListener("change", refreshCreators);

let searchTimer;
el.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refreshCreators, 180);
});

el.tbody.addEventListener("click", (e) => {
  // Opening a profile in the browser shouldn't also pop the detail drawer.
  if (e.target.closest('a[href^="http"]')) return;

  // The status dropdown handles its own events.
  if (e.target.closest("select.status")) return;

  // Ticking a row selects it; it must not also open the drawer.
  const pick = e.target.closest(".rowPick");
  if (pick) {
    const row = pick.closest("tr[data-id]");
    if (row) setRowSelected(row.dataset.id, pick.checked);
    return;
  }

  const copy = e.target.closest("[data-copy]");
  if (copy) {
    e.preventDefault();
    navigator.clipboard.writeText(copy.dataset.copy).catch(() => {});
    const original = copy.textContent;
    copy.textContent = "copied ✓";
    setTimeout(() => (copy.textContent = original), 1000);
    return;
  }
  const row = e.target.closest("tr[data-i]");
  if (row) openCreator(Number(row.dataset.i));
});

el.closeDrawer.addEventListener("click", () => (el.drawer.hidden = true));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") el.drawer.hidden = true;
});

listen("scrape://log", (e) => appendLog(e.payload));
listen("scrape://status", async (e) => {
  const { running, stage, message } = e.payload;
  if (running) {
    setRunning(true, message || "Running…", "running");
    return;
  }
  setRunning(false, message || stage, stage === "done" ? "done" : stage === "failed" ? "failed" : "");
  appendLog(`[scaledue] ${stage}: ${message}`);
  await refreshAll();
});

listen("connect://status", async (e) => {
  const { running, connected, stage, message, username } = e.payload;
  appendLog(`[scaledue] ${stage}: ${message}`);
  if (running) return;

  setBusy(null);
  if (connected) {
    paintConnection({ connected: true, username, detail: "", connectedAt: new Date().toISOString() });
  } else {
    await refreshConnection();
  }
});

(async () => {
  el.dbPath.textContent = await invoke("db_path").catch(() => "");

  // A flow may still be running from before a window reload.
  const job = await invoke("running_job").catch(() => null);
  if (job) {
    setBusy(job);
    el.logPanel.hidden = false;
    if (job === "scrape") setRunning(true, "Run in progress…", "running");
  }

  await refreshConnection();
  await refreshGmail();
  await refreshAll();
})();
