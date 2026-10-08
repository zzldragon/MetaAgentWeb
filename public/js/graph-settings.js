// Graph-level settings: storage/persistence, and custom state types.
//
// Both are per-GRAPH rather than per-node, which is why they live in a dialog off the
// toolbar instead of the inspector — there is no node to select to reach them.
//
// Storage decides where chat sessions, checkpoints and ingested RAG chunks are kept.
// Type definitions let a shared-state field hold a RECORD rather than a scalar, which
// is the difference between passing a score around and passing a finding around.

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const field = (labelText, control, why) => {
  const wrap = el("div", "field");
  const label = el("label", null, labelText);
  wrap.append(label, control);
  if (why) {
    const note = el("div", "why");
    note.innerHTML = why;
    wrap.append(note);
  }
  return wrap;
};

const select = (options, current, onChange) => {
  const box = document.createElement("select");
  for (const [value, label] of options) {
    box.append(new Option(label, value, false, current === value));
  }
  box.addEventListener("change", () => onChange(box.value));
  return box;
};

const BACKENDS = [
  ["disk", "Local disk — JSON files (default)"],
  ["sqlite", "SQLite — one file, no extra dependency"],
  ["postgres", "PostgreSQL — psycopg, shared or remote"],
];

const RAG_STORES = [
  ["json", "JSON files — greppable (default)"],
  ["sqlite", "SQLite — indexed per-KB reads"],
  ["postgres", "PostgreSQL — shared with the DSN above"],
];

/**
 * Storage / persistence.
 *
 * `storage` is mutated in place; `onChange` fires per edit, matching how the node and
 * state editors behave. Keys are DELETED when set back to their default so a graph that
 * never touched storage still serialises byte-identically — MetaAgent's rule 8, which
 * only holds if every writer respects it.
 */
export function renderStorage(host, storage, onChange) {
  host.replaceChildren();

  const set = (key, value, fallback) => {
    if (value === fallback || value === "" || value === undefined) delete storage[key];
    else storage[key] = value;
    onChange();
    renderStorage(host, storage, onChange);        // some rows depend on the backend
  };

  const backend = (storage.backend ?? "disk").toLowerCase();
  host.append(field("Backend",
    select(BACKENDS, backend, (v) => set("backend", v, "disk")),
    "Where chat sessions and checkpoints are kept."));

  if (backend === "sqlite") {
    const input = document.createElement("input");
    input.type = "text";
    input.value = storage.sqlite_path ?? "memory.db";
    input.addEventListener("change", () => set("sqlite_path", input.value.trim(), "memory.db"));
    host.append(field("SQLite file", input));
  }

  if (backend === "postgres") {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "postgresql://user:pass@host:5432/db";
    input.value = storage.dsn ?? "";
    input.addEventListener("change", () => set("dsn", input.value.trim(), ""));
    host.append(field("Postgres DSN", input,
      "Blank reads <code>$DATABASE_URL</code> at run time — which is the safer habit, "
      + "since a DSN carries a password and a graph should not."));
  }

  host.append(field("Ingested RAG chunks",
    select(RAG_STORES, (storage.rag_chunk_store ?? "json").toLowerCase(),
           (v) => set("rag_chunk_store", v, "json")),
    "Uploads, agent writes and fetched pages. One store serves every knowledge base, "
    + "which is why it is a graph setting rather than a per-RAG one."));

  const check = (key, label, why) => {
    const row = el("div", "field row");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `st-${key}`;
    box.checked = Boolean(storage[key]);
    box.addEventListener("change", () => {
      if (box.checked) storage[key] = true; else delete storage[key];
      onChange();
    });
    const lbl = document.createElement("label");
    lbl.htmlFor = box.id;
    lbl.textContent = label;
    row.append(box, lbl);
    host.append(row);
    if (why) {
      const note = el("div", "why");
      note.innerHTML = why;
      host.append(note);
    }
  };

  check("checkpoint", "Crash recovery (resume an interrupted run)",
        "Saves progress after each stage so a graph-mode run can pick up where it "
        + "stopped. Needs shared state to resume into.");

  // These two are stored INVERTED relative to the checkbox: the graph records them only
  // when turned OFF, so a graph that never touched them stays byte-identical.
  const verbosity = (key, label) => {
    const row = el("div", "field row");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `st-${key}`;
    box.checked = storage[key] !== false;
    box.addEventListener("change", () => {
      if (box.checked) delete storage[key]; else storage[key] = false;
      onChange();
    });
    const lbl = document.createElement("label");
    lbl.htmlFor = box.id;
    lbl.textContent = label;
    row.append(box, lbl);
    host.append(row);
  };
  verbosity("show_step_markers", "Show step markers in run output");
  verbosity("show_trace_line", "Show the trace-file line in run output");
}

