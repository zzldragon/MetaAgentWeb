# MetaAgentWeb

The **browser designer for MetaAgent**: design an agent graph on a web canvas, and have
the server run MetaAgent's code generator and hand back the agent.

P0 (the schema export) and P1 (the headless generator) live in MetaAgent itself; this
repo is **P2 (the server) and P3 (the canvas)**. See `MetaAgent/docs/WebDesigner.md` for
the whole plan.

```
node --version          # needs >= 24
npm start               # then open http://127.0.0.1:8722
npm test                # 43 tests, no network, no API key
```

Drag a node from the left onto the canvas, drag from its right-hand port to another
node to link them, edit properties on the right. The graph is validated by MetaAgent
itself as you work, and **Generate** hands back a zip.

**No dependencies and no build step.** Node 24 runs TypeScript natively by stripping
types, so `src/*.ts` executes directly. `package.json` has an empty `dependencies` —
that is deliberate, and it matches what the server serves: MetaAgent's whole identity is
generating code that does not drag a framework along with it.

> Because Node *strips* types rather than checking them, `npm run typecheck` needs a
> `tsc` you install yourself. `tsconfig.json` sets `erasableSyntaxOnly`, which is what
> catches the syntax stripping cannot handle — constructor parameter properties, `enum`,
> `namespace`. Two of those slipped through while writing this and only failed at
> runtime.

## Configuration

Everything is an env var with a working default; the single-user case needs no config
file at all.

| Variable | Default | |
|---|---|---|
| `MTA_HOST` / `MTA_PORT` | `127.0.0.1` / `8722` | **loopback on purpose** — see below |
| `MTA_ROOT` | `../MetaAgent` | where `mta_gen.py` lives |
| `MTA_PYTHON` | `python` | the interpreter that runs it |
| `MTA_DATA` | `./data` | graphs, uploads, job output |
| `MTA_JOBS` | `2` | concurrent generations |
| `MTA_JOB_TIMEOUT_MS` | `120000` | hard cap on one generation |
| `MTA_JOB_TTL_MS` | `3600000` | how long a finished job is collectable |
| `MTA_MAX_UPLOAD` | `32 MB` | request body ceiling |
| `MTA_ZIP_SKIP_OVER` | `2000000` | leave files bigger than this out of a download |

That last one matters more than it looks: codegen copies `rg.exe` (5.4 MB) in beside any
ripgrep-using toolset, which is **96% of a scoutXCode download**. Excluding it takes the
zip from 5.9 MB to 249 KB, and the response names what it left out.

## API

| | | |
|---|---|---|
| `GET` | `/api/schema` | the node registry (33 kinds, 413 edge rules, 5 palette groups) |
| `GET` `POST` | `/api/graphs` | list / create |
| `GET` `PUT` `DELETE` | `/api/graphs/:id` | read / replace / delete |
| `POST` | `/api/mta?name=` | upload a `.mta` (raw body) |
| `GET` | `/api/graphs/:id/mta` | download the bundle it came from |
| `POST` | `/api/analyze` | validate a graph — synchronous, for the canvas |
| `POST` | `/api/generate` | queue a build → `202 {jobId}` |
| `GET` `DELETE` | `/api/jobs/:id` | poll / cancel |
| `GET` | `/api/jobs/:id/download` | the zip |

`analyze` is synchronous because the canvas calls it on every edit and does no
generation. `generate` is queued because it spawns a process and takes seconds.

**A refusal is a result, not an error.** A graph that fails validation, or carries an
API key, comes back as a *completed job* with `ok: false` and a reason. Throwing there
would turn "your graph has a key in it" into "the server broke".

## How it talks to MetaAgent

It **spawns `python mta_gen.py`**, once per request, and parses one JSON object off
stdout. It never imports Python, never keeps an interpreter alive, and never runs
generated code.

That boundary is not ceremony. MetaAgent's `GENERATED_DIR` and `TOOLS_DIR` are
*process-global*, so two concurrent generations in one process would write over each
other and `load_mta` would restore both requests' tool files into one folder. A process
per job **is** the isolation — and it makes the timeout and the kill-switch free.

## Single-user now, multi-tenant later

There is one principal, `local`, and no login. But the **shape** is multi-tenant already,
in four places, each marked in the source:

1. **`principal.ts`** — every request carries a `Principal`, and every lookup goes
   through it. Going multi-tenant means changing where the principal comes from, not
   auditing each endpoint for somewhere that assumed the caller owned what it asked for.
2. **`ids.ts`** — resources are opaque UUIDs, never names or counters. A sequential job
   id is enumerable; with one tenant that is untidy, with two it is a way to read
   someone else's build.
