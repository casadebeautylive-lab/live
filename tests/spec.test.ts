/**
 * Profit Tracker spec §17 — calculation tests on the new default cost rules:
 * $2.50/unit product, $1.00/unit presenter, $20/h assistant, 6% TikTok, $30/h giveaways/misc.
 */
import { describe, expect, it } from "vitest";
import { computeProfit } from "@/lib/engine/profit";
import { computeMinutes, liveEstimateView, reconciliationAdjustments } from "@/lib/engine/minutes";
import { DEFAULT_COSTS, ZERO_COMP } from "@/lib/engine/defaults";
import type { OrderInput, StaffShift } from "@/lib/engine/types";
import { evenOrders, ONE_HOUR_LATER, show, START } from "./helpers";

const money = (v: { toFixed: (n: number) => string } | null | undefined) => v?.toFixed(2);
const at = (min: number) => new Date(Date.parse(START) + min * 60_000).toISOString();
const ENDED_1H = { endedAt: ONE_HOUR_LATER.toISOString() };

function order(id: string, min: number, price = "10.00", qty = 1, extra: Partial<OrderInput> = {}): OrderInput {
  return {
    externalOrderId: id,
    createdAt: at(min),
    status: "active",
    isTest: true,
    items: [{ externalItemId: `${id}-1`, sku: null, title: "Gold hoop", quantity: qty, unitPrice: price, sellerDiscount: "0", platformDiscount: "0" }],
    refunds: [],
    customerShipping: "0",
    platformShippingSubsidy: null,
    sellerShippingCost: null,
    platformGmv: null,
    actualPlatformFees: null,
    settlementAmount: null,
    ...extra,
  };
}

describe("§4 example — 100 units at $10 in a 60-minute LIVE", () => {
  const m = computeProfit(show(evenOrders(100, "10.00"), ENDED_1H));

  it("every cost line matches the spec", () => {
    expect(money(m.netMerchandise)).toBe("1000.00");
    expect(money(m.costs.product)).toBe("250.00");
    expect(money(m.labor.presenter)).toBe("100.00");
    expect(money(m.labor.assistant)).toBe("20.00");
    expect(money(m.costs.hourlyExpenses)).toBe("30.00");
    expect(money(m.platformFees)).toBe("60.00");
    expect(money(m.totalCosts)).toBe("460.00");
  });

  it("$540 profit, $9/min, $540/h, 54% margin", () => {
    expect(money(m.operatingProfit)).toBe("540.00");
    expect(money(m.profitPerMinute)).toBe("9.00");
    expect(money(m.profitPerHour)).toBe("540.00");
    expect(m.marginPct!.toFixed(0)).toBe("54");
  });

  it("an additional $50 seller-paid shipping makes it $490", () => {
    const orders = evenOrders(100, "10.00");
    orders[0].sellerShippingCost = "50.00";
    const s = computeProfit(show(orders, ENDED_1H));
    expect(money(s.netShippingCost)).toBe("50.00");
    expect(money(s.operatingProfit)).toBe("490.00");
  });
});

describe("LIVE durations other than one hour", () => {
  it("§11 example: 3-hour show, 280 units, $3,200", () => {
    const orders = evenOrders(280, "0").map((o, i) => ({
      ...o,
      createdAt: at((i * 180) / 280),
      items: [{ ...o.items[0], unitPrice: i < 160 ? "12.00" : "10.6666666666666666666666666667" }],
    }));
    // 160 × $12 + 120 × $10.666… = $3,200
    const m = computeProfit(show(orders, { endedAt: at(180) }));
    expect(money(m.netMerchandise)).toBe("3200.00");
    expect(money(m.costs.product)).toBe("700.00");
    // average $11.43 → rounded down to $11 → $1.10 per item: 280 × $1.10 = $308
    expect(money(m.labor.presenter)).toBe("308.00");
    expect(money(m.labor.assistant)).toBe("60.00");
    expect(money(m.costs.hourlyExpenses)).toBe("90.00");
    expect(money(m.platformFees)).toBe("192.00");
    expect(money(m.operatingProfit)).toBe("1850.00");
  });

  it("25-minute show prorates hourly costs", () => {
    const m = computeProfit(show([], { endedAt: at(25) }));
    expect(money(m.labor.assistant)).toBe("8.33");
    expect(money(m.costs.hourlyExpenses)).toBe("12.50");
  });
});

