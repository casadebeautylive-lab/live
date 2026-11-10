import type { SupabaseClient } from "@supabase/supabase-js";
import { computeProfit, type DataStatus, type ProfitMetrics } from "@/lib/engine/profit";
import { computeVelocity } from "@/lib/engine/velocity";
import { Decimal, ZERO } from "@/lib/engine/money";
import { loadShowsBulk, type BulkShow } from "./shows";

export type ShowRow = {
  id: string;
  title: string;
  platform: string;
  isTest: boolean;
  startedAt: string;
  status: string;
  host: string;
  hours: Decimal;
  items: number;
  orders: number;
  revenue: Decimal;
  profit: Decimal;
  profitPerHour: Decimal | null;
  revenuePerHour: Decimal | null;
  marginPct: Decimal | null;
  itemsPerHour: Decimal | null;
  avgSecondsBetweenSales: number | null;
  asp: Decimal | null;
  estimated: boolean;
  endedAt: string | null;
  liveRoomId: string | null;
  hosts: string[];
  assistants: string[];
  totalExpenses: Decimal;
  reconciledProfit: Decimal | null;
  dataStatus: DataStatus;
  profitPerMinute: Decimal | null;
  metrics: ProfitMetrics;
  show: BulkShow;
};

export type GroupRow = {
  key: string;
  shows: number;
  hours: Decimal;
  items: number;
  revenue: Decimal;
  profit: Decimal;
  profitPerHour: Decimal | null;
  revenuePerHour: Decimal | null;
  marginPct: Decimal | null;
  itemsPerHour: Decimal | null;
  asp: Decimal | null;
};

export async function loadReport(
  sb: SupabaseClient,
  opts: { from: Date; to: Date; platform?: string; includeTest: boolean; showId?: string; host?: string },
): Promise<ShowRow[]> {
  let q = sb
    .from("live_shows")
    .select("*")
    .gte("started_at", opts.from.toISOString())
    .lt("started_at", opts.to.toISOString())
    .order("started_at", { ascending: false })
    .limit(1000);
  if (opts.platform) q = q.eq("platform", opts.platform);
  if (!opts.includeTest) q = q.eq("is_test", false);
  if (opts.showId) q = q.eq("id", opts.showId);
  q = q.neq("status", "scheduled");
  const { data: shows } = await q;
  const bulk = await loadShowsBulk(sb, shows ?? []);
  const now = new Date();

  const rows = bulk.map((b) => {
    const { meta, input } = b;
    const p = computeProfit(input, now);
    const v = computeVelocity(input, now);
    return {
      id: meta.id,
      title: meta.title,
      platform: meta.platform,
      isTest: meta.isTest,
      startedAt: meta.startedAt,
      status: meta.status,
      host: meta.staff.filter((s) => s.role === "host").map((s) => s.name).join(" + ") || "Default presenter",
      hours: p.activeHours,
      items: p.itemsSold,
      orders: p.orders,
      revenue: p.netMerchandise,
      profit: p.operatingProfit,
      profitPerHour: p.profitPerHour,
      revenuePerHour: v.revenuePerHour,
      marginPct: p.marginPct,
      itemsPerHour: v.itemsPerHour,
      avgSecondsBetweenSales: v.avgSecondsBetweenSales,
      asp: p.avgSellingPrice,
      estimated: p.flags.feesEstimated || p.flags.productCostEstimated,
      endedAt: meta.endedAt,
      liveRoomId: meta.liveRoomId,
      hosts: [...new Set(meta.staff.filter((s) => s.role === "host").map((s) => s.name))],
      assistants: [...new Set(meta.staff.filter((s) => s.role === "assistant").map((s) => s.name))],
      totalExpenses: p.totalExpenses,
      reconciledProfit: p.reconciledProfit,
      dataStatus: p.dataStatus,
      profitPerMinute: p.profitPerMinute,
      metrics: p,
      show: b,
    } satisfies ShowRow;
  });
  return opts.host ? rows.filter((r) => r.hosts.includes(opts.host!)) : rows;
}

/** Aggregate shows by a key. Rates are computed from totals (hour-weighted), not averaged. */
export function groupBy(rows: ShowRow[], keyOf: (r: ShowRow) => string): GroupRow[] {
  const map = new Map<string, GroupRow>();
  for (const r of rows) {
    const k = keyOf(r);
    const g = map.get(k) ?? { key: k, shows: 0, hours: ZERO, items: 0, revenue: ZERO, profit: ZERO, profitPerHour: null, revenuePerHour: null, marginPct: null, itemsPerHour: null, asp: null };
    g.shows++;
    g.hours = g.hours.plus(r.hours);
    g.items += r.items;
    g.revenue = g.revenue.plus(r.revenue);
    g.profit = g.profit.plus(r.profit);
    map.set(k, g);
  }
  for (const g of map.values()) {
    const h = g.hours.isZero() ? null : g.hours;
    g.profitPerHour = h && g.profit.div(h);
    g.revenuePerHour = h && g.revenue.div(h);
    g.itemsPerHour = h && new Decimal(g.items).div(h);
    g.marginPct = g.revenue.gt(0) ? g.profit.div(g.revenue).times(100) : null;
    g.asp = g.items ? g.revenue.div(g.items) : null;
  }
  return [...map.values()].sort((a, b) => b.profit.comparedTo(a.profit));
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // neutralize spreadsheet formula injection and quote
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(rows: ShowRow[], tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const d2 = (v: Decimal | null) => (v === null ? "" : v.toDecimalPlaces(2).toFixed(2));
  const header = [
    "show_id", "started_local", "title", "platform", "test", "host", "status", "hours", "items", "orders",
    "merch_revenue", "operating_profit", "profit_per_hour", "revenue_per_hour", "margin_pct", "items_per_hour",
    "avg_seconds_between_sales", "avg_price_per_item", "contains_estimates",
    "customer_paid_shipping", "total_paid_by_buyers",
  ];
  const lines = rows.map((r) =>
    [
      r.id, fmt.format(new Date(r.startedAt)), r.title, r.platform, r.isTest, r.host, r.status, r.hours.toFixed(3), r.items, r.orders,
      d2(r.revenue), d2(r.profit), d2(r.profitPerHour), d2(r.revenuePerHour), d2(r.marginPct), d2(r.itemsPerHour),
      r.avgSecondsBetweenSales?.toFixed(0) ?? "", d2(r.asp), r.estimated,
      d2(r.metrics.customerShipping), d2(r.revenue.plus(r.metrics.customerShipping)),
    ].map(csvCell).join(","),
  );
  return [header.join(","), ...lines].join("\n") + "\n";
}
