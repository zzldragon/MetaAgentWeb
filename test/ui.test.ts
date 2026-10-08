// The front end's model layer, and that the page it needs is actually served.
//
// `graph.js` deliberately has no DOM dependency — the rules about what a graph is and
// which links are legal live there, and that is the part worth testing. The rendering
// in `canvas.js` and `props.js` needs a browser and is not simulated here; a jsdom
// would be the project's first dependency, to test drawing code that a glance at the
// screen checks better.
//
// What IS covered mechanically is the thing a glance cannot check: that the rules the
// browser enforces are MetaAgent's own, read from the exported schema rather than
// restated in JavaScript.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

process.env.MTA_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "mtaweb-ui-"));

const { createApp } = await import("../src/app.ts");
const { CONFIG } = await import("../src/config.ts");
const model = await import("../public/js/graph.js");

const schema = model.indexSchema(
  JSON.parse(fs.readFileSync(path.join(CONFIG.publicDir, "schema.json"), "utf-8")));
model.useSchema(schema);

const app = createApp({ quiet: true });
let base = "";

before(async () => {
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await app.close();
  fs.rmSync(process.env.MTA_DATA!, { recursive: true, force: true });
});

describe("the page is served", () => {
  it("serves index.html at the root", async () => {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /<svg id="canvas"/);
    assert.match(html, /type="module" src="\/js\/app\.js"/);
  });

  it("serves every asset the page asks for, with the right type", async () => {
    const html = await (await fetch(base + "/")).text();
    const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]!);
    assert.ok(refs.length >= 2, "the page should reference css and js");
    for (const ref of refs) {
      const res = await fetch(base + ref);
      assert.equal(res.status, 200, `${ref} did not load`);
      const type = res.headers.get("content-type") ?? "";
      if (ref.endsWith(".js")) assert.match(type, /javascript/, ref);
      if (ref.endsWith(".css")) assert.match(type, /text\/css/, ref);
    }
  });

  it("serves every module the front end imports", async () => {
    // A missing import is a blank page with an error only the console sees.
    const jsDir = path.join(CONFIG.publicDir, "js");
    for (const file of fs.readdirSync(jsDir)) {
      const source = fs.readFileSync(path.join(jsDir, file), "utf-8");
      for (const m of source.matchAll(/from "\.\/([^"]+)"/g)) {
        const res = await fetch(`${base}/js/${m[1]}`);
        assert.equal(res.status, 200, `${file} imports missing ./${m[1]}`);
      }
    }
  });
});

describe("the [hidden] override", () => {
  it("is present, because the browser's own rule is not strong enough", () => {
    // `hidden` is a USER-AGENT rule (`display: none`), so any author rule that sets
    // `display` beats it on cascade origin alone. `.hint` sets `display: grid`, and the
    // "drag a node to begin" overlay sat on top of a canvas with five nodes on it.
    //
    // Asserting the CSS text is a blunt test, but the alternative is a browser, and the
    // realistic regression is somebody tidying this rule away as redundant. It is not.
    const css = fs.readFileSync(path.join(CONFIG.publicDir, "css", "style.css"), "utf-8");
    assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
                 "the global [hidden] override is gone");
  });

  it("covers everything the UI toggles with `hidden`", () => {
    // Every element the front end hides this way relies on that one rule.
    const html = fs.readFileSync(path.join(CONFIG.publicDir, "index.html"), "utf-8");
    const js = fs.readFileSync(path.join(CONFIG.publicDir, "js", "app.js"), "utf-8")
      + fs.readFileSync(path.join(CONFIG.publicDir, "js", "canvas.js"), "utf-8");
    assert.ok(/hidden/.test(html) || /\.hidden\s*=/.test(js),
              "nothing uses `hidden` any more — this rule and its tests can go");
  });
});

