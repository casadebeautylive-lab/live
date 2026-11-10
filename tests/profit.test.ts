import { describe, expect, it } from "vitest";
import { computeProfit } from "@/lib/engine/profit";
import { computeVelocity } from "@/lib/engine/velocity";
import { productBreakdown } from "@/lib/engine/products";
import type { OrderInput, ShowInput } from "@/lib/engine/types";
import { evenOrders, LEGACY_COSTS, ONE_HOUR_LATER, show as baseShow, START } from "./helpers";

// These tests pin the behaviour of shows saved with the original (v1) cost snapshot.
const DEFAULT_COSTS = LEGACY_COSTS;
const show = (orders: OrderInput[], extra: Partial<ShowInput> = {}) => baseShow(orders, { costs: LEGACY_COSTS, ...extra });

const money = (v: { toFixed: (n: number) => string } | null) => v?.toFixed(2);

describe("legacy snapshot — original Example A — strong show", () => {
  const m = computeProfit(show(evenOrders(100, "10.00")), ONE_HOUR_LATER);

  it("revenue and volume", () => {
    expect(money(m.netMerchandise)).toBe("1000.00");
    expect(m.itemsSold).toBe(100);
    expect(m.orders).toBe(100);
  });

  it("every cost line matches the spec", () => {
    expect(money(m.costs.product)).toBe("200.00");
    expect(money(m.costs.commission)).toBe("100.00");
    expect(money(m.costs.packing)).toBe("20.00");
    expect(money(m.labor.assistant)).toBe("20.00");
    expect(money(m.costs.hourlyExpenses)).toBe("35.00");
    expect(money(m.costs.percentFee)).toBe("74.00");
    expect(money(m.costs.fixedFee)).toBe("30.00");
    expect(money(m.totalCosts)).toBe("479.00");
  });

  it("profit $521, $5.21/item, 52.1% margin, $521/hour", () => {
    expect(money(m.operatingProfit)).toBe("521.00");
    expect(money(m.profitPerItem)).toBe("5.21");
    expect(m.marginPct!.toFixed(1)).toBe("52.1");
    expect(money(m.profitPerHour)).toBe("521.00");
  });

  it("flags fees and product cost as estimated", () => {
    expect(m.flags.feesEstimated).toBe(true);
    expect(m.flags.productCostEstimated).toBe(true);
  });
});

describe("legacy snapshot — original Example B — slower show", () => {
  const m = computeProfit(show(evenOrders(60, "10.00")), ONE_HOUR_LATER);

  it("totals", () => {
    expect(money(m.costs.percentFee)).toBe("44.40");
    expect(money(m.costs.fixedFee)).toBe("18.00");
    expect(money(m.totalCosts)).toBe("309.40");
    expect(money(m.operatingProfit)).toBe("290.60");
  });

  it("per-item and margin", () => {
    expect(money(m.profitPerItem)).toBe("4.84");
    expect(m.marginPct!.toFixed(2)).toBe("48.43");
  });

  it("40% less volume cuts hourly profit by more than 40% because time costs are fixed", () => {
    const a = computeProfit(show(evenOrders(100, "10.00")), ONE_HOUR_LATER);
    const drop = a.profitPerHour!.minus(m.profitPerHour!).div(a.profitPerHour!);
    expect(drop.gt(0.4)).toBe(true);
  });
});

describe("time-based costs", () => {
  it("accrue with zero sales", () => {
    const m = computeProfit(show([]), new Date(Date.parse(START) + 30 * 60_000));
    expect(money(m.labor.assistant)).toBe("10.00");
    expect(money(m.costs.hourlyExpenses)).toBe("17.50");
    expect(money(m.operatingProfit)).toBe("-27.50");
  });

  it("stop accruing while paused", () => {
    const start = Date.parse(START);
    const m = computeProfit(
      show([], {
        pauses: [
          {
            pausedAt: new Date(start + 20 * 60_000).toISOString(),
            resumedAt: new Date(start + 40 * 60_000).toISOString(),
          },
        ],
      }),
      new Date(start + 60 * 60_000),
    );
    expect(m.activeSeconds).toBe(40 * 60);
    expect(money(m.labor.assistant)).toBe("13.33");
  });

  it("stop at show end", () => {
    const m = computeProfit(
      show([], { endedAt: ONE_HOUR_LATER.toISOString() }),
      new Date(ONE_HOUR_LATER.getTime() + 5 * 3_600_000),
    );
    expect(money(m.costs.hourlyExpenses)).toBe("35.00");
  });

  it("hourly and flat host compensation combine with per-item", () => {
    const costs = { ...DEFAULT_COSTS, host: { perItem: "0.50", perHour: "15", flatPerShow: "50" } };
    const m = computeProfit(show(evenOrders(10, "10.00"), { costs }), ONE_HOUR_LATER);
    expect(money(m.costs.commission)).toBe("5.00");
    expect(money(m.labor.byStaff[0].hourly)).toBe("15.00");
    expect(money(m.labor.byStaff[0].flat)).toBe("50.00");
  });
});

