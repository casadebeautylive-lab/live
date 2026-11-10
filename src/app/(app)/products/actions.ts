"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit, requireWriter, supabaseAdmin, supabaseServer } from "@/lib/supabase/clients";
import { run, type ActionState } from "@/lib/action-state";
import { parseCostCsv, type CostCsvRow } from "@/lib/data/products";

const money = z
  .string()
  .trim()
  .transform((v) => v.replace(/^\$/, ""))
  .pipe(z.string().regex(/^\d+(\.\d{1,4})?$/, "must be an amount ≥ 0 like 2.50"));

const chunk = <T,>(arr: T[], n: number) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/** New cost version for one SKU (older versions are kept; shows started later pick up the newest). */
async function _setProductCost(form: FormData) {
  const user = await requireWriter();
  const { sku, title, unit_cost } = z
    .object({ sku: z.string().trim().min(1).max(128), title: z.string().trim().max(300).optional(), unit_cost: money })
    .parse(Object.fromEntries(form));
  const sb = await supabaseServer();
  const { data: before } = await sb.from("products").select("id, product_costs(unit_cost, effective_from)").eq("sku", sku).maybeSingle();
  const { data: product, error } = await sb
    .from("products")
    .upsert({ sku, ...(title ? { title } : {}) }, { onConflict: "sku" })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const { error: e2 } = await sb.from("product_costs").insert({ product_id: product.id, unit_cost, created_by: user.id });
  if (e2) throw new Error(e2.message);
  // order_items are server-written (RLS), so link past lines with the service client
  await supabaseAdmin().from("order_items").update({ product_id: product.id }).eq("sku", sku).is("product_id", null);
  const prev = [...((before as any)?.product_costs ?? [])].sort((a: any, b: any) => String(b.effective_from).localeCompare(String(a.effective_from)))[0];
  await audit(user.id, "sku_cost.set", "products", sku, prev ? { unit_cost: prev.unit_cost } : null, { unit_cost });
  revalidatePath("/products");
  revalidatePath("/settings");
}

/** Upsert products by SKU and return sku → id. Rows without a title don't overwrite an existing title. */
async function upsertProducts(sb: Awaited<ReturnType<typeof supabaseServer>>, rows: CostCsvRow[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const withTitle = rows.filter((r) => r.title).map((r) => ({ sku: r.sku, title: r.title }));
  const noTitle = rows.filter((r) => !r.title).map((r) => ({ sku: r.sku }));
  for (const batch of [withTitle, noTitle]) {
    for (const part of chunk(batch, 500)) {
      const { data, error } = await sb.from("products").upsert(part, { onConflict: "sku" }).select("id, sku");
      if (error) throw new Error(error.message);
      for (const p of data ?? []) ids.set(p.sku, p.id);
    }
  }
  return ids;
}

async function _importProductCosts(form: FormData) {
  const user = await requireWriter();
  const file = form.get("file");
  let text = String(form.get("csv") ?? "");
  if (file && typeof file === "object" && "text" in file && (file as File).size > 0) {
    if ((file as File).size > 2_000_000) throw new Error("File is larger than 2 MB");
    text = await (file as File).text();
  }
  if (!text.trim()) throw new Error("Paste CSV text or choose a file");

  const { rows, errors } = parseCostCsv(text);
  if (errors.length) {
    const shown = errors.slice(0, 15).map((e) => (e.line ? `Line ${e.line}: ${e.message}` : e.message));
    const more = errors.length > 15 ? ` …and ${errors.length - 15} more` : "";
    throw new Error(`Nothing imported — fix ${errors.length} problem${errors.length === 1 ? "" : "s"} and try again. ${shown.join(" · ")}${more}`);
  }

  const sb = await supabaseServer();
  const ids = await upsertProducts(sb, rows);
  const effective_from = new Date().toISOString();
  const costRows = rows.map((r) => {
    const product_id = ids.get(r.sku);
    if (!product_id) throw new Error(`Could not save SKU ${r.sku}`);
    return { product_id, unit_cost: r.cost, effective_from, created_by: user.id };
  });
  for (const part of chunk(costRows, 500)) {
    const { error } = await sb.from("product_costs").insert(part);
    if (error) throw new Error(`Import stopped part-way: ${error.message}`);
  }
  await audit(user.id, "sku_cost.import", "products", null, null, {
    rows: rows.length,
    withTitle: rows.filter((r) => r.title).length,
    effective_from,
  });
  revalidatePath("/products");
  revalidatePath("/settings");
}

export async function setProductCost(_prev: ActionState, form: FormData) { return run(_setProductCost, form); }
export async function importProductCosts(_prev: ActionState, form: FormData) { return run(_importProductCosts, form); }
