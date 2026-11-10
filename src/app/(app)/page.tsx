import Link from "next/link";
import { supabaseAdmin, supabaseServer } from "@/lib/supabase/clients";
import { sweepIdleShows } from "@/lib/lifecycle";
import { getTimezone } from "@/lib/data/context";
import { groupBy, loadReport, type ShowRow } from "@/lib/data/report";
import { addDays, localDate, resolveRange, startOfLocalDay, type RangeKey } from "@/lib/dates";
import { Decimal, formatPct, formatUsd, ZERO } from "@/lib/engine/money";
import { productBreakdown, type ProductRow } from "@/lib/engine/products";
import { fmtDuration, fmtTime } from "@/lib/format";
import { DataStatusBadge, Empty, Kpi, PageHeader, PeriodFilter, StatusPill, tone } from "@/components/ui";
import { BarChart, LineChart } from "@/components/Charts";

type SP = { range?: RangeKey | "current" | "last"; from?: string; to?: string; host?: string; show?: string; sku?: string; test?: string };

const sumD = (rows: ShowRow[], f: (r: ShowRow) => Decimal) => rows.reduce((a, r) => a.plus(f(r)), ZERO);

export default async function DashboardPage({ searchParams }: { searchParams: Promise<SP> }) {
  await sweepIdleShows(supabaseAdmin());
  const sp = await searchParams;
  const sb = await supabaseServer();
  const tz = await getTimezone(sb);
  const includeTest = sp.test === "1";

  // "Current LIVE" / "Last LIVE" quick filters resolve to one show
  let showId = sp.show;
  if (sp.range === "current" || sp.range === "last") {
    let q = sb.from("live_shows").select("id").order("started_at", { ascending: false }).limit(1);
    q = sp.range === "current" ? q.in("status", ["live", "paused"]) : q.not("status", "in", "(live,paused,scheduled)");
    if (!includeTest) q = q.eq("is_test", false);
    const { data } = await q;
    showId = data?.[0]?.id ?? "00000000-0000-0000-0000-000000000000";
  }
  const key: RangeKey = sp.range && sp.range !== "current" && sp.range !== "last" ? sp.range : "7d";
  const range = showId
    ? { from: new Date(0), to: new Date(Date.now() + 86_400_000), label: sp.range === "current" ? "Current LIVE" : sp.range === "last" ? "Last LIVE" : "Selected show" }
    : resolveRange(tz, key, sp.from, sp.to);

  const [rows, { data: running }, { data: hostsList }, { count: reviewCount }] = await Promise.all([
    loadReport(sb, { from: range.from, to: range.to, includeTest, showId, host: sp.host }),
    sb.from("live_shows").select("id, title, started_at, is_test").in("status", ["live", "paused"]).order("started_at", { ascending: false }),
    sb.from("show_staff").select("name").eq("role", "host").limit(500),
    sb.from("orders").select("id", { count: "exact", head: true }).eq("attribution", "needs_review").eq("is_test", false),
  ]);
  const hostNames = [...new Set((hostsList ?? []).map((h) => h.name).filter(Boolean))].sort();

  const revenue = sumD(rows, (r) => r.revenue);
  const profit = sumD(rows, (r) => r.profit);
  const expenses = sumD(rows, (r) => r.totalExpenses);
  const hours = sumD(rows, (r) => r.hours);
  const units = rows.reduce((a, r) => a + r.items, 0);
  const orders = rows.reduce((a, r) => a + r.orders, 0);
  const finalized = rows.filter((r) => r.reconciledProfit !== null);
  const reconciled = sumD(finalized, (r) => r.reconciledProfit!);
  const estimated = rows.some((r) => r.dataStatus !== "finalized");

  // products across shows (each with its own frozen costs)
  const prodMap = new Map<string, ProductRow>();
  for (const r of rows) {
    for (const p of productBreakdown(r.show.input.orders, r.show.input.costs)) {
      const k = p.sku + "|" + p.title;
      const cur = prodMap.get(k);
      if (!cur) prodMap.set(k, { ...p });
      else {
        cur.units += p.units;
        cur.unitsShipped += p.unitsShipped;
        cur.netRevenue = cur.netRevenue.plus(p.netRevenue);
        cur.productCost = cur.productCost.plus(p.productCost);
        cur.contribution = cur.contribution.plus(p.contribution);
        cur.costEstimated = cur.costEstimated || p.costEstimated;
      }
    }
  }
  const products = [...prodMap.values()].sort((a, b) => b.units - a.units);
  const skuRow = sp.sku ? products.find((p) => p.sku === sp.sku) : undefined;

  // top customers in the period (stable ids only)
  const spend = new Map<string, { revenue: Decimal; orders: number; units: number }>();
  for (const r of rows) {
    for (const o of r.show.input.orders) {
      if (o.status === "cancelled" || !o.customerId) continue;
      const cur = spend.get(o.customerId) ?? { revenue: ZERO, orders: 0, units: 0 };
      const net = o.items
        .reduce((a, i) => a.plus(new Decimal(i.unitPrice).times(i.quantity)).minus(i.sellerDiscount), ZERO)
        .minus(o.refunds.reduce((a, x) => a.plus(x.amount), ZERO));
      cur.revenue = cur.revenue.plus(net);
      cur.orders++;
      cur.units += o.items.reduce((a, i) => a + i.quantity, 0) - o.refunds.reduce((a, x) => a + x.quantity, 0);
      spend.set(o.customerId, cur);
    }
  }
  const topIds = [...spend.entries()].sort((a, b) => b[1].revenue.comparedTo(a[1].revenue)).slice(0, 5);
  const { data: custRows } = topIds.length
    ? await sb.from("customers").select("id, display_name, external_customer_id").in("id", topIds.map(([id]) => id))
    : { data: [] as any[] };
  const custName = (id: string) => {
    const c = (custRows ?? []).find((x: any) => x.id === id);
    return c?.display_name || (c ? `Buyer …${String(c.external_customer_id).slice(-6)}` : "Unavailable");
  };

  // daily profit trend (account time zone)
  const days: string[] = [];
  if (!showId) {
    const first = localDate(tz, range.from);
    const last = localDate(tz, new Date(Math.min(range.to.getTime() - 1, Date.now())));
    for (let d = first; d <= last && days.length < 62; d = addDays(d, 1)) days.push(d);
  }
  const daily = days.map((d) => {
    const lo = startOfLocalDay(tz, d).getTime();
    const hi = startOfLocalDay(tz, addDays(d, 1)).getTime();
    const inDay = rows.filter((r) => Date.parse(r.startedAt) >= lo && Date.parse(r.startedAt) < hi);
    return { d, profit: sumD(inDay, (r) => r.profit), revenue: sumD(inDay, (r) => r.revenue) };
  });
  const hostsBoard = groupBy(rows, (r) => r.host);
  const chrono = [...rows].reverse();

  const extra = { host: sp.host, test: sp.test, sku: sp.sku };
  const qs = (patch: Partial<SP>) => {
    const p = new URLSearchParams(Object.entries({ ...sp, ...patch }).filter(([, v]) => v) as [string, string][]);
    return `/?${p.toString()}`;
  };

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader title="Dashboard" sub={`${range.label} · ${rows.length} LIVE show${rows.length === 1 ? "" : "s"}${includeTest ? " · including test shows" : ""}`}>
        <Link href={qs({ test: includeTest ? undefined : "1" })} className="btn">{includeTest ? "Hide test shows" : "Show test shows"}</Link>
      </PageHeader>

      {running && running.length > 0 && (
        <Link href="/live" className="mb-4 flex items-center gap-3 rounded-xl border border-pos/40 bg-pos/10 px-4 py-3 text-sm text-pos hover:bg-pos/15">
          <span className="h-2 w-2 animate-pulse rounded-full bg-pos" />
          <b>LIVE now:</b> {running.map((r) => (r.is_test ? `TEST · ${r.title}` : r.title)).join(" · ")}
          <span className="ml-auto">Open live dashboard →</span>
        </Link>
      )}
      {(reviewCount ?? 0) > 0 && (
        <Link href="/orders?attr=needs_review" className="mb-4 flex items-center gap-3 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn hover:bg-warn/15">
          <b>{reviewCount}</b> order{reviewCount === 1 ? "" : "s"} need review — not assigned to a show because the match was uncertain.
          <span className="ml-auto">Review →</span>
        </Link>
      )}

      <div className="mb-5 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={qs({ range: "current", show: undefined, from: undefined, to: undefined })} className={sp.range === "current" ? "btn-primary" : "btn"}>Current LIVE</Link>
          <Link href={qs({ range: "last", show: undefined, from: undefined, to: undefined })} className={sp.range === "last" ? "btn-primary" : "btn"}>Last LIVE</Link>
          <PeriodFilter path="/" current={showId ? ("none" as RangeKey) : key} from={sp.from} to={sp.to} extra={extra} />
        </div>
        <form className="flex flex-wrap items-center gap-2" action="/">
          {sp.range && <input type="hidden" name="range" value={sp.range} />}
          {sp.from && <input type="hidden" name="from" value={sp.from} />}
          {sp.to && <input type="hidden" name="to" value={sp.to} />}
          {sp.test && <input type="hidden" name="test" value={sp.test} />}
          <select name="host" defaultValue={sp.host ?? ""} className="input w-auto" aria-label="Host">
            <option value="">All hosts</option>
            {hostNames.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
          <select name="sku" defaultValue={sp.sku ?? ""} className="input w-auto max-w-[220px]" aria-label="Product">
            <option value="">All products</option>
            {products.slice(0, 200).map((p) => <option key={p.sku + p.title} value={p.sku}>{p.title} ({p.sku})</option>)}
          </select>
          <button className="btn">Filter</button>
          {(sp.host || sp.sku || showId) && <Link href="/" className="text-sm text-muted hover:text-ink">Clear</Link>}
        </form>
      </div>

      {rows.length === 0 ? (
        <Empty>No LIVE shows in this period.</Empty>
      ) : (
        <>
          <section className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <Kpi big label="Estimated profit" value={formatUsd(profit)} toneClass={tone(profit)} est={estimated} />
            <Kpi big label="Product revenue" value={formatUsd(revenue)} />
            <Kpi label="Reconciled profit" value={finalized.length ? formatUsd(reconciled) : "Pending"} hint={`${finalized.length} of ${rows.length} shows finalized`} toneClass={finalized.length ? tone(reconciled) : "text-muted"} />
            <Kpi label="Total expenses" value={formatUsd(expenses)} est={estimated} />
            <Kpi label="Profit / hour" value={formatUsd(hours.isZero() ? null : profit.div(hours))} toneClass={tone(profit)} />
            <Kpi label="Profit / minute" value={formatUsd(hours.isZero() ? null : profit.div(hours.times(60)))} toneClass={tone(profit)} />
            <Kpi label="Margin" value={formatPct(revenue.gt(0) ? profit.div(revenue).times(100) : null)} />
            <Kpi label="Items sold" value={String(units)} />
            <Kpi label="Orders" value={String(orders)} />
            <Kpi label="Avg order value" value={formatUsd(orders ? revenue.div(orders) : null)} />
            <Kpi label="Avg selling price" value={formatUsd(units ? revenue.div(units) : null)} />
            <Kpi label="Hours live" value={hours.toFixed(1)} />
          </section>

          {skuRow && (
            <section className="card mb-4 grid grid-cols-2 gap-4 p-5 md:grid-cols-5">
              <div className="col-span-2 md:col-span-1">
                <div className="label">Product</div>
                <div className="font-semibold">{skuRow.title}</div>
                <div className="text-xs text-faint">{skuRow.sku}{skuRow.costEstimated ? " · default cost (estimated)" : ""}</div>
              </div>
              <Stat label="Units" value={String(skuRow.units)} />
              <Stat label="Revenue" value={formatUsd(skuRow.netRevenue)} />
              <Stat label="Avg price" value={formatUsd(skuRow.units ? skuRow.netRevenue.div(skuRow.units) : null)} />
              <Stat label="Contribution" value={formatUsd(skuRow.contribution)} tone={tone(skuRow.contribution)} />
            </section>
          )}

          <section className="mb-4 grid gap-4 xl:grid-cols-2">
            {days.length > 1 ? (
              <div className="card p-5">
                <div className="label mb-3">Daily revenue and profit</div>
                <LineChart
                  labels={daily.map((x) => x.d.slice(5))}
                  series={[
                    { name: "Revenue", color: "#d9b26b", values: daily.map((x) => x.revenue.toNumber()) },
                    { name: "Profit", color: "#34d399", values: daily.map((x) => x.profit.toNumber()) },
                  ]}
                />
              </div>
            ) : (
              <div className="card p-5">
                <div className="label mb-3">Cumulative profit</div>
                <LineChart
                  labels={chrono.map((r) => fmtTime(r.startedAt, tz, true))}
                  series={[{ name: "Profit", color: "#34d399", values: chrono.reduce<number[]>((a, r) => [...a, (a.at(-1) ?? 0) + r.profit.toNumber()], []) }]}
                />
              </div>
            )}
            <div className="card p-5">
              <div className="label mb-3">Profit per LIVE</div>
              <BarChart labels={chrono.map((r) => fmtTime(r.startedAt, tz, true))} values={chrono.map((r) => r.profit.toNumber())} format="money" color="#34d399" />
            </div>
          </section>

          <section className="mb-4 grid gap-4 lg:grid-cols-3">
            <div className="card p-5 lg:col-span-2">
              <div className="label mb-2 flex justify-between">
                <span>LIVE shows</span>
                <Link href="/history" className="normal-case tracking-normal text-muted hover:text-ink">All history →</Link>
              </div>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Show</th>
                      <th>Status</th>
                      <th className="text-right">Duration</th>
                      <th className="text-right">Revenue</th>
                      <th className="text-right">Items</th>
                      <th className="text-right">Profit</th>
                      <th className="text-right">/ min</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 12).map((r) => (
                      <tr key={r.id}>
                        <td>
                          <Link href={`/shows/${r.id}`} className="hover:text-gold">{r.isTest && <span className="text-info">TEST · </span>}{r.title}</Link>
                          <div className="text-xs text-faint">{fmtTime(r.startedAt, tz, true)} · {r.host}</div>
                        </td>
                        <td><StatusPill status={r.status} /><div className="mt-1"><DataStatusBadge status={r.dataStatus} /></div></td>
                        <td className="num text-right">{fmtDuration(r.metrics.activeSeconds)}</td>
                        <td className="num text-right">{formatUsd(r.revenue)}</td>
                        <td className="num text-right">{r.items}</td>
                        <td className={`num text-right ${tone(r.profit)}`}>{formatUsd(r.profit)}</td>
                        <td className={`num text-right ${tone(r.profitPerMinute)}`}>{formatUsd(r.profitPerMinute)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="space-y-4">
              <div className="card p-5 text-sm">
                <div className="label mb-2 flex justify-between"><span>Top customers</span><Link href="/customers" className="normal-case tracking-normal text-muted hover:text-ink">All →</Link></div>
                {topIds.length === 0 && <div className="py-3 text-faint">No buyer ids in this period</div>}
                {topIds.map(([id, c]) => (
                  <Link key={id} href={`/customers/${id}`} className="flex justify-between gap-3 py-1 hover:text-gold">
                    <span className="truncate">{custName(id)}</span>
                    <span className="num text-muted">{c.orders} · {c.units}u · <span className="text-ink">{formatUsd(c.revenue)}</span></span>
                  </Link>
                ))}
              </div>
              <div className="card p-5 text-sm">
                <div className="label mb-2 flex justify-between"><span>Top products</span><Link href="/products" className="normal-case tracking-normal text-muted hover:text-ink">All →</Link></div>
                {products.slice(0, 5).map((p) => (
                  <div key={p.sku + p.title} className="flex justify-between gap-3 py-1">
                    <span className="truncate">{p.title}</span>
                    <span className="num text-muted">{p.units}u · <span className="text-ink">{formatUsd(p.netRevenue)}</span></span>
                  </div>
                ))}
              </div>
              <div className="card p-5 text-sm">
                <div className="label mb-2 flex justify-between"><span>Hosts</span><Link href="/team" className="normal-case tracking-normal text-muted hover:text-ink">Compare →</Link></div>
                {hostsBoard.slice(0, 5).map((g) => (
                  <div key={g.key} className="flex justify-between gap-3 py-1">
                    <span className="truncate">{g.key}</span>
                    <span className="num text-muted">{g.shows} shows · <span className={tone(g.profitPerHour)}>{formatUsd(g.profitPerHour)}/h</span></span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone: t = "text-ink" }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className={`num mt-1 text-lg font-semibold ${t}`}>{value}</div>
    </div>
  );
}
