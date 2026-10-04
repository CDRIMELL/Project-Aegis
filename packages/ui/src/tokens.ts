/*
 * Bridge from design tokens to renderers that cannot read CSS variables (the map, charts).
 *
 * Tokens stay defined in one place, `styles/aegis.css`. Canvas and WebGL renderers ask for the
 * resolved value here, so nothing outside the stylesheet ever contains a colour literal.
 */

export type ColorToken = `--color-${string}`;

let probe: CanvasRenderingContext2D | null = null;

function context(): CanvasRenderingContext2D {
  if (!probe) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    probe = canvas.getContext('2d', { willReadFrequently: true });
    if (!probe) {
      throw new Error('2D canvas is unavailable; design tokens cannot be resolved');
    }
  }
  return probe;
}

const hex = (channel: number) => channel.toString(16).padStart(2, '0');

/**
 * Resolves a colour token to `#rrggbb`.
 *
 * The browser does the colour-space conversion: the token's computed value (which may be OKLCH)
 * is painted onto a canvas and read back as sRGB. Throws if the token is not defined, so a
 * misspelt name fails loudly instead of rendering black.
 */
export function resolveColorToken(token: ColorToken): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  if (value.length === 0) {
    throw new Error(`Design token ${token} is not defined`);
  }
  const ctx = context();
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${hex(red)}${hex(green)}${hex(blue)}`;
}

/** Resolves a record of tokens in one call. */
export function resolveColorTokens<K extends string>(
  tokens: Readonly<Record<K, ColorToken>>,
): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const key of Object.keys(tokens) as K[]) {
    out[key] = resolveColorToken(tokens[key]);
  }
  return out;
}
