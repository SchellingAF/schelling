// Exact decimals for deposits: numbers a callback carries, kept as their source text and
// never turned into a float, so 1.000000000000000001 is not rounded to 1 before it is
// floored.
//
// A JSON number is read through JSON.parse's reviver, whose context gives each
// primitive's source text (readJson below). A decimal is that text, or a string, of the
// form [+]digits[.digits][e[+-]digits]: the exponent form /info/ already uses ("0E-8").
// It becomes { digits, scale } with scale >= 0, its value digits / 10^scale, so every
// valid number is exact and nothing throws. A negative value, NaN, Infinity, an empty
// string, more than 80 digits or an exponent beyond 40 either way is not a decimal.

/** A JSON number, as its source text. */
export class JsonNumber {
  readonly source: string;
  constructor(source: string) {
    this.source = source;
  }
}

/** A non-negative decimal: digits / 10^scale. */
export type Decimal = { digits: bigint; scale: number };

/** The most digits a decimal may have, and the largest exponent either way. */
export const DECIMAL_DIGITS = 80;
export const DECIMAL_EXPONENT = 40;

const SHAPE = /^\+?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * JSON text parsed with every number kept as a JsonNumber holding its source text. Throws
 * SyntaxError as JSON.parse does.
 */
export function readJson(text: string): unknown {
  return JSON.parse(text, (_key, value, context?: { source?: string }) =>
    typeof value === "number" ? new JsonNumber(context?.source ?? String(value)) : value,
  );
}

/** A decimal from a JsonNumber or a string; null when it is not one. */
export function parseDecimal(raw: unknown): Decimal | null {
  const text = raw instanceof JsonNumber ? raw.source : raw;
  if (typeof text !== "string") return null;
  const m = SHAPE.exec(text);
  if (!m) return null;
  const whole = m[1]!;
  const fraction = m[2] ?? "";
  if (whole.length + fraction.length > DECIMAL_DIGITS) return null;
  // The exponent's digits are bounded before they are read as a number.
  const exponentText = m[3] ?? "0";
  if (exponentText.replace(/^[+-]?0*/, "").length > 2) return null;
  const exponent = Number(exponentText);
  if (Math.abs(exponent) > DECIMAL_EXPONENT) return null;
  let digits = BigInt(whole + fraction);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    digits *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { digits, scale };
}

/** The decimal in micro-units, rounded down: digits * 10^6 / 10^scale. */
export function toMicroFloor(d: Decimal): bigint {
  return (d.digits * 1_000_000n) / 10n ** BigInt(d.scale);
}

/** The decimal as plain text, which PostgreSQL's numeric reads exactly. */
export function decimalText(d: Decimal): string {
  if (d.scale === 0) return d.digits.toString();
  const padded = d.digits.toString().padStart(d.scale + 1, "0");
  return `${padded.slice(0, -d.scale)}.${padded.slice(-d.scale)}`;
}

/** The decimal is greater than zero. */
export function positive(d: Decimal): boolean {
  return d.digits > 0n;
}
