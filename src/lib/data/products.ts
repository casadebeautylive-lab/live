import type { SupabaseClient } from "@supabase/supabase-js";
import { d, Decimal, ZERO } from "@/lib/engine/money";
import { productBreakdown } from "@/lib/engine/products";
import { DEFAULT_COSTS } from "@/lib/engine/defaults";
import { fetchAll, loadShowsBulk } from "./shows";

// ---------------------------------------------------------------------------
// CSV (pure — unit tested in tests/csv-import.test.ts)
// ---------------------------------------------------------------------------

export const MAX_IMPORT_ROWS = 5000;

export type CostCsvRow = { line: number; sku: string; title: string | null; cost: string };
export type CostCsvError = { line: number; message: string };
export type CostCsvResult = { rows: CostCsvRow[]; errors: CostCsvError[] };

/** RFC-4180-ish line splitter: quoted fields, escaped quotes, CRLF, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      out.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    out.push(row);
  }
  return out;
}

const COST_RE = /^\d+(\.\d{1,4})?$/;

/**
 * Parse a `sku,cost[,title]` CSV (columns in any order, header required).
 * Every problem is reported with its 1-based file line; valid rows are returned alongside.
 */
export function parseCostCsv(text: string): CostCsvResult {
  const errors: CostCsvError[] = [];
  const rows: CostCsvRow[] = [];
  const table = parseCsv(text);
  const lines = table.map((cells, i) => ({ cells, line: i + 1 })).filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (!lines.length) return { rows, errors: [{ line: 0, message: "The file is empty" }] };

  const header = lines[0].cells.map((h) => h.trim().toLowerCase());
  const iSku = header.indexOf("sku");
  const iCost = header.findIndex((h) => h === "cost" || h === "unit_cost");
  const iTitle = header.findIndex((h) => h === "title" || h === "product" || h === "name");
  if (iSku < 0 || iCost < 0) return { rows, errors: [{ line: lines[0].line, message: 'Header must include "sku" and "cost" columns' }] };

  const body = lines.slice(1);
  if (!body.length) return { rows, errors: [{ line: 0, message: "No data rows" }] };
  if (body.length > MAX_IMPORT_ROWS) return { rows, errors: [{ line: 0, message: `Too many rows (${body.length}); the limit is ${MAX_IMPORT_ROWS}` }] };

  const seen = new Map<string, number>();
  for (const { cells, line } of body) {
    const sku = (cells[iSku] ?? "").trim();
    const rawCost = (cells[iCost] ?? "").trim().replace(/^\$/, "");
    const title = iTitle >= 0 ? (cells[iTitle] ?? "").trim() : "";
    if (!sku) {
      errors.push({ line, message: "SKU is empty" });
      continue;
    }
    if (sku.length > 128) {
      errors.push({ line, message: `SKU "${sku.slice(0, 20)}…" is longer than 128 characters` });
      continue;
    }
    if (!COST_RE.test(rawCost)) {
      errors.push({ line, message: `Cost "${rawCost}" for ${sku} must be an amount ≥ 0 like 2.50 (max 4 decimals)` });
      continue;
    }
    if (d(rawCost).gt("1000000")) {
      errors.push({ line, message: `Cost ${rawCost} for ${sku} looks wrong (over $1,000,000)` });
      continue;
    }
    const prev = seen.get(sku);
    if (prev !== undefined) {
      errors.push({ line, message: `SKU ${sku} appears again (first on line ${prev})` });
      continue;
    }
    seen.set(sku, line);
    rows.push({ line, sku, title: title ? title.slice(0, 300) : null, cost: rawCost });
  }
  return { rows, errors };
}

/** Spreadsheet-safe CSV cell (same rules as report.ts). */
export const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

export type CostVersion = { unitCost: string; effectiveFrom: string };
export type CatalogProduct = { id: string; sku: string; title: string | null; current: CostVersion | null; history: CostVersion[] };

