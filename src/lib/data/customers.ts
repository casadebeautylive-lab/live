import type { SupabaseClient } from "@supabase/supabase-js";
import { d, Decimal, ZERO } from "@/lib/engine/money";
import { fetchAll } from "./shows";

const ORDER_COLS = "id, customer_id, show_id, status, is_test, created_at_platform, order_items(sku, title, quantity, unit_price, seller_discount), refunds(amount, quantity)";

export type CustOrder = {
  id: string;
  customerId: string;
  showId: string | null;
  status: string;
  isTest: boolean;
  createdAt: string;
  units: number;
  revenue: Decimal; // Σ unit_price×qty − seller discount − refunds; 0 when cancelled
  refunded: Decimal;
  items: { sku: string | null; title: string; quantity: number }[];
};

export function mapCustOrder(o: any): CustOrder {
  const items = (o.order_items ?? []) as any[];
  const gross = items.reduce((a: Decimal, i: any) => a.plus(d(i.unit_price).times(i.quantity)).minus(d(i.seller_discount)), ZERO);
  const refunded = ((o.refunds ?? []) as any[]).reduce((a: Decimal, r: any) => a.plus(d(r.amount)), ZERO);
  const refundedUnits = ((o.refunds ?? []) as any[]).reduce((a: number, r: any) => a + Math.max(0, Number(r.quantity ?? 0)), 0);
  const cancelled = o.status === "cancelled";
  return {
    id: o.id,
    customerId: o.customer_id,
    showId: o.show_id ?? null,
    status: o.status,
    isTest: !!o.is_test,
    createdAt: o.created_at_platform,
    units: cancelled ? 0 : Math.max(0, items.reduce((a: number, i: any) => a + Math.max(0, Number(i.quantity)), 0) - refundedUnits),
    revenue: cancelled ? ZERO : gross.minus(refunded),
    refunded,
    items: items.map((i) => ({ sku: i.sku ?? null, title: i.title, quantity: Number(i.quantity) })),
  };
}

export type CustomerInfo = { id: string; platform: string; externalId: string; displayName: string | null; firstOrderAt: string | null; lastOrderAt: string | null };

const chunk = <T,>(arr: T[], n: number) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export const mapCustomer = (c: any): CustomerInfo => ({
  id: c.id,
  platform: c.platform,
  externalId: c.external_customer_id,
  displayName: c.display_name ?? null,
  firstOrderAt: c.first_order_at ?? null,
  lastOrderAt: c.last_order_at ?? null,
});

/** Display label. Never invent a name: fall back to a short form of the platform buyer id. */
export const customerLabel = (c: Pick<CustomerInfo, "displayName" | "externalId">) => c.displayName?.trim() || `Buyer …${c.externalId.slice(-6)}`;

export type CustomerStats = {
  orders: number;
  units: number;
  spent: Decimal;
  shows: number;
  bestShow: { showId: string; spent: Decimal } | null;
  firstAt: string | null;
  lastAt: string | null;
  aov: Decimal | null;
  /** Average days between consecutive (non-cancelled) orders; null with fewer than 2 orders. */
  avgDaysBetween: number | null;
};

/** Aggregate a single customer's orders. Cancelled orders don't count as orders. */
export function statsFor(orders: CustOrder[]): CustomerStats {
  const live = orders.filter((o) => o.status !== "cancelled").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const byShow = new Map<string, Decimal>();
  let spent = ZERO;
  let units = 0;
  for (const o of live) {
    spent = spent.plus(o.revenue);
    units += o.units;
    if (o.showId) byShow.set(o.showId, (byShow.get(o.showId) ?? ZERO).plus(o.revenue));
  }
  let bestShow: CustomerStats["bestShow"] = null;
  for (const [showId, v] of byShow) if (!bestShow || v.gt(bestShow.spent)) bestShow = { showId, spent: v };
  const firstAt = live[0]?.createdAt ?? null;
  const lastAt = live[live.length - 1]?.createdAt ?? null;
  const avgDaysBetween =
    live.length >= 2 && firstAt && lastAt ? (new Date(lastAt).getTime() - new Date(firstAt).getTime()) / 86_400_000 / (live.length - 1) : null;
  return { orders: live.length, units, spent, shows: byShow.size, bestShow, firstAt, lastAt, aov: live.length ? spent.div(live.length) : null, avgDaysBetween };
}

/** Orders with a buyer id placed in [from, to). */
export async function loadPeriodCustomerOrders(sb: SupabaseClient, opts: { from: Date; to: Date; includeTest: boolean }): Promise<CustOrder[]> {
  const rows = await fetchAll((a, b) => {
    let q = sb
      .from("orders")
      .select(ORDER_COLS)
      .not("customer_id", "is", null)
      .gte("created_at_platform", opts.from.toISOString())
      .lt("created_at_platform", opts.to.toISOString());
    if (!opts.includeTest) q = q.eq("is_test", false);
    return q.order("id").range(a, b);
  });
  return rows.map(mapCustOrder);
}

/** Every order (any date) for these customers — used for lifetime columns. */
export async function loadLifetimeOrders(sb: SupabaseClient, customerIds: string[], includeTest: boolean): Promise<CustOrder[]> {
  const out: CustOrder[] = [];
  for (const part of chunk(customerIds, 150)) {
    const rows = await fetchAll((a, b) => {
      let q = sb.from("orders").select(ORDER_COLS).in("customer_id", part);
      if (!includeTest) q = q.eq("is_test", false);
      return q.order("id").range(a, b);
    });
    out.push(...rows.map(mapCustOrder));
  }
  return out;
}

export async function loadCustomers(sb: SupabaseClient, ids: string[]): Promise<Map<string, CustomerInfo>> {
  const out = new Map<string, CustomerInfo>();
  for (const part of chunk(ids, 200)) {
    const { data, error } = await sb.from("customers").select("*").in("id", part);
    if (error) throw new Error(error.message);
    for (const c of data ?? []) out.set(c.id, mapCustomer(c));
  }
  return out;
}

export async function loadShowTitles(sb: SupabaseClient, ids: string[]): Promise<Map<string, { title: string; startedAt: string; isTest: boolean }>> {
  const out = new Map<string, { title: string; startedAt: string; isTest: boolean }>();
  for (const part of chunk([...new Set(ids)], 200)) {
    const { data } = await sb.from("live_shows").select("id, title, started_at, is_test").in("id", part);
    for (const s of data ?? []) out.set(s.id, { title: s.title, startedAt: s.started_at, isTest: s.is_test });
  }
  return out;
}

/** Count of non-cancelled orders in range with no buyer id (TikTok doesn't always send one). */
export async function countOrdersWithoutBuyer(sb: SupabaseClient, opts: { from: Date; to: Date; includeTest: boolean }): Promise<number> {
  let q = sb
    .from("orders")
    .select("id", { count: "exact", head: true })
    .is("customer_id", null)
    .neq("status", "cancelled")
    .gte("created_at_platform", opts.from.toISOString())
    .lt("created_at_platform", opts.to.toISOString());
  if (!opts.includeTest) q = q.eq("is_test", false);
  const { count } = await q;
  return count ?? 0;
}
