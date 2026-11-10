import Link from "next/link";
import { supabaseServer } from "@/lib/supabase/clients";
import { getTimezone } from "@/lib/data/context";
import { resolveRange, type RangeKey } from "@/lib/dates";
import { formatPct, formatUsd, ZERO } from "@/lib/engine/money";
import { fmtTime } from "@/lib/format";
import { Empty, Kpi, PageHeader, PeriodFilter } from "@/components/ui";
import {
  countOrdersWithoutBuyer,
  customerLabel,
  loadCustomers,
  loadLifetimeOrders,
  loadPeriodCustomerOrders,
  loadShowTitles,
  statsFor,
  type CustOrder,
  type CustomerStats,
} from "@/lib/data/customers";

type SP = { range?: RangeKey; from?: string; to?: string; test?: string; sort?: string };

const SORTS: [string, string][] = [
  ["lifetime", "Lifetime spend"],
  ["spent", "Spend in period"],
  ["units", "Units"],
  ["orders", "Orders"],
  ["best", "Best single LIVE"],
  ["shows", "LIVEs bought from"],
  ["frequency", "Repeat frequency"],
  ["aov", "Avg order value"],
];

const LIMIT = 200;

export default async function CustomersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const sb = await supabaseServer();
  const tz = await getTimezone(sb);
  const key = sp.range ?? "30d";
  const range = resolveRange(tz, key, sp.from, sp.to);
  const includeTest = sp.test === "1";
  const sort = SORTS.some(([k]) => k === sp.sort) ? sp.sort! : "lifetime";
  const opts = { from: range.from, to: range.to, includeTest };

  const [periodOrders, noBuyer] = await Promise.all([loadPeriodCustomerOrders(sb, opts), countOrdersWithoutBuyer(sb, opts)]);

  const group = (orders: CustOrder[]) => {
    const m = new Map<string, CustOrder[]>();
    for (const o of orders) m.set(o.customerId, [...(m.get(o.customerId) ?? []), o]);
    return m;
  };
  const byCustomerPeriod = group(periodOrders);
  const period = new Map<string, CustomerStats>([...byCustomerPeriod].map(([id, os]) => [id, statsFor(os)]));
  // customers whose only orders in range were cancelled don't count as buyers
  for (const [id, s] of period) if (s.orders === 0) period.delete(id);
  const ids = [...period.keys()];

  const [lifetimeOrders, customers] = await Promise.all([loadLifetimeOrders(sb, ids, includeTest), loadCustomers(sb, ids)]);
  const lifetime = new Map<string, CustomerStats>([...group(lifetimeOrders)].map(([id, os]) => [id, statsFor(os)]));

  const rows = ids.map((id) => ({ id, p: period.get(id)!, l: lifetime.get(id) ?? period.get(id)!, c: customers.get(id) }));
  const nullsLast = (a: number | null, b: number | null) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b);
  const cmp: Record<string, (a: (typeof rows)[number], b: (typeof rows)[number]) => number> = {
    lifetime: (a, b) => b.l.spent.cmp(a.l.spent),
    spent: (a, b) => b.p.spent.cmp(a.p.spent),
    units: (a, b) => b.p.units - a.p.units,
    orders: (a, b) => b.p.orders - a.p.orders,
    best: (a, b) => (b.l.bestShow?.spent ?? ZERO).cmp(a.l.bestShow?.spent ?? ZERO),
    shows: (a, b) => b.l.shows - a.l.shows,
    frequency: (a, b) => nullsLast(a.l.avgDaysBetween, b.l.avgDaysBetween), // fewer days between orders = more frequent
    aov: (a, b) => (b.p.aov ?? ZERO).cmp(a.p.aov ?? ZERO),
  };
  rows.sort((a, b) => cmp[sort](a, b) || b.p.spent.cmp(a.p.spent) || a.id.localeCompare(b.id));
  const top = rows.slice(0, LIMIT);
  const showIds = top.map((r) => r.l.bestShow?.showId).filter(Boolean) as string[];
  const shows = await loadShowTitles(sb, showIds);

  const totalRevenue = rows.reduce((a, r) => a.plus(r.p.spent), ZERO);
  const repeat = rows.filter((r) => r.p.orders >= 2).length;
  const topSpender = rows.reduce((m, r) => (r.p.spent.gt(m) ? r.p.spent : m), ZERO);
  const extra = { test: includeTest ? "1" : undefined, sort: sort === "lifetime" ? undefined : sort };
  const qs = (patch: Partial<SP>) => {
    const p = new URLSearchParams(Object.entries({ ...sp, ...patch }).filter(([, v]) => v) as [string, string][]);
    const s = p.toString();
    return s ? `/customers?${s}` : "/customers";
  };

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader title="Customers" sub={`${range.label} · grouped by platform buyer id${includeTest ? " · including test orders" : ""}`}>
        <Link href={qs({ test: includeTest ? undefined : "1" })} className="btn">{includeTest ? "Hide test orders" : "Show test orders"}</Link>
      </PageHeader>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <PeriodFilter path="/customers" current={key} from={sp.from} to={sp.to} extra={extra} />
        <form action="/customers" className="ml-auto flex items-center gap-2">
          {Object.entries({ range: sp.range, from: sp.from, to: sp.to, test: extra.test }).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
          <label className="label" htmlFor="sort">Sort</label>
          <select id="sort" name="sort" defaultValue={sort} className="input w-auto">
            {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <button className="btn">Apply</button>
        </form>
      </div>

      <section className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi label="Customers in period" value={String(rows.length)} hint="with at least one order" />
        <Kpi label="Repeat customers" value={String(repeat)} hint={`${rows.length ? formatPct(ZERO.plus(repeat).div(rows.length).times(100)) : "—"} placed 2+ orders in period`} />
        <Kpi label="Avg spend / customer" value={rows.length ? formatUsd(totalRevenue.div(rows.length)) : "—"} hint="product revenue in period" />
        <Kpi label="Top customer share" value={totalRevenue.gt(0) ? formatPct(topSpender.div(totalRevenue).times(100)) : "—"} hint="of identified-buyer revenue" />
        <Kpi label="Orders without buyer id" value={String(noBuyer)} hint="Unavailable from TikTok — not counted above" toneClass={noBuyer ? "text-warn" : "text-ink"} />
      </section>

      {!rows.length ? (
        <Empty>No orders with a buyer id in this period.</Empty>
      ) : (
        <section className="card overflow-x-auto">
          <table className="table min-w-[1150px]">
            <thead>
              <tr>
                <th className="text-right">#</th>
                <th>Customer</th>
                <th className="text-right">Orders<div className="normal-case tracking-normal text-faint">in period</div></th>
                <th className="text-right">Units<div className="normal-case tracking-normal text-faint">in period</div></th>
                <th className="text-right">Spent<div className="normal-case tracking-normal text-faint">in period</div></th>
                <th className="text-right">Spent<div className="normal-case tracking-normal text-faint">lifetime</div></th>
                <th className="text-right">Best single LIVE<div className="normal-case tracking-normal text-faint">lifetime</div></th>
                <th className="text-right">LIVEs<div className="normal-case tracking-normal text-faint">lifetime</div></th>
                <th className="text-right">Days between orders<div className="normal-case tracking-normal text-faint">lifetime avg</div></th>
                <th className="text-right">AOV<div className="normal-case tracking-normal text-faint">in period</div></th>
                <th className="text-right">Last purchase</th>
              </tr>
            </thead>
            <tbody>
              {top.map((r, i) => {
                const best = r.l.bestShow;
                const show = best ? shows.get(best.showId) : undefined;
                return (
                  <tr key={r.id}>
                    <td className="num text-right text-faint">{i + 1}</td>
                    <td>
                      {r.c ? (
                        <Link href={`/customers/${r.id}`} className="hover:text-gold" title={`Buyer id: ${r.c.externalId}`}>
                          <span className={r.c.displayName ? "" : "text-muted"}>{customerLabel(r.c)}</span>
                        </Link>
                      ) : (
                        <Link href={`/customers/${r.id}`} className="text-muted hover:text-gold">Unknown buyer</Link>
                      )}
                      {r.c && !r.c.displayName && <div className="text-[11px] text-faint">Name unavailable from platform</div>}
                    </td>
                    <td className="num text-right">{r.p.orders}</td>
                    <td className="num text-right">{r.p.units}</td>
                    <td className="num text-right">{formatUsd(r.p.spent)}</td>
                    <td className="num text-right text-gold">{formatUsd(r.l.spent)}</td>
                    <td className="num text-right">
                      {best ? (
                        <>
                          {formatUsd(best.spent)}
                          <div className="max-w-[180px] truncate text-[11px]">
                            <Link href={`/shows/${best.showId}`} className="text-faint hover:text-gold">{show ? `${show.isTest ? "TEST · " : ""}${show.title}` : "View show"}</Link>
                          </div>
                        </>
                      ) : (
                        <span className="text-faint" title="No orders linked to a LIVE">—</span>
                      )}
                    </td>
                    <td className="num text-right">{r.l.shows}</td>
                    <td className="num text-right">{r.l.avgDaysBetween === null ? <span className="text-faint">one order</span> : r.l.avgDaysBetween.toFixed(1)}</td>
                    <td className="num text-right">{formatUsd(r.p.aov)}</td>
                    <td className="num text-right text-muted">{fmtTime(r.l.lastAt, tz, true)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > LIMIT && <div className="px-4 py-3 text-xs text-faint">Showing top {LIMIT} of {rows.length} customers.</div>}
        </section>
      )}
      <p className="mt-3 text-xs text-faint">
        Spend = item price × quantity − seller discounts − refunds (before shipping and tax); cancelled orders excluded. Lifetime columns include every order from
        these customers, not only this period. TikTok often doesn&apos;t share buyer names — those show as a short form of the buyer id.
      </p>
    </div>
  );
}
