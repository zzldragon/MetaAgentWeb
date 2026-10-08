// The property panel.
//
// Forms are BUILT FROM schema.json, not written per node kind. `default_props()` gives
// a default value and a widget hint inferred from its type, which is enough to edit all
// 33 kinds on day one — including any kind added to MetaAgent later, with no change
// here.
//
// What it deliberately does NOT reproduce is the desktop dialogs: 7,900 lines of Qt that
// know about enums, ranges, conditional visibility and per-field buttons (probe the
// embedding model, load a subgraph .mta). None of that is derivable from a default
// value, so this panel is plainer on purpose rather than by omission.
//
// `ENUMS` and `IMPORTANT` below are the one hand-maintained concession: the handful of
// fields where a free-text box would be actively misleading, and the handful worth
// showing before the other forty. Everything absent from them still renders — just
// generically, and below the fold.

import { kindMeta } from "./graph.js";

/**
 * Choices a text box cannot imply.
 *
 * Kept SHORT on purpose. This is the seam where a second copy of MetaAgent's config
 * table would start growing, and the moment it did it would begin to drift. Anything
 * not listed renders as text and still works; `ConfigTable.md` is the reference a user
 * reaches for.
 */
const ENUMS = {
  "agent.role": ["single", "planner", "worker", "critic", "supervisor", "orchestrator"],
  "agent.on_budget": ["continue", "stop", "retry", "ask"],
  "agent.history_strategy": ["summary_buffer", "window", "buffer"],
  "prompt.role": ["single", "planner", "worker", "critic", "supervisor", "orchestrator"],
  "llm.provider": ["siliconflow", "deepseek", "openai", "gemini", "nvidia", "anthropic",
                   "azure", "ollama", "groq", "together", "mistral", "zhipu", "moonshot"],
  "llm.response_format": ["text", "json_object", "json_schema"],
  "rag.retrieval_algorithm": ["bm25", "dense", "hybrid"],
  "rag.vector_db": ["memory", "qdrant", "chroma", "faiss", "pinecone", "pgvector"],
  "memory.retrieval": ["bm25", "dense", "hybrid"],
  "join.merge": ["concat", "first", "last", "state_only", "vote"],
  "hitl.on_reject": ["stop", "revise"],
  "workerpool.pool_strategy": ["parallel", "dag", "map_reduce", "reflect"],
  "schedule.mode": ["interval", "daily", "once"],
  "media.mode": ["image", "tts", "stt"],
  "guardrail.on_trip": ["redact", "block"],
  "code.language": ["python"],
  "mcp.describe_mode": ["server", "override", "strict"],
};

/** Shown first, before the long generic list — the fields you actually reach for. */
const IMPORTANT = {
  agent: ["role", "max_iterations", "max_wall_clock_s", "enable_todos", "spawn"],
  llm: ["provider", "model", "base_url", "api_key", "temperature"],
  prompt: ["role", "text"],
  tool: ["files"],
  rag: ["docs_dir", "description", "retrieval_algorithm", "vector_db", "top_k"],
  mcp: ["transport", "url", "allow_tools", "deny_tools", "describe_mode",
        "tool_descriptions"],
  memory: ["description", "top_k", "retrieval"],
  router: ["instructions", "default_route"],
  condition: ["branches"],
  while: ["condition", "body", "converge"],
  foreach: ["over", "body", "result_field", "max_parallel"],
  http: ["method", "url", "out_field", "headers", "body"],
  code: ["code", "in_fields", "out_field"],
  llmstep: ["provider", "model", "system", "prompt", "out_field"],
  template: ["template", "out_field"],
  setstate: ["assignments"],
  hitl: ["prompt", "on_reject"],
  join: ["merge"],
  fanout: ["max_parallel"],
  webserver: ["host", "port", "rest_enabled"],
  schedule: ["mode", "interval_seconds", "at"],
  guardrail: ["checks", "on_trip"],
  workerpool: ["pool_strategy", "max_workers"],
};

const div = (cls, html) => {
  const d = document.createElement("div");
  if (cls) d.className = cls;
  if (html !== undefined) d.innerHTML = html;
  return d;
};

/**
 * Render the editor for one node.
 *
 * `onEdit(name, value)` fires per change. Only values that DIFFER from the default are
 * stored on the node: the server fills the rest, so a graph stays small and a MetaAgent
 * default that changes later still reaches graphs nobody has touched.
 */