describe("§5 zero-sales minutes still cost money", () => {
  it("each empty minute loses $0.8333 ($20/h + $30/h)", () => {
    const v = computeMinutes(show([], { endedAt: at(10) }));
    expect(v.minutes).toHaveLength(10);
    for (const m of v.minutes) expect(m.profit.toFixed(4)).toBe("-0.8333");
    expect(money(v.stats.totalProfit)).toBe("-8.33");
  });
});

describe("minute ledger", () => {
  const orders = [order("a", 0.5, "20.00"), order("b", 2.2, "50.00", 2), order("c", 2.9, "15.00")];
  const v = computeMinutes(show(orders, { endedAt: at(30) }));

  it("minutes sum exactly to the show total", () => {
    const total = v.minutes.reduce((a, m) => a.plus(m.profit), v.minutes[0].profit.minus(v.minutes[0].profit));
    expect(total.toFixed(10)).toBe(v.totals.operatingProfit.toFixed(10));
    expect(v.minutes.at(-1)!.cumulativeProfit.toFixed(10)).toBe(v.totals.operatingProfit.toFixed(10));
  });

  it("puts each sale and its costs in its own minute", () => {
    const m2 = v.minutes[2];
    expect(m2.orders).toBe(2);
    expect(m2.units).toBe(3);
    expect(money(m2.revenue)).toBe("115.00"); // 2×50 + 15
    expect(money(m2.cogs)).toBe("7.50");
    expect(money(m2.commission)).toBe("9.90"); // 3 items × $3.30 (10% of the $33.75 average rounded down to $33)
    expect(money(m2.fees)).toBe("6.90");
    expect(m2.labor.toFixed(4)).toBe("0.3333");
    expect(m2.hourlyExpenses.toFixed(2)).toBe("0.50");
  });

  it("best minute, worst minute, rolling windows", () => {
    expect(v.stats.bestMinute!.index).toBe(2);
    expect(v.stats.worstMinute!.revenue.isZero()).toBe(true);
    expect(v.stats.best15!.startIndex).toBe(0);
    expect(money(v.stats.rolling5Revenue)).toBe("0.00"); // last 5 minutes were quiet
    expect(money(v.stats.avgProfitPerMinute)).toBe(money(v.totals.profitPerMinute));
  });

  it("paid-time basis moves revenue to the payment minute", () => {
    const o = order("p", 1, "10.00", 1, { paidAt: at(7.5) });
    const paid = computeMinutes(show([o], { endedAt: at(10), costs: { ...DEFAULT_COSTS, revenueBasis: "paid" } }));
    expect(money(paid.minutes[7].revenue)).toBe("10.00");
    expect(money(paid.minutes[1].revenue)).toBe("0.00");
  });
});

describe("customers and combined packages", () => {
  const buyer = { customerId: "buyer-1" };
  const orders = [order("x1", 5, "10.00", 1, buyer), order("x2", 10, "10.00", 1, buyer), order("x3", 20, "10.00", 1, buyer)];

  it("one package holding three orders pays the label once", () => {
    const m = computeProfit(
      show(orders, {
        ...ENDED_1H,
        packages: [{ externalPackageId: "PKG1", orderIds: ["x1", "x2", "x3"], labelCost: "6.00", reimbursement: "0" }],
      }),
    );
    expect(m.orders).toBe(3);
    expect(money(m.netShippingCost)).toBe("6.00");
    expect(m.flags.shippingUnknownOrders).toBe(0);
  });

  it("estimated package cost is replaced by the actual label cost without double counting", () => {
    const costs = { ...DEFAULT_COSTS, shippingEstimatePerPackage: "5.00" };
    const pkg = { externalPackageId: "PKG1", orderIds: ["x1", "x2", "x3"], reimbursement: "0" };
    const est = computeProfit(show(orders, { ...ENDED_1H, costs, packages: [{ ...pkg, labelCost: null }] }));
    expect(money(est.netShippingCost)).toBe("5.00");
    expect(est.flags.shippingEstimated).toBe(true);
    const act = computeProfit(show(orders, { ...ENDED_1H, costs, packages: [{ ...pkg, labelCost: "7.20" }] }));
    expect(money(act.netShippingCost)).toBe("7.20");
    expect(act.flags.shippingEstimated).toBe(false);
  });

  it("order-level actual shipping (from finance) wins over the package share", () => {
    const withActual = orders.map((o) => ({ ...o, sellerShippingCost: "2.00" }));
    const m = computeProfit(
      show(withActual, {
        ...ENDED_1H,
        packages: [{ externalPackageId: "PKG1", orderIds: ["x1", "x2", "x3"], labelCost: "6.00", reimbursement: "0" }],
      }),
    );
    expect(money(m.netShippingCost)).toBe("6.00");
  });

  it("customer-paid shipping offsets the label but is never revenue", () => {
    const o = order("s", 5, "10.00", 1, { customerShipping: "4.00", sellerShippingCost: "6.00" });
    const m = computeProfit(show([o], ENDED_1H));
    expect(money(m.netMerchandise)).toBe("10.00");
    expect(money(m.netShippingCost)).toBe("2.00");
  });
});

