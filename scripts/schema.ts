// Refresh public/schema.json from MetaAgent.
//
//   npm run schema
//
// The server also serves it live at GET /api/schema (cached), so this is only needed
// when the front end wants the file at build time rather than at run time.
import fs from "node:fs";
import path from "node:path";

import { CONFIG } from "../src/config.ts";
import { schema } from "../src/mtagen.ts";

const text = await schema();
fs.mkdirSync(CONFIG.publicDir, { recursive: true });
const out = path.join(CONFIG.publicDir, "schema.json");
fs.writeFileSync(out, text, "utf-8");

const data = JSON.parse(text) as { kinds: object; allowed_edges: unknown[] };
console.log(`wrote ${out} — ${Object.keys(data.kinds).length} kinds, `
            + `${data.allowed_edges.length} edge rules`);
