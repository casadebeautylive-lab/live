import { DEFAULT_COSTS } from "@/lib/engine/defaults";
import type { CostSnapshot, OrderInput, ShowInput } from "@/lib/engine/types";

/** A pre-v2 snapshot exactly as older shows stored it (original §5 defaults). */
export const LEGACY_COSTS: CostSnapshot = {
  defaultProductCost: "2.00",
  skuCosts: {},
  host: { perItem: "1.00", perHour: "0", flatPerShow: "0" },
  packingPerItem: "0.20",
  assistantPerHour: "20.00",
  marketingPerHour: "35.00",
  percentFee: "0.074",
  fixedFeePerTransaction: "0.30",
};

export const START = "2026-10-08T23:00:00.000Z";
export const ONE_HOUR_LATER = new Date("2026-10-09T00:00:00.000Z");

/** n single-unit orders at $price, spread evenly over the first hour. */
export function evenOrders(n: number, price: string, overrides: Partial<OrderInput> = {}): OrderInput[] {
  const start = Date.parse(START);
  return Array.from({ length: n }, (_, i) => ({
    externalOrderId: `o${i}`,
    createdAt: new Date(start + Math.floor(((i + 0.5) * 3_600_000) / n)).toISOString(),
    status: "active" as const,
    isTest: true,
    items: [
      {
        externalItemId: `o${i}-1`,
        sku: null,
        title: "Gold hoop",
        quantity: 1,
        unitPrice: price,
        sellerDiscount: "0",
        platformDiscount: "0",
      },
    ],
    refunds: [],
    customerShipping: "0",
    platformShippingSubsidy: null,
    sellerShippingCost: null,
    platformGmv: null,
    actualPlatformFees: null,
    settlementAmount: null,
    ...overrides,
  }));
}

export function show(orders: OrderInput[], extra: Partial<ShowInput> = {}): ShowInput {
  return {
    startedAt: START,
    endedAt: null,
    pauses: [],
    costs: DEFAULT_COSTS,
    expenses: [],
    orders,
    ...extra,
  };
}
