import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompRates, CostSnapshot, OrderInput, PackageInput, ShowInput, StaffShift } from "@/lib/engine/types";
import { Decimal } from "@/lib/engine/money";
import { normalizeCosts } from "@/lib/engine/defaults";

/** Order columns the app reads — never the raw TikTok payload (large, only needed for debugging). */
export const ORDER_COLUMNS =
  "id, platform, show_id, external_order_id, status, platform_status, is_test, currency, created_at_platform, paid_at, received_at, customer_id, customer_shipping, platform_shipping_subsidy, seller_shipping_cost, platform_gmv, actual_platform_fees, settlement_amount, live_room_id, order_type, attribution, attribution_method, attribution_note, order_items(external_item_id, sku, title, quantity, unit_price, seller_discount, platform_discount), refunds(external_refund_id, external_item_id, quantity, amount, refunded_at)";

export type ShowStatus = "scheduled" | "live" | "paused" | "ended" | "awaiting_reconciliation" | "finalized";

export const RUNNING: ShowStatus[] = ["live", "paused"];
export const isRunning = (s: string) => s === "live" || s === "paused";

export type ShowMeta = {
  id: string;
  title: string;
  platform: "tiktok" | "whatnot" | "manual";
  status: ShowStatus;
  isTest: boolean;
  startedAt: string;
  endedAt: string | null;
  recalculatedAt: string | null;
  detection: "manual" | "platform";
  liveRoomId: string | null;
  timesVerified: boolean;
  notes: string | null;
  staff: { id: string; staffId: string | null; name: string; role: "host" | "assistant"; joinedAt: string | null; leftAt: string | null; comp: CompRates }[];
};

/** One order as shown in "Recent sales": product money and shipping money kept separate. */
export type RecentSale = {
  id: string;
  externalId: string;
  at: string;
  title: string;
  units: number;
  /** Product money: item price × qty − seller discounts − refunds. */
  amount: string;
  /** Shipping the buyer paid (not revenue). */
  shipping: string;
  refunded: string;
  status: string;
};

export type ShowSnapshot = { meta: ShowMeta; input: ShowInput; recent: RecentSale[] };

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function mapOrderRow(o: any): OrderInput {
  return {
    externalOrderId: o.external_order_id,
    createdAt: o.created_at_platform,
    paidAt: o.paid_at ?? null,
    receivedAt: o.received_at,
    status: o.status,
    isTest: o.is_test,
    customerId: o.customer_id ?? null,
    orderType: o.order_type ?? null,
    items: (o.order_items ?? []).map((i: any) => ({
      externalItemId: i.external_item_id,
      sku: i.sku,
      title: i.title,
      quantity: i.quantity,
      unitPrice: String(i.unit_price),
      sellerDiscount: String(i.seller_discount),
      platformDiscount: String(i.platform_discount),
    })),
    refunds: (o.refunds ?? []).map((r: any) => ({
      externalRefundId: r.external_refund_id,
      externalItemId: r.external_item_id,
      quantity: r.quantity,
      amount: String(r.amount),
      refundedAt: r.refunded_at,
    })),
    customerShipping: String(o.customer_shipping),
    platformShippingSubsidy: s(o.platform_shipping_subsidy),
    sellerShippingCost: s(o.seller_shipping_cost),
    platformGmv: s(o.platform_gmv),
    actualPlatformFees: s(o.actual_platform_fees),
    settlementAmount: s(o.settlement_amount),
  };
}

/** PostgREST caps rows per request (1000 by default on Supabase), so page through. */
export async function fetchAll<T = any>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

const chunk = <T,>(arr: T[], n: number) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

