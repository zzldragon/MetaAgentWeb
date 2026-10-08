// Canvas interactions, driven through a minimal DOM.
//
// These exist because dragging a node did not work and nothing caught it. The cause was
// not in the drag code: `select()` called `draw()`, `draw()` calls `replaceChildren()`,
// and so selecting the node destroyed the element the drag had just captured the
// pointer on. Every unit of it was correct in isolation.
//
// So the tests here drive the real `CanvasView` with real pointer events and assert what
// happened to the MODEL — which is the only level at which that bug is visible.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { installDom, uninstallDom } from "./dom-stub.js";

const ROOT = path.dirname(import.meta.dirname);
const dom = installDom();

const model = await import("../public/js/graph.js");
const { CanvasView } = await import("../public/js/canvas.js");

model.useSchema(model.indexSchema(JSON.parse(
  fs.readFileSync(path.join(ROOT, "public", "schema.json"), "utf-8"))));

after(() => uninstallDom());

let graph: any;
let view: any;
let events: any[];

/** A canvas holding one agent and one llm, wired to record what it reports. */
function fresh() {
  graph = new model.Graph();
  events = [];
  view = new CanvasView(dom.svg, {
    onSelect: (sel: unknown) => events.push({ type: "select", sel }),
    onChange: (info: unknown) => events.push({ type: "change", info }),
    onDrop: (kind: string, x: number, y: number) => events.push({ type: "drop", kind, x, y }),
    onEdgeAttempt: (src: string, dst: string) => events.push({ type: "edge", src, dst }),
  });
  view.setGraph(graph);
}

const nodeEl = (id: string) => dom.nodes.children.find((g: any) => g.dataset.id === id);

/** Press, move, release — the sequence a real drag produces. */
function drag(el: any, from: { x: number; y: number }, to: { x: number; y: number }) {
  el.dispatch("pointerdown", { button: 0, pointerId: 1, clientX: from.x, clientY: from.y });
  el.dispatch("pointermove", { pointerId: 1, clientX: to.x, clientY: to.y });
  el.dispatch("pointerup", { pointerId: 1, clientX: to.x, clientY: to.y });
}

beforeEach(fresh);

