import { describe, expect, it } from "vitest";
import { computeProfit } from "@/lib/engine/profit";
import { computeMinutes } from "@/lib/engine/minutes";
import { DEFAULT_COSTS } from "@/lib/engine/defaults";
import type { OrderInput } from "@/lib/engine/types";
import { parseScanCsv, parseScanPdfItems, unitCostsByUpc, type TextItem } from "@/lib/scan-report";
import { ONE_HOUR_LATER, show, START } from "./helpers";

const at = (min: number) => new Date(Date.parse(START) + min * 60_000).toISOString();
const ENDED_1H = { endedAt: ONE_HOUR_LATER.toISOString() };
function order(id: string, min: number, sku: string | null, price = "20.00", qty = 1): OrderInput {
  return {
    externalOrderId: id,
    createdAt: at(min),
    status: "active",
    isTest: true,
    items: [{ externalItemId: `${id}-1`, sku, title: "Perfume", quantity: qty, unitPrice: price, sellerDiscount: "0", platformDiscount: "0" }],
    refunds: [],
    customerShipping: "0",
    platformShippingSubsidy: null,
    sellerShippingCost: null,
    platformGmv: null,
    actualPlatformFees: null,
    settlementAmount: null,
  };
}

// Mimics the PDF's positioned text: header on each page, wrapped product/lot lines.
const row = (y: number, cells: [string, number][]): TextItem[] => cells.map(([str, x]) => ({ str, x, y }));
const HEAD = row(492, [["Brand", 45], ["Product", 121], ["UPC", 488], ["Lot(s)", 562], ["Count", 665], ["Remaining", 701], ["COGS", 757]]);
const PAGES: TextItem[][] = [
  [
    { str: "End of Show Scan Report", x: 40, y: 553 },
    { str: "Show: 11/4/26 · TikTok | Date: 2026-11-04", x: 40, y: 533 },
    { str: "Units: 5 | Total COGS: $1,060.50", x: 40, y: 519 },
    ...HEAD,
    ...row(472, [["ALBANE", 45], ["ALBANE NOBLE FREEDOM", 121], ["3700066703293", 488], ["ALB-092526-A", 562], ["2", 665], ["99", 701], ["$36.00", 757]]),
    ...row(451, [["Armaf", 45], ["Armaf Club De Nuit Iconic 105ml", 121], ["6294015164152", 488], ["ARM-092526-A", 562], ["1", 665], ["62", 701], ["$24.00", 757]]),
    ...row(441, [["3.6 Oz / 105", 121]]),
  ],
  [
    ...HEAD,
    ...row(472, [["Paco", 45], ["Paco Rabanne 100ml", 121], ["3349668609031", 488], ["PAC-101326-A,", 562], ["2", 665], ["112", 701], ["$1,000.50", 757]]),
    ...row(462, [["PAC-061626-A", 562]]),
  ],
];

describe("end-of-show scan report — parsing", () => {
  it("reads rows across pages, joins wrapped text, checks the header", () => {
    const r = parseScanPdfItems(PAGES);
    expect(r.lines).toHaveLength(3);
    expect(r.lines[1].product).toBe("Armaf Club De Nuit Iconic 105ml 3.6 Oz / 105");
    expect(r.lines[2]).toMatchObject({ upc: "3349668609031", lots: "PAC-101326-A, PAC-061626-A", count: 2, cogs: "1000.50" });
    expect(r.units).toBe(5);
    expect(r.totalCogs).toBe("1060.50");
    expect(r.reportDate).toBe("2026-11-04");
    expect(r.warnings).toEqual([]);
  });
  it("warns when the rows don't add up to the header", () => {
    const pages = [[...PAGES[0].filter((i) => !i.str.startsWith("Units")), { str: "Units: 9 | Total COGS: $70.00", x: 40, y: 519 }]];
    expect(parseScanPdfItems(pages).warnings).toHaveLength(2);
  });
  it("reads the CSV version", () => {
    const r = parseScanCsv("Units: 3 | Total COGS: $60.00\nBrand,Product,UPC,Lot(s),Count,Remaining,COGS\nALBANE,Noble,3700066703293,ALB-1,2,99,$36.00\nArmaf,Iconic,6294015164152,ARM-1,1,62,$24.00\n");
    expect(r.units).toBe(3);
    expect(r.totalCogs).toBe("60.00");
    expect(unitCostsByUpc(r.lines)).toEqual({ "3700066703293": "18.0000", "6294015164152": "24.0000" });
  });
  it("rejects a file that isn't a scan report", () => {
    expect(() => parseScanPdfItems([[{ str: "Hello", x: 0, y: 0 }]])).toThrow(/product table/);
    expect(() => parseScanCsv("a,b\n1,2")).toThrow(/UPC/);
  });
});

describe("end-of-show scan report — profit", () => {
  const report = { totalCogs: "100.00", units: 4, unitCosts: { UPC_A: "30.0000", UPC_B: "10.0000" } };
  const orders = [order("1", 5, "UPC_A"), order("2", 10, "UPC_A"), order("3", 20, "UPC_B"), order("4", 30, "UPC_B")];

  it("product cost equals the report's total COGS exactly, spread by UPC cost", () => {
    const m = computeProfit(show(orders, { ...ENDED_1H, costs: { ...DEFAULT_COSTS, scanReport: report } }));
    expect(m.costs.product.toFixed(2)).toBe("100.00");
    expect(m.flags.productCostEstimated).toBe(false);
    const mins = computeMinutes(show(orders, { ...ENDED_1H, costs: { ...DEFAULT_COSTS, scanReport: report } })).minutes;
    // 30+30+10+10 = 80 counted → scaled ×1.25: 37.50, 37.50, 12.50, 12.50
    expect(mins[5].cogs.toFixed(2)).toBe("37.50");
    expect(mins[20].cogs.toFixed(2)).toBe("12.50");
    expect(mins.reduce((a, x) => a + Number(x.cogs.toFixed(4)), 0)).toBeCloseTo(100, 6);
  });
  it("without UPC matches the total is spread evenly per unit", () => {
    const o = [order("1", 5, null, "20.00", 3), order("2", 10, "OTHER")];
    const m = computeProfit(show(o, { ...ENDED_1H, costs: { ...DEFAULT_COSTS, scanReport: report } }));
    expect(m.costs.product.toFixed(2)).toBe("100.00");
  });
  it("a report uploaded before any sale still counts", () => {
    const m = computeProfit(show([], { ...ENDED_1H, costs: { ...DEFAULT_COSTS, scanReport: report } }));
    expect(m.costs.product.toFixed(2)).toBe("100.00");
  });
  it("no report → unchanged default costing", () => {
    const m = computeProfit(show(orders, ENDED_1H));
    expect(m.costs.product.toFixed(2)).toBe("10.00"); // 4 × $2.50 default
  });
});