function staffMeta(rows: any[], snapshot: CostSnapshot): ShowMeta["staff"] {
  const n = normalizeCosts(snapshot);
  return rows
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))
    .map((r) => ({
      id: r.id,
      staffId: r.staff_id ?? null,
      name: r.name ?? r.staff?.name ?? (r.role === "host" ? "Presenter" : "Assistant"),
      role: r.role,
      joinedAt: r.joined_at ?? null,
      leftAt: r.left_at ?? null,
      comp: { ...(r.role === "host" ? n.presenter : n.assistant), ...(r.comp ?? {}) },
    }));
}

/** Shifts for the engine. No rows = the snapshot's default presenter + assistant for the whole show. */
function shifts(meta: ShowMeta["staff"]): StaffShift[] | undefined {
  if (!meta.length) return undefined;
  return meta.map((m) => ({ staffId: m.staffId, name: m.name, role: m.role, joinedAt: m.joinedAt, leftAt: m.leftAt, comp: m.comp }));
}

/** Packages that contain any of these orders, keyed for the engine by external order id. */
async function loadPackages(sb: SupabaseClient, orders: any[]): Promise<Map<string, PackageInput>> {
  const ids = orders.map((o) => o.id);
  const extById = new Map(orders.map((o) => [o.id, o.external_order_id]));
  const links: any[] = [];
  for (const part of chunk(ids, 200)) {
    const { data } = await sb.from("package_orders").select("package_id, order_id").in("order_id", part);
    links.push(...(data ?? []));
  }
  const pkgIds = [...new Set(links.map((l) => l.package_id))];
  const out = new Map<string, PackageInput>();
  if (!pkgIds.length) return out;
  // all orders in those packages (a package may hold orders from another show; the split must count them)
  const allLinks: any[] = [];
  const pkgs: any[] = [];
  for (const part of chunk(pkgIds, 200)) {
    const [l, p] = await Promise.all([
      sb.from("package_orders").select("package_id, order_id, orders(external_order_id)").in("package_id", part),
      sb.from("packages").select("id, external_package_id, label_cost, reimbursement").in("id", part),
    ]);
    allLinks.push(...(l.data ?? []));
    pkgs.push(...(p.data ?? []));
  }
  for (const p of pkgs) {
    out.set(p.id, {
      externalPackageId: p.external_package_id,
      orderIds: allLinks
        .filter((l) => l.package_id === p.id)
        .map((l) => extById.get(l.order_id) ?? l.orders?.external_order_id)
        .filter(Boolean),
      labelCost: s(p.label_cost),
      reimbursement: String(p.reimbursement ?? 0),
    });
  }
  return out;
}

function metaFrom(show: any, staffRows: any[]): ShowMeta {
  return {
    id: show.id,
    title: show.title,
    platform: show.platform,
    status: show.status,
    isTest: show.is_test,
    startedAt: show.started_at,
    endedAt: show.ended_at,
    recalculatedAt: show.recalculated_at,
    detection: show.detection ?? "manual",
    liveRoomId: show.live_room_id ?? null,
    timesVerified: !!show.times_verified,
    notes: show.notes ?? null,
    staff: staffMeta(staffRows, show.cost_snapshot as CostSnapshot),
  };
}

export type BulkShow = { meta: ShowMeta; input: ShowInput };

