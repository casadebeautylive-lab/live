import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/clients";
import { getTimezone } from "@/lib/data/context";
import { formatUsd, ZERO, type Decimal } from "@/lib/engine/money";
import { fmtTime, PLATFORM_LABEL } from "@/lib/format";
import { Kpi, PageHeader, Unavailable } from "@/components/ui";
import { loadLifetimeOrders, loadShowTitles, mapCustomer, statsFor } from "@/lib/data/customers";

export default async function CustomerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ test?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!z.uuid().safeParse(id).success) notFound();
  const includeTest = sp.test === "1";
  const sb = await supabaseServer();
  const [tz, { data: row }] = await Promise.all([getTimezone(sb), sb.from("customers").select("*").eq("id", id).maybeSingle()]);
  if (!row) notFound();
  const c = mapCustomer(row);

  const orders = (await loadLifetimeOrders(sb, [id], includeTest)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const stats = statsFor(orders);
  const shows = await loadShowTitles(sb, orders.map((o) => o.showId).filter(Boolean) as string[]);

  const perShow = new Map<string, { spent: Decimal; orders: number; units: number }>();
  for (const o of orders) {
    if (o.status === "cancelled") continue;
    const k = o.showId ?? "none";
    const v = perShow.get(k) ?? { spent: ZERO, orders: 0, units: 0 };
    perShow.set(k, { spent: v.spent.plus(o.revenue), orders: v.orders + 1, units: v.units + o.units });
  }
  const perShowRows = [...perShow.entries()].sort((a, b) => b[1].spent.cmp(a[1].spent));
  const cancelled = orders.filter((o) => o.status === "cancelled").length;

  return (
    <div className="mx-auto max-w-[1200px]">
      <div className="mb-2 text-sm"><Link href="/customers" className="text-muted hover:text-gold">← Customers</Link></div>
      <PageHeader
        title={c.displayName?.trim() || "Name unavailable"}
        sub={
          <span>
            {PLATFORM_LABEL[c.platform] ?? c.platform} buyer id <span className="font-mono text-xs text-ink">{c.externalId}</span>
            {" · "}first order {fmtTime(stats.firstAt ?? c.firstOrderAt, tz, true)} · last order {fmtTime(stats.lastAt ?? c.lastOrderAt, tz, true)}
          </span>
        }
      >
        <Link href={`/customers/${id}${includeTest ? "" : "?test=1"}`} className="btn">{includeTest ? "Hide test orders" : "Show test orders"}</Link>
      </PageHeader>
      {!c.displayName && <p className="-mt-3 mb-4 text-xs text-faint">The platform didn&apos;t provide a name or username for this buyer.</p>}

      <section className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Lifetime spend" value={formatUsd(stats.spent)} toneClass="text-gold" hint="product revenue after discounts & refunds" />
        <Kpi label="Orders" value={String(stats.orders)} hint={cancelled ? `${cancelled} cancelled not counted` : undefined} />
        <Kpi label="Units" value={String(stats.units)} />
        <Kpi label="Avg order value" value={formatUsd(stats.aov)} />
        <Kpi label="LIVEs bought from" value={String(stats.shows)} />
        <Kpi label="Best single LIVE" value={formatUsd(stats.bestShow?.spent ?? null)} />
        <Kpi label="Avg days between orders" value={stats.avgDaysBetween === null ? "—" : stats.avgDaysBetween.toFixed(1)} hint={stats.avgDaysBetween === null ? "needs 2+ orders" : undefined} />
        <Kpi label="Follower status" value="—" hint={<Unavailable reason="TikTok does not share follower data for buyers" />} />
      </section>

      <div className="grid gap-5 lg:grid-cols-3">
        <section className="card overflow-x-auto lg:col-span-2">
          <div className="label px-4 pt-4">Purchase history</div>
          <table className="table min-w-[640px]">
            <thead>
              <tr><th>Date</th><th>Show</th><th>Items</th><th className="text-right">Revenue</th><th>Status</th></tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const s = o.showId ? shows.get(o.showId) : undefined;
                return (
                  <tr key={o.id}>
                    <td className="num whitespace-nowrap text-muted">{fmtTime(o.createdAt, tz, true)}</td>
                    <td className="max-w-[200px] truncate">
                      {o.showId ? <Link href={`/shows/${o.showId}`} className="hover:text-gold">{s ? `${s.isTest ? "TEST · " : ""}${s.title}` : "View show"}</Link> : <span className="text-faint">Not linked to a LIVE</span>}
                    </td>
                    <td className="text-sm">
                      {o.items.map((i, k) => (
                        <div key={k} className="truncate">
                          <span className="num text-muted">{i.quantity}×</span> {i.title}
                          {i.sku && <span className="ml-1 font-mono text-[11px] text-faint">{i.sku}</span>}
                        </div>
                      ))}
                    </td>
                    <td className="num text-right">{formatUsd(o.revenue)}</td>
                    <td className="whitespace-nowrap text-xs">
                      {o.status === "cancelled" ? <span className="text-neg">Cancelled</span> : <span className="text-muted">Active</span>}
                      {o.refunded.gt(0) && <div className="text-warn">Refunded {formatUsd(o.refunded)}</div>}
                      {o.isTest && <div className="text-info">Test</div>}
                    </td>
                  </tr>
                );
              })}
              {!orders.length && <tr><td colSpan={5} className="py-6 text-center text-faint">No orders</td></tr>}
            </tbody>
          </table>
        </section>

        <section className="card h-fit overflow-x-auto">
          <div className="label px-4 pt-4">Spend by LIVE</div>
          <table className="table">
            <thead><tr><th>Show</th><th className="text-right">Units</th><th className="text-right">Spent</th></tr></thead>
            <tbody>
              {perShowRows.map(([k, v]) => {
                const s = shows.get(k);
                return (
                  <tr key={k}>
                    <td className="max-w-[180px] truncate">
                      {k === "none" ? <span className="text-faint">Not linked to a LIVE</span> : <Link href={`/shows/${k}`} className="hover:text-gold">{s?.title ?? "View show"}</Link>}
                      {s && <div className="text-[11px] text-faint">{fmtTime(s.startedAt, tz, true)}</div>}
                    </td>
                    <td className="num text-right">{v.units}</td>
                    <td className="num text-right">{formatUsd(v.spent)}</td>
                  </tr>
                );
              })}
              {!perShowRows.length && <tr><td colSpan={3} className="py-6 text-center text-faint">—</td></tr>}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
