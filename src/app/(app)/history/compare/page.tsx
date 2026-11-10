import Link from "next/link";
import { supabaseServer } from "@/lib/supabase/clients";
import { getTimezone } from "@/lib/data/context";
import { loadShowsBulk } from "@/lib/data/shows";
import { computeMinutes } from "@/lib/engine/minutes";
import { formatPct, formatUsd, type Decimal } from "@/lib/engine/money";
import { fmtDuration, fmtTime } from "@/lib/format";
import { LineChart } from "@/components/Charts";
import { DataStatusBadge, Empty, PageHeader, tone } from "@/components/ui";

const COLORS = ["#d9b26b", "#34d399", "#60a5fa", "#f472b6", "#a78bfa", "#fb923c"];

/** Side-by-side comparison of 2–6 shows, including cumulative profit by elapsed minute. */
export default async function ComparePage({ searchParams }: { searchParams: Promise<{ c?: string | string[] }> }) {
  const { c } = await searchParams;
  const ids = (Array.isArray(c) ? c : c ? [c] : []).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 6);
  const sb = await supabaseServer();
  const tz = await getTimezone(sb);
  const { data: shows } = ids.length ? await sb.from("live_shows").select("*").in("id", ids) : { data: [] as any[] };
  const bulk = await loadShowsBulk(sb, shows ?? []);
  const now = new Date();
  const views = bulk
    .map((b) => ({ b, v: computeMinutes(b.input, now) }))
    .sort((x, y) => Date.parse(x.b.meta.startedAt) - Date.parse(y.b.meta.startedAt));

  if (views.length < 2) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Compare shows" />
        <Empty>Pick at least two shows on <Link href="/history" className="text-gold">LIVE history</Link> to compare.</Empty>
      </div>
    );
  }

  const longest = Math.max(...views.map((x) => x.v.minutes.length));
  const labels = Array.from({ length: longest }, (_, i) => `${i + 1}m`);
  const rows: [string, (x: (typeof views)[number]) => string, ((x: (typeof views)[number]) => Decimal | null)?][] = [
    ["Duration", (x) => fmtDuration(x.v.totals.activeSeconds)],
    ["Host", (x) => x.b.meta.staff.filter((s) => s.role === "host").map((s) => s.name).join(", ") || "Default presenter"],
    ["Product revenue", (x) => formatUsd(x.v.totals.netMerchandise)],
    ["Orders", (x) => String(x.v.totals.orders)],
    ["Units sold", (x) => String(x.v.totals.itemsSold)],
    ["Avg selling price", (x) => formatUsd(x.v.totals.avgSellingPrice)],
    ["Avg order value", (x) => formatUsd(x.v.totals.avgOrderValue)],
    ["Product cost", (x) => formatUsd(x.v.totals.costs.product)],
    ["Presenter pay", (x) => formatUsd(x.v.totals.labor.presenter)],
    ["Assistant pay", (x) => formatUsd(x.v.totals.labor.assistant)],
    ["Platform fees", (x) => formatUsd(x.v.totals.platformFees)],
    ["Giveaways & misc.", (x) => formatUsd(x.v.totals.costs.hourlyExpenses.plus(x.v.totals.costs.fixedExpenses))],
    ["Net shipping", (x) => formatUsd(x.v.totals.netShippingCost)],
    ["Total expenses", (x) => formatUsd(x.v.totals.totalExpenses)],
    ["Estimated profit", (x) => formatUsd(x.v.totals.operatingProfit), (x) => x.v.totals.operatingProfit],
    ["Reconciled profit", (x) => (x.v.totals.reconciledProfit ? formatUsd(x.v.totals.reconciledProfit) : "Pending"), (x) => x.v.totals.reconciledProfit],
    ["Profit / minute", (x) => formatUsd(x.v.totals.profitPerMinute), (x) => x.v.totals.profitPerMinute],
    ["Profit / hour", (x) => formatUsd(x.v.totals.profitPerHour), (x) => x.v.totals.profitPerHour],
    ["Margin", (x) => formatPct(x.v.totals.marginPct), (x) => x.v.totals.marginPct],
    ["Units / minute", (x) => x.v.totals.unitsPerMinute?.toFixed(2) ?? "—"],
    ["Best 15 minutes", (x) => (x.v.stats.best15 ? formatUsd(x.v.stats.best15.profit) : "—"), (x) => x.v.stats.best15?.profit ?? null],
    ["Minutes with a sale", (x) => `${x.v.minutes.filter((m) => m.orders > 0).length} / ${x.v.minutes.length}`],
  ];

  return (
    <div className="mx-auto max-w-[1400px]">
      <div className="mb-2 text-sm"><Link href="/history" className="text-muted hover:text-gold">← LIVE history</Link></div>
      <PageHeader title="Compare shows" sub={`${views.length} shows`} />
      <section className="card mb-4 p-5">
        <div className="label mb-3">Cumulative profit by elapsed minute</div>
        <LineChart
          labels={labels}
          series={views.map((x, i) => ({
            name: x.b.meta.title,
            color: COLORS[i],
            values: Array.from({ length: longest }, (_, k) => (x.v.minutes[Math.min(k, x.v.minutes.length - 1)]?.cumulativeProfit.toNumber() ?? 0)),
          }))}
        />
      </section>
      <section className="card overflow-x-auto">
        <table className="table min-w-[800px]">
          <thead>
            <tr>
              <th></th>
              {views.map((x, i) => (
                <th key={x.b.meta.id} className="text-right normal-case tracking-normal">
                  <Link href={`/shows/${x.b.meta.id}`} className="hover:text-gold" style={{ color: COLORS[i] }}>{x.b.meta.title}</Link>
                  <div className="text-faint">{fmtTime(x.b.meta.startedAt, tz, true)}</div>
                  <div className="mt-1 flex justify-end"><DataStatusBadge status={x.v.totals.dataStatus} /></div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, fmt, val]) => (
              <tr key={label}>
                <td className="text-muted">{label}</td>
                {views.map((x) => (
                  <td key={x.b.meta.id} className={`num text-right ${val ? tone(val(x)) : ""}`}>{fmt(x)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