/** Load many shows with batched queries (history, reports). */
export async function loadShowsBulk(sb: SupabaseClient, shows: any[], opts: { packages?: boolean } = {}): Promise<BulkShow[]> {
  if (!shows.length) return [];
  const ids = shows.map((x) => x.id);
  const orders: any[] = [];
  const pauses: any[] = [];
  const expenses: any[] = [];
  const staff: any[] = [];
  for (const part of chunk(ids, 100)) {
    const [o, p, e, st] = await Promise.all([
      fetchAll((a, b) => sb.from("orders").select(ORDER_COLUMNS).in("show_id", part).order("id").range(a, b)),
      sb.from("show_pauses").select("show_id, paused_at, resumed_at").in("show_id", part),
      sb.from("show_expenses").select("show_id, kind, category, description, amount, incurred_at").in("show_id", part),
      sb.from("show_staff").select("*, staff(id, name)").in("show_id", part),
    ]);
    orders.push(...o);
    pauses.push(...(p.data ?? []));
    expenses.push(...(e.data ?? []));
    staff.push(...(st.data ?? []));
  }
  const packages = opts.packages === false ? new Map<string, PackageInput>() : await loadPackages(sb, orders);
  const pkgList = [...packages.values()];

  return shows.map((show) => {
    const meta = metaFrom(show, staff.filter((r) => r.show_id === show.id));
    const showOrders = orders.filter((o) => o.show_id === show.id);
    const ext = new Set(showOrders.map((o) => o.external_order_id));
    return {
      meta,
      input: {
        startedAt: show.started_at,
        endedAt: show.ended_at,
        pauses: pauses.filter((p) => p.show_id === show.id).map((p) => ({ pausedAt: p.paused_at, resumedAt: p.resumed_at })),
        costs: show.cost_snapshot as CostSnapshot,
        expenses: expenses.filter((e) => e.show_id === show.id).map(mapExpense),
        orders: showOrders.map(mapOrderRow),
        staff: shifts(meta.staff),
        packages: pkgList.filter((p) => p.orderIds.some((id) => ext.has(id))),
      },
    };
  });
}

const mapExpense = (e: any) => ({
  kind: e.kind,
  category: e.category ?? undefined,
  description: e.description,
  amount: String(e.amount),
  incurredAt: e.incurred_at,
});

/** Load a show and everything the engine needs. Works with either user or admin client. */
export async function loadShowSnapshot(sb: SupabaseClient, showId: string): Promise<ShowSnapshot | null> {
  const { data: show } = await sb.from("live_shows").select("*").eq("id", showId).maybeSingle();
  if (!show) return null;

  const [pauses, expenses, orders, staff] = await Promise.all([
    sb.from("show_pauses").select("paused_at, resumed_at").eq("show_id", showId),
    sb.from("show_expenses").select("kind, category, description, amount, incurred_at").eq("show_id", showId),
    fetchAll((a, b) =>
      sb.from("orders").select(ORDER_COLUMNS).eq("show_id", showId).order("created_at_platform").order("id").range(a, b),
    ),
    sb.from("show_staff").select("*, staff(id, name)").eq("show_id", showId),
  ]);
  const packages = await loadPackages(sb, orders);

  const recent: RecentSale[] = [...orders]
    .reverse()
    .slice(0, 25)
    .map((o: any) => ({
      id: o.id,
      at: o.created_at_platform,
      title: (o.order_items ?? []).map((i: any) => i.title).join(", ") || "—",
      units: (o.order_items ?? []).reduce((a: number, i: any) => a + i.quantity, 0),
      externalId: o.external_order_id,
      amount: (o.order_items ?? [])
        .reduce((a: Decimal, i: any) => a.plus(new Decimal(i.unit_price).times(i.quantity)).minus(i.seller_discount), new Decimal(0))
        .minus((o.refunds ?? []).reduce((a: Decimal, r: any) => a.plus(r.amount), new Decimal(0)))
        .toFixed(2),
      shipping: new Decimal(o.customer_shipping ?? 0).toFixed(2),
      refunded: (o.refunds ?? []).reduce((a: Decimal, r: any) => a.plus(r.amount), new Decimal(0)).toFixed(2),
      status: o.status,
    }));

  const meta = metaFrom(show, staff.data ?? []);
  return {
    meta,
    input: {
      startedAt: show.started_at,
      endedAt: show.ended_at,
      pauses: (pauses.data ?? []).map((p: any) => ({ pausedAt: p.paused_at, resumedAt: p.resumed_at })),
      costs: show.cost_snapshot as CostSnapshot,
      expenses: (expenses.data ?? []).map(mapExpense),
      orders: orders.map(mapOrderRow),
      staff: shifts(meta.staff),
      packages: [...packages.values()],
    },
    recent,
  };
}
