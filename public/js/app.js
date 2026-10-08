// Wiring: palette, canvas, inspector, toolbar, and the debounced validation loop.

import { api, waitForJob } from "./api.js";
import { CanvasView } from "./canvas.js";
import { Graph, History, indexSchema, kindMeta, useSchema } from "./graph.js";
import { vivid } from "./colour.js";
import { renderEdge, renderEmpty, renderNode } from "./props.js";
import { renderStorage, renderTypes } from "./graph-settings.js";
import { renderStateEditor } from "./state-editor.js";

const $ = (id) => document.getElementById(id);

const state = {
  schema: null,
  graph: new Graph(),
  history: new History(),
  graphId: null,
  dirty: false,
  lastReport: null,
  toolFiles: [],
  run: { enabled: false, reason: "" },
};

let view = null;

// ── status ──────────────────────────────────────────────────────────────────
const say = (text) => { $("status").textContent = text; };

function refreshCounts() {
  const g = state.graph;
  $("counts").textContent =
    `${g.nodes.length} node${g.nodes.length === 1 ? "" : "s"}, ${g.edges.length} link${g.edges.length === 1 ? "" : "s"}`
    + (state.dirty ? " · unsaved" : "");
}

// ── validation ──────────────────────────────────────────────────────────────
let analyzeTimer = null;
let analyzeSeq = 0;

/**
 * Re-validate after edits settle.
 *
 * Debounced because `analyze` spawns Python, and sequence-guarded because a slow reply
 * must never overwrite a newer one — the panel would then describe a graph that is two
 * edits behind, which is worse than saying nothing.
 */
function scheduleAnalyze(delay = 450) {
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(async () => {
    if (state.graph.nodes.length === 0) { showReport(null); return; }
    const seq = ++analyzeSeq;
    try {
      const report = await api.analyze(state.graph.toJSON());
      if (seq === analyzeSeq) showReport(report);
    } catch (err) {
      if (seq === analyzeSeq) say(`validation unavailable: ${err.message}`);
    }
  }, delay);
}

function showReport(report) {
  state.lastReport = report;
  const host = $("tab-issues");
  const pill = $("issue-count");
  host.replaceChildren();

  if (!report) {
    $("mode").textContent = "—";
    pill.className = "pill";
    say("ready");
    renderEmptyIssues(host, "Add a node to start validating.");
    return;
  }

  $("mode").textContent = report.mode ?? "—";
  const errors = report.errors ?? [];
  const warnings = report.warnings ?? [];

  for (const text of errors) host.append(issue("err", text));
  for (const text of warnings) host.append(issue("warn", text));
  if (errors.length === 0 && warnings.length === 0) {
    host.append(issue("ok", `Valid — mode ${report.mode}, entry ${report.entry}.`));
  }

  pill.textContent = String(errors.length || warnings.length || "");
  pill.className = `pill${errors.length ? " on" : warnings.length ? " on warn" : ""}`;
  say(errors.length ? `${errors.length} error(s)` : "ready");

  // Outline the nodes named in an error. MetaAgent's messages quote names, so a
  // substring match is what is available — it is a hint, not a claim.
  const named = new Set();
  for (const node of state.graph.nodes) {
    if (errors.some((e) => e.includes(`'${node.name}'`) || e.includes(`"${node.name}"`))) {
      named.add(node.id);
    }
  }
  view.setBad(named);
  $("btn-generate").disabled = errors.length > 0;
}

function issue(level, text) {
  const d = document.createElement("div");
  d.className = `issue ${level}`;
  d.textContent = text;
  return d;
}

function renderEmptyIssues(host, message) {
  const d = document.createElement("div");
  d.className = "empty";
  d.textContent = message;
  host.append(d);
}

// ── edits ───────────────────────────────────────────────────────────────────
/** Every mutation goes through here: one place that snapshots, redraws and re-validates. */
function edit(mutate, { snapshot = true } = {}) {
  if (snapshot) state.history.push(state.graph);
  mutate();
  state.dirty = true;
  view.setGraph(state.graph);
  refreshCounts();
  scheduleAnalyze();
}

