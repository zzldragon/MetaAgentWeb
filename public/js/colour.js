// Deriving a usable accent from MetaAgent's node palette.
//
// The palette is Material 100/200 pastels — mean luminance 0.79. On the desktop canvas
// they FILL the node body, so a pale wash is exactly right. Here the body is white and
// the colour is an accent, and a 0.79-luminance accent on a light page is invisible.
//
// Rather than fork the palette (a second colour table is a second thing to drift), each
// pastel is pushed into a saturated sibling: same hue, so a node is still recognisably
// "the blue one", but with enough contrast to read as a deliberate accent.

const hex2rgb = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const rgb2hex = (r, g, b) =>
  "#" + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v)))
    .toString(16).padStart(2, "0")).join("");

function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0))
          : max === g ? (b - r) / d + 2
          : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hsl2rgb(h, s, l) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const to = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [to(h + 1 / 3) * 255, to(h) * 255, to(h - 1 / 3) * 255];
}

/** Relative luminance — what the eye actually reads as "how dark is this". */
const luminance = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/**
 * A saturated, readable accent derived from a pastel.
 *
 * Targets a perceptual LUMINANCE, not an HSL lightness. Fixing lightness looks
 * reasonable and is not: yellow at L=0.46 reads far brighter than blue at L=0.46, so a
 * fixed-lightness palette lands with a wider contrast spread than it started with
 * (measured: 0.34 -> 0.59). Binary-searching lightness for a luminance target holds all
 * 33 accents at the same apparent weight.
 *
 * Near-greys keep their neutrality. Forcing saturation onto a colour whose hue is
 * nearly arbitrary invents one — `router` (#B0BEC5) and `end` (#90A4AE) both became the
 * same blue that way, which is worse than either being grey.
 */
export function vivid(hex, target = 0.34) {
  try {
    const [h, s] = rgb2hsl(...hex2rgb(hex));
    const neutral = s < 0.18;
    const sat = neutral ? s : Math.max(s, 0.60);

    let lo = 0;
    let hi = 1;
    let best = hex;
    for (let i = 0; i < 20; i += 1) {
      const mid = (lo + hi) / 2;
      const rgb = hsl2rgb(h, sat, mid);
      const lum = luminance(...rgb);
      best = rgb2hex(...rgb);
      if (Math.abs(lum - target) < 0.005) break;
      if (lum > target) hi = mid; else lo = mid;
    }
    return best;
  } catch {
    return hex;
  }
}

/** A tint pale enough to sit behind text. */
export function wash(hex, target = 0.93) {
  try {
    const [h, s] = rgb2hsl(...hex2rgb(hex));
    const sat = s < 0.18 ? s : Math.max(s, 0.45);
    let lo = 0;
    let hi = 1;
    let best = hex;
    for (let i = 0; i < 20; i += 1) {
      const mid = (lo + hi) / 2;
      const rgb = hsl2rgb(h, sat, mid);
      best = rgb2hex(...rgb);
      const lum = luminance(...rgb);
      if (Math.abs(lum - target) < 0.004) break;
      if (lum > target) hi = mid; else lo = mid;
    }
    return best;
  } catch {
    return hex;
  }
}