describe("refunds and cancellations", () => {
  it("partial refund reduces revenue and fee, keeps the earned commission", () => {
    const o = order("r", 5, "10.00", 3, {
      refunds: [{ externalRefundId: "R1", externalItemId: "r-1", quantity: 1, amount: "10.00", refundedAt: at(90) }],
    });
    const m = computeProfit(show([o], ENDED_1H));
    expect(money(m.netMerchandise)).toBe("20.00");
    expect(m.itemsSold).toBe(2);
    expect(money(m.platformFees)).toBe("1.20");
    expect(money(m.costs.commission)).toBe("3.00");
    expect(money(m.costs.product)).toBe("7.50");
  });

  it("cancelled orders are excluded everywhere", () => {
    const m = computeProfit(show([order("ok", 5), order("no", 6, "10.00", 1, { status: "cancelled" })], ENDED_1H));
    expect(m.orders).toBe(1);
    expect(m.cancelledOrders).toBe(1);
    expect(money(m.costs.commission)).toBe("1.00");
  });
});

describe("after the show closes", () => {
  const late = order("late", 63, "10.00", 1, { receivedAt: at(64) });
  const s = show([order("a", 10, "10.00", 1, { receivedAt: at(10) }), late], ENDED_1H);

  it("a late order still counts toward its show and is flagged", () => {
    const m = computeProfit(s);
    expect(m.orders).toBe(2);
    expect(m.flags.outsideWindowOrders).toBe(1);
    const v = computeMinutes(s);
    expect(v.minutes).toHaveLength(60);
    expect(v.minutes[59].orders).toBe(1);
  });

  it("original live estimate excludes later arrivals; adjustments show the difference", () => {
    const original = computeProfit(liveEstimateView(s));
    const final = computeProfit(s);
    expect(original.orders).toBe(1);
    const adj = reconciliationAdjustments(original, final);
    expect(money(adj.find((a) => a.label === "Product revenue")!.delta)).toBe("10.00");
  });
});

describe("staff joining or leaving midway", () => {
  const presenterA: StaffShift = { staffId: "A", name: "Sarah", role: "host", joinedAt: null, leftAt: at(30), comp: { ...ZERO_COMP, perUnit: "1.00" } };
  const presenterB: StaffShift = { staffId: "B", name: "Dana", role: "host", joinedAt: at(30), leftAt: null, comp: { ...ZERO_COMP, perUnit: "1.50", perHour: "10" } };
  const assistant: StaffShift = { staffId: "C", name: "Ben", role: "assistant", joinedAt: at(15), leftAt: at(45), comp: { ...ZERO_COMP, perHour: "20" } };
  const m = computeProfit(
    show([order("a", 10, "10.00", 2), order("b", 40, "10.00", 4)], { ...ENDED_1H, staff: [presenterA, presenterB, assistant] }),
  );

  it("commission goes to whoever was on shift", () => {
    const [a, b, c] = m.labor.byStaff;
    expect(money(a.commission)).toBe("2.00");
    expect(money(b.commission)).toBe("6.00");
    expect(money(b.hourly)).toBe("5.00");
    expect(money(c.hourly)).toBe("10.00");
    expect(c.minutes).toBe(30);
  });

  it("supports percentage-of-sales and flat pay", () => {
    const pct: StaffShift = { staffId: "D", name: "Rae", role: "host", joinedAt: null, leftAt: null, comp: { ...ZERO_COMP, percentOfSales: "0.10", flatPerShow: "25" } };
    const r = computeProfit(show([order("a", 10, "40.00")], { ...ENDED_1H, staff: [pct] }));
    expect(money(r.labor.presenter)).toBe("29.00");
  });
});