describe("maximisable dialogs", () => {
  const app = fs.readFileSync(path.join(CONFIG.publicDir, "js", "app.js"), "utf-8");
  const css = fs.readFileSync(path.join(CONFIG.publicDir, "css", "style.css"), "utf-8");

  it("uses the roomy shell for everything you read at length", () => {
    // The three that show a transcript, a source file or a timeline. A fixed 640px box
    // is the wrong container for all of them, and the realistic regression is a fourth
    // being added with plain `dialog(` out of habit.
    //
    // Matched by FUNCTION BODY, not by a phrase from the title: the first version
    // searched for "generated source" and hit the doc comment above the function, which
    // failed for a reason that had nothing to do with the code.
    for (const fn of ["runDialog", "codeDialog", "tracesDialog"]) {
      const at = app.indexOf(`function ${fn}(`);
      assert.ok(at > 0, `${fn} is missing`);
      const body = app.slice(at, at + 700);
      assert.match(body, /wideDialog\(/, `${fn} does not use wideDialog`);
    }
  });

  it("lets the transcript take the leftover height when maximised", () => {
    // Maximising a window whose content still stops a third of the way down is worse
    // than not offering it, so `.tall` has to release the fixed max-height.
    assert.match(css, /dialog\.tall\s+\.runout\s*\{[^}]*max-height:\s*none/,
                 ".tall does not release .runout's fixed height");
    assert.match(css, /dialog\.tall\s+#dlg-body\s*\{[^}]*flex:\s*1/);
  });

  it("re-centres itself when resized", () => {
    // A <dialog> centres from its NATURAL size, so one resized after opening drifts.
    assert.match(css, /dialog\.wide\s*\{[^}]*inset:/,
                 "a maximised dialog would sit off-centre");
  });

  it("remembers the choice for the session", () => {
    assert.match(app, /wideByDefault/,
                 "maximising should stick, not need re-clicking every time");
  });
});

describe("the graph model", () => {
  it("enforces MetaAgent's own edge rules, not a copy of them", () => {
    // These come from ALLOWED_EDGES via schema.json. If the export changed shape, the
    // browser would silently allow everything — so assert both directions.
    assert.equal(model.edgeAllowed("llm", "agent"), true);
    assert.equal(model.edgeAllowed("agent", "llm"), false, "resources feed agents, not back");
    assert.equal(model.edgeAllowed("agent", "agent"), true);
    assert.equal(model.edgeAllowed("gui", "agent"), true);
    assert.equal(model.edgeAllowed("agent", "gui"), false);
  });

  it("explains a refused link in the node's own words", () => {
    const g = new model.Graph();
    const a = g.addNode("agent", 0, 0);
    const l = g.addNode("llm", 200, 0);
    const bad = g.addEdge(a.id, l.id);
    assert.equal(bad.ok, false);
    assert.match(bad.reason!, /Agent cannot link to LLM/);
  });

  it("refuses a self-link and a duplicate", () => {
    const g = new model.Graph();
    const a = g.addNode("agent", 0, 0);
    const b = g.addNode("agent", 200, 0);
    assert.match(g.addEdge(a.id, a.id).reason!, /itself/);
    assert.equal(g.addEdge(a.id, b.id).ok, true);
    assert.match(g.addEdge(a.id, b.id).reason!, /already exists/);
  });

  it("gives every node a unique id and name", () => {
    const g = new model.Graph();
    const made = Array.from({ length: 5 }, () => g.addNode("agent", 0, 0));
    assert.equal(new Set(made.map((n) => n.id)).size, 5);
    assert.equal(new Set(made.map((n) => n.name)).size, 5, "stage names key the runtime");
  });

  it("sends only the props the user changed", () => {
    // An agent has 51 props; restating the 50 nobody touched would bloat the graph and
    // freeze today's defaults into it. The server fills the rest.
    const g = new model.Graph();
    const a = g.addNode("agent", 0, 0);
    assert.deepEqual(a.props, {});
    const wire = g.toJSON();
    assert.deepEqual(wire.nodes[0].props, {});
  });

  it("removes a node's links along with it", () => {
    // A link to a node that no longer exists reaches codegen as a KeyError.
    const g = new model.Graph();
    const a = g.addNode("agent", 0, 0);
    const l = g.addNode("llm", 200, 0);
    g.addEdge(l.id, a.id);
    assert.equal(g.edges.length, 1);
    g.removeNode(a.id);
    assert.equal(g.edges.length, 0, "a dangling edge survived");
  });

  it("round-trips through the wire format", () => {
    const g = new model.Graph();
    const a = g.addNode("agent", 10, 20);
    a.props.role = "planner";
    const copy = new model.Graph(JSON.parse(JSON.stringify(g.toJSON())));
    assert.equal(copy.nodes.length, 1);
    assert.equal(copy.nodes[0]!.props.role, "planner");
    assert.equal(copy.nodes[0]!.x, 10);
  });
});

describe("undo history", () => {
  it("steps back and forward", () => {
    const g = new model.Graph();
    const history = new model.History();
    history.push(g);
    g.addNode("agent", 0, 0);
    assert.equal(g.nodes.length, 1);

    const back = history.undo(g)!;
    assert.equal(back.nodes.length, 0, "undo should reach the empty graph");
    const forward = history.redo(back)!;
    assert.equal(forward.nodes.length, 1);
  });

  it("drops the redo trail once you edit again", () => {
    const g = new model.Graph();
    const history = new model.History();
    history.push(g);
    g.addNode("agent", 0, 0);
    const back = history.undo(g)!;
    assert.equal(history.canRedo, true);
    history.push(back);                              // a new edit
    assert.equal(history.canRedo, false, "a stale redo would resurrect a discarded graph");
  });

  it("bounds how much it keeps", () => {
    const history = new model.History(3);
    const g = new model.Graph();
    for (let i = 0; i < 10; i += 1) history.push(g);
    assert.equal(history.past.length, 3);
  });
});

describe("node silhouettes", () => {
  it("gives every kind a shape the renderer knows how to draw", async () => {
    const { SHAPE_NAMES } = await import("../public/js/shapes.js");
    for (const [kind, meta] of Object.entries(schema.kinds) as [string, any][]) {
      assert.ok(meta.shape, `${kind} has no shape`);
      assert.ok(SHAPE_NAMES.includes(meta.shape),
                `${kind} wants shape "${meta.shape}", which shapes.js cannot draw`);
    }
  });

  it("draws each silhouette inside the same box, with ports on the edges", async () => {
    // Every shape must fit one box and keep its left/right midpoints on the box edges,
    // or links would attach at different places depending on the node kind.
    const { shapePath, SHAPE_NAMES } = await import("../public/js/shapes.js");
    for (const name of SHAPE_NAMES) {
      const d = shapePath(name, 132, 46);
      assert.match(d, /^M/, `${name} is not a path`);
      const coords = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map(Number);
      assert.ok(coords.length >= 4, `${name} has too few points`);
      // Allow a little overshoot for the document foot's curve, which dips below.
      assert.ok(Math.max(...coords) <= 132 + 14, `${name} escapes the box: ${d}`);
      assert.ok(Math.min(...coords) >= -14, `${name} escapes the box: ${d}`);
    }
  });

  it("says what a node DOES, so the roles group visibly", () => {
    // The point of shapes over colour alone: role is readable at a glance even when
    // colours repeat. These groupings are MetaAgent's, exported not restated.
    const shapeOf = (k: string) => (schema.kinds as any)[k].shape;
    assert.equal(shapeOf("router"), shapeOf("condition"), "both decide");
    assert.equal(shapeOf("condition"), shapeOf("while"));
    assert.equal(shapeOf("rag"), shapeOf("memory"), "both store");
    assert.equal(shapeOf("prompt"), shapeOf("template"), "both are text");
    assert.equal(shapeOf("guardrail"), shapeOf("hitl"), "both are gates");
    assert.notEqual(shapeOf("agent"), shapeOf("router"));
    assert.equal(shapeOf("end"), "stadium");
  });

  it("carries a short tag for the decision diamonds", () => {
    // "if / else" fits a diamond; "Condition" does not.
    assert.equal((schema.kinds as any).condition.tag, "if / else");
    assert.equal((schema.kinds as any).fanout.tag, "fan-out");
    assert.equal((schema.kinds as any).agent.tag, undefined, "only diamonds get a tag");
  });
});

describe("the schema drives the palette", () => {
  it("covers every kind exactly once, so nothing can be undraggable", () => {
    const listed = schema.palette.flatMap((group: { kinds: string[] }) => group.kinds);
    assert.equal(listed.length, Object.keys(schema.kinds).length);
    assert.equal(new Set(listed).size, listed.length);
  });

  it("gives every kind a label and a colour to render", () => {
    for (const [kind, meta] of Object.entries(schema.kinds) as [string, any][]) {
      assert.ok(meta.label, `${kind} has no label`);
      assert.match(meta.color, /^#[0-9A-Fa-f]{6}$/, `${kind} has no colour`);
    }
  });

  it("marks credential fields so the panel can hide them", () => {
    assert.equal(schema.kinds.llm.props.api_key.secret, true);
    assert.notEqual(schema.kinds.agent.props.max_output_tokens.secret, true);
  });
});
