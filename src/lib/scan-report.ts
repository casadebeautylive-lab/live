/**
 * End-of-show scan report: the products scanned out after a LIVE with their real
 * cost (COGS). Pure parsing — PDF text extraction happens in scan-report-pdf.ts.
 *
 * Report layout (PDF or CSV):
 *   "Units: 283 | Total COGS: $4,569.03"
 *   Brand | Product | UPC | Lot(s) | Count | Remaining | COGS
 * COGS on a row is the total for that row (Count units), not a unit cost.
 */
import { Decimal } from "@/lib/engine/money";
import { parseCsv } from "@/lib/data/products";

export type ScanLine = { brand: string; product: string; upc: string; lots: string; count: number; cogs: string };

export type ScanReport = {
  reportDate: string | null; // YYYY-MM-DD as printed
  showLabel: string | null; // e.g. "11/4/26 · TikTok"
  units: number; // Σ count
  totalCogs: string; // Σ row COGS, 2 decimals
  headerUnits: number | null; // as printed in the header
  headerTotalCogs: string | null;
  lines: ScanLine[];
  warnings: string[];
};

export type TextItem = { str: string; x: number; y: number };

const money = (s: string): Decimal | null => {
  const m = s.replace(/[,\s]/g, "").match(/^-?\$?(-?\d+(?:\.\d+)?)$/);
  return m ? new Decimal(m[1]) : null;
};

