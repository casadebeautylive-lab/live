import { div, Decimal, ZERO } from "./money";
import { buildLedger, minuteExpenses, minuteProfit, type Ledger } from "./ledger";
import { profitFromLedger, type ProfitMetrics } from "./profit";
import type { ShowInput } from "./types";

/**
 * Minute-by-minute profit (Profit Tracker spec §5).
 *
 * Two distinct metrics:
 *  - Minute profit: profit or loss generated inside one 60-second bucket.
 *    A minute with no sales still loses money: hourly staff pay and hourly
 *    expenses accrue every active second (default $20 + $30 per hour = $0.8333/min).
 *  - Average profit per minute: cumulative profit ÷ elapsed active minutes.
 */

export type MinuteMetric = {
  index: number;
  start: string;
  end: string;
  elapsedMinutes: number; // wall-clock minutes from show start to this bucket's end
  activeSeconds: number;
  orders: number;
  units: number;
  revenue: Decimal;
  cogs: Decimal;
  commission: Decimal;
  fees: Decimal;
  labor: Decimal;
  hourlyExpenses: Decimal;
  fixedExpenses: Decimal;
  packing: Decimal;
  shipping: Decimal;
  expenses: Decimal; // every cost including net shipping
  profit: Decimal;
  cumulativeRevenue: Decimal;
  cumulativeExpenses: Decimal;
  cumulativeProfit: Decimal;
  avgProfitPerMinute: Decimal | null;
};

export type MinuteWindow = { startIndex: number; endIndex: number; start: string; profit: Decimal; revenue: Decimal };

export type MinuteStats = {
  currentMinuteRevenue: Decimal;
  currentMinuteProfit: Decimal;
  rolling5Revenue: Decimal;
  rolling10Profit: Decimal;
  bestMinute: MinuteMetric | null;
  worstMinute: MinuteMetric | null;
  best15: MinuteWindow | null;
  avgRevenuePerMinute: Decimal | null;
  avgProfitPerMinute: Decimal | null;
  /** Current pace: average profit per minute × 60. */
  profitPerHourPace: Decimal | null;
  totalProfit: Decimal;
};

export type MinuteView = { minutes: MinuteMetric[]; stats: MinuteStats; totals: ProfitMetrics; ledger: Ledger };

export function minutesFromLedger(L: Ledger): MinuteMetric[] {
  let cumRev = ZERO;
  let cumExp = ZERO;
  let cumActiveMs = 0;
  return L.minutes.map((m) => {
    const expenses = minuteExpenses(m).plus(m.shipping);
    const profit = minuteProfit(m);
    cumRev = cumRev.plus(m.revenue);
    cumExp = cumExp.plus(expenses);
    cumActiveMs += m.activeMs;
    const cumProfit = cumRev.minus(cumExp);
    return {
      index: m.index,
      start: new Date(m.start).toISOString(),
      end: new Date(m.end).toISOString(),
      elapsedMinutes: Math.round((m.end - L.start) / 60_000),
      activeSeconds: Math.round(m.activeMs / 1000),
      orders: m.orders,
      units: m.units,
      revenue: m.revenue,
      cogs: m.cogs,
      commission: m.commission,
      fees: m.fees,
      labor: m.labor,
      hourlyExpenses: m.hourlyExpenses,
      fixedExpenses: m.fixedExpenses,
      packing: m.packing,
      shipping: m.shipping,
      expenses,
      profit,
      cumulativeRevenue: cumRev,
      cumulativeExpenses: cumExp,
      cumulativeProfit: cumProfit,
      avgProfitPerMinute: div(cumProfit, new Decimal(cumActiveMs).div(60_000)),
    };
  });
}

const sumOf = (rows: MinuteMetric[], key: "revenue" | "profit") => rows.reduce((a, r) => a.plus(r[key]), ZERO);

