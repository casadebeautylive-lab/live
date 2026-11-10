import { describe, expect, it } from "vitest";
import { parseCostCsv, parseCsv } from "@/lib/data/products";

describe("SKU cost CSV import", () => {
  it("parses quoted fields, CRLF and any column order", () => {
    const r = parseCostCsv('title,cost,sku\r\n"Hoop, 30mm",2.75,HOOP-30\r\nCuban chain,$3.10,CUBAN-5\r\n');
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => [x.sku, x.cost, x.title])).toEqual([
      ["HOOP-30", "2.75", "Hoop, 30mm"],
      ["CUBAN-5", "3.10", "Cuban chain"],
    ]);
  });

  it("reports every bad row with its line number", () => {
    const r = parseCostCsv("sku,cost\nA,2.50\n,1\nB,abc\nA,3\nC,-1");
    expect(r.rows.map((x) => x.sku)).toEqual(["A"]);
    expect(r.errors.map((e) => e.line)).toEqual([3, 4, 5, 6]);
  });

  it("requires sku and cost headers", () => {
    expect(parseCostCsv("product,price\nx,1").errors[0].message).toMatch(/sku/);
  });

  it("handles escaped quotes and newlines inside quotes", () => {
    expect(parseCsv('a,"he said ""hi""\nthere"\n')).toEqual([["a", 'he said "hi"\nthere']]);
  });
});
