"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit, requireWriter, supabaseServer } from "@/lib/supabase/clients";
import { run, type ActionState } from "@/lib/action-state";

const money = z.string().trim().regex(/^\d+(\.\d{1,4})?$/, "must be an amount like 1.25");
const pct = z.coerce.number().min(0).max(99);
const platform = z.enum(["tiktok", "whatnot", "manual"]);
const CATEGORIES = ["giveaways", "advertising", "packaging", "shipping_labels", "labor", "bonuses", "other"] as const;
const HOURLY_ROWS = 4;

const CostSchema = z.object({
  platform,
  default_product_cost: money,
  host_per_item: money,
  host_per_hour: money,
  presenter_percent_pct: pct,
  presenter_pct_of_avg_pct: pct,
  host_flat_per_show: money,
  assistant_per_hour: money,
  packing_per_item: money,
  percent_fee_pct: pct,
  fixed_fee_per_transaction: money,
  shipping_estimate: z.union([money, z.literal("")]).optional(),
});

/**
 * Save a new version of a platform's cost profile + fee rule. Old versions are
 * kept (shows reference them) and every show keeps its own frozen snapshot, so
 * this only affects shows started afterwards.
 */
async function _saveCosts(form: FormData) {
  const user = await requireWriter();
  const raw = Object.fromEntries(form);
  const c = CostSchema.parse(raw);
  const hourly = Array.from({ length: HOURLY_ROWS }, (_, i) => ({
    label: String(raw[`hourly_label_${i}`] ?? "").trim(),
    category: String(raw[`hourly_category_${i}`] ?? "other"),
    perHour: String(raw[`hourly_rate_${i}`] ?? "").trim(),
  }))
    .filter((h) => h.label && h.perHour)
    .map((h) => ({
      label: z.string().max(60).parse(h.label),
      category: z.enum(CATEGORIES).parse(h.category),
      perHour: money.parse(h.perHour),
    }));

  const sb = await supabaseServer();
  const { data: oldProfile } = await sb.from("cost_profiles").select("*").eq("platform", c.platform).eq("is_active", true).maybeSingle();
  const { data: oldFee } = await sb.from("fee_rules").select("*").eq("platform", c.platform).eq("is_active", true).maybeSingle();

  await sb.from("cost_profiles").update({ is_active: false }).eq("platform", c.platform).eq("is_active", true);
  const profile = {
    platform: c.platform,
    name: `${c.platform} ${new Date().toISOString().slice(0, 10)}`,
    default_product_cost: c.default_product_cost,
    host_per_item: c.host_per_item,
    host_per_hour: c.host_per_hour,
    presenter_percent_of_sales: (c.presenter_percent_pct / 100).toFixed(6),
    presenter_pct_of_avg: (c.presenter_pct_of_avg_pct / 100).toFixed(6),
    host_flat_per_show: c.host_flat_per_show,
    assistant_per_hour: c.assistant_per_hour,
    packing_per_item: c.packing_per_item,
    marketing_per_hour: 0, // replaced by the hourly expense list
    hourly_expenses: hourly,
    shipping_estimate_per_package: c.shipping_estimate ? c.shipping_estimate : null,
    created_by: user.id,
  };
  const { error: e1 } = await sb.from("cost_profiles").insert(profile);
  if (e1) throw new Error(e1.message);

  await sb.from("fee_rules").update({ is_active: false }).eq("platform", c.platform).eq("is_active", true);
  const fee = { platform: c.platform, percent_fee: (c.percent_fee_pct / 100).toFixed(6), fixed_fee_per_transaction: c.fixed_fee_per_transaction, created_by: user.id };
  const { error: e2 } = await sb.from("fee_rules").insert(fee);
  if (e2) throw new Error(e2.message);

  await audit(user.id, "costs.update", "cost_profiles", c.platform, { profile: oldProfile, fee: oldFee }, { profile, fee });
  revalidatePath("/settings");
}

async function _saveAlerts(form: FormData) {
  const user = await requireWriter();
  const sb = await supabaseServer();
  const { data: rules } = await sb.from("alert_rules").select("id, kind, threshold, enabled");
  for (const r of rules ?? []) {
    const threshold = z.coerce.number().min(0).max(1_000_000).parse(form.get(`threshold_${r.id}`) ?? r.threshold);
    const enabled = form.get(`enabled_${r.id}`) === "on";
    if (Number(r.threshold) !== threshold || r.enabled !== enabled) {
      await sb.from("alert_rules").update({ threshold, enabled }).eq("id", r.id);
      await audit(user.id, "alert.update", "alert_rules", r.id, r, { threshold, enabled });
    }
  }
  revalidatePath("/settings");
}

const validTz = (v: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v });
    return true;
  } catch {
    return false;
  }
};

/** Reporting time zone, accounting basis and LIVE attribution rules. */
async function _saveRules(form: FormData) {
  const user = await requireWriter();
  const f = z
    .object({
      timezone: z.string().refine(validTz, "unknown time zone"),
      revenue_basis: z.enum(["created", "paid"]),
      attribution_before_minutes: z.coerce.number().int().min(0).max(120),
      attribution_after_minutes: z.coerce.number().int().min(0).max(240),
      auto_show_idle_minutes: z.coerce.number().int().min(5).max(240),
    })
    .parse(Object.fromEntries(form));
  const sb = await supabaseServer();
  const { data: before } = await sb.from("app_settings").select("*").eq("id", 1).single();
  const { error } = await sb.from("app_settings").update({ ...f, updated_at: new Date().toISOString() }).eq("id", 1);
  if (error) throw new Error(error.message);
  await audit(user.id, "settings.rules", "app_settings", "1", before, f);
  revalidatePath("/", "layout");
}

export async function saveCosts(_p: ActionState, f: FormData) { return run(_saveCosts, f); }
export async function saveAlerts(_p: ActionState, f: FormData) { return run(_saveAlerts, f); }
export async function saveRules(_p: ActionState, f: FormData) { return run(_saveRules, f); }
