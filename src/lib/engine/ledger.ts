import { d, Decimal, sum, ZERO } from "./money";
import { normalizeCosts, type NormalizedCosts } from "./defaults";
import type { OrderInput, PauseInput, ShowInput, StaffRole, StaffShift } from "./types";

/**
 * The minute ledger — single source of truth for show profit.
 *
 * Every dollar of revenue and every cost is placed into exactly one 60-second
 * bucket of the show timeline. Show totals (computeProfit) and minute views
 * (computeMinutes) both read this ledger, so they always agree to the cent.
 *
 *   Revenue           order's minute (created or paid time, per the snapshot's basis)
 *   Product cost      order's minute (SKU cost, else default — flagged "estimated")
 *   Commission        order's minute, paid to staff on shift at that time
 *   Packing           order's minute
 *   Platform fees     order's minute (actual when reported, else % + fixed per order)
 *   Net shipping      order's minute (actual, else package share, else estimate)
 *   Staff hourly pay  accrues every active second the person is on shift
 *   Hourly expenses   accrue every active second of the show, sales or not
 *   Flat staff pay    minute the person joined
 *   Fixed expenses    minute they were incurred
 *
 * Refunds reduce revenue (and the fee estimate) in the ORIGINAL order's minute,
 * so the final view replays the show as it truly turned out. Commission, product
 * and packing costs on refunded units are kept: the commission was earned and
 * the merchandise is assumed not recovered.
 *
 * Orders time-stamped outside the show window (e.g. a late-arriving order that
 * belongs to the show) land in the first or last minute and are counted in
 * `outsideWindowOrders`.
 */

export type MinuteRow = {
  index: number;
  start: number; // epoch ms
  end: number; // epoch ms
  activeMs: number;
  orders: number;
  units: number;
  revenue: Decimal;
  cogs: Decimal;
  commission: Decimal;
  packing: Decimal;
  fees: Decimal;
  labor: Decimal; // hourly + flat staff pay
  hourlyExpenses: Decimal;
  fixedExpenses: Decimal;
  /** Net seller shipping cost (positive = cost, negative = shipping made money). */
  shipping: Decimal;
};

export type OrderLine = {
  order: OrderInput;
  minute: number;
  at: number;
  cancelled: boolean;
  gross: Decimal;
  sellerDiscount: Decimal;
  platformDiscount: Decimal;
  refunds: Decimal;
  net: Decimal;
  unitsShipped: number;
  unitsRefunded: number;
  cogs: Decimal;
  commission: Decimal;
  packing: Decimal;
  feeEstimatePct: Decimal;
  feeEstimateFixed: Decimal;
  feeActual: Decimal | null;
  /** Net seller shipping cost for this order (positive = cost). */
  shippingNetCost: Decimal;
  shippingSource: "actual" | "package" | "estimate" | "unknown";
  estimatedSkus: string[];
};

export type StaffLine = {
  staffId: string | null;
  name: string;
  role: StaffRole;
  activeMs: number;
  commission: Decimal;
  hourly: Decimal;
  flat: Decimal;
  unitsCredited: number;
  salesCredited: Decimal;
  /** Effective $ per sold item (tiered by the show's average price). */
  perUnitRate: Decimal;
};

export type Ledger = {
  costs: NormalizedCosts;
  start: number;
  end: number;
  activeMs: number;
  minutes: MinuteRow[];
  orders: OrderLine[];
  staff: StaffLine[];
  hourlyExpenseTotals: { label: string; category: string; amount: Decimal }[];
  fixedExpenseTotals: { category: string; amount: Decimal }[];
  outsideWindowOrders: number;
  /** Scan-report cost not attached to any order (no sales recorded yet); counted in product cost. */
  scanReportUnassigned: Decimal;
};

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = new Decimal(3_600_000);

/** Active ms inside [a, b] after removing paused time. */
export function activeWithin(a: number, b: number, pauses: PauseInput[], showEnd: number): number {
  if (!(b > a)) return 0;
  let paused = 0;
  for (const p of pauses) {
    const ps = Math.max(Date.parse(p.pausedAt), a);
    const pe = Math.min(p.resumedAt ? Date.parse(p.resumedAt) : showEnd, b);
    if (pe > ps) paused += pe - ps;
  }
  return Math.max(0, b - a - paused);
}

