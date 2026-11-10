import { div, sum, Decimal, ZERO } from "./money";
import { activeWithin, averagePool, breakdownOrder, buildLedger, skuCost, type Ledger, type StaffLine } from "./ledger";
import type { PauseInput, ShowInput } from "./types";

export { breakdownOrder, skuCost };

/**
 * Show-level profit. Every number here is a sum over the minute ledger
 * (see ledger.ts), so it always matches the minute-by-minute view.
 *
 *   Product revenue   = gross item sales − seller-funded discounts − refunds
 *                       (before shipping and tax; platform-funded discounts don't reduce it)
 *   Estimated profit  = product revenue − product cost − staff pay − packing
 *                       − hourly & fixed expenses − platform fees − net shipping cost
 *   Reconciled profit = Σ settled proceeds (already net of platform fees, refunds and
 *                       shipping) − product cost − staff pay − packing − expenses.
 *                       Only available once every non-cancelled order has settled.
 *
 * Customer-paid shipping is never revenue. Net shipping cost is only counted when
 * the seller's label cost is known (or an estimate is configured); otherwise it is
 * pass-through ($0) and flagged.
 */

export type DataStatus = "live" | "estimated" | "partially_reconciled" | "finalized";

export type StaffCost = {
  staffId: string | null;
  name: string;
  role: "host" | "assistant";
  minutes: number;
  commission: Decimal;
  hourly: Decimal;
  flat: Decimal;
  total: Decimal;
  unitsCredited: number;
  salesCredited: Decimal;
  perUnitRate: Decimal;
};

export type ProfitMetrics = {
  // revenue
  grossMerchandise: Decimal;
  sellerDiscounts: Decimal;
  platformDiscounts: Decimal;
  refunds: Decimal;
  /** Product revenue: after seller discounts and refunds, before shipping and tax. */
  netMerchandise: Decimal;
  customerShipping: Decimal;
  platformShippingSubsidy: Decimal;
  sellerShippingCost: Decimal;
  /** customer shipping + subsidy − seller shipping cost (only where the cost is known/estimated). */
  shippingContribution: Decimal;
  /** −shippingContribution: what shipping actually cost the business. */
  netShippingCost: Decimal;
  platformGmv: Decimal | null;
  platformGmvOrders: number;

  // volume
  orders: number;
  cancelledOrders: number;
  refundedOrders: number;
  unitsShipped: number;
  unitsRefunded: number;
  itemsSold: number; // net units sold = shipped − refunded − giveaways
  giveawayUnits: number; // giveaway items handed out (cost counted, not a sale)

  // costs
  costs: {
    product: Decimal;
    commission: Decimal; // per-unit + % of sales, all staff
    staffHourly: Decimal;
    staffFlat: Decimal;
    packing: Decimal;
    hourlyExpenses: Decimal;
    fixedExpenses: Decimal;
    percentFee: Decimal;
    fixedFee: Decimal;
    actualPlatformFees: Decimal;
  };
  labor: { presenter: Decimal; assistant: Decimal; byStaff: StaffCost[] };
  hourlyExpenseBreakdown: { label: string; category: string; amount: Decimal }[];
  fixedExpenseBreakdown: { category: string; amount: Decimal }[];
  platformFees: Decimal;
  /** All costs except shipping. */
  totalCosts: Decimal;
  /** All costs including net shipping. */
  totalExpenses: Decimal;

  // profit
  operatingProfit: Decimal; // estimated profit
  profitPerItem: Decimal | null;
  profitPerHour: Decimal | null;
  profitPerMinute: Decimal | null;
  marginPct: Decimal | null;

  // rates
  ordersPerMinute: Decimal | null;
  unitsPerMinute: Decimal | null;

  // averages
  /** Average price per item: auction items only when the LIVE has auctions, giveaways never. */
  avgSellingPrice: Decimal | null;
  /** Average order value on the same basis as avgSellingPrice (product money, no shipping). */
  avgOrderValue: Decimal | null;
  /** What the averages are based on. */
  avgBasis: "auction" | "sales";

  // payouts & reconciliation
  estimatedPayout: Decimal;
  confirmedSettlement: Decimal | null;
  settledOrders: number;
  reconciledProfit: Decimal | null;
  dataStatus: DataStatus;

  // time
  activeSeconds: number;
  activeHours: Decimal;
  activeMinutes: Decimal;

  // break-even
  breakEven: {
    contributionPerUnit: Decimal | null;
    fixedCostsToDate: Decimal;
    unitsNeeded: number | null;
    unitsRemaining: number | null;
    reached: boolean;
  };

  // honesty flags
  flags: {
    feesEstimated: boolean;
    productCostEstimated: boolean;
    shippingEstimated: boolean; // at least one order with unknown or estimated shipping
    shippingUnknownOrders: number;
    estimatedSkus: string[];
    outsideWindowOrders: number;
  };
};