describe("orders vs units, fees per transaction", () => {
  it("one order of three bracelets = 1 order, 3 units, one $0.30 fee", () => {
    const [o] = evenOrders(1, "10.00");
    o.items[0].quantity = 3;
    const m = computeProfit(show([o]), ONE_HOUR_LATER);
    expect(m.orders).toBe(1);
    expect(m.itemsSold).toBe(3);
    expect(money(m.costs.fixedFee)).toBe("0.30");
    expect(money(m.costs.product)).toBe("6.00");
  });
});

describe("discounts, shipping and GMV", () => {
  it("seller discounts reduce revenue; platform discounts do not", () => {
    const [o] = evenOrders(1, "20.00");
    o.items[0].sellerDiscount = "2.00";
    o.items[0].platformDiscount = "5.00";
    const m = computeProfit(show([o]), ONE_HOUR_LATER);
    expect(money(m.grossMerchandise)).toBe("20.00");
    expect(money(m.netMerchandise)).toBe("18.00");
    expect(money(m.platformDiscounts)).toBe("5.00");
  });

  it("customer shipping is never revenue and is pass-through when seller cost is unknown", () => {
    const orders = evenOrders(2, "10.00", { customerShipping: "5.99" });
    const m = computeProfit(show(orders), ONE_HOUR_LATER);
    expect(money(m.netMerchandise)).toBe("20.00");
    expect(money(m.customerShipping)).toBe("11.98");
    expect(money(m.shippingContribution)).toBe("0.00");
    expect(m.flags.shippingEstimated).toBe(true);
  });

  it("net shipping contribution counts once when the seller label cost is known", () => {
    const orders = evenOrders(1, "10.00", {
      customerShipping: "5.00",
      platformShippingSubsidy: "2.00",
      sellerShippingCost: "8.00",
    });
    const m = computeProfit(show(orders), ONE_HOUR_LATER);
    expect(money(m.shippingContribution)).toBe("-1.00");
    const base = computeProfit(show(evenOrders(1, "10.00")), ONE_HOUR_LATER);
    expect(money(m.operatingProfit.minus(base.operatingProfit))).toBe("-1.00");
  });

  it("platform GMV is reported separately, never derived", () => {
    const m1 = computeProfit(show(evenOrders(2, "10.00")), ONE_HOUR_LATER);
    expect(m1.platformGmv).toBeNull();
    const m2 = computeProfit(show(evenOrders(2, "10.00", { platformGmv: "13.50" })), ONE_HOUR_LATER);
    expect(money(m2.platformGmv)).toBe("27.00");
    expect(money(m2.netMerchandise)).toBe("20.00");
  });
});

describe("actual platform fees and settlements", () => {
  it("actual fees replace the estimate for that order", () => {
    const orders = evenOrders(2, "10.00");
    orders[0].actualPlatformFees = "1.50";
    const m = computeProfit(show(orders), ONE_HOUR_LATER);
    expect(money(m.costs.actualPlatformFees)).toBe("1.50");
    expect(money(m.costs.percentFee)).toBe("0.74");
    expect(money(m.costs.fixedFee)).toBe("0.30");
    expect(money(m.platformFees)).toBe("2.54");
  });

  it("all-actual fees clears the estimate flag", () => {
    const m = computeProfit(show(evenOrders(2, "10.00", { actualPlatformFees: "1.00" })), ONE_HOUR_LATER);
    expect(m.flags.feesEstimated).toBe(false);
  });

  it("confirmed settlement is separate from estimated payout", () => {
    const m = computeProfit(show(evenOrders(2, "10.00", { settlementAmount: "8.80" })), ONE_HOUR_LATER);
    expect(money(m.confirmedSettlement)).toBe("17.60");
    expect(m.settledOrders).toBe(2);
  });
});

