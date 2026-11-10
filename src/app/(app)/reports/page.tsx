import { supabaseServer } from "@/lib/supabase/clients";
import { getTimezone } from "@/lib/data/context";
import { loadReport } from "@/lib/data/report";
import { resolveRange, type RangeKey } from "@/lib/dates";
import { formatPct, formatUsd, ZERO, type Decimal } from "@/lib/engine/money";
import { fmtDuration, fmtTime } from "@/lib/format";
import { PrintButton } from "@/components/PrintButton";
import { Empty, PageHeader, PeriodFilter } from "@/components/ui";

type SP = { range?: RangeKey; from?: string; to?: string; show?: string; test?: string };

const EXPORTS: [string, string, string][] = [
  ["shows", "LIVE shows", "Every show with all its profit fields"],
  ["orders", "Orders", "Order-level revenue, shipping, fees, settlement"],
  ["payroll", "Payroll", "Pay per person per show"],
  ["products", "Products", "Units, revenue and margin by SKU"],
  ["customers", "Customers", "Spend and orders by buyer"],
  ["expenses", "Expenses", "Fixed and hourly expenses"],
];

export default async function ReportsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const sb = await supabaseServer();
  const tz = await getTimezone(sb);
  const key = sp.range ?? "30d";
  const range = sp.show ? { from: new Date(0), to: new Date(Date.now() + 86_400_000), label: "One show" } : resolveRange(tz, key, sp.from, sp.to);
  const includeTest = sp.test === "1";
  const rows = await loadReport(sb, { from: range.from, to: range.to, includeTest, showId: sp.show || undefined });
  const params = new URLSearchParams(Object.entries({ range: sp.range, from: sp.from, to: sp.to, show: sp.show, test: sp.test }).filter(([, v]) => v) as [string, string][]).toString();

  const sum = (f: (r: (typeof rows)[number]) => Decimal) => rows.reduce((a, r) => a.plus(f(r)), ZERO);
  const totals = {
    revenue: sum((r) => r.metrics.netMerchandise),
    product: sum((r) => r.metrics.costs.product),
    presenter: sum((r) => r.metrics.labor.presenter),
    assistant: sum((r) => r.metrics.labor.assistant),
    hourly: sum((r) => r.metrics.costs.hourlyExpenses.plus(r.metrics.costs.fixedExpenses)),
    fees: sum((r) => r.metrics.platformFees),
    shipping: sum((r) => r.metrics.netShippingCost),
    expenses: sum((r) => r.totalExpenses),
    profit: sum((r) => r.profit),
    hours: sum((r) => r.hours),
  };
  const finalized = rows.filter((r) => r.reconciledProfit !== null);

  return (
    <div className="mx-auto max-w-[1400px]">
      <div className="print:hidden">
        <PageHeader title="Reports & exports" sub={`${range.label} · ${rows.length} shows`}>
          <PrintButton />
        </PageHeader>
        <div className="mb-5"><PeriodFilter path="/reports" current={key} from={sp.from} to={sp.to} extra={{ test: sp.test }} /></div>
        <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {EXPORTS.map(([kind, label, hint]) => (
            <a key={kind} href={`/api/reports/${kind}?${params}`} className="card block p-4 hover:border-faint">
              <div className="font-medium">{label} CSV</div>
              <div className="mt-1 text-xs text-faint">{hint}</div>
            </a>
          ))}
        </section>
        <p className="mb-6 text-xs text-faint">Minute-by-minute CSV is on each show&apos;s page. CSV files open in Excel, Numbers and Google Sheets.</p>
      </div>

      {/* printable report */}
      <article className="card p-6 print:border-0 print:p-0">
        <header className="mb-5 flex flex-wrap items-end gap-3 border-b border-line pb-4">
          <div>
            <div className="font-serif text-lg tracking-[0.18em] text-gold print:text-black">CASA DE BEAUTY</div>
            <h2 className="text-xl font-semibold">LIVE profit report — {rows.length === 1 ? rows[0].title : range.label}</h2>
            <div className="text-sm text-muted">Generated {fmtTime(new Date().toISOString(), tz, true)} · {tz.replace("_", " ")} · USD</div>
          </div>
        </header>
        {!rows.length ? (
          <Empty>No shows in this period.</Empty>
        ) : (
          <>
            <table className="table mb-6 max-w-xl">
              <tbody>
                <R label="Product revenue" v={formatUsd(totals.revenue)} />
                <R label="Product cost" v={formatUsd(totals.product)} />
                <R label="Presenter pay" v={formatUsd(totals.presenter)} />
                <R label="Assistant pay" v={formatUsd(totals.assistant)} />
                <R label="Giveaways & other expenses" v={formatUsd(totals.hourly)} />
                <R label="TikTok fees" v={formatUsd(totals.fees)} />
                <R label="Net shipping" v={formatUsd(totals.shipping)} />
                <R label="Total expenses" v={formatUsd(totals.expenses)} />
                <R label="Estimated profit" v={formatUsd(totals.profit)} strong />
                <R label="Reconciled profit" v={finalized.length === rows.length ? formatUsd(sum((r) => r.reconciledProfit ?? ZERO)) : `Pending (${finalized.length} of ${rows.length} shows finalized)`} />
                <R label="Margin" v={formatPct(totals.revenue.gt(0) ? totals.profit.div(totals.revenue).times(100) : null)} />
                <R label="Profit per hour" v={formatUsd(totals.hours.isZero() ? null : totals.profit.div(totals.hours))} />
              </tbody>
            </table>
            <div className="overflow-x-auto">
              <table className="table min-w-[1100px] text-xs">
                <thead>
                  <tr>
                    <th>Date</th><th>Show</th><th>Host</th><th className="text-right">Duration</th><th className="text-right">Revenue</th><th className="text-right">Units</th>
                    <th className="text-right">Product</th><th className="text-right">Presenter</th><th className="text-right">Assistant</th><th className="text-right">Other exp.</th>
                    <th className="text-right">Fees</th><th className="text-right">Shipping</th><th className="text-right">Est. profit</th><th className="text-right">Reconciled</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const p = r.metrics;
                    return (
                      <tr key={r.id}>
                        <td className="num whitespace-nowrap">{fmtTime(r.startedAt, tz, true)}</td>
                        <td>{r.isTest ? "TEST · " : ""}{r.title}</td>
                        <td>{r.host}</td>
                        <td className="num text-right">{fmtDuration(p.activeSeconds)}</td>
                        <td className="num text-right">{formatUsd(p.netMerchandise)}</td>
                        <td className="num text-right">{p.itemsSold}</td>
                        <td className="num text-right">{formatUsd(p.costs.product)}</td>
                        <td className="num text-right">{formatUsd(p.labor.presenter)}</td>
                        <td className="num text-right">{formatUsd(p.labor.assistant)}</td>
                        <td className="num text-right">{formatUsd(p.costs.hourlyExpenses.plus(p.costs.fixedExpenses))}</td>
                        <td className="num text-right">{formatUsd(p.platformFees)}{p.flags.feesEstimated ? "*" : ""}</td>
                        <td className="num text-right">{p.flags.shippingUnknownOrders === p.orders && p.orders ? "Pending" : formatUsd(p.netShippingCost)}</td>
                        <td className="num text-right font-medium">{formatUsd(p.operatingProfit)}</td>
                        <td className="num text-right">{p.reconciledProfit ? formatUsd(p.reconciledProfit) : "Pending"}</td>
                        <td className="whitespace-nowrap">{r.dataStatus.replace("_", " ")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-faint">* estimated from the fee rule until TikTok reports actual fees. Shipping is pending until orders settle.</p>
          </>
        )}
      </article>
    </div>
  );
}

function R({ label, v, strong }: { label: string; v: string; strong?: boolean }) {
  return (
    <tr>
      <td className={strong ? "font-semibold" : "text-muted"}>{label}</td>
      <td className={`num text-right ${strong ? "font-semibold" : ""}`}>{v}</td>
    </tr>
  );
}
