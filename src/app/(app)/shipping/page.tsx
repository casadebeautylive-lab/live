import Link from "next/link";
import { supabaseServer } from "@/lib/supabase/clients";
import { getTimezone } from "@/lib/data/context";
import { loadReport } from "@/lib/data/report";
import { resolveRange, type RangeKey } from "@/lib/dates";
import { buildLedger } from "@/lib/engine/ledger";
import { d, Decimal, formatPct, formatUsd, ZERO } from "@/lib/engine/money";
import { fmtTime } from "@/lib/format";
import { DataStatusBadge, Empty, Kpi, PageHeader, PeriodFilter } from "@/components/ui";

type SP = { range?: RangeKey; from?: string; to?: string; show?: string; test?: string };

const SOURCE: Record<string, [string, string]> = {
  actual: ["TikTok settled", "text-pos"],
  package: ["Package label", "text-ink"],
  estimate: ["Estimate", "text-gold"],
  unknown: ["Pending", "text-faint"],
};

export default async function ShippingPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const sb = await supabaseServer();
  const tz = await getTimezone(sb);
  const key = sp.range ?? "30d";
  const range = resolveRange(tz, key, sp.from, sp.to);
  const includeTest = sp.test === "1";
  const rows = await loadReport(sb, { from: range.from, to: range.to, includeTest, showId: sp.show || undefined });

  // per-order lines from each show's ledger (the same numbers the profit uses)
  type Line = { showId: string; showTitle: string; orderId: string; at: number; units: number; revenue: Decimal; customer: Decimal; subsidy: Decimal | null; seller: Decimal | null; net: Decimal; source: string; packages: string[] };
  const lines: Line[] = [];
  const pkgSet = new Set<string>();
  let units = 0;
  for (const r of rows) {
    const L = buildLedger(r.show.input, new Date());
    const pkgOf = new Map<string, string[]>();
    for (const p of r.show.input.packages ?? []) {
      for (const oid of p.orderIds) pkgOf.set(oid, [...(pkgOf.get(oid) ?? []), p.externalPackageId]);
      if (p.orderIds.some((oid) => r.show.input.orders.some((o) => o.externalOrderId === oid && o.status !== "cancelled"))) pkgSet.add(p.externalPackageId);
    }
    for (const l of L.orders) {
      if (l.cancelled) continue;
      units += l.unitsShipped - l.unitsRefunded;
      lines.push({
        showId: r.id,
        showTitle: r.title,
        orderId: l.order.externalOrderId,
        at: l.at,
        units: l.unitsShipped,
        revenue: l.net,
        customer: d(l.order.customerShipping),
        subsidy: l.order.platformShippingSubsidy === null ? null : d(l.order.platformShippingSubsidy),
        seller: l.order.sellerShippingCost === null ? null : d(l.order.sellerShippingCost),
        net: l.shippingNetCost,
        source: l.shippingSource,
        packages: pkgOf.get(l.order.externalOrderId) ?? [],
      });
    }
  }
  const net = rows.reduce((a, r) => a.plus(r.metrics.netShippingCost), ZERO);
  const revenue = rows.reduce((a, r) => a.plus(r.revenue), ZERO);
  const customerPaid = rows.reduce((a, r) => a.plus(r.metrics.customerShipping), ZERO);
  const orders = lines.length;
  const unknown = lines.filter((l) => l.source === "unknown").length;
  const estimated = lines.filter((l) => l.source === "estimate").length;

  // tracking numbers for packages in view
  const pkgIds = [...pkgSet];
  const { data: pkgRows } = pkgIds.length
    ? await sb.from("packages").select("external_package_id, tracking_number, carrier").in("external_package_id", pkgIds.slice(0, 500))
    : { data: [] as any[] };
  const tracking = new Map((pkgRows ?? []).map((p: any) => [p.external_package_id, p]));
  const recent = [...lines].sort((a, b) => b.at - a.at).slice(0, 200);

  const extra = { show: sp.show, test: sp.test };
  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader title="Shipping" sub={`${range.label} · ${rows.length} shows · ${orders} orders`}>
        <Link href={`/shipping?${new URLSearchParams(Object.entries({ ...sp, test: includeTest ? undefined : "1" }).filter(([, v]) => v) as [string, string][])}`} className="btn">
          {includeTest ? "Hide test data" : "Show test data"}
        </Link>
      </PageHeader>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <PeriodFilter path="/shipping" current={key} from={sp.from} to={sp.to} extra={extra} />
        <form action="/shipping" className="ml-auto flex items-center gap-2">
          {Object.entries({ range: sp.range, from: sp.from, to: sp.to, test: sp.test }).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
          <select name="show" defaultValue={sp.show ?? ""} className="input w-auto max-w-[260px]" aria-label="Show">
            <option value="">All shows in period</option>
            {rows.map((r) => <option key={r.id} value={r.id}>{r.title} · {fmtTime(r.startedAt, tz, true)}</option>)}
          </select>
          <button className="btn">Filter</button>
        </form>
      </div>

      {!rows.length ? (
        <Empty>No shows in this period.</Empty>
      ) : (
        <>
          <section className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
            <Kpi big label="Seller-paid net shipping" value={formatUsd(net)} est={unknown + estimated > 0} hint="After customer payments and subsidies" />
            <Kpi label="Per order" value={formatUsd(orders ? net.div(orders) : null)} />
            <Kpi label="Per package" value={pkgSet.size ? formatUsd(net.div(pkgSet.size)) : "Unavailable"} hint={pkgSet.size ? `${pkgSet.size} packages` : "No package data from TikTok yet"} />
            <Kpi label="Per unit" value={formatUsd(units ? net.div(units) : null)} />
            <Kpi label="% of product revenue" value={formatPct(revenue.gt(0) ? net.div(revenue).times(100) : null)} />
            <Kpi label="Customer-paid shipping" value={formatUsd(customerPaid)} hint="Not revenue — offsets labels" />
            <Kpi label="Orders pending" value={String(unknown)} hint={estimated ? `${estimated} more on estimates` : "Settle with TikTok later"} toneClass={unknown ? "text-warn" : "text-ink"} />
          </section>

          <section className="card mb-5 overflow-x-auto">
            <div className="label px-4 pt-4">By show</div>
            <table className="table min-w-[800px]">
              <thead>
                <tr><th>Show</th><th className="text-right">Orders</th><th className="text-right">Packages</th><th className="text-right">Net shipping</th><th className="text-right">Per order</th><th className="text-right">% of revenue</th><th>Data</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const pk = new Set((r.show.input.packages ?? []).map((p) => p.externalPackageId)).size;
                  const ns = r.metrics.netShippingCost;
                  return (
                    <tr key={r.id}>
                      <td><Link href={`/shows/${r.id}`} className="hover:text-gold">{r.title}</Link><div className="text-xs text-faint">{fmtTime(r.startedAt, tz, true)}</div></td>
                      <td className="num text-right">{r.orders}</td>
                      <td className="num text-right">{pk || "—"}</td>
                      <td className="num text-right">{r.metrics.flags.shippingUnknownOrders === r.orders && r.orders ? <span className="text-faint">Pending</span> : formatUsd(ns)}</td>
                      <td className="num text-right">{formatUsd(r.orders ? ns.div(r.orders) : null)}</td>
                      <td className="num text-right">{formatPct(r.revenue.gt(0) ? ns.div(r.revenue).times(100) : null)}</td>
                      <td><DataStatusBadge status={r.dataStatus} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className="card overflow-x-auto">
            <div className="label px-4 pt-4">Orders (latest {recent.length})</div>
            <table className="table min-w-[1200px]">
              <thead>
                <tr>
                  <th>TikTok order</th><th>Show</th><th className="text-right">Units</th><th className="text-right">Product revenue</th>
                  <th className="text-right">Customer paid</th><th className="text-right">Platform subsidy</th><th className="text-right">Seller charges</th>
                  <th className="text-right">Net shipping</th><th>Source</th><th>Package / tracking</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((l) => {
                  const [label, cls] = SOURCE[l.source];
                  return (
                    <tr key={l.showId + l.orderId}>
                      <td className="num">{l.orderId}<div className="text-xs text-faint">{fmtTime(new Date(l.at).toISOString(), tz, true)}</div></td>
                      <td className="max-w-[180px] truncate"><Link href={`/shows/${l.showId}`} className="hover:text-gold">{l.showTitle}</Link></td>
                      <td className="num text-right">{l.units}</td>
                      <td className="num text-right">{formatUsd(l.revenue)}</td>
                      <td className="num text-right">{formatUsd(l.customer)}</td>
                      <td className="num text-right">{l.subsidy ? formatUsd(l.subsidy) : "—"}</td>
                      <td className="num text-right">{l.seller ? formatUsd(l.seller) : <span className="text-faint">Pending</span>}</td>
                      <td className="num text-right">{l.source === "unknown" ? <span className="text-faint">Pending</span> : formatUsd(l.net)}</td>
                      <td className={`text-xs ${cls}`}>{label}</td>
                      <td className="text-xs">
                        {l.packages.length ? (
                          l.packages.map((p) => (
                            <div key={p} className="font-mono">
                              {p}
                              <span className="text-muted"> {tracking.get(p)?.tracking_number ?? ""}</span>
                            </div>
                          ))
                        ) : (
                          <span className="text-faint">Unavailable</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
          <p className="mt-3 text-xs text-faint">
            Net shipping = seller shipping charges − customer-paid shipping − platform subsidies. A combined package&apos;s label is counted once and split across its orders.
            TikTok&apos;s settled per-order figure replaces any package or estimated amount, so nothing is deducted twice.
          </p>
        </>
      )}
    </div>
  );
}