/** All products with their cost versions, newest first. */
export async function loadCatalog(sb: SupabaseClient): Promise<Map<string, CatalogProduct>> {
  const rows = await fetchAll((a, b) => sb.from("products").select("id, sku, title, product_costs(unit_cost, effective_from)").order("sku").range(a, b));
  return new Map(
    rows.map((p: any) => {
      const history: CostVersion[] = [...(p.product_costs ?? [])]
        .sort((x: any, y: any) => String(y.effective_from).localeCompare(String(x.effective_from)))
        .map((c: any) => ({ unitCost: String(c.unit_cost), effectiveFrom: c.effective_from }));
      return [p.sku, { id: p.id, sku: p.sku, title: p.title, current: history[0] ?? null, history }];
    }),
  );
}

/** Default product cost from the active TikTok cost profile (the fallback new shows will use). */
export async function defaultProductCost(sb: SupabaseClient): Promise<string> {
  const { data } = await sb.from("cost_profiles").select("platform, default_product_cost").eq("is_active", true);
  const row = (data ?? []).find((r: any) => r.platform === "tiktok") ?? (data ?? [])[0];
  return row ? String(row.default_product_cost) : DEFAULT_COSTS.defaultProductCost;
}

export type MergedProduct = {
  key: string;
  sku: string;
  title: string;
  units: number;
  netRevenue: Decimal;
  productCost: Decimal;
  contribution: Decimal;
  avgPrice: Decimal | null;
  grossMarginPct: Decimal | null;
  contributionPct: Decimal | null;
  costEstimated: boolean;
};

/** Per-SKU totals across shows started in the range, each show priced with its own frozen cost snapshot. */
export async function loadPeriodProducts(sb: SupabaseClient, opts: { from: Date; to: Date; includeTest: boolean }): Promise<{ rows: MergedProduct[]; shows: number }> {
  let q = sb
    .from("live_shows")
    .select("*")
    .gte("started_at", opts.from.toISOString())
    .lt("started_at", opts.to.toISOString())
    .neq("status", "scheduled")
    .order("started_at", { ascending: false })
    .limit(1000);
  if (!opts.includeTest) q = q.eq("is_test", false);
  const { data: shows } = await q;
  const bulk = await loadShowsBulk(sb, shows ?? [], { packages: false });

  const merged = new Map<string, MergedProduct>();
  for (const { input } of bulk) {
    const orders = opts.includeTest ? input.orders : input.orders.filter((o) => !o.isTest);
    for (const r of productBreakdown(orders, input.costs)) {
      const key = r.sku === "(no sku)" ? `title:${r.title}` : r.sku;
      const m =
        merged.get(key) ??
        ({ key, sku: r.sku, title: r.title, units: 0, netRevenue: ZERO, productCost: ZERO, contribution: ZERO, avgPrice: null, grossMarginPct: null, contributionPct: null, costEstimated: false } satisfies MergedProduct);
      m.units += r.units;
      m.netRevenue = m.netRevenue.plus(r.netRevenue);
      m.productCost = m.productCost.plus(r.productCost);
      m.contribution = m.contribution.plus(r.contribution);
      m.costEstimated = m.costEstimated || r.costEstimated;
      merged.set(key, m);
    }
  }
  for (const m of merged.values()) {
    m.avgPrice = m.units > 0 ? m.netRevenue.div(m.units) : null;
    m.grossMarginPct = m.netRevenue.gt(0) ? m.netRevenue.minus(m.productCost).div(m.netRevenue).times(100) : null;
    m.contributionPct = m.netRevenue.gt(0) ? m.contribution.div(m.netRevenue).times(100) : null;
  }
  return { rows: [...merged.values()], shows: bulk.length };
}

/** All-time units per SKU (non-cancelled orders; refunds not netted). Light query: no money columns. */
export async function loadAllTimeUnits(sb: SupabaseClient, includeTest: boolean): Promise<Map<string, number>> {
  const rows = await fetchAll((a, b) => {
    let q = sb.from("order_items").select("sku, quantity, orders!inner(status, is_test)").not("sku", "is", null).neq("orders.status", "cancelled");
    if (!includeTest) q = q.eq("orders.is_test", false);
    return q.order("id").range(a, b);
  });
  const out = new Map<string, number>();
  for (const r of rows as any[]) out.set(r.sku, (out.get(r.sku) ?? 0) + Number(r.quantity ?? 0));
  return out;
}