export function skuCost(costs: { skuCosts: Record<string, string>; defaultProductCost: string }, sku: string | null) {
  if (sku && costs.skuCosts[sku] !== undefined) return { cost: d(costs.skuCosts[sku]), estimated: false };
  return { cost: d(costs.defaultProductCost), estimated: true };
}

/**
 * A giveaway line: the "Jewelry Giveaway" listing, a $0 item, or a TikTok LIVE lottery order.
 * Giveaways still cost the product, but they are not sales, so they're left out of
 * items-sold and the average prices.
 */
export function isGiveawayItem(order: OrderInput, item: OrderInput["items"][number]): boolean {
  return order.orderType === "ZERO_LOTTERY" || /give\s*-?\s*a\s*way/i.test(item.title) || d(item.unitPrice).isZero();
}

export type AveragePool = { revenue: Decimal; units: number; orders: number; hasAuction: boolean; giveawayUnits: number; avgPrice: Decimal | null };

/**
 * The basis for average prices: giveaway items never count; if the LIVE has any auction
 * orders, only auction items count. Refunded units/amounts are netted out.
 */
export function averagePool(orders: OrderInput[]): AveragePool {
  const live = orders.filter((o) => o.status !== "cancelled");
  const hasAuction = live.some((o) => o.orderType === "AUCTION");
  let revenue = ZERO;
  let units = 0;
  let count = 0;
  let giveawayUnits = 0;
  for (const o of live) {
    const refundedQty = new Map<string, number>();
    for (const r of o.refunds) if (r.externalItemId) refundedQty.set(r.externalItemId, (refundedQty.get(r.externalItemId) ?? 0) + r.quantity);
    let orderRev = ZERO;
    let orderUnits = 0;
    for (const it of o.items) {
      const qty = Math.max(0, Math.trunc(it.quantity));
      const netQty = Math.max(0, qty - (refundedQty.get(it.externalItemId) ?? 0));
      if (isGiveawayItem(o, it)) {
        giveawayUnits += netQty;
        continue;
      }
      if (hasAuction && o.orderType !== "AUCTION") continue;
      const lineRefund = o.refunds.filter((r) => r.externalItemId === it.externalItemId).reduce((a, r) => a.plus(r.amount), ZERO);
      orderRev = orderRev.plus(d(it.unitPrice).times(qty).minus(d(it.sellerDiscount)).minus(lineRefund));
      orderUnits += netQty;
    }
    const orderLevel = o.refunds.filter((r) => !r.externalItemId).reduce((a, r) => a.plus(r.amount), ZERO);
    if (orderUnits > 0) {
      revenue = revenue.plus(orderRev.minus(orderLevel));
      units += orderUnits;
      count++;
    }
  }
  return { revenue, units, orders: count, hasAuction, giveawayUnits, avgPrice: units > 0 ? revenue.div(units) : null };
}

/** Per-item commission for a pay plan at a given show average price (whole-dollar average). */
export function perUnitRate(comp: { perUnit: string; pctOfAvgPrice?: string }, avgPrice: Decimal | null): Decimal {
  const base = d(comp.perUnit);
  const pct = d(comp.pctOfAvgPrice);
  if (pct.isZero() || avgPrice === null) return base;
  // the average is rounded DOWN to whole dollars first: $12.90 → $12 → $1.20 per item
  return Decimal.max(base, avgPrice.floor().times(pct));
}

