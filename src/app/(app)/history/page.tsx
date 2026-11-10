import Link from "next/link";
import { supabaseServer } from "@/lib/supabase/clients";
import { getTimezone } from "@/lib/data/context";
import { groupBy, loadReport, type GroupRow } from "@/lib/data/report";
import { resolveRange, type RangeKey } from "@/lib/dates";
import { formatPct, formatUsd, Decimal, ZERO } from "@/lib/engine/money";
import { fmtDuration, fmtTime, PLATFORM_LABEL } from "@/lib/format";
import { DataStatusBadge, StatusPill } from "@/components/ui";

type SP = { range?: RangeKey; from?: string; to?: string; platform?: string; test?: string };

const RANGES: [RangeKey, string][] = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["7d", "7 days"],
  ["30d", "30 days"],
];

export default async function HistoryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const sb = await supabaseServer();
  const tz = await getTimezone(sb);
  const key = sp.range ?? "7d";
  const range = resolveRange(tz, key, sp.from, sp.to);
  const includeTest = sp.test === "1";
  const rows = await loadReport(sb, { from: range.from, to: range.to, platform: sp.platform || undefined, includeTest });
  const total = groupBy(rows, () => "All shows")[0];
  const byPlatform = groupBy(rows, (r) => PLATFORM_LABEL[r.platform]);
  const byHost = groupBy(rows, (r) => r.host);
  // shipping buyers paid (not revenue, not profit — shown so it can be tracked per LIVE)
  const shippingPaid = rows.reduce((a, r) => a.plus(r.metrics.customerShipping), ZERO);

  const qs = (patch: Partial<SP>) => {
    const p = new URLSearchParams(Object.entries({ ...sp, ...patch }).filter(([, v]) => v) as [string, string][]);
    return `?${p.toString()}`;
  };

  return (
    <div className="mx-auto max-w-[1400px]">
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-2xl font-semibold">LIVE history</h1>
          <div className="text-sm text-muted">{range.label} · {rows.length} shows{includeTest ? " · including test shows" : ""}</div>
        </div>
        <a href={`/api/reports/csv${qs({})}`} className="btn ml-auto">Export CSV</a>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {RANGES.map(([k, label]) => (
          <Link key={k} href={qs({ range: k, from: undefined, to: undefined })} className={key === k ? "btn-primary" : "btn"}>{label}</Link>
        ))}
        <form className="flex flex-wrap items-center gap-2" action="/history">
          <input type="hidden" name="range" value="custom" />
          {sp.platform && <input type="hidden" name="platform" value={sp.platform} />}
          {includeTest && <input type="hidden" name="test" value="1" />}
          <input type="date" name="from" defaultValue={sp.from} className="input w-auto" aria-label="From" />
          <input type="date" name="to" defaultValue={sp.to} className="input w-auto" aria-label="To" />
          <button className={key === "custom" ? "btn-primary" : "btn"}>Apply</button>
        </form>
        <div className="ml-auto flex flex-wrap gap-2">
          {["", "tiktok", "whatnot", "manual"].map((p) => (
            <Link key={p || "all"} href={qs({ platform: p || undefined })} className={(sp.platform ?? "") === p ? "btn-primary" : "btn"}>
              {p ? PLATFORM_LABEL[p] : "All platforms"}
            </Link>
          ))}
          <Link href={qs({ test: includeTest ? undefined : "1" })} className="btn">{includeTest ? "Hide test shows" : "Show test shows"}</Link>
        </div>
      </div>

      {total && (
        <section className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          <Stat label="Estimated profit" value={formatUsd(total.profit)} tone={total.profit.isNegative() ? "text-neg" : "text-pos"} />
          <Stat label="Merch revenue" value={formatUsd(total.revenue)} />
          <Stat label="Shipping paid by buyers" value={formatUsd(shippingPaid)} />
          <Stat label="Profit / hour" value={formatUsd(total.profitPerHour)} />
          <Stat label="Margin" value={formatPct(total.marginPct)} />
          <Stat label="Items sold" value={String(total.items)} />
          <Stat label="Hours live" value={total.hours.toFixed(1)} />
        </section>
      )}

      <section className="mb-5 grid gap-4 lg:grid-cols-2">
        <Comparison title="By platform" rows={byPlatform} />
        <Comparison title="By host" rows={byHost} />
      </section>

      <form action="/history/compare" className="card overflow-x-auto">
        <div className="flex flex-wrap items-center gap-3 px-4 pt-4">
          <div className="label">Shows</div>
          <span className="text-xs text-faint">Tick 2–6 shows to compare them side by side.</span>
          <button className="btn ml-auto">Compare selected</button>
        </div>
        <table className="table min-w-[1350px]">
          <thead>
            <tr>
              <th></th><th>Show</th><th>Status</th><th>Host</th><th className="text-right">Duration</th><th className="text-right">Items</th>
              <th className="text-right">Revenue</th><th className="text-right">Shipping paid</th><th className="text-right">Expenses</th><th className="text-right">Est. profit</th><th className="text-right">Reconciled</th>
              <th className="text-right">Profit/min</th><th className="text-right">Profit/hr</th><th className="text-right">Margin</th><th className="text-right">Avg price</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><input type="checkbox" name="c" value={r.id} className="h-4 w-4 accent-[#d9b26b]" aria-label={`Compare ${r.title}`} /></td>
                <td>
                  <Link href={`/shows/${r.id}`} className="hover:text-gold">
                    {r.isTest && <span className="text-info">TEST · </span>}{r.title}
                  </Link>
                  <div className="text-xs text-faint">{PLATFORM_LABEL[r.platform]} · {fmtTime(r.startedAt, tz, true)}{r.liveRoomId ? " · LIVE " + r.liveRoomId : ""}</div>
                </td>
                <td><StatusPill status={r.status} /><div className="mt-1"><DataStatusBadge status={r.dataStatus} /></div></td>
                <td className="text-muted">{r.host}</td>
                <td className="num text-right">{fmtDuration(r.metrics.activeSeconds)}</td>
                <td className="num text-right">{r.items}</td>
                <td className="num text-right">{formatUsd(r.revenue)}</td>
                <td className="num text-right">{formatUsd(r.metrics.customerShipping)}</td>
                <td className="num text-right">{formatUsd(r.totalExpenses)}</td>
                <td className={`num text-right ${r.profit.isNegative() ? "text-neg" : "text-pos"}`}>{formatUsd(r.profit)}</td>
                <td className="num text-right">{r.reconciledProfit ? formatUsd(r.reconciledProfit) : <span className="text-faint">Pending</span>}</td>
                <td className="num text-right">{formatUsd(r.profitPerMinute)}</td>
                <td className="num text-right">{formatUsd(r.profitPerHour)}</td>
                <td className="num text-right">{formatPct(r.marginPct)}</td>
                <td className="num text-right">{formatUsd(r.asp)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={15} className="py-8 text-center text-faint">No shows in this range</td></tr>}
          </tbody>
        </table>
      </form>
    </div>
  );
}