function header(text: string) {
  const units = text.match(/Units:\s*([\d,]+)/i);
  const cogs = text.match(/Total COGS:\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
  const date = text.match(/Date:\s*(\d{4}-\d{2}-\d{2})/i);
  const show = text.match(/Show:\s*([^|\n]+?)\s*(?:\||$)/im);
  return {
    headerUnits: units ? Number(units[1].replace(/,/g, "")) : null,
    headerTotalCogs: cogs ? new Decimal(cogs[1].replace(/,/g, "")).toFixed(2) : null,
    reportDate: date ? date[1] : null,
    showLabel: show ? show[1].trim() : null,
  };
}

function finish(lines: ScanLine[], h: ReturnType<typeof header>): ScanReport {
  const warnings: string[] = [];
  const units = lines.reduce((a, l) => a + l.count, 0);
  const total = lines.reduce((a, l) => a.plus(l.cogs), new Decimal(0));
  if (h.headerUnits !== null && h.headerUnits !== units) warnings.push(`The report header says ${h.headerUnits} units but its rows add up to ${units}.`);
  if (h.headerTotalCogs !== null && total.minus(h.headerTotalCogs).abs().gt("0.05"))
    warnings.push(`The report header says $${h.headerTotalCogs} but its rows add up to $${total.toFixed(2)}.`);
  return { ...h, units, totalCogs: total.toFixed(2), lines, warnings };
}

/**
 * Parse the PDF's positioned text items (all pages, in page order).
 * Columns are located from the header row on each page; rows without a UPC
 * are wrapped text that belongs to the row above.
 */
export function parseScanPdfItems(pages: TextItem[][]): ScanReport {
  const allText = pages
    .flat()
    .map((i) => i.str)
    .join("\n");
  const h = header(allText);
  const lines: ScanLine[] = [];
  for (const items of pages) {
    const words = items.filter((i) => i.str.trim());
    const at = (name: string) => words.find((w) => w.str.trim().toLowerCase() === name)?.x;
    const col = { product: at("product"), upc: at("upc"), lot: at("lot(s)") ?? at("lots"), count: at("count"), remaining: at("remaining"), cogs: at("cogs") };
    if (Object.values(col).some((v) => v === undefined)) continue; // page without the table header
    const headerY = words.find((w) => w.str.trim().toLowerCase() === "upc")!.y;
    const columnOf = (x: number) =>
      x >= col.cogs! - 2 ? "cogs" : x >= col.remaining! - 2 ? "remaining" : x >= col.count! - 2 ? "count" : x >= col.lot! - 2 ? "lot" : x >= col.upc! - 2 ? "upc" : x >= col.product! - 2 ? "product" : "brand";
    // group into visual rows (same baseline), top to bottom
    const rows = new Map<number, TextItem[]>();
    for (const w of words) {
      if (w.y >= headerY - 1) continue; // header and above
      const key = [...rows.keys()].find((k) => Math.abs(k - w.y) <= 1.5) ?? w.y;
      rows.set(key, [...(rows.get(key) ?? []), w]);
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      const cells: Record<string, string> = {};
      for (const w of rows.get(y)!.sort((a, b) => a.x - b.x)) {
        const c = columnOf(w.x);
        cells[c] = cells[c] ? `${cells[c]} ${w.str.trim()}` : w.str.trim();
      }
      if (cells.upc && /^\d{3,14}$/.test(cells.upc.replace(/\s/g, ""))) {
        const cogs = money(cells.cogs ?? "");
        lines.push({
          brand: cells.brand ?? "",
          product: cells.product ?? "",
          upc: cells.upc.replace(/\s/g, ""),
          lots: cells.lot ?? "",
          count: Number((cells.count ?? "0").replace(/[^\d]/g, "")) || 0,
          cogs: cogs ? cogs.toFixed(2) : "0.00",
        });
      } else if (lines.length) {
        // wrapped text from the row above
        const prev = lines[lines.length - 1];
        if (cells.product) prev.product = `${prev.product} ${cells.product}`.trim();
        if (cells.lot) prev.lots = `${prev.lots} ${cells.lot}`.trim();
        if (cells.brand) prev.brand = `${prev.brand} ${cells.brand}`.trim();
      }
    }
  }
  if (!lines.length) throw new Error("Couldn't find the product table in this PDF. Upload the End of Show Scan Report (PDF or CSV).");
  return finish(lines, h);
}

/** CSV export of the same report (columns: Brand, Product, UPC, Lot(s), Count, Remaining, COGS). */
export function parseScanCsv(text: string): ScanReport {
  const table = parseCsv(text);
  const hi = table.findIndex((r) => r.some((c) => c.trim().toLowerCase() === "upc"));
  if (hi < 0) throw new Error('This file has no "UPC" column. Upload the End of Show Scan Report (PDF or CSV).');
  const head = table[hi].map((c) => c.trim().toLowerCase());
  const ix = (...names: string[]) => head.findIndex((c) => names.includes(c));
  const i = { brand: ix("brand"), product: ix("product"), upc: ix("upc"), lot: ix("lot(s)", "lots", "lot"), count: ix("count", "qty", "quantity"), cogs: ix("cogs", "cost") };
  if (i.count < 0 || i.cogs < 0) throw new Error('This file needs "Count" and "COGS" columns.');
  const lines: ScanLine[] = [];
  for (const r of table.slice(hi + 1)) {
    const upc = (r[i.upc] ?? "").replace(/\s/g, "");
    if (!upc) continue;
    const cogs = money(r[i.cogs] ?? "");
    lines.push({
      brand: i.brand >= 0 ? (r[i.brand] ?? "").trim() : "",
      product: i.product >= 0 ? (r[i.product] ?? "").trim() : "",
      upc,
      lots: i.lot >= 0 ? (r[i.lot] ?? "").trim() : "",
      count: Number((r[i.count] ?? "0").replace(/[^\d]/g, "")) || 0,
      cogs: cogs ? cogs.toFixed(2) : "0.00",
    });
  }
  if (!lines.length) throw new Error("No product rows found in this file.");
  return finish(lines, header(table.slice(0, hi).map((r) => r.join(" ")).join("\n")));
}

/** UPC → cost per unit (rows with the same UPC, e.g. two lots, are combined). */
export function unitCostsByUpc(lines: ScanLine[]): Record<string, string> {
  const acc = new Map<string, { units: number; cogs: Decimal }>();
  for (const l of lines) {
    const a = acc.get(l.upc) ?? { units: 0, cogs: new Decimal(0) };
    a.units += l.count;
    a.cogs = a.cogs.plus(l.cogs);
    acc.set(l.upc, a);
  }
  const out: Record<string, string> = {};
  for (const [upc, a] of acc) if (a.units > 0) out[upc] = a.cogs.div(a.units).toFixed(4);
  return out;
}