/** Revenue/volume/product-cost breakdown of a single order (no time context). */
export function breakdownOrder(order: OrderInput, costs: { skuCosts: Record<string, string>; defaultProductCost: string }) {
  let gross = ZERO;
  let sellerDiscount = ZERO;
  let platformDiscount = ZERO;
  let unitsShipped = 0;
  let productCost = ZERO;
  const estimatedSkus: string[] = [];
  for (const item of order.items) {
    const qty = Math.max(0, Math.trunc(item.quantity));
    gross = gross.plus(d(item.unitPrice).times(qty));
    sellerDiscount = sellerDiscount.plus(d(item.sellerDiscount));
    platformDiscount = platformDiscount.plus(d(item.platformDiscount));
    unitsShipped += qty;
    const { cost, estimated } = skuCost(costs, item.sku);
    productCost = productCost.plus(cost.times(qty));
    if (estimated) estimatedSkus.push(item.sku ?? "(no sku)");
  }
  const refunds = sum(order.refunds.map((r) => d(r.amount)));
  const unitsRefunded = Math.min(
    unitsShipped,
    order.refunds.reduce((acc, r) => acc + Math.max(0, Math.trunc(r.quantity)), 0),
  );
  const net = gross.minus(sellerDiscount).minus(refunds);
  return { gross, sellerDiscount, platformDiscount, refunds, net, unitsShipped, unitsRefunded, productCost, estimatedSkus };
}

function defaultStaff(c: NormalizedCosts): StaffShift[] {
  return [
    { staffId: null, name: "Presenter", role: "host", joinedAt: null, leftAt: null, comp: c.presenter },
    { staffId: null, name: "Assistant", role: "assistant", joinedAt: null, leftAt: null, comp: c.assistant },
  ];
}

function emptyMinute(index: number, start: number, end: number, activeMs: number): MinuteRow {
  return {
    index,
    start,
    end,
    activeMs,
    orders: 0,
    units: 0,
    revenue: ZERO,
    cogs: ZERO,
    commission: ZERO,
    packing: ZERO,
    fees: ZERO,
    labor: ZERO,
    hourlyExpenses: ZERO,
    fixedExpenses: ZERO,
    shipping: ZERO,
  };
}