describe("product cost changes and snapshots", () => {
  it("SKU cost overrides the $2.50 fallback; old snapshots are untouched by new ones", () => {
    const o = order("k", 5);
    o.items[0].sku = "HOOP-14K";
    const before = computeProfit(show([o], ENDED_1H));
    const after = computeProfit(show([o], { ...ENDED_1H, costs: { ...DEFAULT_COSTS, skuCosts: { "HOOP-14K": "3.10" } } }));
    expect(money(before.costs.product)).toBe("2.50");
    expect(before.flags.productCostEstimated).toBe(true);
    expect(money(after.costs.product)).toBe("3.10");
    expect(after.flags.productCostEstimated).toBe(false);
  });
});

describe("estimated → settled without double counting", () => {
  it("actual fees replace the estimate; settled proceeds give the reconciled profit", () => {
    const orders = [order("a", 5, "10.00"), order("b", 6, "10.00")];
    const est = computeProfit(show(orders, ENDED_1H));
    expect(est.dataStatus).toBe("estimated");
    expect(est.reconciledProfit).toBeNull();

    // TikTok settles each order at $9.10: $10 − $0.60 commission − $0.30 other fees
    const settled = orders.map((o) => ({ ...o, actualPlatformFees: "0.90", settlementAmount: "9.10" }));
    const fin = computeProfit(show(settled, ENDED_1H));
    expect(money(fin.platformFees)).toBe("1.80");
    expect(fin.flags.feesEstimated).toBe(false);
    expect(fin.dataStatus).toBe("finalized");
    // 18.20 settled − 5.00 product − 2.00 presenter − 20.00 assistant − 30.00 misc
    expect(money(fin.reconciledProfit)).toBe("-38.80");
    expect(money(fin.operatingProfit)).toBe("-38.80");
  });

  it("partially settled shows report their status", () => {
    const orders = [order("a", 5, "10.00", 1, { settlementAmount: "9.40" }), order("b", 6)];
    expect(computeProfit(show(orders, ENDED_1H)).dataStatus).toBe("partially_reconciled");
  });
});

describe("customer shipping is not automatically profit", () => {
  it("before settlement, customer shipping offsets a combined package's label down to $0 — never below", () => {
    const orders = ["p1", "p2", "p3"].map((id, i) => order(id, 5 + i, "10.00", 1, { customerShipping: "4.99" }));
    const m = computeProfit(show(orders, { ...ENDED_1H, packages: [{ externalPackageId: "PK", orderIds: ["p1", "p2", "p3"], labelCost: "6.40", reimbursement: "0" }] }));
    expect(money(m.netShippingCost)).toBe("0.00");
  });

  it("TikTok's settled figure is authoritative, even when shipping nets a credit", () => {
    const o = order("s", 5, "10.00", 1, { customerShipping: "4.99", sellerShippingCost: "3.00" });
    expect(money(computeProfit(show([o], ENDED_1H)).netShippingCost)).toBe("-1.99");
  });
});

