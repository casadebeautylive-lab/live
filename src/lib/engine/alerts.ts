import type { ProfitMetrics } from "./profit";
import type { VelocityMetrics } from "./velocity";

export type AlertKind =
  | "no_sale_minutes"
  | "profit_per_hour_below"
  | "margin_below_pct"
  | "items_per_hour_below"
  | "show_unprofitable";

export type AlertRule = { id: string; kind: AlertKind; threshold: number; enabled: boolean };

export type FiredAlert = {
  ruleId: string;
  kind: AlertKind;
  severity: "warning" | "critical";
  message: string;
  /** Stable key so the same condition is recorded once per occurrence, not every second. */
  dedupeKey: string;
};

// Rate-based alerts are noisy in the first minutes of a show; wait for a sample.
const MIN_ACTIVE_SECONDS_FOR_RATES = 15 * 60;

export function evaluateAlerts(
  rules: AlertRule[],
  profit: ProfitMetrics,
  velocity: VelocityMetrics,
  showId: string,
): FiredAlert[] {
  const fired: FiredAlert[] = [];
  const rateReady = profit.activeSeconds >= MIN_ACTIVE_SECONDS_FOR_RATES;

  for (const r of rules) {
    if (!r.enabled) continue;
    switch (r.kind) {
      case "no_sale_minutes": {
        const since = velocity.secondsSinceLastSale ?? profit.activeSeconds;
        if (since >= r.threshold * 60) {
          // one alert per quiet stretch: keyed by the count of sales so far
          fired.push({
            ruleId: r.id,
            kind: r.kind,
            severity: "warning",
            message: `No sale in the last ${Math.floor(since / 60)} minutes`,
            dedupeKey: `${showId}:${r.id}:sales=${velocity.saleEvents}`,
          });
        }
        break;
      }
      case "profit_per_hour_below":
        if (rateReady && profit.profitPerHour && profit.profitPerHour.lt(r.threshold)) {
          fired.push({
            ruleId: r.id,
            kind: r.kind,
            severity: "warning",
            message: `Profit per hour is $${profit.profitPerHour.toFixed(2)}, below $${r.threshold}`,
            dedupeKey: `${showId}:${r.id}:h${Math.floor(profit.activeSeconds / 3600)}`,
          });
        }
        break;
      case "margin_below_pct":
        if (rateReady && profit.marginPct && profit.marginPct.lt(r.threshold)) {
          fired.push({
            ruleId: r.id,
            kind: r.kind,
            severity: "warning",
            message: `Margin is ${profit.marginPct.toFixed(1)}%, below ${r.threshold}%`,
            dedupeKey: `${showId}:${r.id}:h${Math.floor(profit.activeSeconds / 3600)}`,
          });
        }
        break;
      case "items_per_hour_below":
        if (rateReady && velocity.itemsPerHour && velocity.itemsPerHour.lt(r.threshold)) {
          fired.push({
            ruleId: r.id,
            kind: r.kind,
            severity: "warning",
            message: `Selling ${velocity.itemsPerHour.toFixed(1)} items/hour, below ${r.threshold}`,
            dedupeKey: `${showId}:${r.id}:h${Math.floor(profit.activeSeconds / 3600)}`,
          });
        }
        break;
      case "show_unprofitable":
        if (profit.orders > 0 && profit.operatingProfit.lt(0)) {
          fired.push({
            ruleId: r.id,
            kind: r.kind,
            severity: "critical",
            message: `Show is losing money: $${profit.operatingProfit.toFixed(2)}`,
            dedupeKey: `${showId}:${r.id}:h${Math.floor(profit.activeSeconds / 3600)}`,
          });
        }
        break;
    }
  }
  return fired;
}