function selectionChanged(sel) {
  const host = $("tab-props");
  if (!sel) { renderEmpty(host, "Select a node or link."); return; }

  if (sel.type === "edge") {
    const edge = state.graph.edges.find((e) => e.src === sel.src && e.dst === sel.dst);
    if (!edge) return renderEmpty(host, "Select a node or link.");
    renderEdge(host, edge, state.graph, {
      onEdit: () => edit(() => {}, { snapshot: false }),
      onDelete: () => {
        edit(() => state.graph.removeEdge(edge.src, edge.dst));
        view.select(null);
      },
    });
    return;
  }

  const node = state.graph.node(sel.id);
  if (!node) return renderEmpty(host, "Select a node or link.");
  renderNode(host, node, state.schema, {
    onEdit: () => edit(() => {}, { snapshot: false }),
    onRename: (name) => {
      if (!name || name === node.name) return;
      if (state.graph.nodes.some((n) => n !== node && n.name === name)) {
        say(`another node is already called "${name}"`);
        selectionChanged(sel);
        return;
      }
      edit(() => { node.name = name; });
      view.select(sel);
    },
    onDelete: () => {
      edit(() => state.graph.removeNode(node.id));
      view.select(null);
    },
  }, state.toolFiles);
}

function drawState() {
  renderStateEditor($("tab-state"), state.graph.state_schema, state.schema, () => {
    state.dirty = true;
    refreshCounts();
    scheduleAnalyze();
  });
}

// ── palette ─────────────────────────────────────────────────────────────────
function buildPalette(filter = "") {
  const host = $("palette");
  host.replaceChildren();
  const needle = filter.trim().toLowerCase();

  for (const group of state.schema.palette) {
    const matches = group.kinds.filter((kind) => {
      if (!needle) return true;
      const meta = state.schema.kinds[kind];
      return kind.includes(needle) || meta.label.toLowerCase().includes(needle);
    });
    if (matches.length === 0) continue;

    const box = document.createElement("details");
    box.className = "group";
    // Searching opens everything; otherwise the first two groups, as on the desktop.
    box.open = Boolean(needle)
      || group.group === "Agents & flow" || group.group === "Resources";
    box.innerHTML = `<summary>${group.group}</summary>`;

    for (const kind of matches) {
      const meta = state.schema.kinds[kind];
      const chip = document.createElement("div");
      chip.className = "chip-node";
      chip.draggable = true;
      chip.title = kind;
      chip.innerHTML =
        `<span class="swatch" style="background:${vivid(meta.color)}"></span>`;
      chip.append(document.createTextNode(meta.label));
      chip.addEventListener("dragstart", (ev) => {
        ev.dataTransfer.setData("text/mta-kind", kind);
        ev.dataTransfer.effectAllowed = "copy";
      });
      // Click also works: dragging is not everyone's pointer, and a chip that only
      // responds to a drag looks broken to anyone who tried a click first.
      chip.addEventListener("dblclick", () => addNode(kind));
      box.append(chip);
    }
    host.append(box);
  }
}

function addNode(kind, x, y) {
  let node;
  edit(() => {
    // No drop point (a double-click in the palette): drop it under the last node so a
    // graph built entirely by clicking still comes out readable.
    const last = state.graph.nodes[state.graph.nodes.length - 1];
    node = state.graph.addNode(
      kind,
      x ?? (last ? last.x : 120),
      y ?? (last ? last.y + 80 : 120));
  });
  view.select({ type: "node", id: node.id });
}

// ── dialogs ─────────────────────────────────────────────────────────────────
// Whether the roomy dialogs open maximised. Remembered for the session: someone who
// maximises to read a run wants the next one maximised too, and re-clicking it every
// time is the kind of small friction that makes a tool feel unfinished.
const wideByDefault = { on: false };

function dialog(html) {
  const dlg = $("dlg");
  $("dlg-body").innerHTML = html;
  dlg.classList.remove("wide", "tall");
  dlg.showModal();
  return dlg;
}

/**
 * A dialog that can fill the screen.
 *
 * `tall` makes the body a flex column so the transcript (or the source listing) takes
 * the leftover height instead of a fixed 340px — maximising a window whose content
 * still ends a third of the way down is worse than not offering it.
 */
