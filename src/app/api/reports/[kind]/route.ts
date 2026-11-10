import { supabaseServer } from "@/lib/supabase/clients";
import { getTimezone } from "@/lib/data/context";
import { loadReport } from "@/lib/data/report";
import { fetchAll, loadShowSnapshot } from "@/lib/data/shows";
import { resolveRange, type RangeKey } from "@/lib/dates";
import { computeMinutes } from "@/lib/engine/minutes";
import { productBreakdown, type ProductRow } from "@/lib/engine/products";
import { breakdownOrder } from "@/lib/engine/ledger";
import { normalizeCosts } from "@/lib/engine/defaults";
import { csvCell } from "@/lib/data/products";
import { d, Decimal, ZERO } from "@/lib/engine/money";

export const dynamic = "force-dynamic";

const KINDS = ["shows", "orders", "minutes", "customers", "products", "payroll", "expenses"] as const;
type Kind = (typeof KINDS)[number];

const m2 = (v: Decimal | null | undefined) => (v === null || v === undefined ? "" : v.toDecimalPlaces(2).toFixed(2));
const csv = (header: string[], rows: unknown[][]) => [header.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n") + "\n";

/**
 * CSV exports. ?range=&from=&to=&show=&test=1
 * Auth: the signed-in user's client, so RLS limits data to members.
 */
export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (!KINDS.includes(kind as Kind)) return new Response("Unknown export", { status: 404 });
  const sb = await supabaseServer();
  const { data: auth } = await sb.auth.getClaims();
  if (!auth?.claims?.sub) return new Response("Not signed in", { status: 401 });

  const u = new URL(req.url);
  const tz = await getTimezone(sb);
  const showId = u.searchParams.get("show") || undefined;
  const includeTest = u.searchParams.get("test") === "1";
  const range = showId
    ? { from: new Date(0), to: new Date(Date.now() + 86_400_000), label: "show" }
    : resolveRange(tz, (u.searchParams.get("range") ?? "30d") as RangeKey, u.searchParams.get("from") ?? undefined, u.searchParams.get("to") ?? undefined);
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const t = (iso: string | null | undefined) => (iso ? local.format(new Date(iso)).replace(",", "") : "");
  const now = new Date();
  let body = "";
  let name = `casadebeauty-${kind}`;

  if (kind === "minutes") {
    if (!showId) return new Response("Pass ?show=<show id>", { status: 400 });
    const snap = await loadShowSnapshot(sb, showId);
    if (!snap) return new Response("Show not found", { status: 404 });
    const v = computeMinutes(snap.input, now);
    name += `-${snap.meta.title.replace(/[^\w-]+/g, "_").slice(0, 40)}`;
    body = csv(
      ["minute_index", "minute_start_local", "elapsed_minutes", "active_seconds", "orders", "units", "revenue", "product_cost", "commission", "platform_fees", "labor", "hourly_expenses", "fixed_expenses", "packing", "net_shipping", "minute_profit", "cumulative_revenue", "cumulative_expenses", "cumulative_profit", "avg_profit_per_minute"],
      v.minutes.map((x) => [x.index, t(x.start), x.elapsedMinutes, x.activeSeconds, x.orders, x.units, m2(x.revenue), m2(x.cogs), m2(x.commission), m2(x.fees), m2(x.labor), m2(x.hourlyExpenses), m2(x.fixedExpenses), m2(x.packing), m2(x.shipping), m2(x.profit), m2(x.cumulativeRevenue), m2(x.cumulativeExpenses), m2(x.cumulativeProfit), m2(x.avgProfitPerMinute)]),
    );
  } else {
    const rows = await loadReport(sb, { from: range.from, to: range.to, includeTest, showId });
    if (!showId) name += `-${range.from.toISOString().slice(0, 10)}-to-${range.to.toISOString().slice(0, 10)}`;

    if (kind === "shows") {
      body = csv(
        ["show_id", "tiktok_live_id", "title", "platform", "test", "hosts", "assistants", "start_local", "end_local", "duration_minutes", "duration_hours", "status", "data_status", "revenue", "orders", "units", "avg_selling_price", "avg_order_value", "product_cost", "presenter_pay", "assistant_pay", "platform_fees", "fees_estimated", "hourly_expenses", "fixed_expenses", "packing", "net_shipping", "shipping_pending_orders", "total_expenses", "estimated_profit", "reconciled_profit", "profit_per_minute", "profit_per_hour", "margin_pct", "orders_per_minute", "units_per_minute"],
        rows.map((r) => {
          const p = r.metrics;
          return [r.id, r.liveRoomId ?? "", r.title, r.platform, r.isTest, r.hosts.join(" + "), r.assistants.join(" + "), t(r.startedAt), t(r.endedAt), p.activeMinutes.toFixed(1), p.activeHours.toFixed(3), r.status, r.dataStatus, m2(p.netMerchandise), p.orders, p.itemsSold, m2(p.avgSellingPrice), m2(p.avgOrderValue), m2(p.costs.product), m2(p.labor.presenter), m2(p.labor.assistant), m2(p.platformFees), p.flags.feesEstimated, m2(p.costs.hourlyExpenses), m2(p.costs.fixedExpenses), m2(p.costs.packing), m2(p.netShippingCost), p.flags.shippingUnknownOrders, m2(p.totalExpenses), m2(p.operatingProfit), m2(p.reconciledProfit), m2(p.profitPerMinute), m2(p.profitPerHour), m2(p.marginPct), p.ordersPerMinute?.toFixed(3) ?? "", p.unitsPerMinute?.toFixed(3) ?? ""];
        }),
      );
    } else if (kind === "payroll") {
      body = csv(
        ["show_id", "show", "start_local", "person", "role", "minutes", "units_credited", "sales_credited", "commission", "hourly", "flat", "total_pay"],
        rows.flatMap((r) => r.metrics.labor.byStaff.map((s) => [r.id, r.title, t(r.startedAt), s.name, s.role === "host" ? "presenter" : "assistant", s.minutes, s.unitsCredited, m2(s.salesCredited), m2(s.commission), m2(s.hourly), m2(s.flat), m2(s.total)])),
      );
    } else if (kind === "products") {
      const merged = new Map<string, ProductRow>();
      for (const r of rows) {
        for (const p of productBreakdown(r.show.input.orders, r.show.input.costs)) {
          const k = p.sku + "|" + p.title;
          const c = merged.get(k);
          if (!c) merged.set(k, { ...p });
          else {
            c.units += p.units;
            c.netRevenue = c.netRevenue.plus(p.netRevenue);
            c.productCost = c.productCost.plus(p.productCost);
            c.contribution = c.contribution.plus(p.contribution);
            c.costEstimated ||= p.costEstimated;
          }
        }
      }
      body = csv(
        ["sku", "product", "units", "revenue", "product_cost", "avg_price", "gross_margin_pct", "contribution", "cost_estimated"],
        [...merged.values()]
          .sort((a, b) => b.units - a.units)
          .map((p) => [p.sku, p.title, p.units, m2(p.netRevenue), m2(p.productCost), m2(p.units ? p.netRevenue.div(p.units) : null), m2(p.netRevenue.gt(0) ? p.netRevenue.minus(p.productCost).div(p.netRevenue).times(100) : null), m2(p.contribution), p.costEstimated]),
      );
    } else if (kind === "orders" || kind === "customers") {
      // orders in range (or for one show) — including unassigned ones, with their show if any
      const orders = await fetchAll((a, b) => {
        let q = sb.from("orders").select("id, platform, show_id, external_order_id, status, platform_status, is_test, currency, created_at_platform, paid_at, received_at, customer_id, customer_shipping, platform_shipping_subsidy, seller_shipping_cost, platform_gmv, actual_platform_fees, settlement_amount, live_room_id, attribution, attribution_method, attribution_note, order_items(*), refunds(*), customers(external_customer_id, display_name), live_shows(title, cost_snapshot)");
        q = showId ? q.eq("show_id", showId) : q.gte("created_at_platform", range.from.toISOString()).lt("created_at_platform", range.to.toISOString());
        if (!includeTest) q = q.eq("is_test", false);
        return q.order("created_at_platform").range(a, b);
      });
      if (kind === "orders") {
        body = csv(
          ["tiktok_order_id", "created_local", "paid_local", "status", "test", "customer_id", "customer_name", "show", "attribution", "matched_by", "units", "gross", "seller_discount", "platform_discount", "refunds", "product_revenue", "customer_shipping", "platform_shipping_subsidy", "seller_shipping_charges", "platform_fees_reported", "settlement", "items"],
          orders.map((o: any) => {
            const b = breakdownOrder(
              { externalOrderId: o.external_order_id, createdAt: o.created_at_platform, status: o.status, isTest: o.is_test, items: (o.order_items ?? []).map((i: any) => ({ externalItemId: i.external_item_id, sku: i.sku, title: i.title, quantity: i.quantity, unitPrice: String(i.unit_price), sellerDiscount: String(i.seller_discount), platformDiscount: String(i.platform_discount) })), refunds: (o.refunds ?? []).map((r: any) => ({ externalRefundId: r.external_refund_id, externalItemId: r.external_item_id, quantity: r.quantity, amount: String(r.amount), refundedAt: r.refunded_at })), customerShipping: "0", platformShippingSubsidy: null, sellerShippingCost: null, platformGmv: null, actualPlatformFees: null, settlementAmount: null },
              o.live_shows?.cost_snapshot ? normalizeCosts(o.live_shows.cost_snapshot) : { skuCosts: {}, defaultProductCost: "0" },
            );
            return [o.external_order_id, t(o.created_at_platform), t(o.paid_at), o.status, o.is_test, o.customers?.external_customer_id ?? "", o.customers?.display_name ?? "", o.live_shows?.title ?? "", o.attribution, o.attribution_method ?? "", b.unitsShipped, m2(b.gross), m2(b.sellerDiscount), m2(b.platformDiscount), m2(b.refunds), m2(b.net), m2(d(o.customer_shipping)), o.platform_shipping_subsidy ?? "", o.seller_shipping_cost ?? "", o.actual_platform_fees ?? "", o.settlement_amount ?? "", (o.order_items ?? []).map((i: any) => `${i.quantity}x ${i.title}`).join("; ")];
          }),
        );
      } else {
        const agg = new Map<string, { id: string; name: string; orders: number; units: number; spent: Decimal; shows: Set<string>; first: string; last: string }>();
        for (const o of orders as any[]) {
          if (o.status === "cancelled" || !o.customers) continue;
          const id = o.customers.external_customer_id;
          const a = agg.get(id) ?? { id, name: o.customers.display_name ?? "", orders: 0, units: 0, spent: ZERO, shows: new Set<string>(), first: o.created_at_platform, last: o.created_at_platform };
          const net = (o.order_items ?? []).reduce((s: Decimal, i: any) => s.plus(d(i.unit_price).times(i.quantity)).minus(d(i.seller_discount)), ZERO).minus((o.refunds ?? []).reduce((s: Decimal, r: any) => s.plus(d(r.amount)), ZERO));
          a.orders++;
          a.units += (o.order_items ?? []).reduce((s: number, i: any) => s + i.quantity, 0) - (o.refunds ?? []).reduce((s: number, r: any) => s + r.quantity, 0);
          a.spent = a.spent.plus(net);
          if (o.show_id) a.shows.add(o.show_id);
          if (o.created_at_platform > a.last) a.last = o.created_at_platform;
          if (o.created_at_platform < a.first) a.first = o.created_at_platform;
          agg.set(id, a);
        }
        body = csv(
          ["customer_id", "name", "orders", "units", "spent", "avg_order_value", "lives_bought_from", "first_order_local", "last_order_local"],
          [...agg.values()].sort((a, b) => b.spent.comparedTo(a.spent)).map((a) => [a.id, a.name || "unavailable", a.orders, a.units, m2(a.spent), m2(a.spent.div(a.orders)), a.shows.size, t(a.first), t(a.last)]),
        );
      }
    } else if (kind === "expenses") {
      const ids = rows.map((r) => r.id);
      const { data: ex } = ids.length ? await sb.from("show_expenses").select("*").in("show_id", ids.slice(0, 500)).order("incurred_at") : { data: [] as any[] };
      const titles = new Map(rows.map((r) => [r.id, r.title]));
      const fixed = (ex ?? []).map((e: any) => ["fixed", titles.get(e.show_id) ?? "", t(e.incurred_at), e.category ?? "other", e.description, m2(d(e.amount))]);
      const hourly = rows.flatMap((r) => r.metrics.hourlyExpenseBreakdown.map((h) => ["hourly", r.title, t(r.startedAt), h.category, h.label, m2(h.amount)]));
      body = csv(["type", "show", "time_local", "category", "description", "amount"], [...fixed, ...hourly]);
    }
  }

  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}.csv"`,
      "cache-control": "no-store",
    },
  });
}
