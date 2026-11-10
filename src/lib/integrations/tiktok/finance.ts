import { d, Decimal } from "@/lib/engine/money";

/**
 * TikTok finance → order reconciliation values.
 *
 * Sources (field names from TikTok's published API reference):
 *  - Settled:   GET /finance/202501/orders/{order_id}/statement_transactions
 *               → revenue_amount, fee_and_tax_amount, shipping_cost_amount, settlement_amount
 *  - Unsettled: GET /finance/202507/orders/unsettled → transactions[] with
 *               est_revenue_amount, est_fee_tax_amount, est_shipping_cost_amount,
 *               est_adjustment_amount, est_settlement_amount
 *               (TikTok: settlement = revenue − shipping_cost − fee_tax − adjustment)
 *
 * We use TikTok's own order-level totals rather than re-adding dozens of
 * individual fee lines, so nothing is counted twice. Signs are normalized:
 * fees and shipping are reported as a cost (positive) whatever sign TikTok uses
 * for them — the settlement identity tells us which direction they go.
 *
 * Shipping maps onto the engine so that the engine's net shipping cost equals
 * TikTok's: engine net = sellerShippingCost − customerShipping − subsidy, so
 * sellerShippingCost = TikTok net shipping cost + customerShipping + subsidy.
 */

export type FinanceValues = {
  settled: boolean;
  revenue: string | null;
  platformFees: string | null; // cost, positive
  netShippingCost: string | null; // cost, positive = seller paid more than it recovered
  settlement: string | null;
};

const num = (v: unknown): Decimal | null => (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? d(v) : typeof v === "number" ? d(v) : null);
const str = (v: Decimal | null) => (v === null ? null : v.toString());

/**
 * Express a TikTok amount as a cost. TikTok reports fees/shipping either signed
 * (negative = deducted) or as positive amounts subtracted in the settlement
 * formula. If revenue − |x| − … reconciles to settlement we know it's a deduction.
 */
function asCost(x: Decimal | null): Decimal | null {
  if (x === null) return null;
  return x.isNegative() ? x.negated() : x;
}

export function fromSettledOrder(data: any): FinanceValues {
  const revenue = num(data?.revenue_amount);
  const fee = num(data?.fee_and_tax_amount);
  const ship = num(data?.shipping_cost_amount);
  const settlement = num(data?.settlement_amount);
  return {
    settled: settlement !== null,
    revenue: str(revenue),
    platformFees: str(signedCost(fee, revenue, settlement, ship)),
    netShippingCost: str(signedCost(ship, revenue, settlement, fee)),
    settlement: str(settlement),
  };
}

export function fromUnsettledTransaction(t: any): FinanceValues {
  const revenue = num(t?.est_revenue_amount);
  const fee = num(t?.est_fee_tax_amount);
  const ship = num(t?.est_shipping_cost_amount);
  const settlement = num(t?.est_settlement_amount);
  const adj = num(t?.est_adjustment_amount) ?? new Decimal(0);
  const plus = (a: Decimal | null) => (a ?? new Decimal(0)).plus(adj);
  return {
    settled: false,
    revenue: str(revenue),
    platformFees: str(signedCost(fee, revenue, settlement, plus(ship))),
    netShippingCost: str(signedCost(ship, revenue, settlement, plus(fee))),
    settlement: null,
  };
}

/**
 * Decide whether `x` is a deduction (cost) or a credit by checking the
 * settlement identity revenue ± x ± other ≈ settlement. Falls back to treating
 * negative values as costs.
 */
function signedCost(x: Decimal | null, revenue: Decimal | null, settlement: Decimal | null, other: Decimal | null): Decimal | null {
  if (x === null) return null;
  if (revenue !== null && settlement !== null) {
    const o = other ?? new Decimal(0);
    // Signed convention: settlement = revenue + x + other
    if (revenue.plus(x).plus(o).minus(settlement).abs().lte("0.02")) return x.negated();
    // Positive convention: settlement = revenue − x − other
    if (revenue.minus(x).minus(o).minus(settlement).abs().lte("0.02")) return x;
  }
  return asCost(x);
}

/** Order fields to write, given finance values and what the order already knows about customer shipping. */
export function orderFinanceUpdate(f: FinanceValues, customerShipping: string, platformShippingSubsidy: string | null) {
  return {
    actual_platform_fees: f.platformFees,
    seller_shipping_cost:
      f.netShippingCost === null ? null : d(f.netShippingCost).plus(d(customerShipping)).plus(d(platformShippingSubsidy)).toString(),
    settlement_amount: f.settlement,
  };
}

export type LiveSession = {
  id: string;
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  creator: string | null;
  stats: Record<string, unknown>;
};

const unixToIso = (v: unknown): string | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date((n < 1e12 ? n * 1000 : n)).toISOString();
};

/** GET /analytics/202609/shop_lives/performance → live_stream_sessions[] */
export function mapLiveSessions(data: any): LiveSession[] {
  return ((data?.live_stream_sessions ?? []) as any[])
    .filter((s) => s?.id)
    .map((s) => ({
      id: String(s.id),
      title: s.title ?? null,
      startedAt: unixToIso(s.start_time),
      endedAt: unixToIso(s.end_time),
      creator: s.creator?.nick_name ?? s.creator?.user_name ?? null,
      stats: { sales: s.sales_performance ?? null, traffic: s.traffic_performance ?? s.traffic ?? null, interaction: s.interaction_performance ?? null },
    }));
}
