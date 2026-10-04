/*
 * Deterministic mathematics for the simulation (ADR 0020).
 *
 * The language guarantees the exact result of addition, subtraction, multiplication, division and
 * square root: every conforming engine returns the same bits. It does not guarantee that for
 * `Math.sin`, `Math.cos`, `Math.atan2`, `Math.log` and the like, and engines do differ in the last
 * digit, from one engine to another and from one version to the next.
 *
 * A world must be the same world wherever and whenever it is computed, so the simulation uses the
 * functions below, which are built only from the guaranteed operations. They are accurate to
 * about one part in 10^15, which is far finer than anything the simulation resolves. They are not
 * meant to match `Math.*` bit for bit; they are meant to match themselves, everywhere.
 *
 * The algorithms are textbook: reduce the argument to a small range with exact steps, then sum a
 * short power series.
 */

export const PI = 3.141592653589793;
export const HALF_PI = 1.5707963267948966;
export const TWO_PI = 6.283185307179586;

/** The first 33 bits of π/2, so that multiplying it by a small whole number is exact. */
const PIO2_HEAD = 1.5707963267341256;
/** π/2 minus `PIO2_HEAD`. */
const PIO2_TAIL = 6.077100506506192e-11;

/** ln 2 split the same way: the head has few enough bits that a whole multiple is exact. */
const LN2_HEAD = 0.6931471803691238;
const LN2_TAIL = 1.9082149292705877e-10;

const SQRT2 = 1.4142135623730951;
const SQRT1_2 = 0.7071067811865476;

/** sin r for |r| ≤ π/4: r(1 − z/(2·3)(1 − z/(4·5)(1 − ...))), with z = r². */
function sinSeries(r: number): number {
  const z = r * r;
  let sum = 1;
  for (let n = 21; n >= 3; n -= 2) sum = 1 - (z / ((n - 1) * n)) * sum;
  return r * sum;
}

/** cos r for |r| ≤ π/4: 1 − z/(1·2)(1 − z/(3·4)(1 − ...)), with z = r². */
function cosSeries(r: number): number {
  const z = r * r;
  let sum = 1;
  for (let n = 20; n >= 2; n -= 2) sum = 1 - (z / ((n - 1) * n)) * sum;
  return sum;
}

/** Splits x into a whole number of quarter turns and a remainder within ±π/4. */
function reduce(x: number): { quarter: number; remainder: number } {
  const turns = Math.round(x / HALF_PI);
  const remainder = x - turns * PIO2_HEAD - turns * PIO2_TAIL;
  return { quarter: ((turns % 4) + 4) % 4, remainder };
}

export function sin(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN;
  const { quarter, remainder } = reduce(x);
  switch (quarter) {
    case 0:
      return sinSeries(remainder);
    case 1:
      return cosSeries(remainder);
    case 2:
      return -sinSeries(remainder);
    default:
      return -cosSeries(remainder);
  }
}

export function cos(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN;
  const { quarter, remainder } = reduce(x);
  switch (quarter) {
    case 0:
      return cosSeries(remainder);
    case 1:
      return -sinSeries(remainder);
    case 2:
      return -cosSeries(remainder);
    default:
      return sinSeries(remainder);
  }
}

export function tan(x: number): number {
  return sin(x) / cos(x);
}

/** atan x for 0 ≤ x ≤ 1. Halves the angle twice, exactly up to square roots, then sums a series. */
function atanUnit(x: number): number {
  // atan x = 2 atan(x / (1 + sqrt(1 + x²))).
  let t = x / (1 + Math.sqrt(1 + x * x));
  t = t / (1 + Math.sqrt(1 + t * t));
  // Now t ≤ tan(π/16) ≈ 0.199: t(1 − z/3 + z²/5 − ...), with z = t².
  const z = t * t;
  let sum = 0;
  for (let n = 29; n >= 1; n -= 2) sum = 1 / n - z * sum;
  return 4 * t * sum;
}

export function atan(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  const magnitude = Math.abs(x);
  const angle = magnitude > 1 ? HALF_PI - atanUnit(1 / magnitude) : atanUnit(magnitude);
  return x < 0 ? -angle : angle;
}

/** The angle of the point (x, y), in (−π, π]. The sign of a zero is not distinguished. */
export function atan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  if (x > 0) return atan(y / x);
  if (x < 0) return y >= 0 ? atan(y / x) + PI : atan(y / x) - PI;
  if (y > 0) return HALF_PI;
  if (y < 0) return -HALF_PI;
  return 0;
}

export function asin(x: number): number {
  if (!(x >= -1 && x <= 1)) return Number.NaN;
  return atan2(x, Math.sqrt((1 - x) * (1 + x)));
}

export function acos(x: number): number {
  if (!(x >= -1 && x <= 1)) return Number.NaN;
  return atan2(Math.sqrt((1 - x) * (1 + x)), x);
}

/** The natural logarithm. */
export function ln(x: number): number {
  if (Number.isNaN(x) || x < 0) return Number.NaN;
  if (x === 0) return Number.NEGATIVE_INFINITY;
  if (x === Number.POSITIVE_INFINITY) return x;
  // x = m · 2^k with m in [√½, √2). Halving and doubling are exact.
  let m = x;
  let k = 0;
  while (m >= SQRT2) {
    m /= 2;
    k += 1;
  }
  while (m < SQRT1_2) {
    m *= 2;
    k -= 1;
  }
  // ln m = 2(s + s³/3 + s⁵/5 + ...), with s = (m − 1)/(m + 1), so |s| ≤ 0.172.
  const s = (m - 1) / (m + 1);
  const z = s * s;
  let sum = 0;
  for (let n = 29; n >= 1; n -= 2) sum = 1 / n + z * sum;
  return k * LN2_HEAD + (2 * s * sum + k * LN2_TAIL);
}

/** The length of the vector (x, y). Square root is exact, so this is too. */
export function hypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** A whole number with a comma between thousands, the same on every engine. */
export function groupThousands(value: number): string {
  const rounded = Math.round(value);
  const digits = String(Math.abs(rounded));
  let grouped = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += ',';
    grouped += digits.charAt(i);
  }
  return rounded < 0 ? `-${grouped}` : grouped;
}