describe("dragging a node", () => {
  it("moves it — the whole point, and it was broken", () => {
    const n = graph.addNode("agent", 100, 100);
    view.setGraph(graph);

    drag(nodeEl(n.id), { x: 100, y: 100 }, { x: 180, y: 150 });

    assert.equal(n.x, 180, "the node did not move horizontally");
    assert.equal(n.y, 150, "the node did not move vertically");
  });

  it("survives selecting it first", () => {
    // The regression itself: pointerdown selects, and selection used to rebuild the DOM
    // out from under the drag.
    const n = graph.addNode("agent", 0, 0);
    view.setGraph(graph);
    const el = nodeEl(n.id);

    el.dispatch("pointerdown", { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    assert.equal(view.selection.id, n.id, "pointerdown should select");
    assert.ok(dom.nodes.children.includes(el),
              "the element being dragged was removed from the canvas");

    el.dispatch("pointermove", { pointerId: 1, clientX: 60, clientY: 40 });
    assert.equal(n.x, 60);
  });

  it("reports a move once, and only when something actually moved", () => {
    const n = graph.addNode("agent", 0, 0);
    view.setGraph(graph);
    const el = nodeEl(n.id);

    el.dispatch("pointerdown", { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    el.dispatch("pointerup", { pointerId: 1, clientX: 0, clientY: 0 });
    assert.equal(events.filter((e) => e.type === "change").length, 0,
                 "a click that did not move should not become an undo step");

    drag(el, { x: 0, y: 0 }, { x: 30, y: 0 });
    assert.equal(events.filter((e) => e.type === "change").length, 1);
  });

  it("ignores the right mouse button", () => {
    const n = graph.addNode("agent", 10, 10);
    view.setGraph(graph);
    nodeEl(n.id).dispatch("pointerdown", { button: 2, clientX: 0, clientY: 0 });
    nodeEl(n.id).dispatch("pointermove", { clientX: 99, clientY: 99 });
    assert.equal(n.x, 10, "a right-click drag should not move the node");
  });

  it("is not disturbed by a validation landing mid-drag", () => {
    // `setBad` comes from a debounced analyze and can arrive at any moment. It calls
    // draw(); doing so mid-drag would replace the element under the pointer.
    const n = graph.addNode("agent", 0, 0);
    view.setGraph(graph);
    const el = nodeEl(n.id);

    el.dispatch("pointerdown", { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    view.setBad([n.id]);
    assert.ok(dom.nodes.children.includes(el), "a redraw stole the node mid-drag");

    el.dispatch("pointermove", { pointerId: 1, clientX: 45, clientY: 0 });
    assert.equal(n.x, 45);
    el.dispatch("pointerup", { pointerId: 1, clientX: 45, clientY: 0 });
    // ...and the deferred redraw still happens, so the marking is not lost.
    assert.ok(nodeEl(n.id).className.includes("bad"));
  });
});

describe("selection", () => {
  it("marks the selected node without rebuilding the canvas", () => {
    const a = graph.addNode("agent", 0, 0);
    const b = graph.addNode("agent", 200, 0);
    view.setGraph(graph);
    const before = dom.nodes.children.slice();

    view.select({ type: "node", id: a.id });
    assert.ok(nodeEl(a.id).className.includes("sel"));
    assert.ok(!nodeEl(b.id).className.includes("sel"));
    assert.deepEqual(dom.nodes.children, before, "selection re-created the node elements");

    view.select({ type: "node", id: b.id });
    assert.ok(!nodeEl(a.id).className.includes("sel"), "the old selection stayed marked");
    assert.ok(nodeEl(b.id).className.includes("sel"));
  });

  it("clears on an empty-canvas click", () => {
    graph.addNode("agent", 0, 0);
    view.setGraph(graph);
    view.select({ type: "node", id: graph.nodes[0].id });
    dom.svg.dispatch("pointerdown", { button: 0, clientX: 500, clientY: 500 });
    assert.equal(view.selection, null);
  });
});

describe("drawing a link", () => {
  const portOf = (id: string, which: 0 | 1) =>
    // the two circles are appended after the rects and the two text labels
    nodeEl(id).children.filter((c: any) => c.tagName === "circle")[which];

  it("reports a legal link when dropped on another node", () => {
    const a = graph.addNode("agent", 0, 0);
    const l = graph.addNode("llm", 300, 0);
    view.setGraph(graph);

    // from the llm's OUT port onto the agent's box
    portOf(l.id, 1).dispatch("pointerdown", { pointerId: 1, clientX: 432, clientY: 23 });
    dom.svg.dispatch("pointermove", { pointerId: 1, clientX: 60, clientY: 23 });
    dom.svg.dispatch("pointerup", { pointerId: 1, clientX: 60, clientY: 23 });

    const attempt = events.find((e) => e.type === "edge");
    assert.ok(attempt, "no link attempt was reported");
    assert.equal(attempt.src, l.id);
    assert.equal(attempt.dst, a.id);
  });

  it("reports nothing when dropped on empty canvas", () => {
    const l = graph.addNode("llm", 0, 0);
    view.setGraph(graph);
    portOf(l.id, 1).dispatch("pointerdown", { pointerId: 1, clientX: 132, clientY: 23 });
    dom.svg.dispatch("pointerup", { pointerId: 1, clientX: 800, clientY: 600 });
    assert.equal(events.find((e) => e.type === "edge"), undefined);
  });

  it("does not start a node drag when the port is grabbed", () => {
    // The port must swallow the event, or you would move the node while drawing a link.
    const l = graph.addNode("llm", 0, 0);
    view.setGraph(graph);
    portOf(l.id, 1).dispatch("pointerdown", { pointerId: 1, clientX: 132, clientY: 23 });
    dom.svg.dispatch("pointermove", { pointerId: 1, clientX: 400, clientY: 300 });
    assert.equal(l.x, 0, "the node moved while a link was being drawn");
  });
});

describe("the empty-canvas hint", () => {
  it("hides once there is a node, and comes back when there is not", () => {
    assert.equal(dom.hint.hidden, false);
    const n = graph.addNode("agent", 0, 0);
    view.setGraph(graph);
    assert.equal(dom.hint.hidden, true, "the hint stayed over a graph with a node in it");
    graph.removeNode(n.id);
    view.setGraph(graph);
    assert.equal(dom.hint.hidden, false);
  });
});