3. **`paths.ts`** — one `pathFor()` resolves every filesystem path. v2 adds a tenant
   segment there and nowhere else.
4. **`queue.ts`** — admission is a **policy function**, not an `if` in a handler. v1's
   is a global concurrency cap; v2's is per-tenant with quotas.

When you want real accounts, `MetaAgent/codegen_ts/runtime_ts/userdb.ts` (428 lines,
zero deps, `node:sqlite` with a JSON fallback, scrypt hashing, expiring server-side
tokens) drops straight in.

### Why loopback is the default

This server turns a posted graph into runnable code. On `0.0.0.0` that is a
code-generation service open to the network, with no authentication. Binding wider
should be something someone typed, not something they inherited — so the default is
`127.0.0.1` and a warning prints if you change it.

Three facts worth keeping in view:

* **Codegen does not execute graph content.** The one `exec()` in `graph_codegen.py`
  runs MetaAgent's own template; the `compile()` on a custom GUI is a syntax check whose
  result is discarded.
* **`load_mta` is zip-slip safe** — it takes `os.path.basename` of every member.
* **The output is runnable code built from caller-supplied text.** Ship it to the user;
  never run it here. Keep "generate and download" strictly separate from any "try it"
  button — that button inverts every line above.

## The canvas

Hand-written SVG, no framework. That is a deliberate trade and worth stating plainly:
**React Flow would have been less code and better out of the box** — minimap, snapping,
edge routing. It would also have meant `npm install`, a bundler, a build step and
~200 MB of `node_modules` for a project whose entire pitch so far has been that
`npm start` is the setup. Given that, and that the renderer sits behind one file
(`canvas.js`), swapping it later is contained.

What it does today: drag-and-drop from a searchable palette, node drag, link-by-drag
with **live legality** (the trail turns green or red before you let go), pan, zoom, fit,
undo/redo, delete, save/open, `.mta` import, and generate-with-download.

**Everything the canvas knows comes from `schema.json`** — the 33 kinds, their colours,
the 413 legal link pairs, and every property. Nothing about node kinds is written down
in JavaScript, so a node added to MetaAgent appears here with no change to this repo.

### The property panel is deliberately plainer than the desktop one

Forms are generated from each prop's default value and inferred widget type. That covers
all 33 kinds immediately, but it cannot reproduce `canvas_qt/dialogs.py` — 7,900 lines of
Qt that know about ranges, conditional visibility and per-field buttons (probe the
embedding model, load a subgraph `.mta`). None of that is derivable from a default.

Two small hand-maintained lists in `props.js` soften the worst of it: `ENUMS` for fields
where a free-text box would actively mislead, and `IMPORTANT` for the handful worth
showing above the other forty. Both are kept short on purpose — they are exactly where a
second copy of MetaAgent's config table would start growing, and the moment it did it
would drift.

## Layout

```
public/
  index.html     the shell
  css/style.css  MetaAgent's desktop palette, so the two feel like one product
  js/graph.js    the model + rules (no DOM — this is the tested part)
  js/canvas.js   SVG rendering, drag, link, pan, zoom
  js/props.js    schema-driven property forms
  js/api.js      the server API
  js/app.js      wiring, toolbar, debounced validation
src/
  config.ts      env-driven settings
  principal.ts   decision 1 — who is asking
  ids.ts         decision 2 — opaque ids
  paths.ts       decision 3 — the one path resolver
  queue.ts       decision 4 — jobs with an admission policy
  mtagen.ts      the Python bridge (the only place Python is spawned)
  store.ts       saved graphs, owned and ownership-checked
  http.ts        json / body / static / download helpers
  routes.ts      the API surface
  app.ts         the assembled app — built, not listening
  server.ts      the entry point
scripts/schema.ts   refresh public/schema.json
test/api.test.ts    21 tests over a real socket
```

## Tests

`npm test` builds the whole app, listens on an ephemeral port and drives it with
`fetch`. Each run gets its own `MTA_DATA`, so runs cannot see each other's graphs. They
generate real agents through real Python — no model is called and no API key is needed.

The cases worth knowing about: the credential refusal, that a scrubbed key never reaches
the generated code, that no filesystem path leaks into a job response, and that `../../`
reaches neither the graph store nor the static route.

**What the tests do NOT cover:** the drawing. `graph.js` is tested because it has no DOM
dependency and holds the rules; `canvas.js` and `props.js` need a browser. Simulating one
would mean adding jsdom — this project's first dependency — to test rendering that a
glance at the screen checks better. So open it and look.