function Stat({ label, value, tone = "text-ink" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="card p-4">
      <div className="label">{label}</div>
      <div className={`num mt-2 text-xl font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

function Comparison({ title, rows }: { title: string; rows: GroupRow[] }) {
  const max = rows.reduce((m, r) => Decimal.max(m, r.profitPerHour?.abs() ?? ZERO), ZERO);
  return (
    <div className="card overflow-x-auto p-5">
      <div className="label mb-3">{title}</div>
      <table className="table">
        <thead>
          <tr><th></th><th className="text-right">Shows</th><th className="text-right">Profit/hr</th><th className="text-right">Margin</th><th className="text-right">Items/hr</th><th className="text-right">Avg price</th></tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.key}>
              <td className="min-w-[140px]">
                {g.key}
                <div className="mt-1 h-1 rounded bg-line">
                  <div className={`h-1 rounded ${g.profitPerHour?.isNegative() ? "bg-neg" : "bg-gold"}`} style={{ width: `${max.isZero() ? 0 : g.profitPerHour!.abs().div(max).times(100).toNumber()}%` }} />
                </div>
              </td>
              <td className="num text-right">{g.shows}</td>
              <td className="num text-right">{formatUsd(g.profitPerHour)}</td>
              <td className="num text-right">{formatPct(g.marginPct)}</td>
              <td className="num text-right">{g.itemsPerHour?.toFixed(1) ?? "—"}</td>
              <td className="num text-right">{formatUsd(g.asp)}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={6} className="py-4 text-center text-faint">—</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