export function buildLedger(show: ShowInput, now: Date = new Date()): Ledger {
  const c = normalizeCosts(show.costs);
  const start = Date.parse(show.startedAt);
  const rawEnd = show.endedAt ? Date.parse(show.endedAt) : now.getTime();
  const end = Math.max(start, rawEnd);
  const pauses = show.pauses;
  const count = Math.max(1, Math.ceil((end - start) / MS_PER_MINUTE));
  const minuteOf = (t: number) => Math.min(count - 1, Math.max(0, Math.floor((t - start) / MS_PER_MINUTE)));

  // ---- buckets with active time ----
  const minutes: MinuteRow[] = [];
  let totalActive = 0;
  for (let i = 0; i < count; i++) {
    const a = start + i * MS_PER_MINUTE;
    const b = Math.min(a + MS_PER_MINUTE, end);
    const act = activeWithin(a, b, pauses, end);
    totalActive += act;
    minutes.push(emptyMinute(i, a, Math.max(a, b), act));
  }

  // ---- staff ----
  // The show's average item price sets the tiered per-item commission for everyone.
  const avgPool = averagePool(show.orders);
  const shifts = show.staff ?? defaultStaff(c);
  const staff: StaffLine[] = shifts.map((s) => ({
    staffId: s.staffId,
    name: s.name,
    role: s.role,
    activeMs: 0,
    commission: ZERO,
    hourly: ZERO,
    flat: ZERO,
    unitsCredited: 0,
    salesCredited: ZERO,
    perUnitRate: perUnitRate(s.comp, avgPool.avgPrice),
  }));
  const shiftBounds = shifts.map((s) => ({
    from: s.joinedAt ? Math.max(start, Date.parse(s.joinedAt)) : start,
    to: s.leftAt ? Math.min(end, Date.parse(s.leftAt)) : end,
  }));

  shifts.forEach((s, si) => {
    const { from, to } = shiftBounds[si];
    const rate = d(s.comp.perHour);
    for (const m of minutes) {
      const act = activeWithin(Math.max(m.start, from), Math.min(m.end, to), pauses, end);
      if (act <= 0) continue;
      staff[si].activeMs += act;
      if (!rate.isZero()) {
        const amt = rate.times(act).div(MS_PER_HOUR);
        m.labor = m.labor.plus(amt);
        staff[si].hourly = staff[si].hourly.plus(amt);
      }
    }
    const flat = d(s.comp.flatPerShow);
    if (!flat.isZero()) {
      const m = minutes[minuteOf(from)];
      m.labor = m.labor.plus(flat);
      staff[si].flat = flat;
    }
  });

  // ---- hourly expenses ----
  const hourlyExpenseTotals = c.hourlyExpenses.map((h) => ({ label: h.label, category: h.category, amount: ZERO }));
  c.hourlyExpenses.forEach((h, hi) => {
    const rate = d(h.perHour);
    if (rate.isZero()) return;
    for (const m of minutes) {
      if (m.activeMs <= 0) continue;
      const amt = rate.times(m.activeMs).div(MS_PER_HOUR);
      m.hourlyExpenses = m.hourlyExpenses.plus(amt);
      hourlyExpenseTotals[hi].amount = hourlyExpenseTotals[hi].amount.plus(amt);
    }
  });

  // ---- fixed expenses ----
  const fixedByCat = new Map<string, Decimal>();
  for (const e of show.expenses) {
    const amt = d(e.amount);
    const m = minutes[minuteOf(Date.parse(e.incurredAt))];
    m.fixedExpenses = m.fixedExpenses.plus(amt);
    const cat = e.category ?? (e.kind === "giveaway" ? "giveaways" : "other");
    fixedByCat.set(cat, (fixedByCat.get(cat) ?? ZERO).plus(amt));
  }

  // ---- packages: label cost split equally across the package's orders ----
  const packageShare = new Map<string, { share: Decimal; known: boolean }>();
  for (const p of show.packages ?? []) {
    const n = p.orderIds.length;
    if (!n) continue;
    const known = p.labelCost !== null;
    const base = known ? d(p.labelCost).minus(d(p.reimbursement)) : d(c.shippingEstimatePerPackage);
    if (!known && c.shippingEstimatePerPackage === null) continue;
    const share = base.div(n);
    for (const id of p.orderIds) packageShare.set(id, { share, known });
  }

  // ---- orders ----
  let outsideWindowOrders = 0;
  let scanReportUnassigned = ZERO;
  const lines: OrderLine[] = [];
  for (const order of show.orders) {
    const basisTime = c.revenueBasis === "paid" && order.paidAt ? order.paidAt : order.createdAt;
    const at = Date.parse(basisTime);
    const mi = minuteOf(at);
    const b = breakdownOrder(order, c);
    const cancelled = order.status === "cancelled";
    const line: OrderLine = {
      order,
      minute: mi,
      at,
      cancelled,
      gross: b.gross,
      sellerDiscount: b.sellerDiscount,
      platformDiscount: b.platformDiscount,
      refunds: b.refunds,
      net: b.net,
      unitsShipped: b.unitsShipped,
      unitsRefunded: b.unitsRefunded,
      cogs: b.productCost,
      commission: ZERO,
      packing: ZERO,
      feeEstimatePct: ZERO,
      feeEstimateFixed: ZERO,
      feeActual: null,
      shippingNetCost: ZERO,
      shippingSource: "unknown",
      estimatedSkus: b.estimatedSkus,
    };
    lines.push(line);
    if (cancelled) continue;
    if (at < start || at > end) outsideWindowOrders++;

    const clamped = Math.min(end, Math.max(start, at));
    // Staff are paid on sold items only — giveaway items earn no commission.
    let compUnits = 0;
    let salesForComp = ZERO;
    for (const it of order.items) {
      if (isGiveawayItem(order, it)) continue;
      const qty = Math.max(0, Math.trunc(it.quantity));
      compUnits += qty;
      salesForComp = salesForComp.plus(d(it.unitPrice).times(qty)).minus(d(it.sellerDiscount));
    }
    shifts.forEach((s, si) => {
      const { from, to } = shiftBounds[si];
      if (clamped < from || clamped > to) return;
      const amt = staff[si].perUnitRate.times(compUnits).plus(d(s.comp.percentOfSales).times(salesForComp));
      if (amt.isZero()) return;
      line.commission = line.commission.plus(amt);
      staff[si].commission = staff[si].commission.plus(amt);
      staff[si].unitsCredited += compUnits;
      staff[si].salesCredited = staff[si].salesCredited.plus(salesForComp);
    });

    line.packing = d(c.packingPerItem).times(b.unitsShipped);

    if (order.actualPlatformFees !== null) {
      line.feeActual = d(order.actualPlatformFees);
    } else {
      line.feeEstimatePct = Decimal.max(b.net, ZERO).times(d(c.percentFee));
      line.feeEstimateFixed = d(c.fixedFeePerTransaction);
    }

    // shipping: actual order-level > package share > estimate > unknown (pass-through)
    const credit = d(order.customerShipping).plus(d(order.platformShippingSubsidy));
    const pkg = packageShare.get(order.externalOrderId);
    if (order.sellerShippingCost !== null) {
      line.shippingNetCost = d(order.sellerShippingCost).minus(credit);
      line.shippingSource = "actual";
    } else if (pkg) {
      // Not settled by TikTok: customer shipping may offset the label, but never turns
      // shipping into profit (combined orders often pay shipping once).
      line.shippingNetCost = Decimal.max(ZERO, pkg.share.minus(credit));
      line.shippingSource = pkg.known ? "package" : "estimate";
    } else if (c.shippingEstimatePerPackage !== null) {
      line.shippingNetCost = Decimal.max(ZERO, d(c.shippingEstimatePerPackage).minus(credit));
      line.shippingSource = "estimate";
    }

    const m = minutes[mi];
    m.orders += 1;
    m.units += b.unitsShipped - b.unitsRefunded;
    m.revenue = m.revenue.plus(b.net);
    m.cogs = m.cogs.plus(b.productCost);
    m.commission = m.commission.plus(line.commission);
    m.packing = m.packing.plus(line.packing);
    m.fees = m.fees.plus(line.feeActual ?? line.feeEstimatePct.plus(line.feeEstimateFixed));
    m.shipping = m.shipping.plus(line.shippingNetCost);
  }

  // ---- end-of-show scan report: product cost is exactly the report's total COGS ----
  if (c.scanReport) {
    const target = d(c.scanReport.totalCogs);
    const sold = lines.filter((l) => !l.cancelled);
    const counted = sold.reduce((a, l) => a.plus(l.cogs), ZERO);
    const units = sold.reduce((a, l) => a + l.unitsShipped, 0);
    // weight by the per-item costs found (UPC = SKU); without any, by units
    const weightOf = (l: OrderLine) => (counted.gt(0) ? l.cogs.div(counted) : units > 0 ? new Decimal(l.unitsShipped).div(units) : ZERO);
    let assigned = ZERO;
    for (const l of sold) {
      const next = target.times(weightOf(l));
      minutes[l.minute].cogs = minutes[l.minute].cogs.minus(l.cogs).plus(next);
      l.cogs = next;
      l.estimatedSkus = [];
      assigned = assigned.plus(next);
    }
    // nothing sold (yet): keep the cost visible in the first minute
    if (!sold.length || assigned.isZero()) minutes[0].cogs = minutes[0].cogs.plus(target.minus(assigned));
    scanReportUnassigned = !sold.length || assigned.isZero() ? target.minus(assigned) : ZERO;
  }

  return {
    costs: c,
    start,
    end,
    activeMs: totalActive,
    minutes,
    orders: lines,
    staff,
    hourlyExpenseTotals,
    fixedExpenseTotals: [...fixedByCat.entries()].map(([category, amount]) => ({ category, amount })),
    outsideWindowOrders,
    scanReportUnassigned,
  };
}

/** Total of all costs in a minute (excluding shipping, which may be a credit). */
export function minuteExpenses(m: MinuteRow): Decimal {
  return m.cogs.plus(m.commission).plus(m.packing).plus(m.fees).plus(m.labor).plus(m.hourlyExpenses).plus(m.fixedExpenses);
}

export function minuteProfit(m: MinuteRow): Decimal {
  return m.revenue.minus(minuteExpenses(m)).minus(m.shipping);
}
