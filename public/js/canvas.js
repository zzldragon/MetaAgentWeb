// SVG canvas: draw the graph, drag nodes, draw links, pan and zoom.
//
// Hand-rolled rather than React Flow, and the trade is worth stating: this project has
// no build step and no dependencies, and keeping it that way means `npm start` is the
// whole setup. What that costs is the polish a mature canvas library gives free —
// minimap, snapping, edge routing around nodes. The renderer is isolated behind this
// file, so swapping it later touches nothing else.

import { edgeAllowed, kindMeta } from "./graph.js";
import { vivid, wash } from "./colour.js";
import { hasFlatLeftEdge, shapePath, textInset } from "./shapes.js";

const NODE_W = 132;
const NODE_H = 46;
const SVG_NS = "http://www.w3.org/2000/svg";

const el = (name, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

export class CanvasView {
  constructor(svg, handlers) {
    this.svg = svg;
    this.h = handlers;                       // { onSelect, onChange, onEdgeAttempt }
    this.gNodes = svg.querySelector("#nodes");
    this.gEdges = svg.querySelector("#edges");
    this.linkPath = svg.querySelector("#linking");
    this.viewport = svg.querySelector("#viewport");
    this.view = { x: 0, y: 0, k: 1 };
    this.selection = null;                   // {type:'node'|'edge', id|src,dst}
    this.graph = null;
    this.badIds = new Set();
    this.dragging = false;
    this.redrawPending = false;
    this.#wire();
  }

  setGraph(graph) { this.graph = graph; this.draw(); }

  /** Node ids the validator complained about, so they can be outlined. */
  setBad(ids) { this.badIds = new Set(ids); this.draw(); }

  /**
   * Change the selection WITHOUT rebuilding the canvas.
   *
   * This used to call `draw()`, which does `replaceChildren()` -- so selecting a node
   * destroyed the very element the caller was about to capture the pointer on, and
   * dragging silently did nothing. Selection is a class change; it has no business
   * re-creating the DOM, and not doing so is faster besides.
   */
  select(sel) {
    this.selection = sel;
    this.#applySelection();
    this.h.onSelect?.(sel);
  }

  #applySelection() {
    for (const g of this.gNodes.children) {
      g.classList.toggle(
        "sel", this.selection?.type === "node" && this.selection.id === g.dataset.id);
    }
    // Edges carry no state of their own, so redrawing just them is cheap and correct.
    this.gEdges.replaceChildren();
    for (const edge of this.graph?.edges ?? []) this.#drawEdge(edge);
  }

  // ── geometry ──────────────────────────────────────────────────────────────
  /** Screen point → graph coordinates. */
  toGraph(clientX, clientY) {
    const r = this.svg.getBoundingClientRect();
    return {
      x: (clientX - r.left - this.view.x) / this.view.k,
      y: (clientY - r.top - this.view.y) / this.view.k,
    };
  }

  #applyView() {
    this.viewport.setAttribute(
      "transform", `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`);
  }

  zoomBy(factor, cx, cy) {
    const k = Math.min(2.5, Math.max(0.25, this.view.k * factor));
    const r = this.svg.getBoundingClientRect();
    const px = (cx ?? r.width / 2);
    const py = (cy ?? r.height / 2);
    // Keep the point under the cursor fixed while scaling, so zoom feels anchored
    // rather than the whole graph sliding away from where you were looking.
    this.view.x = px - (px - this.view.x) * (k / this.view.k);
    this.view.y = py - (py - this.view.y) * (k / this.view.k);
    this.view.k = k;
    this.#applyView();
  }

  fit() {
    const nodes = this.graph?.nodes ?? [];
    if (nodes.length === 0) { this.view = { x: 0, y: 0, k: 1 }; this.#applyView(); return; }
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const minX = Math.min(...xs) - 40;
    const minY = Math.min(...ys) - 40;
    const maxX = Math.max(...xs) + NODE_W + 40;
    const maxY = Math.max(...ys) + NODE_H + 40;
    const r = this.svg.getBoundingClientRect();
    const k = Math.min(1.4, r.width / (maxX - minX), r.height / (maxY - minY));
    this.view.k = Math.max(0.25, k);
    this.view.x = (r.width - (maxX - minX) * this.view.k) / 2 - minX * this.view.k;
    this.view.y = (r.height - (maxY - minY) * this.view.k) / 2 - minY * this.view.k;
    this.#applyView();
  }

  // ── drawing ───────────────────────────────────────────────────────────────
  draw() {
    if (!this.graph) return;
    // A redraw mid-drag would replace the node under the pointer. `setBad()` is called
    // from a debounced validation, so it CAN land here while someone is dragging.
    if (this.dragging) { this.redrawPending = true; return; }
    this.gNodes.replaceChildren();
    this.gEdges.replaceChildren();
    for (const edge of this.graph.edges) this.#drawEdge(edge);
    for (const node of this.graph.nodes) this.#drawNode(node);
    document.getElementById("canvas-hint").hidden = this.graph.nodes.length > 0;
  }

  #port(node, side) {
    return { x: node.x + (side === "out" ? NODE_W : 0), y: node.y + NODE_H / 2 };
  }

  #curve(a, b) {
    // A horizontal-tangent bezier: the control offset grows with distance so short
    // links stay tight and long ones do not double back through their own node.
    const dx = Math.max(36, Math.abs(b.x - a.x) * 0.5);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  }

  #drawEdge(edge) {
    const src = this.graph.node(edge.src);
    const dst = this.graph.node(edge.dst);
    if (!src || !dst) return;                       // a dangling link draws nothing
    const d = this.#curve(this.#port(src, "out"), this.#port(dst, "in"));
    const selected = this.selection?.type === "edge"
      && this.selection.src === edge.src && this.selection.dst === edge.dst;

    // A 2px line is nearly impossible to click, so an invisible fat path sits under it
    // purely to catch the pointer.
    const hit = el("path", { d, class: "edge-hit" });
    hit.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      this.select({ type: "edge", src: edge.src, dst: edge.dst });
    });
    this.gEdges.append(hit, el("path", { d, class: `edge${selected ? " sel" : ""}` }));
  }

  #drawNode(node) {
    const meta = kindMeta(node.kind);
    const selected = this.selection?.type === "node" && this.selection.id === node.id;
    const bad = this.badIds.has(node.id) || this.badIds.has(node.name);
    const g = el("g", {
      class: `node${selected ? " sel" : ""}${bad ? " bad" : ""}`,
      transform: `translate(${node.x},${node.y})`,
    });
    g.dataset.id = node.id;

    // The silhouette carries the ROLE (a diamond decides, a cylinder stores); the fill
    // carries the exact kind. Both come from schema.json, so the browser and the desktop
    // canvas draw the same vocabulary.
    const shape = meta.shape ?? "rect";
    const outline = shapePath(shape, NODE_W, NODE_H);
    // The accent is DERIVED from the palette, not the palette itself: the raw pastels
    // are luminance ~0.79 and simply do not read as an outline. See colour.js.
    const accent = vivid(meta.color);
    g.append(el("path", { class: "body", d: outline, stroke: accent }));

    // A colour strip only reads as a strip against a straight left edge. On an angled
    // or curved one it would be a sliver poking outside the outline, so those kinds get
    // a pale wash of the same hue instead -- same information, no artefact.
    if (hasFlatLeftEdge(shape)) {
      g.append(el("rect", { class: "tag", x: 1.5, y: 1.5, width: 6,
                            height: NODE_H - 3, fill: accent }));
    } else {
      g.append(el("path", { class: "tint", d: outline, fill: wash(meta.color) }));
    }

    const inset = textInset(shape);
    // A diamond is widest at its waist, so its two label lines straddle the middle
    // rather than sitting where a rectangle's would.
    const centred = shape === "diamond";
    const nameY = centred ? NODE_H / 2 - 1 : 20;
    const kindY = centred ? NODE_H / 2 + 12 : 35;
    const cap = centred ? 12 : 17;

    const name = el("text", centred
      ? { x: NODE_W / 2, y: nameY, "text-anchor": "middle", class: "name" }
      : { x: inset, y: nameY, class: "name" });
    name.textContent = node.name.length > cap
      ? `${node.name.slice(0, cap - 1)}…` : node.name;

    const kind = el("text", centred
      ? { x: NODE_W / 2, y: kindY, class: "kind", "text-anchor": "middle" }
      : { x: inset, y: kindY, class: "kind" });
    // Inside a diamond the short tag ("if / else", "fan-out") reads better than the
    // full label, which is what the desktop canvas does too.
    kind.textContent = meta.tag ?? meta.label;
    g.append(name, kind);

    const inPort = el("circle", { class: "port", cx: 0, cy: NODE_H / 2, r: 5 });
    const outPort = el("circle", { class: "port", cx: NODE_W, cy: NODE_H / 2, r: 5 });
    g.append(inPort, outPort);

    outPort.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      this.#startLink(node, ev);
    });
    g.addEventListener("pointerdown", (ev) => this.#startDrag(node, g, ev));
    g.addEventListener("dblclick", () => this.h.onRename?.(node));

    this.gNodes.append(g);
  }

  // ── interaction ───────────────────────────────────────────────────────────
  #startDrag(node, g, ev) {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    this.select({ type: "node", id: node.id });
    const start = this.toGraph(ev.clientX, ev.clientY);
    const from = { x: node.x, y: node.y };
    let moved = false;
    this.dragging = true;
    g.classList.add("dragging");
    g.setPointerCapture(ev.pointerId);

    const move = (e) => {
      const p = this.toGraph(e.clientX, e.clientY);
      node.x = Math.round(from.x + (p.x - start.x));
      node.y = Math.round(from.y + (p.y - start.y));
      moved = true;
      g.setAttribute("transform", `translate(${node.x},${node.y})`);
      // Redraw only the links, so dragging stays cheap on a big graph.
      this.gEdges.replaceChildren();
      for (const edge of this.graph.edges) this.#drawEdge(edge);
    };
    const up = () => {
      this.dragging = false;
      try { g.releasePointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
      g.classList.remove("dragging");
      g.removeEventListener("pointermove", move);
      g.removeEventListener("pointerup", up);
      if (this.redrawPending) { this.redrawPending = false; this.draw(); }
      // Only a real move is worth an undo step and a re-validate; a click that happens
      // to jitter should not fill the history.
      if (moved) this.h.onChange?.({ reason: "move" });
    };
    g.addEventListener("pointermove", move);
    g.addEventListener("pointerup", up);
  }

  #startLink(src, ev) {
    const from = this.#port(src, "out");
    this.svg.setPointerCapture(ev.pointerId);

    const move = (e) => {
      const to = this.toGraph(e.clientX, e.clientY);
      this.linkPath.setAttribute("d", this.#curve(from, to));
      // Colour the trail by legality so the answer arrives before the drop, not after.
      const over = this.#nodeAt(to);
      const ok = over && !this.graph.edgeProblem(src.id, over.id);
      this.linkPath.style.stroke = over
        ? (ok ? "var(--ok)" : "var(--err)")
        : "var(--accent)";
    };
    const up = (e) => {
      this.svg.releasePointerCapture(ev.pointerId);
      this.svg.removeEventListener("pointermove", move);
      this.svg.removeEventListener("pointerup", up);
      this.linkPath.removeAttribute("d");
      this.linkPath.style.stroke = "";
      const target = this.#nodeAt(this.toGraph(e.clientX, e.clientY));
      if (target) this.h.onEdgeAttempt?.(src.id, target.id);
    };
    this.svg.addEventListener("pointermove", move);
    this.svg.addEventListener("pointerup", up);
  }

  #nodeAt({ x, y }) {
    // Reverse order: the last drawn node is on top, so it should win the hit test.
    for (let i = this.graph.nodes.length - 1; i >= 0; i -= 1) {
      const n = this.graph.nodes[i];
      if (x >= n.x && x <= n.x + NODE_W && y >= n.y && y <= n.y + NODE_H) return n;
    }
    return null;
  }

  #wire() {
    // Pan on empty canvas, or with the middle button anywhere.
    this.svg.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 && ev.button !== 1) return;
      this.select(null);
      const from = { x: ev.clientX, y: ev.clientY, vx: this.view.x, vy: this.view.y };
      const move = (e) => {
        this.view.x = from.vx + (e.clientX - from.x);
        this.view.y = from.vy + (e.clientY - from.y);
        this.#applyView();
      };
      const up = () => {
        this.svg.removeEventListener("pointermove", move);
        this.svg.removeEventListener("pointerup", up);
      };
      this.svg.addEventListener("pointermove", move);
      this.svg.addEventListener("pointerup", up);
    });

    this.svg.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const r = this.svg.getBoundingClientRect();
      this.zoomBy(ev.deltaY < 0 ? 1.12 : 1 / 1.12,
                  ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });

    // Drop from the palette.
    this.svg.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "copy";
    });
    this.svg.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const kind = ev.dataTransfer.getData("text/mta-kind");
      if (!kind) return;
      const p = this.toGraph(ev.clientX, ev.clientY);
      this.h.onDrop?.(kind, p.x - NODE_W / 2, p.y - NODE_H / 2);
    });
  }
}

export { NODE_W, NODE_H, edgeAllowed };
