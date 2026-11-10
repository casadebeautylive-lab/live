import Link from "next/link";
import { currentUser, supabaseServer } from "@/lib/supabase/clients";
import { getTimezone } from "@/lib/data/context";
import { resolveRange, type RangeKey } from "@/lib/dates";
import { d, formatPct, formatUsd, ZERO } from "@/lib/engine/money";
import { fmtTime } from "@/lib/format";
import { ActionForm } from "@/components/ActionForm";
import { EstTag, Kpi, PageHeader, PeriodFilter, tone } from "@/components/ui";
import { defaultProductCost, loadAllTimeUnits, loadCatalog, loadPeriodProducts, type MergedProduct } from "@/lib/data/products";
import { importProductCosts, setProductCost } from "./actions";

type SP = { range?: RangeKey; from?: string; to?: string; test?: string; sort?: "top" | "worst" | "margin" | "revenue"; q?: string };

const SORTS: [NonNullable<SP["sort"]>, string][] = [
  ["top", "Top-selling"],
  ["revenue", "Revenue"],
  ["worst", "Worst-performing"],
  ["margin", "Highest margin"],
];

export default async function ProductsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const sb = await supabaseServer();
  const [tz, user] = await Promise.all([getTimezone(sb), currentUser()]);
  const canWrite = !!user?.canWrite;
  const key = sp.range ?? "30d";
  const range = resolveRange(tz, key, sp.from, sp.to);
  const includeTest = sp.test === "1";
  const sort = sp.sort ?? "top";

  const [{ rows: sold, shows }, catalog, allTime, fallback] = await Promise.all([
    loadPeriodProducts(sb, { from: range.from, to: range.to, includeTest }),
    loadCatalog(sb),
    loadAllTimeUnits(sb, includeTest),
    defaultProductCost(sb),
  ]);

  // include catalog SKUs that didn't sell in the period (so costs can be set ahead of a show)
  const rows: (MergedProduct & { catalogOnly?: boolean })[] = [...sold];
  for (const p of catalog.values()) {
    if (!rows.some((r) => r.sku === p.sku)) {
      rows.push({ key: p.sku, sku: p.sku, title: p.title ?? p.sku, units: 0, netRevenue: ZERO, productCost: ZERO, contribution: ZERO, avgPrice: null, grossMarginPct: null, contributionPct: null, costEstimated: !p.current, catalogOnly: true });
    }
  }
  const q = (sp.q ?? "").trim().toLowerCase();
  const filtered = q ? rows.filter((r) => r.sku.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)) : rows;
  const cmp: Record<string, (a: MergedProduct, b: MergedProduct) => number> = {
    top: (a, b) => b.units - a.units,
    revenue: (a, b) => b.netRevenue.comparedTo(a.netRevenue),
    worst: (a, b) => a.contribution.comparedTo(b.contribution) || a.units - b.units,
    margin: (a, b) => (b.contributionPct ?? d(-1e9)).comparedTo(a.contributionPct ?? d(-1e9)),
  };
  filtered.sort((a, b) => cmp[sort](a, b) || a.sku.localeCompare(b.sku));

  const units = sold.reduce((a, r) => a + r.units, 0);
  const revenue = sold.reduce((a, r) => a.plus(r.netRevenue), ZERO);
  const pcost = sold.reduce((a, r) => a.plus(r.productCost), ZERO);
  const onFallback = sold.filter((r) => r.costEstimated).length;
  const missingCost = [...rows].filter((r) => !catalog.get(r.sku)?.current && r.sku !== "(no sku)").length;

  const extra = { test: includeTest ? "1" : undefined, sort: sp.sort, q: sp.q };
  const qs = (patch: Partial<SP>) => {
    const p = new URLSearchParams(Object.entries({ ...sp, ...patch }).filter(([, v]) => v) as [string, string][]);
    return `/products?${p.toString()}`;
  };

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader title="Products & SKU costs" sub={`${range.label} · ${shows} shows${includeTest ? " · including test shows" : ""}`}>
        <a href="/api/products/costs.csv" className="btn">Download costs CSV</a>
        <Link href={qs({ test: includeTest ? undefined : "1" })} className="btn">{includeTest ? "Hide test shows" : "Show test shows"}</Link>
      </PageHeader>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <PeriodFilter path="/products" current={key} from={sp.from} to={sp.to} extra={extra} />
        <form action="/products" className="ml-auto flex items-center gap-2">
          {Object.entries({ range: sp.range, from: sp.from, to: sp.to, test: extra.test, sort: sp.sort }).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
          <input name="q" defaultValue={sp.q} placeholder="Search SKU or name" className="input w-56" />
          <button className="btn">Search</button>
        </form>
      </div>

      <section className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi label="SKUs sold" value={String(sold.length)} />
        <Kpi label="Units sold" value={String(units)} />
        <Kpi label="Revenue" value={formatUsd(revenue)} />
        <Kpi label="Gross margin" value={formatPct(revenue.gt(0) ? revenue.minus(pcost).div(revenue).times(100) : null)} hint="(revenue − product cost) ÷ revenue" est={onFallback > 0} />
        <Kpi label="SKUs on fallback cost" value={String(onFallback)} hint={`$${d(fallback).toFixed(2)} used when a SKU has no cost`} toneClass={onFallback ? "text-warn" : "text-ink"} />
      </section>

      <div className="mb-3 flex flex-wrap gap-2">
        {SORTS.map(([k, label]) => (
          <Link key={k} href={qs({ sort: k })} className={sort === k ? "btn-primary" : "btn"}>{label}</Link>
        ))}
      </div>

      <section className="card mb-5 overflow-x-auto">
        <table className="table min-w-[1150px]">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Product</th>
              <th className="text-right">Units<div className="normal-case tracking-normal text-faint">in period</div></th>
              <th className="text-right">Units<div className="normal-case tracking-normal text-faint">all time</div></th>
              <th className="text-right">Revenue</th>
              <th className="text-right">Unit cost</th>
              <th className="text-right">Avg price</th>
              <th className="text-right">Gross margin</th>
              <th className="text-right">Contribution</th>
              {canWrite && <th>New cost</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 500).map((r) => {
              const cat = catalog.get(r.sku);
              const cur = cat?.current;
              return (
                <tr key={r.key} className={r.units === 0 ? "text-muted" : ""}>
                  <td className="font-mono text-xs">{r.sku}</td>
                  <td className="max-w-[260px]">
                    <div className="truncate">{r.title}</div>
                    {cat && cat.history.length > 1 && (
                      <details className="text-xs text-faint">
                        <summary className="cursor-pointer hover:text-ink">{cat.history.length} cost versions</summary>
                        <ul className="mt-1 space-y-0.5">
                          {cat.history.slice(0, 8).map((h, i) => (
                            <li key={i} className="num">${d(h.unitCost).toFixed(2)} from {fmtTime(h.effectiveFrom, tz, true)}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </td>
                  <td className="num text-right">{r.units}</td>
                  <td className="num text-right">{allTime.get(r.sku) ?? 0}</td>
                  <td className="num text-right">{formatUsd(r.netRevenue)}</td>
                  <td className="num text-right">
                    {cur ? `$${d(cur.unitCost).toFixed(2)}` : <span className="text-gold">${d(fallback).toFixed(2)} <EstTag text="default" /></span>}
                  </td>
                  <td className="num text-right">{formatUsd(r.avgPrice)}</td>
                  <td className="num text-right">{formatPct(r.grossMarginPct)}</td>
                  <td className={`num text-right ${r.units ? tone(r.contribution) : ""}`}>{r.units ? formatUsd(r.contribution) : "—"}</td>
                  {canWrite && (
                    <td>
                      {r.sku !== "(no sku)" ? (
                        <ActionForm action={setProductCost} className="flex gap-1.5">
                          <input type="hidden" name="sku" value={r.sku} />
                          <input type="hidden" name="title" value={r.title} />
                          <input name="unit_cost" placeholder={cur ? d(cur.unitCost).toFixed(2) : "0.00"} inputMode="decimal" className="input w-24" required aria-label={`New cost for ${r.sku}`} />
                          <button className="btn">Save</button>
                        </ActionForm>
                      ) : (
                        <span className="text-xs text-faint">No SKU on order</span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            {!filtered.length && <tr><td colSpan={10} className="py-8 text-center text-faint">No products</td></tr>}
          </tbody>
        </table>
        {filtered.length > 500 && <div className="px-4 py-3 text-xs text-faint">Showing 500 of {filtered.length}. Search to narrow down.</div>}
      </section>
      <p className="-mt-3 mb-6 text-xs text-faint">
        Contribution = revenue − product cost − presenter commission − packing − platform fees (hourly show costs are not split across products). New costs apply to shows
        started after the change; past shows keep the costs frozen when they started (the owner can recalculate a show from its page).
        {missingCost > 0 && <> {missingCost} SKU(s) have no cost set yet.</>}
      </p>

      {canWrite && (
        <section className="card p-5">
          <h2 className="mb-1 font-semibold">Bulk update costs from CSV</h2>
          <p className="mb-4 text-sm text-muted">
            Columns: <code className="text-ink">sku,cost</code> and optionally <code className="text-ink">title</code>. Up to 5,000 rows. If any row has a problem nothing is
            imported and every problem is listed. <a href="/api/products/costs.csv" className="text-gold hover:underline">Download current costs</a> to use as a template.
          </p>
          <ActionForm action={importProductCosts} resetOnSuccess successText="Costs imported." className="grid gap-3">
            <input type="file" name="file" accept=".csv,text/csv" className="text-sm text-muted file:mr-3 file:rounded-lg file:border file:border-line file:bg-panel-2 file:px-3 file:py-1.5 file:text-ink" />
            <textarea name="csv" rows={5} placeholder={"sku,cost,title\nHOOP-GP-30,2.75,Gold hoop 30mm"} className="input font-mono text-xs" />
            <button className="btn-primary w-fit">Import costs</button>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