/** Active milliseconds between start and (end ?? now), minus paused intervals. */
export function activeMs(startedAt: string, endedAt: string | null, pauses: PauseInput[], now: Date): number {
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : now.getTime();
  return activeWithin(start, end, pauses, end);
}

function staffCost(s: StaffLine): StaffCost {
  return {
    staffId: s.staffId,
    name: s.name,
    role: s.role,
    minutes: Math.round(s.activeMs / 60_000),
    commission: s.commission,
    hourly: s.hourly,
    flat: s.flat,
    total: s.commission.plus(s.hourly).plus(s.flat),
    unitsCredited: s.unitsCredited,
    salesCredited: s.salesCredited,
    perUnitRate: s.perUnitRate,
  };
}

export function profitFromLedger(L: Ledger, isLive: boolean): ProfitMetrics {
  let grossMerchandise = ZERO;
  let sellerDiscounts = ZERO;
  let platformDiscounts = ZERO;
  let refunds = ZERO;
  let netMerchandise = ZERO;
  let customerShipping = ZERO;
  let platformShippingSubsidy = ZERO;
  let sellerShippingCost = ZERO;
  let netShippingCost = ZERO;
  let platformGmv = ZERO;
  let platformGmvOrders = 0;
  let orders = 0;
  let cancelledOrders = 0;
  let refundedOrders = 0;
  let unitsShipped = 0;
  let unitsRefunded = 0;
  let product = ZERO;
  let commission = ZERO;
  let packing = ZERO;
  let percentFee = ZERO;
  let fixedFee = ZERO;
  let actualPlatformFees = ZERO;
  let confirmedSettlement = ZERO;
  let settledOrders = 0;
  let feesEstimated = false;
  let shippingUnknownOrders = 0;
  let shippingEstimated = false;
  const estimatedSkus = new Set<string>();

  for (const l of L.orders) {
    if (l.cancelled) {
      cancelledOrders++;
      continue;
    }
    const o = l.order;
    orders++;
    if (l.refunds.gt(0)) refundedOrders++;
    grossMerchandise = grossMerchandise.plus(l.gross);
    sellerDiscounts = sellerDiscounts.plus(l.sellerDiscount);
    platformDiscounts = platformDiscounts.plus(l.platformDiscount);
    refunds = refunds.plus(l.refunds);
    netMerchandise = netMerchandise.plus(l.net);
    unitsShipped += l.unitsShipped;
    unitsRefunded += l.unitsRefunded;
    product = product.plus(l.cogs);
    commission = commission.plus(l.commission);
    packing = packing.plus(l.packing);
    l.estimatedSkus.forEach((s) => estimatedSkus.add(s));

    customerShipping = customerShipping.plus(o.customerShipping || "0");
    if (o.platformShippingSubsidy !== null) platformShippingSubsidy = platformShippingSubsidy.plus(o.platformShippingSubsidy);
    if (o.sellerShippingCost !== null) sellerShippingCost = sellerShippingCost.plus(o.sellerShippingCost);
    netShippingCost = netShippingCost.plus(l.shippingNetCost);
    if (l.shippingSource === "unknown") {
      shippingUnknownOrders++;
      shippingEstimated = true;
    } else if (l.shippingSource === "estimate") {
      shippingEstimated = true;
    }

    if (o.platformGmv !== null) {
      platformGmv = platformGmv.plus(o.platformGmv);
      platformGmvOrders++;
    }
    if (l.feeActual !== null) {
      actualPlatformFees = actualPlatformFees.plus(l.feeActual);
    } else {
      feesEstimated = true;
      percentFee = percentFee.plus(l.feeEstimatePct);
      fixedFee = fixedFee.plus(l.feeEstimateFixed);
    }
    if (o.settlementAmount !== null) {
      confirmedSettlement = confirmedSettlement.plus(o.settlementAmount);
      settledOrders++;
    }
  }
  product = product.plus(L.scanReportUnassigned);


  const byStaff = L.staff.map(staffCost);
  const staffHourly = sum(byStaff.map((s) => s.hourly));
  const staffFlat = sum(byStaff.map((s) => s.flat));
  const hourlyExpenses = sum(L.hourlyExpenseTotals.map((h) => h.amount));
  const fixedExpenses = sum(L.fixedExpenseTotals.map((f) => f.amount));

  const costs = {
    product,
    commission,
    staffHourly,
    staffFlat,
    packing,
    hourlyExpenses,
    fixedExpenses,
    percentFee,
    fixedFee,
    actualPlatformFees,
  };
  const platformFees = percentFee.plus(fixedFee).plus(actualPlatformFees);
  const totalCosts = sum(Object.values(costs));
  const totalExpenses = totalCosts.plus(netShippingCost);
  const operatingProfit = netMerchandise.minus(totalExpenses);
  const shippingContribution = netShippingCost.negated();

  const hours = new Decimal(L.activeMs).div(3_600_000);
  const minutes = new Decimal(L.activeMs).div(60_000);
  // Averages: giveaways never count; auction items only when the LIVE has auctions.
  const pool = averagePool(L.orders.map((l) => l.order));
  const giveawayUnits = pool.giveawayUnits;
  const hasAuction = pool.hasAuction;
  const poolRevenue = pool.revenue;
  const poolUnits = pool.units;
  const poolOrders = pool.orders;
  const itemsSold = Math.max(0, unitsShipped - unitsRefunded - giveawayUnits);

  // Break-even: time/fixed costs vs. contribution per unit.
  const fixedCostsToDate = staffHourly.plus(staffFlat).plus(hourlyExpenses).plus(fixedExpenses);
  const variableCosts = totalExpenses.minus(fixedCostsToDate);
  const contributionPerUnit = unitsShipped > 0 ? netMerchandise.minus(variableCosts).div(unitsShipped) : null;
  let unitsNeeded: number | null = null;
  if (contributionPerUnit && contributionPerUnit.gt(0)) unitsNeeded = fixedCostsToDate.div(contributionPerUnit).ceil().toNumber();

  // Reconciliation: settled proceeds already reflect platform fees, refunds and shipping.
  const internalCosts = product.plus(commission).plus(staffHourly).plus(staffFlat).plus(packing).plus(hourlyExpenses).plus(fixedExpenses);
  const allSettled = orders > 0 && settledOrders === orders;
  const reconciledProfit = allSettled ? confirmedSettlement.minus(internalCosts) : null;
  const dataStatus: DataStatus = isLive
    ? "live"
    : allSettled
      ? "finalized"
      : settledOrders > 0
        ? "partially_reconciled"
        : "estimated";

  return {
    grossMerchandise,
    sellerDiscounts,
    platformDiscounts,
    refunds,
    netMerchandise,
    customerShipping,
    platformShippingSubsidy,
    sellerShippingCost,
    shippingContribution,
    netShippingCost,
    platformGmv: platformGmvOrders > 0 ? platformGmv : null,
    platformGmvOrders,
    orders,
    cancelledOrders,
    refundedOrders,
    unitsShipped,
    unitsRefunded,
    itemsSold,
    giveawayUnits,
    costs,
    labor: {
      presenter: sum(byStaff.filter((s) => s.role === "host").map((s) => s.total)),
      assistant: sum(byStaff.filter((s) => s.role === "assistant").map((s) => s.total)),
      byStaff,
    },
    hourlyExpenseBreakdown: L.hourlyExpenseTotals,
    fixedExpenseBreakdown: L.fixedExpenseTotals,
    platformFees,
    totalCosts,
    totalExpenses,
    operatingProfit,
    profitPerItem: itemsSold > 0 ? operatingProfit.div(itemsSold) : null,
    profitPerHour: div(operatingProfit, hours),
    profitPerMinute: div(operatingProfit, minutes),
    marginPct: netMerchandise.gt(0) ? operatingProfit.div(netMerchandise).times(100) : null,
    ordersPerMinute: div(new Decimal(orders), minutes),
    unitsPerMinute: div(new Decimal(itemsSold), minutes),
    avgSellingPrice: poolUnits > 0 ? poolRevenue.div(poolUnits) : null,
    avgOrderValue: poolOrders > 0 ? poolRevenue.div(poolOrders) : null,
    avgBasis: hasAuction ? "auction" : "sales",
    estimatedPayout: netMerchandise.minus(platformFees).minus(netShippingCost),
    confirmedSettlement: settledOrders > 0 ? confirmedSettlement : null,
    settledOrders,
    reconciledProfit,
    dataStatus,
    activeSeconds: Math.floor(L.activeMs / 1000),
    activeHours: hours,
    activeMinutes: minutes,
    breakEven: {
      contributionPerUnit,
      fixedCostsToDate,
      unitsNeeded,
      unitsRemaining: unitsNeeded === null ? null : Math.max(0, unitsNeeded - unitsShipped),
      reached: operatingProfit.gte(0) && orders > 0,
    },
    flags: {
      feesEstimated,
      productCostEstimated: estimatedSkus.size > 0,
      shippingEstimated,
      shippingUnknownOrders,
      estimatedSkus: [...estimatedSkus],
      outsideWindowOrders: L.outsideWindowOrders,
    },
  };
}

export function computeProfit(show: ShowInput, now: Date = new Date()): ProfitMetrics {
  return profitFromLedger(buildLedger(show, now), show.endedAt === null);
}