const MERGE_POLICIES = [
  ["merge_shallow", "merge top-level keys"],
  ["merge_deep", "merge recursively"],
  ["extend", "list: add every written item"],
  ["upsert_by_key", "list of records: replace by key, else append"],
  ["overwrite", "last write wins"],
  ["custom", "your own merge(old, new)"],
];

const BLANK_SCHEMA = { type: "object", properties: {} };

/**
 * Custom state types (`type_defs`).
 *
 * A named JSON-Schema record plus a merge policy. Once defined, a shared-state field can
 * be typed `Finding` or `list[Finding]` instead of `str`, and the schema is what drives
 * the agent's `set_state` tool — so the model emits a well-formed record rather than
 * prose you then have to parse.
 *
 * The schema is edited as raw JSON. A form-builder for JSON Schema is a project of its
 * own, and the people reaching for nested state types are comfortable with the notation.
 */
export function renderTypes(host, typeDefs, onChange) {
  host.replaceChildren();

  const names = Object.keys(typeDefs);
  if (names.length === 0) {
    host.append(el("div", "empty",
      "No custom types. Add one to give a state field a RECORD shape instead of a scalar."));
  }

  for (const name of names) {
    const def = typeDefs[name];
    const card = el("div", "state-row");

    const top = el("div", "state-top");
    const rename = document.createElement("input");
    rename.type = "text";
    rename.value = name;
    rename.spellcheck = false;
    rename.addEventListener("change", () => {
      const next = rename.value.trim();
      if (!next || next === name) { rename.value = name; return; }
      if (next in typeDefs) { rename.value = name; return; }   // no silent clobber
      // Rebuilt rather than mutated so the key ORDER survives a rename, which is what
      // makes the list stop jumping around while you edit it.
      const rebuilt = {};
      for (const key of Object.keys(typeDefs)) rebuilt[key === name ? next : key] = typeDefs[key];
      for (const key of Object.keys(typeDefs)) delete typeDefs[key];
      Object.assign(typeDefs, rebuilt);
      onChange();
      renderTypes(host, typeDefs, onChange);
    });
    const remove = el("button", "tiny", "×");
    remove.title = "Remove this type";
    remove.addEventListener("click", () => {
      delete typeDefs[name];
      onChange();
      renderTypes(host, typeDefs, onChange);
    });
    top.append(rename, remove);
    card.append(top);

    const desc = document.createElement("input");
    desc.type = "text";
    desc.className = "desc";
    desc.placeholder = "what one of these represents (shown to the agents)";
    desc.value = def.description ?? "";
    desc.addEventListener("change", () => { def.description = desc.value; onChange(); });
    card.append(desc);

    card.append(select(MERGE_POLICIES, def.merge ?? "merge_shallow", (v) => {
      def.merge = v;
      onChange();
      renderTypes(host, typeDefs, onChange);
    }));

    const schema = document.createElement("textarea");
    schema.spellcheck = false;
    schema.value = JSON.stringify(def.schema ?? BLANK_SCHEMA, null, 1);
    schema.addEventListener("change", () => {
      try {
        def.schema = JSON.parse(schema.value);
        schema.style.borderColor = "";
        onChange();
      } catch {
        schema.style.borderColor = "var(--err)";   // keep the text so it can be fixed
      }
    });
    card.append(schema);

    if ((def.merge ?? "") === "custom") {
      const src = document.createElement("textarea");
      src.spellcheck = false;
      src.placeholder = "def merge(old, new):\n    ...";
      src.value = def.merge_src ?? "";
      src.addEventListener("change", () => { def.merge_src = src.value; onChange(); });
      card.append(src);
    }

    host.append(card);
  }

  const add = el("button", "", "+ Add type");
  add.addEventListener("click", () => {
    let n = names.length + 1;
    while (`Type${n}` in typeDefs) n += 1;
    typeDefs[`Type${n}`] = { description: "", merge: "merge_shallow",
                             schema: structuredClone(BLANK_SCHEMA) };
    onChange();
    renderTypes(host, typeDefs, onChange);
  });
  host.append(add);

  const note = el("div", "why");
  note.innerHTML = "Use a type on a state field as <code>Finding</code> or "
    + "<code>list[Finding]</code>. The schema drives the agent's <code>set_state</code> "
    + "tool, so the model emits a well-formed record rather than prose.";
  host.append(note);
}
