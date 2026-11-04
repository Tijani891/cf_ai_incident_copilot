// Incident Copilot front end: plain JS, no build step.
const $ = (id) => document.getElementById(id);
const els = {
  messages: $("messages"), empty: $("empty"), form: $("composer"), input: $("input"), send: $("send"),
  sessionId: $("session-id"), newSession: $("new-session"),
  stack: $("stack"), saveStack: $("save-stack"), stackStatus: $("stack-status"),
  runTriage: $("run-triage"), triageStatus: $("triage-status"), steps: $("steps"),
  report: $("report"), reportBody: $("report-body"), copyPm: $("copy-pm"),
};

let sessionId = null;
let busy = false;
let latestPostmortem = "";

// ---------- helpers ----------

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function md(text) {
  if (window.marked && window.DOMPurify) {
    return DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }));
  }
  return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
}

function storage(op, key, value) {
  try {
    if (op === "get") return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* private mode: fall back to the URL hash only */ }
  return null;
}

async function api(path, options = {}) {
  const res = await fetch(`/api/sessions${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res;
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function addMessage(role, content, extraClass = "") {
  els.empty.hidden = true;
  const div = document.createElement("div");
  const isAlert = role === "user" && content.startsWith("[Alertmanager]");
  div.className = `msg ${role} ${isAlert ? "alert" : ""} ${extraClass}`.replace(/\s+/g, " ").trim();
  if (role === "assistant") div.innerHTML = md(content);
  else div.textContent = content;
  els.messages.appendChild(div);
  scrollToBottom();
  return div;
}

function setBusy(value) {
  busy = value;
  els.send.disabled = value;
  els.input.disabled = value;
}

// ---------- session lifecycle ----------

async function initSession() {
  const fromHash = location.hash.slice(1);
  const valid = (id) => /^[a-f0-9-]{36}$/.test(id || "");
  sessionId = valid(fromHash) ? fromHash : valid(storage("get", "sessionId")) ? storage("get", "sessionId") : null;

  if (!sessionId) {
    const { id } = await (await api("", { method: "POST" })).json();
    sessionId = id;
  }
  storage("set", "sessionId", sessionId);
  history.replaceState(null, "", `#${sessionId}`);
  els.sessionId.textContent = sessionId.slice(0, 8);
  els.sessionId.title = `Session ${sessionId} — bookmark this URL to come back to the incident`;

  const state = await (await api(`/${sessionId}`)).json();
  els.stack.value = state.stack || "";
  for (const m of state.messages) addMessage(m.role, m.content);

  const latest = state.reports[0];
  if (latest?.status === "complete") renderReport(latest.report);
  if (latest?.status === "running") pollTriage(latest.id);
}

els.newSession.addEventListener("click", async () => {
  if (busy) return;
  const { id } = await (await api("", { method: "POST" })).json();
  location.hash = id;
  location.reload();
});

// ---------- chat ----------

async function sendMessage(text) {
  if (busy || !text.trim()) return;
  setBusy(true);
  addMessage("user", text);
  const bubble = addMessage("assistant", "", "thinking");

  let reply = "";
  let frame = 0;
  try {
    const res = await api(`/${sessionId}/chat`, { method: "POST", body: JSON.stringify({ message: text }) });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      reply += decoder.decode(value, { stream: true });
      // Re-render markdown at most once per animation frame.
      if (!frame) frame = requestAnimationFrame(() => { bubble.innerHTML = md(reply); scrollToBottom(); frame = 0; });
    }
    if (frame) cancelAnimationFrame(frame);
    bubble.innerHTML = md(reply || "_No response from the model._");
  } catch (err) {
    bubble.classList.add("error");
    bubble.textContent = `Error: ${err.message}`;
  } finally {
    bubble.classList.remove("thinking");
    scrollToBottom();
    setBusy(false);
    els.input.focus();
  }
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value;
  els.input.value = "";
  sendMessage(text);
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.form.requestSubmit();
  }
});