describe("giveaways and auction-only averages", () => {
  const give = (id: string, min: number, extra: Partial<OrderInput> = {}) => {
    const o = order(id, min, "0.00", 1, extra);
    o.items[0].title = "Jewelry Giveaway";
    return o;
  };

  it("giveaway items cost the product but aren't items sold or part of the averages", () => {
    const m = computeProfit(show([order("a", 1, "10.00"), order("b", 2, "20.00"), give("g", 3)], ENDED_1H));
    expect(m.itemsSold).toBe(2);
    expect(m.giveawayUnits).toBe(1);
    expect(money(m.avgSellingPrice)).toBe("15.00");
    expect(money(m.avgOrderValue)).toBe("15.00");
    expect(money(m.costs.product)).toBe("7.50"); // giveaway jewelry still costs $2.50
    expect(money(m.labor.presenter)).toBe("3.00"); // 2 sold items × $1.50 (avg $15); nothing on the giveaway
  });

  it("a priced 'Jewelry Giveaway' listing is still a giveaway", () => {
    const g = order("g", 3, "1.00");
    g.items[0].title = "jewelry give-away";
    const m = computeProfit(show([order("a", 1, "12.00"), g], ENDED_1H));
    expect(m.giveawayUnits).toBe(1);
    expect(money(m.avgSellingPrice)).toBe("12.00");
  });

  it("when the LIVE has auctions, averages use auction items only", () => {
    const orders = [
      order("a1", 1, "8.00", 1, { orderType: "AUCTION" }),
      order("a2", 2, "12.00", 1, { orderType: "AUCTION" }),
      order("n1", 3, "30.00", 1, { orderType: "" }), // buy-now
      give("g", 4, { orderType: "ZERO_LOTTERY" }),
    ];
    const m = computeProfit(show(orders, ENDED_1H));
    expect(m.avgBasis).toBe("auction");
    expect(money(m.avgSellingPrice)).toBe("10.00");
    expect(money(m.avgOrderValue)).toBe("10.00");
    expect(money(m.netMerchandise)).toBe("50.00"); // revenue still counts every sale
    expect(m.itemsSold).toBe(3);
  });

  it("a TikTok LIVE lottery order is a giveaway whatever the title", () => {
    const m = computeProfit(show([order("a", 1, "10.00", 1, { orderType: "AUCTION" }), order("z", 2, "0.00", 1, { orderType: "ZERO_LOTTERY" })], ENDED_1H));
    expect(m.giveawayUnits).toBe(1);
    expect(m.itemsSold).toBe(1);
  });
});

describe("presenter commission tiers by the show's average item price", () => {
  const sold = (n: number, price: string) => Array.from({ length: n }, (_, i) => order(`t${price}-${i}`, i + 1, price));

  it("$1 per item up to a $10 average", () => {
    const m = computeProfit(show(sold(10, "9.00"), ENDED_1H));
    expect(money(m.labor.byStaff[0].perUnitRate)).toBe("1.00");
    expect(money(m.labor.presenter)).toBe("10.00");
  });

  it("the average is rounded down to whole dollars: $12.90 → $1.20, $11.99 → $1.10", () => {
    expect(money(computeProfit(show(sold(10, "12.90"), ENDED_1H)).labor.byStaff[0].perUnitRate)).toBe("1.20");
    expect(money(computeProfit(show(sold(10, "11.99"), ENDED_1H)).labor.byStaff[0].perUnitRate)).toBe("1.10");
    expect(money(computeProfit(show(sold(10, "10.99"), ENDED_1H)).labor.byStaff[0].perUnitRate)).toBe("1.00");
  });

  it("$12 average → $1.20 per item, $15 → $1.50", () => {
    expect(money(computeProfit(show(sold(10, "12.00"), ENDED_1H)).labor.presenter)).toBe("12.00");
    expect(money(computeProfit(show(sold(10, "15.00"), ENDED_1H)).labor.presenter)).toBe("15.00");
  });

  it("uses the auction average and ignores giveaways", () => {
    const orders = [
      order("a1", 1, "14.00", 1, { orderType: "AUCTION" }),
      order("a2", 2, "16.00", 1, { orderType: "AUCTION" }),
      order("n1", 3, "5.00", 1, { orderType: "" }), // buy-now item: paid, but not in the average
      order("g1", 4, "0.00", 1, { orderType: "ZERO_LOTTERY" }),
    ];
    const m = computeProfit(show(orders, ENDED_1H));
    expect(money(m.avgSellingPrice)).toBe("15.00");
    expect(money(m.labor.byStaff[0].perUnitRate)).toBe("1.50");
    expect(money(m.labor.presenter)).toBe("4.50"); // 3 sold items × $1.50
  });

  it("older show snapshots without the tier keep a flat rate", () => {
    const costs = { ...DEFAULT_COSTS, presenter: { ...ZERO_COMP, perUnit: "1.00" } };
    expect(money(computeProfit(show(sold(10, "15.00"), { ...ENDED_1H, costs })).labor.presenter)).toBe("10.00");
  });
});