export function renderNode(host, node, schema, { onEdit, onRename, onDelete },
                           toolFiles = []) {
  host.replaceChildren();
  const kind = schema.kinds[node.kind];
  const props = kind.props;

  const head = div("field");
  head.innerHTML = `<label>Name</label>`;
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = node.name;
  nameInput.spellcheck = false;
  nameInput.addEventListener("change", () => onRename(nameInput.value.trim()));
  head.append(nameInput);
  head.append(div("why", `<code>${node.kind}</code> · ${kindMeta(node.kind).label}`));
  host.append(head);

  const listed = new Set(IMPORTANT[node.kind] ?? []);
  const primary = [...listed].filter((n) => n in props);
  const rest = Object.keys(props).filter((n) => !listed.has(n)).sort();

  for (const name of primary) {
    host.append(field(node, name, props[name], onEdit, toolFiles));
  }

  if (rest.length > 0) {
    const more = document.createElement("details");
    more.className = "section";
    more.innerHTML = `<summary>All settings (${rest.length})</summary>`;
    for (const name of rest) {
      more.append(field(node, name, props[name], onEdit, toolFiles));
    }
    host.append(more);
  }

  const del = document.createElement("button");
  del.textContent = "Delete node";
  del.style.marginTop = "12px";
  del.addEventListener("click", onDelete);
  host.append(del);
}

function field(node, name, spec, onEdit, toolFiles = []) {
  const key = `${node.kind}.${name}`;
  const current = node.props[name] !== undefined ? node.props[name] : spec.default;
  const wrap = div("field");
  const label = `<label for="p-${name}">${name}</label>`;

  const commit = (value) => {
    // Store only a real change. Writing every default back would bloat the graph and
    // freeze today's defaults into it.
    if (JSON.stringify(value) === JSON.stringify(spec.default)) delete node.props[name];
    else node.props[name] = value;
    onEdit(name, value);
  };

  if (spec.widget === "checkbox") {
    wrap.className = "field row";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `p-${name}`;
    box.checked = Boolean(current);
    box.addEventListener("change", () => commit(box.checked));
    wrap.append(box, Object.assign(document.createElement("label"),
                                   { htmlFor: `p-${name}`, textContent: name }));
    return wrap;
  }

  wrap.innerHTML = label;

  // The one enum that carries a security consequence, so it says so where it is set
  // rather than only in the docs.
  if (key === "mcp.describe_mode") {
    const sel = document.createElement("select");
    for (const option of ENUMS[key]) {
      sel.append(new Option(option, option, false, String(current) === option));
    }
    const note = div("why");
    const explain = {
      server: "The server writes the descriptions. They reach the model verbatim, in "
              + "the tool schema, <b>before any call is made</b> — a hostile server "
              + "can inject there.",
      override: "Your text replaces the tool description. <b>Parameter</b> docs still "
                + "come from the server, so this is a partial control.",
      strict: "Only tools you have described are exposed, and all server prose is "
              + "stripped. Nothing the server wrote reaches the model.",
    };
    const paint = () => { note.innerHTML = explain[sel.value] ?? ""; };
    sel.addEventListener("change", () => { commit(sel.value); paint(); });
    paint();
    wrap.append(sel, note);
    return wrap;
  }

  if (ENUMS[key]) {
    const sel = document.createElement("select");
    sel.id = `p-${name}`;
    for (const option of ENUMS[key]) {
      sel.append(new Option(option, option, false, String(current) === option));
    }
    sel.addEventListener("change", () => commit(sel.value));
    wrap.append(sel);
    return wrap;
  }

  if (spec.widget === "int" || spec.widget === "float") {
    const input = document.createElement("input");
    input.type = "number";
    input.id = `p-${name}`;
    if (spec.widget === "float") input.step = "any";
    input.value = String(current ?? 0);
    input.addEventListener("change", () => {
      const n = spec.widget === "int"
        ? Number.parseInt(input.value, 10) : Number.parseFloat(input.value);
      commit(Number.isFinite(n) ? n : spec.default);
    });
    wrap.append(input);
    // MetaAgent's convention, and not guessable from a `0` in a box.
    if (spec.default === 0) wrap.append(div("why", "0 = unlimited"));
    return wrap;
  }

  // A Tool node's `files` is the one list worth a real control: it names .py files that
  // must exist in MetaAgent's library, and a JSON box gives no way to discover them.
  // Getting it wrong used to fail deep in codegen with a bare FileNotFoundError.
  if (node.kind === "tool" && name === "files") {
    const chosen = new Set(Array.isArray(current) ? current : []);
    if (toolFiles.length === 0) {
      wrap.append(div("why", "No tool files found in MetaAgent's <code>tools/</code>."));
      return wrap;
    }
    const box = div("picker");
    for (const file of toolFiles) {
      const row = div("field row");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = `tf-${file.name}`;
      cb.checked = chosen.has(file.name);
      cb.addEventListener("change", () => {
        if (cb.checked) chosen.add(file.name); else chosen.delete(file.name);
        // Sorted, so the same selection always serialises the same way and a graph does
        // not show a spurious diff because two boxes were ticked in a different order.
        commit([...chosen].sort());
      });
      const lbl = document.createElement("label");
      lbl.htmlFor = cb.id;
      lbl.textContent = file.name;
      row.append(cb, lbl);
      box.append(row);
    }
    wrap.append(box);
    wrap.append(div("why", `${toolFiles.length} file(s) in MetaAgent's tools/ — `
                           + "every top-level <code>def</code> becomes a tool."));
    return wrap;
  }

  if (spec.widget === "list" || spec.widget === "object") {
    const area = document.createElement("textarea");
    area.id = `p-${name}`;
    area.spellcheck = false;
    area.value = JSON.stringify(current ?? spec.default, null, 1);
    area.addEventListener("change", () => {
      try {
        commit(JSON.parse(area.value));
        area.style.borderColor = "";
      } catch {
        // Keep the text so the typo can be fixed; refuse to store nonsense.
        area.style.borderColor = "var(--err)";
      }
    });
    wrap.append(area);
    wrap.append(div("why", "JSON"));
    return wrap;
  }

  // text — long values get a textarea, because a prompt in a one-line box is unusable
  const long = name === "text" || name === "code" || name === "template"
    || name === "instructions" || String(current ?? "").length > 60;
  const input = document.createElement(long ? "textarea" : "input");
  input.id = `p-${name}`;
  input.spellcheck = false;
  if (!long) input.type = spec.secret ? "password" : "text";
  input.value = String(current ?? "");
  input.addEventListener("change", () => commit(input.value));
  wrap.append(input);

  if (spec.secret) {
    // Rule 10, said where it will be read. The server refuses a graph with a literal
    // key anyway; saying so here means finding out before you press Generate.
    wrap.append(div("why",
      "Leave blank — the end user fills this in. <code>${ENV_VAR}</code> to carry it."));
  }
  return wrap;
}

