// The shared-state editor — the graph's `state_schema`.
//
// This was the web designer's biggest hole. `condition`, `while`, `setstate`, `foreach`
// and every agent's `reads`/`writes` all name fields from this list, so without a way to
// edit it, **graph mode was unbuildable in the browser**: you could drop an If/Else node
// but had nothing for it to branch on. (TradingAgents, for scale, declares 14 fields.)
//
// The REDUCER is the part worth getting right in the UI, because it is the part people
// get wrong. It decides what happens when two branches write the same field at once, and
// MetaAgent rejects concurrent writes to an `overwrite` field at generation time — an
// error that is baffling unless you knew the reducer existed. So each one carries a
// one-line explanation rather than sitting in a bare dropdown.

const REDUCER_HELP = {
  overwrite: "last write wins — NOT safe for two parallel branches",
  append: "list: add one item; str: concatenate",
  extend: "list: add every item of the written list",
  add: "numbers: sum the writes",
  max: "keep the largest",
  min: "keep the smallest",
  merge_shallow: "dict: merge top-level keys",
  merge_deep: "dict: merge recursively",
  upsert_by_key: "list of records: replace by a key, else append",
  custom: "your own reducer, named in the field",
};

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Render the editor into `host`.
 *
 * `fields` is mutated in place and `onChange` fires after every edit, so the caller
 * treats it exactly like a node's props.
 */
export function renderStateEditor(host, fields, schema, onChange) {
  host.replaceChildren();

  if (fields.length === 0) {
    host.append(el("div", "empty",
      "No shared state. Add a field to branch on, accumulate into, or pass between agents."));
  }

  fields.forEach((field, index) => {
    const card = el("div", "state-row");

    // Built-ins (user_input and friends) are supplied by the runtime. Showing them but
    // refusing edits is friendlier than hiding them: they are referenceable, and their
    // absence from the list reads as "I need to create user_input", which you do not.
    const builtin = Boolean(field.builtin);

    const top = el("div", "state-top");
    const name = document.createElement("input");
    name.type = "text";
    name.value = field.name ?? "";
    name.placeholder = "field_name";
    name.spellcheck = false;
    name.disabled = builtin;
    name.addEventListener("change", () => {
      field.name = name.value.trim();
      onChange();
    });

    const type = document.createElement("select");
    for (const t of schema.state.types) {
      type.append(new Option(t, t, false, (field.type ?? "str") === t));
    }
    type.disabled = builtin;
    type.addEventListener("change", () => { field.type = type.value; onChange(); });

    top.append(name, type);
    if (!builtin) {
      const remove = el("button", "tiny", "×");
      remove.title = "Remove this field";
      remove.addEventListener("click", () => {
        fields.splice(index, 1);
        renderStateEditor(host, fields, schema, onChange);
        onChange();
      });
      top.append(remove);
    } else {
      top.append(el("span", "why", "built in"));
    }
    card.append(top);

    const reducer = document.createElement("select");
    for (const r of schema.state.reducers) {
      reducer.append(new Option(r, r, false, (field.reducer ?? "overwrite") === r));
    }
    reducer.disabled = builtin;
    const why = el("div", "why", REDUCER_HELP[field.reducer ?? "overwrite"] ?? "");
    reducer.addEventListener("change", () => {
      field.reducer = reducer.value;
      why.textContent = REDUCER_HELP[reducer.value] ?? "";
      onChange();
    });
    card.append(reducer, why);

    if (!builtin) {
      const desc = document.createElement("input");
      desc.type = "text";
      desc.className = "desc";
      desc.placeholder = "what this field holds (shown to the agents)";
      desc.value = field.description ?? "";
      desc.addEventListener("change", () => {
        field.description = desc.value;
        onChange();
      });
      card.append(desc);
    } else if (field.description) {
      card.append(el("div", "why", field.description));
    }

    host.append(card);
  });

  const add = el("button", "", "+ Add field");
  add.addEventListener("click", () => {
    let n = fields.length + 1;
    while (fields.some((f) => f.name === `field_${n}`)) n += 1;
    fields.push({ name: `field_${n}`, type: "str", reducer: "overwrite",
                  default: "", description: "" });
    renderStateEditor(host, fields, schema, onChange);
    onChange();
  });
  host.append(add);

  const note = el("div", "why");
  note.innerHTML = "Two branches writing one <code>overwrite</code> field is rejected at "
    + "generation. Use <code>append</code>, <code>add</code>, <code>max</code> or "
    + "<code>min</code> for anything a fan-out touches.";
  host.append(note);
}
