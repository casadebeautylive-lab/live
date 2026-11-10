import { d, Decimal, ZERO } from "./money";
import { skuCost } from "./profit";
import { averagePool, isGiveawayItem, perUnitRate } from "./ledger";
import { normalizeCosts } from "./defaults";
import type { CostSnapshot, OrderInput } from "./types";

export type ProductRow = {
  sku: string;
  title: string;
  units: number; // net units (shipped − refunded)
  unitsShipped: number;
  netRevenue: Decimal;
  productCost: Decimal;
  /** Contribution profit: revenue − product, presenter commission, packing and allocated platform fees.
   *  Time-based show costs are not allocated to SKUs. */
  contribution: Decimal;
  avgPrice: Decimal | null;
  marginPct: Decimal | null;
  costEstimated: boolean;
};

/**
 * Per-SKU analytics. Seller discounts and refunds are attributed to their line.
 * Estimated platform fees are allocated the same way the profit engine computes them:
 * percent fee on line net revenue, fixed fee split across the order's units.
 */
export function productBreakdown(orders: OrderInput[], snapshot: CostSnapshot): ProductRow[] {
  const costs = normalizeCosts(snapshot);
  const presenterRate = perUnitRate(costs.presenter, averagePool(orders).avgPrice);
  const rows = new Map<string, ProductRow>();

  for (const order of orders) {
    if (order.status === "cancelled") continue;
    const orderUnits = order.items.reduce((a, i) => a + Math.max(0, i.quantity), 0);
    const orderGrossNet = order.items.reduce(
      (a, i) => a.plus(d(i.unitPrice).times(i.quantity)).minus(d(i.sellerDiscount)),
      ZERO,
    );
    const unattributedRefunds = order.refunds.filter((r) => !r.externalItemId);
    const actualFees = order.actualPlatformFees === null ? null : d(order.actualPlatformFees);

    for (const item of order.items) {
      const key = item.sku ?? `title:${item.title}`;
      const row =
        rows.get(key) ??
        ({
          sku: item.sku ?? "(no sku)",
          title: item.title,
          units: 0,
          unitsShipped: 0,
          netRevenue: ZERO,
          productCost: ZERO,
          contribution: ZERO,
          avgPrice: null,
          marginPct: null,
          costEstimated: false,
        } satisfies ProductRow);

      const qty = Math.max(0, item.quantity);
      const lineNet = d(item.unitPrice).times(qty).minus(d(item.sellerDiscount));
      const share = orderGrossNet.isZero() ? ZERO : lineNet.div(orderGrossNet);
      const itemRefunds = order.refunds.filter((r) => r.externalItemId === item.externalItemId);
      const refundAmt = itemRefunds
        .reduce((a, r) => a.plus(d(r.amount)), ZERO)
        .plus(unattributedRefunds.reduce((a, r) => a.plus(d(r.amount)), ZERO).times(share));
      const refundQty = Math.min(qty, itemRefunds.reduce((a, r) => a + r.quantity, 0));
      const net = lineNet.minus(refundAmt);

      const { cost, estimated } = skuCost(costs, item.sku);
      const pCost = cost.times(qty);
      const fees =
        actualFees !== null
          ? actualFees.times(share)
          : Decimal.max(net, ZERO)
              .times(d(costs.percentFee))
              .plus(orderUnits ? d(costs.fixedFeePerTransaction).times(qty).div(orderUnits) : ZERO);
      const giveaway = isGiveawayItem(order, item);
      const perItem = d(costs.packingPerItem)
        .times(qty)
        .plus(giveaway ? ZERO : presenterRate.times(qty).plus(d(costs.presenter.percentOfSales).times(lineNet)));

      row.units += qty - refundQty;
      row.unitsShipped += qty;
      row.netRevenue = row.netRevenue.plus(net);
      row.productCost = row.productCost.plus(pCost);
      row.contribution = row.contribution.plus(net.minus(pCost).minus(fees).minus(perItem));
      row.costEstimated = row.costEstimated || estimated;
      rows.set(key, row);
    }
  }

  for (const row of rows.values()) {
    row.avgPrice = row.units > 0 ? row.netRevenue.div(row.units) : null;
    row.marginPct = row.netRevenue.gt(0) ? row.contribution.div(row.netRevenue).times(100) : null;
  }
  return [...rows.values()].sort((a, b) => b.units - a.units);
}