describe("refunds and cancellations", () => {
  it("cancelled orders drop out of every total", () => {
    const orders = evenOrders(3, "10.00");
    orders[1].status = "cancelled";
    const m = computeProfit(show(orders), ONE_HOUR_LATER);
    expect(m.orders).toBe(2);
    expect(m.cancelledOrders).toBe(1);
    expect(money(m.netMerchandise)).toBe("20.00");
    expect(money(m.costs.fixedFee)).toBe("0.60");
    expect(money(m.costs.product)).toBe("4.00");
  });

  it("a refund reduces revenue and items sold but keeps the item cost", () => {
    const orders = evenOrders(2, "10.00");
    orders[0].refunds = [
      { externalRefundId: "r1", externalItemId: "o0-1", quantity: 1, amount: "10.00", refundedAt: START },
    ];
    const m = computeProfit(show(orders), ONE_HOUR_LATER);
    expect(money(m.netMerchandise)).toBe("10.00");
    expect(m.itemsSold).toBe(1);
    expect(m.unitsRefunded).toBe(1);
    expect(money(m.costs.product)).toBe("4.00");
    expect(money(m.costs.percentFee)).toBe("0.74");
  });
});

describe("SKU costs", () => {
  it("uses SKU-specific cost and only flags unknown SKUs", () => {
    const orders = evenOrders(2, "10.00");
    orders[0].items[0].sku = "HOOP-14K";
    orders[1].items[0].sku = "CUFF-01";
    const costs = { ...DEFAULT_COSTS, skuCosts: { "HOOP-14K": "3.25" } };
    const m = computeProfit(show(orders, { costs }), ONE_HOUR_LATER);
    expect(money(m.costs.product)).toBe("5.25");
    expect(m.flags.estimatedSkus).toEqual(["CUFF-01"]);
  });

  it("product breakdown sums to engine revenue", () => {
    const orders = evenOrders(4, "12.00");
    orders.forEach((o, i) => (o.items[0].sku = i % 2 ? "A" : "B"));
    const rows = productBreakdown(orders, DEFAULT_COSTS);
    const total = rows.reduce((a, r) => a.plus(r.netRevenue), rows[0].netRevenue.minus(rows[0].netRevenue));
    expect(money(total)).toBe(money(computeProfit(show(orders), ONE_HOUR_LATER).netMerchandise));
    expect(rows.map((r) => r.units)).toEqual([2, 2]);
  });
});

describe("decimal safety", () => {
  it("no floating-point drift on cents", () => {
    const m = computeProfit(show(evenOrders(3, "0.10")), ONE_HOUR_LATER);
    expect(m.netMerchandise.toString()).toBe("0.3");
  });
});

describe("break-even", () => {
  it("units needed to cover time costs at current contribution per unit", () => {
    const m = computeProfit(show(evenOrders(10, "10.00")), ONE_HOUR_LATER);
    // per unit: 10 − 2 − 1 − 0.20 − 0.74 − 0.30 = 5.76; fixed = 55 → 10 units
    expect(m.breakEven.contributionPerUnit!.toFixed(2)).toBe("5.76");
    expect(m.breakEven.unitsNeeded).toBe(10);
    expect(m.breakEven.unitsRemaining).toBe(0);
  });
});

describe("velocity", () => {
  it("uses actual sale timestamps, not duration ÷ items", () => {
    const start = Date.parse(START);
    const orders = evenOrders(3, "10.00");
    orders[0].createdAt = new Date(start + 10 * 60_000).toISOString();
    orders[1].createdAt = new Date(start + 11 * 60_000).toISOString();
    orders[2].createdAt = new Date(start + 13 * 60_000).toISOString();
    const v = computeVelocity(show(orders), new Date(start + 60 * 60_000));
    expect(v.avgSecondsBetweenSales).toBe(90);
    expect(v.secondsSinceLastSale).toBe(47 * 60);
    expect(v.longestGapSeconds).toBe(47 * 60);
  });

  it("counts out-of-order arrivals", () => {
    const orders = evenOrders(3, "10.00");
    orders[0].receivedAt = "2026-10-08T23:30:00Z";
    orders[1].receivedAt = "2026-10-08T23:29:00Z"; // later-created order arrived first
    orders[2].receivedAt = "2026-10-08T23:50:00Z";
    orders[0].createdAt = "2026-10-08T23:10:00Z";
    orders[1].createdAt = "2026-10-08T23:20:00Z";
    orders[2].createdAt = "2026-10-08T23:40:00Z";
    expect(computeVelocity(show(orders), ONE_HOUR_LATER).outOfOrderEvents).toBe(1);
  });
});
