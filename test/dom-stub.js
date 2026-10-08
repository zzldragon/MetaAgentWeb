// A DOM small enough to drive CanvasView, and no larger.
//
// Written instead of pulling in jsdom because the goal is narrow: exercise the pointer
// interactions — drag a node, draw a link — and assert what they did to the model.
// jsdom would be this project's first dependency and would bring a browser's worth of
// surface to test three event handlers.
//
// It exists because of a real bug: `select()` called `draw()`, which does
// `replaceChildren()`, so selecting a node destroyed the element the drag had just
// captured the pointer on. Dragging silently did nothing, and nothing in the suite
// noticed. This stub is the thing that would have.

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...names) { for (const n of names) this.set.add(n); this.#sync(); }
  remove(...names) { for (const n of names) this.set.delete(n); this.#sync(); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name); else this.set.delete(name);
    this.#sync();
    return on;
  }
  #sync() { this.el.attributes.class = [...this.set].join(" "); }
}

class El {
  constructor(tag) {
    this.tagName = tag;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.parent = null;
    this.textContent = "";
    this.hidden = false;
    this.listeners = new Map();
    this.classList = new ClassList(this);
    this.captured = null;
  }

  get className() { return this.attributes.class ?? ""; }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "class") {
      this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean));
    }
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }

  append(...nodes) {
    for (const n of nodes) { n.parent = this; this.children.push(n); }
  }
  replaceChildren(...nodes) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...nodes);
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }

  /** Fire an event on this element, then bubble unless the handler stopped it. */
  dispatch(type, event = {}) {
    const ev = {
      type, button: 0, pointerId: 1, clientX: 0, clientY: 0,
      stopPropagation() { ev._stopped = true; },
      preventDefault() { ev._prevented = true; },
      ...event,
    };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
    if (!ev._stopped && this.parent) this.parent.dispatch(type, { ...event, ...ev });
    return ev;
  }

  /** Is this element still attached to the tree the document renders? */
  get isConnected() {
    let node = this;
    while (node.parent) node = node.parent;
    return node._isRoot === true;
  }

  setPointerCapture(id) {
    // A real browser throws InvalidStateError here when the element is no longer in the
    // document, and that is EXACTLY how the drag bug presented: `select()` had already
    // replaced this element, the throw escaped the pointerdown handler, and the
    // pointermove listener was never attached — so the node simply did not move.
    // Modelling the throw is what makes the drag test able to fail.
    if (!this.isConnected) {
      const err = new Error("setPointerCapture on a detached element");
      err.name = "InvalidStateError";
      throw err;
    }
    this.captured = id;
  }
  releasePointerCapture() { this.captured = null; }

  // The canvas only ever asks for its own box, and only to convert screen -> graph
  // coordinates. A fixed origin keeps that arithmetic honest and predictable.
  getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 700 }; }

  querySelector(selector) {
    const id = selector.startsWith("#") ? selector.slice(1) : null;
    const walk = (node) => {
      if (id && node.attributes.id === id) return node;
      for (const child of node.children) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }
}

/** Install a global `document` sufficient for CanvasView. Returns the svg root. */
export function installDom() {
  const byId = new Map();
  const make = (tag, id) => {
    const e = new El(tag);
    if (id) { e.setAttribute("id", id); byId.set(id, e); }
    return e;
  };

  const svg = make("svg", "canvas");
  svg._isRoot = true;
  const viewport = make("g", "viewport");
  const edges = make("g", "edges");
  const nodes = make("g", "nodes");
  const linking = make("path", "linking");
  viewport.append(edges, nodes, linking);
  svg.append(viewport);
  byId.set("canvas-hint", make("div", "canvas-hint"));

  globalThis.document = {
    createElementNS: (_ns, tag) => new El(tag),
    createElement: (tag) => new El(tag),
    getElementById: (id) => byId.get(id) ?? null,
  };
  return { svg, nodes, edges, linking, hint: byId.get("canvas-hint") };
}

export function uninstallDom() {
  delete globalThis.document;
}
