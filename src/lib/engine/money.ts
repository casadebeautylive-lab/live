import Decimal from "decimal.js";

// 28 significant digits, banker-safe rounding for display only.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

export const ZERO = new Decimal(0);

export function d(value: string | number | Decimal | null | undefined): Decimal {
  if (value === null || value === undefined || value === "") return ZERO;
  return new Decimal(value);
}

export function sum(values: Decimal[]): Decimal {
  return values.reduce((acc, v) => acc.plus(v), ZERO);
}

/** Safe division: returns null when the divisor is zero. */
export function div(a: Decimal, b: Decimal): Decimal | null {
  return b.isZero() ? null : a.div(b);
}

export function toMoneyString(v: Decimal): string {
  return v.toDecimalPlaces(2).toFixed(2);
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatUsd(v: Decimal | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const x = v.toDecimalPlaces(2);
  return usd.format(x.isZero() ? 0 : x.toNumber()); // never "-$0.00"
}

export function formatPct(v: Decimal | null | undefined, places = 1): string {
  if (v === null || v === undefined) return "—";
  return `${v.toDecimalPlaces(places).toFixed(places)}%`;
}
