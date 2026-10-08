// Node silhouettes, as SVG paths.
//
// Which kind gets which shape comes from `schema.json` (MetaAgent's own KIND_SHAPE), so
// the browser and the desktop canvas draw the same vocabulary and neither owns a private
// copy. This file only knows how to draw the nine shapes, not who wears them.
//
// The shape says what a node DOES -- a diamond decides, a cylinder stores, a
// parallelogram is I/O -- and the fill colour says which kind it is. That split is why a
// dense graph stays readable when the colours start repeating.
//
// Every silhouette fits the SAME w x h box and keeps its left and right port midpoints
// on the box edges, so links attach identically whatever the shape.

const pts = (...pairs) => `M${pairs.map(([x, y]) => `${x},${y}`).join(" L")} Z`;

/** Rounded rectangle, the default. */
function rect(w, h, r = 8) {
  return `M${r},0 H${w - r} A${r},${r} 0 0 1 ${w},${r} V${h - r}`
       + ` A${r},${r} 0 0 1 ${w - r},${h} H${r}`
       + ` A${r},${r} 0 0 1 0,${h - r} V${r} A${r},${r} 0 0 1 ${r},0 Z`;
}

const SHAPES = {
  rect,

  /** Decision: router, condition, while, for-each, fan-out, join, debate. */
  diamond: (w, h) => pts([w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]),

  /** Storage: RAG and memory. Elliptical cap at the top, like a database drum. */
  cylinder: (w, h) => {
    const ry = Math.min(9, h / 4);
    return `M0,${ry} A${w / 2},${ry} 0 0 1 ${w},${ry} V${h - ry}`
         + ` A${w / 2},${ry} 0 0 1 0,${h - ry} Z`
         + ` M0,${ry} A${w / 2},${ry} 0 0 0 ${w},${ry}`;
  },

  /** Text: prompt, skill, template. A page with a wavy foot. */
  document: (w, h) => `M0,0 H${w} V${h - 8}`
    + ` C${w * 0.75},${h + 3} ${w * 0.25},${h - 13} 0,${h - 6} Z`,

  /** Model: llm, llmstep, eval. */
  hexagon: (w, h) => {
    const c = Math.min(16, w / 5);
    return pts([c, 0], [w - c, 0], [w, h / 2], [w - c, h], [c, h], [0, h / 2]);
  },

  /** I/O and side effects: tool, mcp, http, code, media, setstate, remote_worker. */
  parallelogram: (w, h) => {
    const s = Math.min(14, w / 8);
    return pts([s, 0], [w, 0], [w - s, h], [0, h]);
  },

  /** A gate you must pass: guardrail, hitl. */
  octagon: (w, h) => {
    const c = Math.min(12, h / 3);
    return pts([c, 0], [w - c, 0], [w, c], [w, h - c],
               [w - c, h], [c, h], [0, h - c], [0, c]);
  },

  /** A way in or out of the process: webserver, gui, schedule, webhook, mcp_server. */
  trapezoid: (w, h) => {
    const s = Math.min(13, w / 9);
    return pts([s, 0], [w - s, 0], [w, h], [0, h]);
  },

  /** Terminal: end. A pill, which reads as "stop". */
  stadium: (w, h) => rect(w, h, h / 2),
};

/** The SVG path for one silhouette, falling back to a rectangle. */
export function shapePath(shape, w, h) {
  return (SHAPES[shape] ?? SHAPES.rect)(w, h);
}

/**
 * How far in from the left edge a label must start to clear an angled top corner.
 *
 * The desktop canvas carries the same table for the same reason: text set at a fixed
 * inset collides with a hexagon's or a parallelogram's cut corner.
 */
const INSET = {
  hexagon: 20, parallelogram: 18, octagon: 15, trapezoid: 14, stadium: 18,
  diamond: 30, cylinder: 12, document: 11,
};

export const textInset = (shape) => INSET[shape] ?? 11;

/** Shapes whose top edge is not flat, so the colour strip must be inset too. */
export const hasFlatLeftEdge = (shape) =>
  shape === "rect" || shape === "document" || shape === "cylinder";

export const SHAPE_NAMES = Object.keys(SHAPES);
