import type { CompRates, CostSnapshot, HourlyExpenseRule, RevenueBasis } from "./types";

export const ZERO_COMP: CompRates = { perUnit: "0", perHour: "0", percentOfSales: "0", flatPerShow: "0", pctOfAvgPrice: "0" };

/**
 * Stav's business defaults (Profit Tracker spec §3). Editable in Settings and
 * snapshotted onto each show when it starts.
 *
 *   Product cost        $2.50 / unit (fallback when a SKU has no cost)
 *   Presenter           $1.00 / item sold, or 10% of the show's average item price if higher
 *   Assistant           $20.00 / hour
 *   TikTok commission   6% of product revenue, excluding shipping
 *   Giveaways / misc.   $30.00 / hour
 */
export const DEFAULT_COSTS: CostSnapshot = {
  version: 2,
  defaultProductCost: "2.50",
  skuCosts: {},
  packingPerItem: "0",
  percentFee: "0.06",
  fixedFeePerTransaction: "0",
  presenter: { ...ZERO_COMP, perUnit: "1.00", pctOfAvgPrice: "0.10" },
  assistant: { ...ZERO_COMP, perHour: "20.00" },
  hourlyExpenses: [{ category: "giveaways", label: "Giveaways / misc.", perHour: "30.00" }],
  revenueBasis: "created",
  shippingEstimatePerPackage: null,
};

export type NormalizedCosts = {
  defaultProductCost: string;
  skuCosts: Record<string, string>;
  packingPerItem: string;
  percentFee: string;
  fixedFeePerTransaction: string;
  presenter: CompRates;
  assistant: CompRates;
  hourlyExpenses: HourlyExpenseRule[];
  revenueBasis: RevenueBasis;
  shippingEstimatePerPackage: string | null;
  scanReport: { totalCogs: string; units: number; unitCosts: Record<string, string> } | null;
};

/**
 * Read a snapshot of either version. Legacy (v1) snapshots map exactly onto
 * the v2 model so historical shows calculate the same as before:
 *   host.perItem/perHour/flatPerShow → presenter, assistantPerHour → assistant,
 *   marketingPerHour → an hourly "Marketing" expense.
 */
export function normalizeCosts(c: CostSnapshot): NormalizedCosts {
  const isV2 = c.version === 2 || c.presenter !== undefined || c.hourlyExpenses !== undefined;
  const presenter: CompRates = isV2
    ? { ...ZERO_COMP, ...c.presenter }
    : {
        ...ZERO_COMP,
        perUnit: c.host?.perItem ?? "0",
        perHour: c.host?.perHour ?? "0",
        flatPerShow: c.host?.flatPerShow ?? "0",
      };
  const assistant: CompRates = isV2 ? { ...ZERO_COMP, ...c.assistant } : { ...ZERO_COMP, perHour: c.assistantPerHour ?? "0" };
  const hourlyExpenses: HourlyExpenseRule[] = isV2
    ? (c.hourlyExpenses ?? [])
    : c.marketingPerHour && Number(c.marketingPerHour) !== 0
      ? [{ category: "advertising", label: "Marketing", perHour: c.marketingPerHour }]
      : [];
  return {
    defaultProductCost: c.defaultProductCost,
    // scan-report unit costs (UPC → cost) win over the SKU cost list
    skuCosts: { ...(c.skuCosts ?? {}), ...(c.scanReport?.unitCosts ?? {}) },
    packingPerItem: c.packingPerItem ?? "0",
    percentFee: c.percentFee ?? "0",
    fixedFeePerTransaction: c.fixedFeePerTransaction ?? "0",
    presenter,
    assistant,
    hourlyExpenses,
    revenueBasis: c.revenueBasis ?? "created",
    shippingEstimatePerPackage: c.shippingEstimatePerPackage ?? null,
    scanReport: c.scanReport ?? null,
  };
}
