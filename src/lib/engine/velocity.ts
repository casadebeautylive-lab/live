import { Decimal } from "./money";
import { activeMs, breakdownOrder } from "./profit";
import { buildLedger } from "./ledger";
import { minutesFromLedger } from "./minutes";
import type { ShowInput } from "./types";

export type VelocityMetrics = {
  saleEvents: number; // non-cancelled orders
  avgSecondsBetweenSales: number | null; // mean of consecutive gaps between sale timestamps
  secondsSinceLastSale: number | null;
  longestGapSeconds: number | null; // includes show start → first sale and last sale → now/end
  itemsPerMinute: Decimal | null;
  itemsPerHour: Decimal | null;
  ordersPerHour: Decimal | null;
  revenuePerHour: Decimal | null;
  outOfOrderEvents: number; // events that arrived after a later-created event
};

export type TimelineBucket = {
  start: string;
  units: number;
  orders: number;
  netRevenue: Decimal;
  cumulativeRevenue: Decimal;
  cumulativeProfit: Decimal;
};

export function computeVelocity(show: ShowInput, now: Date = new Date()): VelocityMetrics {
  const active = show.orders.filter((o) => o.status !== "cancelled");
  const times = active.map((o) => Date.parse(o.createdAt)).sort((a, b) => a - b);
  const start = Date.parse(show.startedAt);
  const end = show.endedAt ? Date.parse(show.endedAt) : now.getTime();

  let avg: number | null = null;
  if (times.length >= 2) avg = (times[times.length - 1] - times[0]) / (times.length - 1) / 1000;

  let longest: number | null = null;
  if (end > start) {
    const points = [start, ...times.filter((t) => t >= start && t <= end), end];
    longest = 0;
    for (let i = 1; i < points.length; i++) longest = Math.max(longest, points[i] - points[i - 1]);
    longest = Math.floor(longest / 1000);
  }

  // Out-of-order detection: walk events in arrival order, count those created
  // earlier than something we had already received.
  let outOfOrder = 0;
  const byArrival = active
    .filter((o) => o.receivedAt)
    .sort((a, b) => Date.parse(a.receivedAt!) - Date.parse(b.receivedAt!));
  let maxCreated = -Infinity;
  for (const o of byArrival) {
    const t = Date.parse(o.createdAt);
    if (t < maxCreated) outOfOrder++;
    maxCreated = Math.max(maxCreated, t);
  }

  const ms = activeMs(show.startedAt, show.endedAt, show.pauses, now);
  const hours = new Decimal(ms).div(3_600_000);
  const units = active.reduce((acc, o) => {
    const b = breakdownOrder(o, show.costs);
    return acc + b.unitsShipped - b.unitsRefunded;
  }, 0);
  const revenue = active.reduce((acc, o) => acc.plus(breakdownOrder(o, show.costs).net), new Decimal(0));

  return {
    saleEvents: active.length,
    avgSecondsBetweenSales: avg,
    secondsSinceLastSale: times.length ? Math.max(0, Math.floor((end - times[times.length - 1]) / 1000)) : null,
    longestGapSeconds: longest,
    itemsPerMinute: hours.isZero() ? null : new Decimal(units).div(hours.times(60)),
    itemsPerHour: hours.isZero() ? null : new Decimal(units).div(hours),
    ordersPerHour: hours.isZero() ? null : new Decimal(active.length).div(hours),
    revenuePerHour: hours.isZero() ? null : revenue.div(hours),
    outOfOrderEvents: outOfOrder,
  };
}

/** Bucketed sales over time with cumulative revenue and profit (profit includes time costs). */
export function computeTimeline(show: ShowInput, bucketMinutes = 5, now: Date = new Date()): TimelineBucket[] {
  const start = Date.parse(show.startedAt);
  const end = show.endedAt ? Date.parse(show.endedAt) : now.getTime();
  if (!(end > start)) return [];
  const minutes = minutesFromLedger(buildLedger(show, now));
  const buckets: TimelineBucket[] = [];
  for (let i = 0; i < minutes.length; i += bucketMinutes) {
    const group = minutes.slice(i, i + bucketMinutes);
    const last = group[group.length - 1];
    buckets.push({
      start: group[0].start,
      units: group.reduce((a, m) => a + m.units, 0),
      orders: group.reduce((a, m) => a + m.orders, 0),
      netRevenue: group.reduce((a, m) => a.plus(m.revenue), new Decimal(0)),
      cumulativeRevenue: last.cumulativeRevenue,
      cumulativeProfit: last.cumulativeProfit,
    });
  }
  return buckets;
}
