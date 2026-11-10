import type { SupabaseClient } from "@supabase/supabase-js";
import { breakdownOrder } from "@/lib/engine/ledger";
import { normalizeCosts } from "@/lib/engine/defaults";
import { d, Decimal, ZERO } from "@/lib/engine/money";
import type { CostSnapshot } from "@/lib/engine/types";
import { mapOrderRow } from "./shows";

export type AttributionStatus = "assigned" | "unassigned" | "needs_review" | "not_live";

export const ATTRIBUTION_LABEL: Record<AttributionStatus, [string, string]> = {
  assigned: ["Assigned", "border-pos/40 bg-pos/10 text-pos"],
  needs_review: ["Needs review", "border-warn/40 bg-warn/10 text-warn"],
  unassigned: ["Unassigned", "border-line bg-panel-2 text-muted"],
  not_live: ["Not from a LIVE", "border-info/40 bg-info/10 text-info"],
};

export const METHOD_LABEL: Record<string, string> = {
  platform_live_id: "TikTok LIVE id",
  time_window: "Show time window",
  manual: "Manual",
};

/** Columns the orders list and drilldown need (customer + show embedded). */
export const ORDER_SELECT =
  "id, platform, show_id, external_order_id, status, platform_status, is_test, currency, created_at_platform, paid_at, received_at, customer_id, customer_shipping, platform_shipping_subsidy, seller_shipping_cost, platform_gmv, actual_platform_fees, settlement_amount, live_room_id, attribution, attribution_method, attribution_note, order_items(*), refunds(*), customers(id, display_name, external_customer_id), live_shows(id, title, is_test, started_at, ended_at, cost_snapshot)";

export type ShowOption = { id: string; title: string; isTest: boolean; startedAt: string; endedAt: string | null; platform: string };

const toShowOption = (s: any): ShowOption => ({
  id: s.id,
  title: s.title,
  isTest: !!s.is_test,
  startedAt: s.started_at,
  endedAt: s.ended_at ?? null,
  platform: s.platform,
});

/** Product revenue for one order: Σ unit_price×qty − seller discounts − refunds (decimal). */
export function orderMoney(o: any) {
  const b = breakdownOrder(mapOrderRow(o), { skuCosts: {}, defaultProductCost: "0" });
  return {
    net: b.net,
    refunds: b.refunds,
    units: b.unitsShipped,
    titles: (o.order_items ?? []).map((i: any) => String(i.title)),
  };
}

export function customerLabel(o: any): string | null {
  const c = o.customers;
  if (!c) return null;
  return c.display_name || c.external_customer_id || null;
}

export type FeeRule = { percentFee: string; fixedFee: string };

/** Active fee rule per platform (fallback estimate for orders without a show snapshot). */
export async function loadFeeRules(sb: SupabaseClient): Promise<Record<string, FeeRule>> {
  const { data } = await sb.from("fee_rules").select("platform, percent_fee, fixed_fee_per_transaction").eq("is_active", true);
  const out: Record<string, FeeRule> = {};
  for (const r of data ?? []) out[r.platform] = { percentFee: String(r.percent_fee), fixedFee: String(r.fixed_fee_per_transaction) };
  return out;
}

/**
 * Platform fees: actual when TikTok reported them, otherwise an estimate from the
 * show's frozen snapshot (or the active fee rule when the order has no show).
 * Returns null when no rule is available.
 */
export function orderFees(o: any, net: Decimal, rules: Record<string, FeeRule>): { amount: Decimal; estimated: boolean } | null {
  if (o.actual_platform_fees !== null && o.actual_platform_fees !== undefined) return { amount: d(o.actual_platform_fees), estimated: false };
  if (o.status === "cancelled") return { amount: ZERO, estimated: true };
  let pct: string | null = null;
  let fixed: string | null = null;
  const snap = o.live_shows?.cost_snapshot as CostSnapshot | undefined;
  if (snap) {
    const n = normalizeCosts(snap);
    pct = n.percentFee;
    fixed = n.fixedFeePerTransaction;
  } else if (rules[o.platform]) {
    pct = rules[o.platform].percentFee;
    fixed = rules[o.platform].fixedFee;
  }
  if (pct === null || fixed === null) return null;
  return { amount: Decimal.max(net, ZERO).times(d(pct)).plus(d(fixed)), estimated: true };
}

/** Shows whose window overlaps [from, to). */
export async function loadShowsInRange(sb: SupabaseClient, from: Date, to: Date, includeTest: boolean): Promise<ShowOption[]> {
  let q = sb
    .from("live_shows")
    .select("id, title, platform, is_test, started_at, ended_at")
    .lt("started_at", to.toISOString())
    .or(`ended_at.is.null,ended_at.gte.${from.toISOString()}`)
    .order("started_at", { ascending: false })
    .limit(500);
  if (!includeTest) q = q.eq("is_test", false);
  const { data } = await q;
  return (data ?? []).map(toShowOption);
}

const TWO_HOURS = 2 * 3_600_000;

/**
 * Candidate shows per order: the latest attribution decision's candidate_show_ids,
 * plus any show (same test flag) whose window contains the order time ±2h.
 */
export async function candidateShows(sb: SupabaseClient, orders: any[]): Promise<Map<string, ShowOption[]>> {
  const out = new Map<string, ShowOption[]>();
  if (!orders.length) return out;
  const ids = orders.map((o) => o.id);
  const { data: attrs } = await sb
    .from("order_show_attributions")
    .select("order_id, candidate_show_ids, created_at")
    .in("order_id", ids)
    .order("created_at", { ascending: false });
  const latest = new Map<string, string[]>();
  for (const a of attrs ?? []) if (!latest.has(a.order_id)) latest.set(a.order_id, (a.candidate_show_ids ?? []) as string[]);

  const times = orders.map((o) => Date.parse(o.created_at_platform));
  const min = new Date(Math.min(...times) - TWO_HOURS).toISOString();
  const max = new Date(Math.max(...times) + TWO_HOURS).toISOString();
  const { data: windowShows } = await sb
    .from("live_shows")
    .select("id, title, platform, is_test, started_at, ended_at")
    .lte("started_at", max)
    .or(`ended_at.is.null,ended_at.gte.${min}`)
    .limit(500);
  const byId = new Map<string, ShowOption>((windowShows ?? []).map((s: any) => [s.id, toShowOption(s)]));

  const missing = [...new Set([...latest.values()].flat())].filter((id) => !byId.has(id));
  if (missing.length) {
    const { data } = await sb.from("live_shows").select("id, title, platform, is_test, started_at, ended_at").in("id", missing);
    for (const s of data ?? []) byId.set(s.id, toShowOption(s));
  }

  const now = Date.now();
  for (const o of orders) {
    const t = Date.parse(o.created_at_platform);
    const set = new Map<string, ShowOption>();
    for (const id of latest.get(o.id) ?? []) {
      const s = byId.get(id);
      if (s) set.set(id, s);
    }
    for (const s of byId.values()) {
      if (s.isTest !== !!o.is_test) continue;
      const a = Date.parse(s.startedAt) - TWO_HOURS;
      const b = (s.endedAt ? Date.parse(s.endedAt) : now) + TWO_HOURS;
      if (t >= a && t <= b) set.set(s.id, s);
    }
    out.set(
      o.id,
      [...set.values()].sort((x, y) => Math.abs(Date.parse(x.startedAt) - t) - Math.abs(Date.parse(y.startedAt) - t)),
    );
  }
  return out;
}