for (const btn of document.querySelectorAll(".example")) {
  btn.addEventListener("click", () => sendMessage(btn.textContent));
}

// ---------- stack memory ----------

els.saveStack.addEventListener("click", async () => {
  els.stackStatus.className = "hint";
  els.stackStatus.textContent = "saving…";
  try {
    await api(`/${sessionId}/stack`, { method: "PUT", body: JSON.stringify({ stack: els.stack.value }) });
    els.stackStatus.className = "hint ok";
    els.stackStatus.textContent = "remembered";
  } catch (err) {
    els.stackStatus.className = "hint bad";
    els.stackStatus.textContent = err.message;
  }
});

// ---------- triage workflow ----------

function setSteps(state) {
  els.steps.className = `steps ${state}`;
}

els.runTriage.addEventListener("click", async () => {
  els.runTriage.disabled = true;
  els.triageStatus.className = "hint";
  els.triageStatus.textContent = "starting…";
  try {
    const { reportId } = await (await api(`/${sessionId}/triage`, { method: "POST" })).json();
    pollTriage(reportId);
  } catch (err) {
    els.triageStatus.className = "hint bad";
    els.triageStatus.textContent = err.message;
    els.runTriage.disabled = false;
  }
});

async function pollTriage(reportId) {
  els.runTriage.disabled = true;
  setSteps("running");
  const started = Date.now();
  while (Date.now() - started < 5 * 60_000) {
    try {
      const s = await (await api(`/${sessionId}/triage/${reportId}`)).json();
      els.triageStatus.textContent = s.workflowStatus;
      if (s.workflowStatus === "complete" && s.report) {
        setSteps("done");
        els.triageStatus.className = "hint ok";
        renderReport(s.report);
        break;
      }
      if (["errored", "terminated"].includes(s.workflowStatus)) {
        setSteps("failed");
        els.triageStatus.className = "hint bad";
        els.triageStatus.textContent = `failed: ${typeof s.error === "string" ? s.error : s.error?.message || "unknown"}`;
        break;
      }
    } catch (err) {
      els.triageStatus.textContent = `retrying… (${err.message})`;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  els.runTriage.disabled = false;
}

function renderReport(report) {
  if (!report) return;
  const { classification: c, analysis: a } = report;
  latestPostmortem = report.postmortem || "";

  const hyps = a.hypotheses.map((h) => `
    <div class="hyp ${escapeHtml(h.likelihood)}">
      <strong>${escapeHtml(h.cause)}</strong> <span class="hint">(${escapeHtml(h.likelihood)})</span>
      <div class="ev">${escapeHtml(h.evidence)}</div>
      ${h.checks.length ? `<pre>${h.checks.map(escapeHtml).join("\n")}</pre>` : ""}
    </div>`).join("");

  const mitigations = a.immediate_mitigations.length
    ? `<h3>Immediate mitigations</h3><ul>${a.immediate_mitigations.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul>`
    : "";

  els.reportBody.innerHTML = `
    <div><span class="sev ${escapeHtml(c.severity)}">${escapeHtml(c.severity)}</span> <strong>${escapeHtml(c.title)}</strong></div>
    <p class="hint">${escapeHtml(c.affected_components.join(", ") || "components unknown")} · ${escapeHtml(c.customer_impact)}</p>
    <h3>Hypotheses</h3>${hyps || "<p class='hint'>None yet: add more evidence in chat.</p>"}
    ${mitigations}
    <details><summary>Postmortem draft</summary><div class="pm">${md(latestPostmortem)}</div></details>`;
  els.report.hidden = false;
}

els.copyPm.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(latestPostmortem);
    els.copyPm.textContent = "Copied";
  } catch {
    els.copyPm.textContent = "Copy failed";
  }
  setTimeout(() => (els.copyPm.textContent = "Copy postmortem"), 1500);
});

initSession().catch((err) => addMessage("assistant", `Could not start a session: ${err.message}`, "error"));