function wideDialog(titleHtml, bodyHtml) {
  const dlg = dialog(`
    <div class="dlg-head">
      <h3>${titleHtml}</h3>
      <button id="dlg-max" class="tiny" title="Maximise / restore (double-click the title)">
        ⤢</button>
    </div>
    ${bodyHtml}`);
  dlg.classList.add("tall");

  const toggle = () => {
    wideByDefault.on = !dlg.classList.contains("wide");
    dlg.classList.toggle("wide", wideByDefault.on);
  };
  dlg.querySelector("#dlg-max").onclick = toggle;
  dlg.querySelector(".dlg-head").ondblclick = (ev) => {
    if (ev.target.id !== "dlg-max") toggle();
  };
  if (wideByDefault.on) dlg.classList.add("wide");
  return dlg;
}

async function openGraphDialog() {
  const { graphs } = await api.listGraphs();
  const dlg = dialog(`<h3>Open a graph</h3>
    <div class="list" id="glist">${
      graphs.length === 0
        ? '<div class="empty">Nothing saved yet.</div>'
        : graphs.map((g) => `<div class="item" data-id="${g.id}">
             <b>${escapeHtml(g.name)}</b>
             <span class="when">${new Date(g.updatedAt).toLocaleString()}</span>
           </div>`).join("")
    }</div>
    <div class="row"><button value="cancel">Close</button></div>`);

  dlg.querySelector(".row button").onclick = () => dlg.close();
  for (const item of dlg.querySelectorAll(".item")) {
    item.onclick = async () => {
      const record = await api.getGraph(item.dataset.id);
      state.graph = new Graph(record.graph);
      state.graphId = record.id;
      state.dirty = false;
      $("graph-name").value = record.name;
      state.history = new History();
      view.setGraph(state.graph);
      view.fit();
      view.select(null);
      drawState();
      refreshCounts();
      scheduleAnalyze(0);
      dlg.close();
    };
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function generate() {
  const name = $("graph-name").value.trim() || "Agent";
  const dlg = dialog(`<h3>Generating ${escapeHtml(name)}</h3>
    <div id="gen-state">queued…</div>
    <div class="row"><button value="cancel">Close</button></div>`);
  dlg.querySelector(".row button").onclick = () => dlg.close();
  const line = dlg.querySelector("#gen-state");

  try {
    const { jobId } = await api.generate({
      graph: state.graph.toJSON(), name, target: $("target").value,
    });
    const job = await waitForJob(jobId, (j) => { line.textContent = `${j.state}…`; });

    if (job.state !== "done") {
      line.innerHTML = `<div class="issue err">${escapeHtml(job.error ?? job.state)}</div>`;
      return;
    }
    const r = job.result;
    if (!r.ok) {
      // A refusal is a considered answer — show the reason, not "failed".
      line.innerHTML = r.errors.map((e) => `<div class="issue err">${escapeHtml(e)}</div>`)
        .join("");
      return;
    }
    const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
    line.innerHTML = `
      <div class="issue ok">Generated ${r.files.length} files — mode <b>${r.mode}</b>.</div>
      ${r.warnings.map((w) => `<div class="issue warn">${escapeHtml(w)}</div>`).join("")}
      <p class="row" style="justify-content:flex-start">
        <a href="${api.downloadUrl(jobId)}" download>
          <button class="primary">Download ${escapeHtml(r.name)}.zip (${kb(r.zipBytes)})</button>
        </a>
        <button id="btn-code">Code…</button>
        <button id="btn-traces">History…</button>
        <button id="btn-run" ${state.run.enabled ? "" : "disabled"}
                title="${escapeHtml(state.run.reason ?? "Run the generated agent here")}">
          Run…
        </button>
      </p>
      ${state.run.enabled ? "" : `<div class="why">${escapeHtml(state.run.reason ?? "")}</div>`}`;
    const runBtn = dlg.querySelector("#btn-run");
    if (runBtn) runBtn.onclick = () => { dlg.close(); runDialog(jobId, r.name); };
    const codeBtn = dlg.querySelector("#btn-code");
    if (codeBtn) codeBtn.onclick = () => { dlg.close(); codeDialog(jobId, r); };
    const trBtn = dlg.querySelector("#btn-traces");
    if (trBtn) trBtn.onclick = () => { dlg.close(); tracesDialog(jobId, r.name); };
  } catch (err) {
    line.innerHTML = `<div class="issue err">${escapeHtml(err.message)}</div>`;
  }
}

/**
 * Read the generated source in the browser — the web counterpart of the desktop's
 * right-click "Check Code".
 *
 * Served straight from the finished job rather than the zip, so seeing what your graph
 * produced costs no download and no unpacking. Line numbers only, no syntax
 * highlighting: a highlighter is either a dependency or a bad regex, and neither is
 * worth it to skim emitted code.
 */
function codeDialog(jobId, result) {
  const files = (result.files ?? [])
    .filter((f) => /\.(py|ts|json|md|txt|bat)$/.test(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  const dlg = wideDialog(`${escapeHtml(result.name)} — generated source`, `
    <div class="field">
      <label for="code-pick">File</label>
      <select id="code-pick">${files.map((f) =>
        `<option value="${escapeHtml(f.path)}">${escapeHtml(f.path)} `
        + `(${(f.bytes / 1024).toFixed(1)} KB)</option>`).join("")}</select>
    </div>
    <pre id="code-out" class="runout code">loading…</pre>
    <div class="row"><button id="code-close">Close</button></div>`);

  const pick = dlg.querySelector("#code-pick");
  const out = dlg.querySelector("#code-out");
  dlg.querySelector("#code-close").onclick = () => dlg.close();

  const load = async () => {
    out.textContent = "loading…";
    try {
      const file = await api.file(jobId, pick.value);
      const lines = file.text.split("\n");
      const width = String(lines.length).length;
      out.textContent = lines
        .map((line, i) => `${String(i + 1).padStart(width, " ")}  ${line}`)
        .join("\n") + (file.truncated ? "\n\n… truncated" : "");
      out.scrollTop = 0;
    } catch (err) {
      out.textContent = `[error] ${err.message}`;
    }
  };
  pick.onchange = load;
  // agent.py is what anyone opens this for; make it the default when it is present.
  const main = files.find((f) => /^agent\.(py|ts)$/.test(f.path));
  if (main) pick.value = main.path;
  load();
}

/**
 * Run a generated agent and stream its output.
 *
 * Server-Sent Events rather than polling: a run prints as it thinks, and a view that
 * only updates every second reads as a hang. The stream replays what it has already
 * printed on connect, so opening this a moment late still shows the run from the start.
 */
function runDialog(jobId, name) {
  const dlg = wideDialog(`Run ${escapeHtml(name)}`, `
    <div class="field">
      <label for="run-task">Task</label>
      <input type="text" id="run-task" placeholder="what should the agent do?">
    </div>
    <pre id="run-out" class="runout" hidden></pre>
    <div class="row">
      <button id="run-stop" hidden class="reject">Stop</button>
      <button id="run-go" class="primary">Run</button>
      <button id="run-close">Close</button>
    </div>`);

  const task = dlg.querySelector("#run-task");
  const out = dlg.querySelector("#run-out");
  const go = dlg.querySelector("#run-go");
  const stopBtn = dlg.querySelector("#run-stop");
  let source = null;
  let runId = null;

  const append = (text) => {
    out.hidden = false;
    out.textContent += text;
    out.scrollTop = out.scrollHeight;   // follow the tail, like a terminal
  };

  const finish = () => {
    source?.close();
    source = null;
    go.disabled = false;
    stopBtn.hidden = true;
  };

  go.onclick = async () => {
    const text = task.value.trim();
    if (!text) { task.focus(); return; }
    go.disabled = true;
    stopBtn.hidden = false;
    out.textContent = "";
    try {
      const run = await api.run(jobId, text);
      runId = run.id;
      source = new EventSource(api.runStreamUrl(runId));
      source.addEventListener("output", (ev) => append(JSON.parse(ev.data)));
      source.addEventListener("done", (ev) => {
        const done = JSON.parse(ev.data);
        const code = done.exitCode === null || done.exitCode === undefined
          ? "" : ` — exit ${done.exitCode}`;
        append(`\n[${done.state}${code}]\n`);
        finish();
      });
      source.onerror = () => { append("\n[stream lost]\n"); finish(); };
    } catch (err) {
      append(`[error] ${err.message}\n`);
      finish();
    }
  };

  stopBtn.onclick = () => { if (runId) api.stopRun(runId).catch(() => {}); };
  dlg.querySelector("#run-close").onclick = () => {
    // Closing the window abandons the view, not the process; stop it explicitly so an
    // agent is never left running with nobody watching.
    if (runId && source) api.stopRun(runId).catch(() => {});
    finish();
    dlg.close();
  };
  task.focus();
}

/**
 * Graph-level settings: storage/persistence and custom state types.
 *
 * A dialog rather than an inspector tab because neither belongs to a node — there is
 * nothing to select to reach them, which is why the desktop puts them under a Graph
 * menu too.
 */
function settingsDialog() {
  const dlg = dialog(`<h3>Graph settings</h3>
    <div class="tabs" id="gs-tabs">
      <button class="tab on" data-gs="storage">Storage</button>
      <button class="tab" data-gs="types">Custom types</button>
    </div>
    <div id="gs-storage" class="gs-body"></div>
    <div id="gs-types" class="gs-body" hidden></div>
    <div class="row"><button id="gs-close" class="primary">Done</button></div>`);

  const touched = () => {
    state.dirty = true;
    refreshCounts();
    scheduleAnalyze();
  };
  renderStorage(dlg.querySelector("#gs-storage"), state.graph.storage, touched);
  renderTypes(dlg.querySelector("#gs-types"), state.graph.type_defs, touched);

  for (const tab of dlg.querySelectorAll("#gs-tabs .tab")) {
    tab.onclick = () => {
      for (const other of dlg.querySelectorAll("#gs-tabs .tab")) {
        other.classList.toggle("on", other === tab);
      }
      dlg.querySelector("#gs-storage").hidden = tab.dataset.gs !== "storage";
      dlg.querySelector("#gs-types").hidden = tab.dataset.gs !== "types";
    };
  }
  dlg.querySelector("#gs-close").onclick = () => dlg.close();
}

/** Absorb another .mta into the open graph. */
async function mergeMta(file) {
  say(`merging ${file.name}…`);
  try {
    const { graph } = await api.parseMta(await file.arrayBuffer());
    // Drop the incoming graph BELOW everything already here, so a merge never lands on
    // top of what you were looking at.
    const lowest = state.graph.nodes.reduce((y, n) => Math.max(y, n.y), 0);
    let info;
    edit(() => { info = state.graph.merge(graph, { dy: lowest + 140 }); });
    drawState();
    view.fit();
    const renamed = info.renamed.length
      ? ` — renamed ${info.renamed.map(([a, b]) => `${a}→${b}`).join(", ")}`
      : "";
    say(`merged ${info.nodes} node(s)${renamed}`);
  } catch (err) {
    say(`merge failed: ${err.message}`);
  }
}

/**
 * The design review.
 *
 * A different question from the Validation tab: that one asks whether a graph CAN
 * generate, this asks whether it is a sensible design — unbounded budgets, an
 * orchestrator with no caps, a fan-out writing an overwrite field. Deterministic only,
 * so it costs nothing and needs no key.
 */
async function reviewDialog() {
  const dlg = dialog(`<h3>Design review</h3>
    <div id="rev-body">reviewing…</div>
    <div class="row"><button id="rev-close">Close</button></div>`);
  dlg.querySelector("#rev-close").onclick = () => dlg.close();
  const body = dlg.querySelector("#rev-body");
  try {
    const report = await api.estimate(state.graph.toJSON());
    const findings = report.findings ?? [];
    if (report.errors?.length) {
      body.innerHTML = report.errors
        .map((e) => `<div class="issue err">${escapeHtml(e)}</div>`).join("");
      return;
    }
    if (findings.length === 0) {
      body.innerHTML = `<div class="issue ok">Nothing to flag.</div>`;
      return;
    }
    const rank = { error: 0, warn: 1, warning: 1, info: 2 };
    findings.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
    const cls = (s) => (s === "error" ? "err" : s === "info" ? "ok" : "warn");
    body.innerHTML = findings.map((f) => `
      <div class="issue ${cls(f.severity)}">
        <b>${escapeHtml(f.target)}</b> — ${escapeHtml(f.message)}
        ${f.detail ? `<div class="why">${escapeHtml(f.detail)}</div>` : ""}
      </div>`).join("");
  } catch (err) {
    body.innerHTML = `<div class="issue err">${escapeHtml(err.message)}</div>`;
  }
}

/** Run history: the JSONL trace a generated agent writes beside itself, per run. */
async function tracesDialog(jobId, name) {
  const dlg = wideDialog(`${escapeHtml(name)} — run history`, `
    <div id="tr-list" class="list">loading…</div>
    <pre id="tr-out" class="runout code" hidden></pre>
    <div class="row"><button id="tr-close">Close</button></div>`);
  dlg.querySelector("#tr-close").onclick = () => dlg.close();
  const list = dlg.querySelector("#tr-list");
  const out = dlg.querySelector("#tr-out");

  try {
    const { traces } = await api.traces(jobId);
    if (traces.length === 0) {
      list.innerHTML = `<div class="empty">No runs yet — traces appear here `
        + `once the agent has been run.</div>`;
      return;
    }
    list.replaceChildren();
    for (const trace of traces) {
      const item = document.createElement("div");
      item.className = "item";
      item.innerHTML = `<b>${escapeHtml(trace.name)}</b>`
        + `<span class="when">${new Date(trace.at).toLocaleString()} `
        + `· ${(trace.bytes / 1024).toFixed(1)} KB</span>`;
      item.onclick = async () => {
        out.hidden = false;
        out.textContent = "loading…";
        const file = await api.file(jobId, `traces/${trace.name}`);
        out.textContent = summariseTrace(file.text);
      };
      list.append(item);
    }
  } catch (err) {
    list.innerHTML = `<div class="issue err">${escapeHtml(err.message)}</div>`;
  }
}

/**
 * A trace as a readable timeline.
 *
 * Raw JSONL is unreadable at a glance and the interesting columns are always the same:
 * when, what, how long. Anything unrecognised is shown whole rather than dropped —
 * a trace format that grows should not silently lose its new events.
 */
function summariseTrace(text) {
  const lines = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let ev;
    try { ev = JSON.parse(raw); } catch { continue; }
    const at = `${String(ev.t ?? 0).padStart(8)}s`;
    const kind = String(ev.kind ?? "?").padEnd(14);
    const rest = Object.entries(ev)
      .filter(([k]) => k !== "t" && k !== "kind")
      .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 60) : JSON.stringify(v)}`)
      .join("  ");
    lines.push(`${at}  ${kind}${rest}`);
  }
  return lines.join("\n") || "(empty trace)";
}

async function save() {
  const name = $("graph-name").value.trim() || "Untitled";
  try {
    if (state.graphId) {
      await api.saveGraph(state.graphId, name, state.graph.toJSON());
    } else {
      const meta = await api.createGraph(name, state.graph.toJSON());
      state.graphId = meta.id;
    }
    state.dirty = false;
    refreshCounts();
    say("saved");
  } catch (err) {
    say(`save failed: ${err.message}`);
  }
}

async function importMta(file) {
  say(`importing ${file.name}…`);
  try {
    const bytes = await file.arrayBuffer();
    const name = file.name.replace(/\.mta$/i, "");
    const record = await api.uploadMta(name, bytes);
    state.graph = new Graph(record.graph ?? (await api.getGraph(record.id)).graph);
    state.graphId = record.id;
    state.dirty = false;
    $("graph-name").value = record.name;
    state.history = new History();
    view.setGraph(state.graph);
    view.fit();
    drawState();
    refreshCounts();
    showReport(record.report);
    say(`imported ${record.report?.tools_restored?.length ?? 0} tool file(s)`);
  } catch (err) {
    say(`import failed: ${err.message}`);
  }
}

// ── boot ────────────────────────────────────────────────────────────────────
async function main() {
  try {
    state.schema = indexSchema(await api.schema());
  } catch (err) {
    say(`could not load the node registry: ${err.message}`);
    return;
  }
  useSchema(state.schema);
  // The tool library, for the Tool node's file picker. Not fatal if it fails: the panel
  // says so and every other node still works.
  try {
    state.toolFiles = (await api.tools()).tools ?? [];
  } catch {
    state.toolFiles = [];
  }
  // Ask BEFORE offering a Run button, so a server with running disabled says why
  // instead of failing when the button is pressed.
  try {
    state.run = await api.runStatus();
  } catch {
    state.run = { enabled: false, reason: "run status unavailable" };
  }

  view = new CanvasView($("canvas"), {
    onSelect: selectionChanged,
    onChange: () => { state.dirty = true; refreshCounts(); scheduleAnalyze(); },
    onDrop: (kind, x, y) => addNode(kind, x, y),
    onEdgeAttempt: (srcId, dstId) => {
      const result = state.graph.addEdge(srcId, dstId);
      if (!result.ok) { say(result.reason); return; }
      edit(() => {});
      say("");
    },
  });
  view.setGraph(state.graph);

  buildPalette();
  drawState();
  renderEmpty($("tab-props"), "Select a node or link.");
  renderEmptyIssues($("tab-issues"), "Add a node to start validating.");
  refreshCounts();
  say("ready");

  $("palette-search").addEventListener("input", (e) => buildPalette(e.target.value));

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      for (const t of document.querySelectorAll(".tab")) t.classList.toggle("on", t === tab);
      for (const name of ["props", "state", "issues"]) {
        $(`tab-${name}`).hidden = tab.dataset.tab !== name;
      }
    });
  }

  $("btn-new").onclick = () => {
    if (state.dirty && !confirm("Discard unsaved changes?")) return;
    state.graph = new Graph();
    state.graphId = null;
    state.dirty = false;
    state.history = new History();
    $("graph-name").value = "Untitled";
    view.setGraph(state.graph);
    view.select(null);
    drawState();
    refreshCounts();
    showReport(null);
  };
  $("btn-open").onclick = () => openGraphDialog().catch((e) => say(e.message));
  $("btn-save").onclick = save;
  $("btn-settings").onclick = settingsDialog;
  $("btn-merge").onclick = () => $("file-merge").click();
  $("btn-review").onclick = reviewDialog;
  $("file-merge").onchange = (e) => {
    if (e.target.files[0]) mergeMta(e.target.files[0]);
    e.target.value = "";
  };
  $("btn-generate").onclick = generate;
  $("btn-upload").onclick = () => $("file-mta").click();
  $("file-mta").onchange = (e) => {
    if (e.target.files[0]) importMta(e.target.files[0]);
    e.target.value = "";
  };

  // Quick starts. Not templates in any grand sense -- just the two or three nodes you
  // would have dragged out anyway, already wired, so an empty canvas offers a first
  // move instead of only an instruction.
  const STARTS = {
    minimal: [["agent", 300, 150], ["llm", 80, 150]],
    tools: [["agent", 340, 150], ["llm", 80, 70], ["prompt", 80, 160], ["tool", 80, 250]],
  };
  for (const button of document.querySelectorAll("[data-start]")) {
    button.onclick = () => {
      const spec = STARTS[button.dataset.start];
      edit(() => {
        const made = spec.map(([kind, x, y]) => state.graph.addNode(kind, x, y));
        // Everything else feeds the agent, which is the shape of every one of these.
        const agent = made[0];
        for (const node of made.slice(1)) state.graph.addEdge(node.id, agent.id);
      });
      view.fit();
      view.select({ type: "node", id: state.graph.nodes[0].id });
    };
  }
  $("start-import").onclick = () => $("file-mta").click();

  $("zoom-in").onclick = () => view.zoomBy(1.2);
  $("zoom-out").onclick = () => view.zoomBy(1 / 1.2);
  $("zoom-fit").onclick = () => view.fit();

  document.addEventListener("keydown", (ev) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName);
    if (ev.ctrlKey && ev.key.toLowerCase() === "s") { ev.preventDefault(); save(); return; }
    if (typing) return;
    if (ev.ctrlKey && ev.key.toLowerCase() === "z") {
      const next = ev.shiftKey ? state.history.redo(state.graph)
                               : state.history.undo(state.graph);
      if (next) {
        state.graph = next;
        view.setGraph(state.graph);
        view.select(null);
        drawState();
        refreshCounts();
        scheduleAnalyze();
      }
      ev.preventDefault();
      return;
    }
    if ((ev.key === "Delete" || ev.key === "Backspace") && view.selection) {
      const sel = view.selection;
      edit(() => {
        if (sel.type === "node") state.graph.removeNode(sel.id);
        else state.graph.removeEdge(sel.src, sel.dst);
      });
      view.select(null);
      ev.preventDefault();
    }
  });

  window.addEventListener("beforeunload", (ev) => {
    if (state.dirty) { ev.preventDefault(); ev.returnValue = ""; }
  });
}

main();
