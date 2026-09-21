export const MICROS_PER_DOLLAR = 1_000_000n;

export function microsToDollarNumeric(micros: bigint): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const whole = abs / MICROS_PER_DOLLAR;
  const frac = (abs % MICROS_PER_DOLLAR).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

export function dollarNumericToMicros(value: string | number): bigint {
  const raw = String(value).trim();
  if (!raw) return 0n;
  const negative = raw.startsWith("-");
  const unsigned = negative || raw.startsWith("+") ? raw.slice(1) : raw;
  const [wholePart, fracPart = ""] = unsigned.split(".");
  const whole = BigInt(wholePart || "0");
  const frac = BigInt((fracPart + "000000").slice(0, 6));
  const micros = whole * MICROS_PER_DOLLAR + frac;
  return negative ? -micros : micros;
}
