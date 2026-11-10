import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompRates, CostSnapshot, HourlyExpenseRule } from "@/lib/engine/types";
import { DEFAULT_COSTS, ZERO_COMP, normalizeCosts } from "@/lib/engine/defaults";

const str = (v: unknown, fallback = "0") => (v === null || v === undefined ? fallback : String(v));

/**
 * Freeze the currently active rules for a platform into a v2 snapshot.
 * Per-person pay is frozen separately on each shift (see staffComp).
 */
export async function buildCostSnapshot(
  sb: SupabaseClient,
  platform: "tiktok" | "whatnot" | "manual",
): Promise<{ snapshot: CostSnapshot; costProfileId: string | null; feeRuleId: string | null }> {
  const [{ data: profile }, { data: fee }, { data: costs }, { data: settings }] = await Promise.all([
    sb.from("cost_profiles").select("*").eq("platform", platform).eq("is_active", true).maybeSingle(),
    sb.from("fee_rules").select("*").eq("platform", platform).eq("is_active", true).maybeSingle(),
    sb.from("product_costs").select("unit_cost, effective_from, products(sku)").order("effective_from", { ascending: false }),
    sb.from("app_settings").select("revenue_basis").eq("id", 1).maybeSingle(),
  ]);

  const skuCosts: Record<string, string> = {};
  for (const row of (costs ?? []) as any[]) {
    const sku = row.products?.sku;
    if (sku && skuCosts[sku] === undefined) skuCosts[sku] = String(row.unit_cost); // newest first
  }

  const hourly = Array.isArray(profile?.hourly_expenses)
    ? (profile.hourly_expenses as HourlyExpenseRule[])
    : DEFAULT_COSTS.hourlyExpenses!;
  // legacy marketing column still honoured if someone set it
  if (profile?.marketing_per_hour && Number(profile.marketing_per_hour) > 0 && !hourly.some((h) => h.label === "Marketing")) {
    hourly.push({ category: "advertising", label: "Marketing", perHour: String(profile.marketing_per_hour) });
  }

  return {
    snapshot: {
      version: 2,
      defaultProductCost: str(profile?.default_product_cost, DEFAULT_COSTS.defaultProductCost),
      skuCosts,
      packingPerItem: str(profile?.packing_per_item, "0"),
      percentFee: str(fee?.percent_fee, DEFAULT_COSTS.percentFee),
      fixedFeePerTransaction: str(fee?.fixed_fee_per_transaction, "0"),
      presenter: {
        perUnit: str(profile?.host_per_item, "1"),
        perHour: str(profile?.host_per_hour),
        percentOfSales: str(profile?.presenter_percent_of_sales),
        flatPerShow: str(profile?.host_flat_per_show),
        pctOfAvgPrice: str(profile?.presenter_pct_of_avg, "0.10"),
      },
      assistant: { ...ZERO_COMP, perHour: str(profile?.assistant_per_hour, "20") },
      hourlyExpenses: hourly,
      revenueBasis: settings?.revenue_basis === "paid" ? "paid" : "created",
      shippingEstimatePerPackage: profile?.shipping_estimate_per_package == null ? null : String(profile.shipping_estimate_per_package),
    },
    costProfileId: profile?.id ?? null,
    feeRuleId: fee?.id ?? null,
  };
}

/** Pay rates for one person on a show: their staff profile overrides, else the show's role default. */
export function staffComp(snapshot: CostSnapshot, role: "host" | "assistant", staff: any | null): CompRates {
  const n = normalizeCosts(snapshot);
  const base = role === "host" ? n.presenter : n.assistant;
  if (!staff) return { ...base };
  const pick = (v: unknown, fallback: string) => (v === null || v === undefined ? fallback : String(v));
  if (role === "host") {
    return {
      perUnit: pick(staff.host_per_item, base.perUnit),
      perHour: pick(staff.host_per_hour, base.perHour),
      percentOfSales: pick(staff.percent_of_sales, base.percentOfSales),
      flatPerShow: pick(staff.host_flat_per_show, base.flatPerShow),
      pctOfAvgPrice: base.pctOfAvgPrice ?? "0",
    };
  }
  return { ...base, perHour: pick(staff.hourly_rate, base.perHour), percentOfSales: pick(staff.percent_of_sales, base.percentOfSales) };
}