export function minuteStats(rows: MinuteMetric[], windowSize = 15): MinuteStats {
  const last = rows[rows.length - 1];
  const totalProfit = last?.cumulativeProfit ?? ZERO;
  const activeMinutes = new Decimal(rows.reduce((a, r) => a + r.activeSeconds, 0)).div(60);

  let best: MinuteMetric | null = null;
  let worst: MinuteMetric | null = null;
  for (const r of rows) {
    if (r.activeSeconds === 0 && r.revenue.isZero() && r.expenses.isZero()) continue; // fully paused
    if (!best || r.profit.gt(best.profit)) best = r;
    if (!worst || r.profit.lt(worst.profit)) worst = r;
  }

  // best rolling window (sliding sum)
  let best15: MinuteWindow | null = null;
  if (rows.length) {
    const n = Math.min(windowSize, rows.length);
    let p = sumOf(rows.slice(0, n), "profit");
    let rv = sumOf(rows.slice(0, n), "revenue");
    let bestStart = 0;
    let bestP = p;
    let bestR = rv;
    for (let i = n; i < rows.length; i++) {
      p = p.plus(rows[i].profit).minus(rows[i - n].profit);
      rv = rv.plus(rows[i].revenue).minus(rows[i - n].revenue);
      if (p.gt(bestP)) {
        bestP = p;
        bestR = rv;
        bestStart = i - n + 1;
      }
    }
    best15 = { startIndex: bestStart, endIndex: bestStart + n - 1, start: rows[bestStart].start, profit: bestP, revenue: bestR };
  }

  const avgProfit = div(totalProfit, activeMinutes);
  return {
    currentMinuteRevenue: last?.revenue ?? ZERO,
    currentMinuteProfit: last?.profit ?? ZERO,
    rolling5Revenue: sumOf(rows.slice(-5), "revenue"),
    rolling10Profit: sumOf(rows.slice(-10), "profit"),
    bestMinute: best,
    worstMinute: worst,
    best15,
    avgRevenuePerMinute: div(last?.cumulativeRevenue ?? ZERO, activeMinutes),
    avgProfitPerMinute: avgProfit,
    profitPerHourPace: avgProfit ? avgProfit.times(60) : null,
    totalProfit,
  };
}

export function computeMinutes(show: ShowInput, now: Date = new Date()): MinuteView {
  const ledger = buildLedger(show, now);
  const minutes = minutesFromLedger(ledger);
  return { minutes, stats: minuteStats(minutes), totals: profitFromLedger(ledger, show.endedAt === null), ledger };
}

/**
 * What the show looked like when it ended, before reconciliation: drops orders
 * and refunds that arrived after the end and any actual fees, shipping costs and
 * settlements (those come from finance data after the show). Used as the
 * "original live estimate" when no frozen snapshot was stored at show end.
 */
export function liveEstimateView(show: ShowInput): ShowInput {
  if (!show.endedAt) return show;
  const end = Date.parse(show.endedAt);
  return {
    ...show,
    // the scan report arrives after the show — the live estimate used the default costs
    costs: { ...show.costs, scanReport: null },
    packages: [],
    orders: show.orders
      .filter((o) => !o.receivedAt || Date.parse(o.receivedAt) <= end)
      .map((o) => ({
        ...o,
        refunds: o.refunds.filter((r) => Date.parse(r.refundedAt) <= end),
        actualPlatformFees: null,
        sellerShippingCost: null,
        settlementAmount: null,
      })),
  };
}

export type Adjustment = { label: string; original: Decimal; final: Decimal; delta: Decimal };

/** Category-by-category difference between the original live estimate and the current final numbers. */
export function reconciliationAdjustments(original: ProfitMetrics, final: ProfitMetrics): Adjustment[] {
  const row = (label: string, a: Decimal, b: Decimal): Adjustment => ({ label, original: a, final: b, delta: b.minus(a) });
  return [
    row("Product revenue", original.netMerchandise, final.netMerchandise),
    row("Product cost", original.costs.product, final.costs.product),
    row("Staff pay", original.labor.presenter.plus(original.labor.assistant), final.labor.presenter.plus(final.labor.assistant)),
    row("Platform fees", original.platformFees, final.platformFees),
    row("Net shipping", original.netShippingCost, final.netShippingCost),
    row(
      "Other expenses",
      original.costs.hourlyExpenses.plus(original.costs.fixedExpenses).plus(original.costs.packing),
      final.costs.hourlyExpenses.plus(final.costs.fixedExpenses).plus(final.costs.packing),
    ),
    row("Estimated profit", original.operatingProfit, final.operatingProfit),
  ];
}