/** The empty state, and the edge editor, share this panel. */
export function renderEmpty(host, message) {
  host.replaceChildren(div("empty", message));
}

export function renderEdge(host, edge, graph, { onEdit, onDelete }) {
  host.replaceChildren();
  const src = graph.node(edge.src);
  const dst = graph.node(edge.dst);
  if (!src || !dst) return;

  host.append(div("field",
    `<label>Link</label><b>${src.name}</b> → <b>${dst.name}</b>`));
  host.append(div("why", `<code>${src.kind}</code> → <code>${dst.kind}</code>`));

  const commit = () => onEdit();

  // Several LLMs on one agent are a FAILOVER CHAIN, and the order lives on the LINK, not
  // the LLM node -- so the same model can be primary for one agent and a fallback for
  // another. `priority` appears 41 times across the shipped graphs; leaving it
  // uneditable made a whole MetaAgent feature unreachable from the browser.
  if (src.kind === "llm" && dst.kind === "agent") {
    const wrap = div("field");
    wrap.innerHTML = "<label for=\"e-priority\">Fallback priority</label>";
    const input = document.createElement("input");
    input.type = "number";
    input.id = "e-priority";
    input.min = "0";
    input.value = String(edge.props.priority ?? 0);
    input.addEventListener("change", () => {
      const n = Number.parseInt(input.value, 10);
      // A priority of 1 is STORED, not dropped as "the default". Absent is not the same
      // as 1: codegen sorts unset links to the END of the chain
      // (`(priority or 0) or Infinity`), so deleting a 1 would quietly demote the very
      // link the user just made primary. Only 0 clears it.
      if (Number.isFinite(n) && n > 0) edge.props.priority = n;
      else delete edge.props.priority;
      commit();
    });
    wrap.append(input);
    wrap.append(div("why",
      "1 = primary, then 2, 3… tried in order when the one before it errors. "
      + "<b>0 = unset</b>, and unset links come <i>after</i> every numbered one, in the "
      + "order you drew them."));
    host.append(wrap);
  }

  // An agent-to-agent link can carry a data-handoff contract, injected into BOTH
  // prompts: what the upstream must produce, what the downstream will receive.
  const stages = new Set(["agent", "workerpool", "router"]);
  if (stages.has(src.kind) && stages.has(dst.kind)) {
    const wrap = div("field");
    wrap.innerHTML = "<label for=\"e-contract\">Handoff contract</label>";
    const area = document.createElement("textarea");
    area.id = "e-contract";
    area.spellcheck = false;
    area.placeholder = "what this stage must hand the next one";
    area.value = edge.props.contract ?? "";
    area.addEventListener("change", () => {
      const text = area.value.trim();
      if (text) edge.props.contract = text;
      else delete edge.props.contract;
      commit();
    });
    wrap.append(area);
    wrap.append(div("why",
      "Written into both agents' prompts — the upstream is told to produce it, "
      + "the downstream to expect it."));
    host.append(wrap);

    const enforce = div("field row");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = "e-enforce";
    box.checked = Boolean(edge.props.contract_enforce);
    box.addEventListener("change", () => {
      if (box.checked) edge.props.contract_enforce = true;
      else delete edge.props.contract_enforce;
      commit();
    });
    const lbl = document.createElement("label");
    lbl.htmlFor = "e-enforce";
    lbl.textContent = "Check it, and retry the stage if unmet";
    enforce.append(box, lbl);
    host.append(enforce);
  }

  const del = document.createElement("button");
  del.textContent = "Delete link";
  del.style.marginTop = "12px";
  del.addEventListener("click", onDelete);
  host.append(del);
}
