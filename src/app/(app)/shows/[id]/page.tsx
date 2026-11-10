import { notFound } from "next/navigation";
import Link from "next/link";
import { currentUser, supabaseServer } from "@/lib/supabase/clients";
import { loadShowSnapshot } from "@/lib/data/shows";
import { getTimezone } from "@/lib/data/context";
import { computeMinutes, liveEstimateView, minuteStats, type MinuteMetric } from "@/lib/engine/minutes";
import { productBreakdown } from "@/lib/engine/products";
import { normalizeCosts } from "@/lib/engine/defaults";
import { EXPENSE_CATEGORIES } from "@/lib/engine/types";
import { d, Decimal, formatPct, formatUsd, ZERO } from "@/lib/engine/money";
import { fmtDuration, fmtTime, PLATFORM_LABEL } from "@/lib/format";
import { utcToLocalInput } from "@/lib/dates";
import { ActionForm } from "@/components/ActionForm";
import { BarChart, LineChart } from "@/components/Charts";
import { CostBreakdown, Flags, MoneyIn, ShippingAndFees } from "@/components/ProfitPanels";
import { DataStatusBadge, EstTag, Kpi, StatusPill, tone } from "@/components/ui";
import { addExpense, deleteExpense, editShift, editShow, recalculateShow, removeScanReport, updateShowCosts, uploadScanReport } from "../actions";

type SP = { view?: "final" | "original"; minutes?: "all" };

const hhmm = (iso: string, tz: string) => fmtTime(iso, tz).replace(/:\d\d (?=[AP]M)/, " ");

/** Frozen per-minute rows (captured at show end) → the same shape the engine produces. */
function frozenMinutes(rows: any[]): MinuteMetric[] {
  let cumRev = ZERO;
  let cumExp = ZERO;
  let active = 0;
  return rows.map((r) => {
    const revenue = d(r.revenue);
    const profit = d(r.profit);
    const expenses = revenue.minus(profit);
    cumRev = cumRev.plus(revenue);
    cumExp = cumExp.plus(expenses);
    active += r.active_seconds;
    const cum = d(r.cumulative_profit);
    return {
      index: r.minute_index,
      start: r.minute_start,
      end: new Date(Date.parse(r.minute_start) + 60_000).toISOString(),
      elapsedMinutes: r.minute_index + 1,
      activeSeconds: r.active_seconds,
      orders: r.orders,
      units: r.units,
      revenue,
      cogs: d(r.cogs),
      commission: d(r.commission),
      fees: d(r.fees),
      labor: d(r.labor),
      hourlyExpenses: d(r.hourly_expenses),
      fixedExpenses: d(r.fixed_expenses),
      packing: d(r.packing),
      shipping: d(r.shipping),
      expenses,
      profit,
      cumulativeRevenue: cumRev,
      cumulativeExpenses: cumExp,
      cumulativeProfit: cum,
      avgProfitPerMinute: active ? cum.div(active / 60) : null,
    };
  });
}

export default async function ShowDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const { id } = await params;
  const sp = await searchParams;
  const sb = await supabaseServer();
  const snap = await loadShowSnapshot(sb, id);
  if (!snap) notFound();
  const [tz, user, { data: showRow }, { data: frozen }, { data: expenseRows }, { data: orderRows }, { data: scanReport }] = await Promise.all([
    getTimezone(sb),
    currentUser(),
    sb.from("live_shows").select("original_estimate, platform_stats, scheduled_start, scheduled_end").eq("id", id).single(),
    sb.from("show_minute_metrics").select("*").eq("show_id", id).eq("view", "original").order("minute_index"),
    sb.from("show_expenses").select("id, category, kind, description, amount, incurred_at").eq("show_id", id).order("incurred_at"),
    sb
      .from("orders")
      .select("id, external_order_id, created_at_platform, status, customer_id, attribution_method, settlement_amount, actual_platform_fees, seller_shipping_cost, order_items(quantity, unit_price, seller_discount, title), refunds(amount)")
      .eq("show_id", id)
      .order("created_at_platform", { ascending: false })
      .limit(300),
    sb.from("show_scan_reports").select("file_name, report_date, show_label, units, total_cogs, lines, warnings, uploaded_at").eq("show_id", id).maybeSingle(),
  ]);
  const meta = snap.meta;
  const canWrite = user?.canWrite ?? false;
  const running = meta.status === "live" || meta.status === "paused";
  const now = new Date();

  const final = computeMinutes(snap.input, now);
  const hasOriginal = !running && !!meta.endedAt;
  const original = hasOriginal
    ? frozen?.length
      ? { minutes: frozenMinutes(frozen), frozen: true }
      : { minutes: computeMinutes(liveEstimateView(snap.input), now).minutes, frozen: false }
    : null;
  const viewOriginal = sp.view === "original" && !!original;
  const minutes = viewOriginal ? original!.minutes : final.minutes;
  const stats = viewOriginal ? minuteStats(minutes) : final.stats;
  const m = final.totals;
  const oe = (showRow?.original_estimate ?? null) as Record<string, any> | null;
  const originalTotals = original
    ? oe
      ? { revenue: d(oe.revenue), profit: d(oe.profit), fees: d(oe.platformFees), shipping: d(oe.netShipping), expenses: d(oe.totalExpenses), staff: d(oe.presenter).plus(d(oe.assistant)) }
      : (() => {
          const t = computeMinutes(liveEstimateView(snap.input), now).totals;
          return { revenue: t.netMerchandise, profit: t.operatingProfit, fees: t.platformFees, shipping: t.netShippingCost, expenses: t.totalExpenses, staff: t.labor.presenter.plus(t.labor.assistant) };
        })()
    : null;
  const products = productBreakdown(snap.input.orders, snap.input.costs);
  const n = normalizeCosts(snap.input.costs);
  const labels = minutes.map((x) => hhmm(x.start, tz));
  const tableMinutes = sp.minutes === "all" ? minutes : minutes.slice(-30);
  const est = m.flags.feesEstimated || m.flags.productCostEstimated || m.flags.shippingEstimated;
  const qs = (patch: Partial<SP>) => `?${new URLSearchParams(Object.entries({ ...sp, ...patch }).filter(([, v]) => v) as [string, string][]).toString()}`;

  return (
    <div className="mx-auto max-w-[1400px]">
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <Link href="/history" className="text-muted hover:text-ink">← LIVE history</Link>
        {running && <Link href={`/live?show=${id}`} className="btn-primary ml-auto">Open live dashboard</Link>}
      </div>

      {/* header */}
      <header className="mb-5 flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="label">
            {meta.isTest && <span className="text-info">TEST · </span>}
            {PLATFORM_LABEL[meta.platform]}
            {meta.liveRoomId && <> · TikTok LIVE {meta.liveRoomId}</>}
            {meta.detection === "platform" && " · auto-detected"}
          </div>
          <h1 className="text-2xl font-semibold">{meta.title}</h1>
          <div className="mt-1 text-sm text-muted">
            {fmtTime(meta.startedAt, tz, true)} – {meta.endedAt ? fmtTime(meta.endedAt, tz, true) : "now"} · {fmtDuration(m.activeSeconds)} ({m.activeHours.toFixed(2)} h)
            {!meta.timesVerified && meta.detection === "platform" && <span className="text-gold"> · times estimated</span>}
            {meta.timesVerified && <span className="text-pos"> · times confirmed by TikTok</span>}
          </div>
          <div className="mt-1 text-sm text-muted">
            Presenter: {meta.staff.filter((s) => s.role === "host").map((s) => s.name).join(", ") || "Default presenter"} · Assistant:{" "}
            {meta.staff.filter((s) => s.role === "assistant").map((s) => s.name).join(", ") || (meta.staff.length ? "none" : "Default assistant")}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <StatusPill status={meta.status} />
          <DataStatusBadge status={m.dataStatus} />
          <a href={`/api/reports/minutes?show=${id}`} className="btn">Minutes CSV</a>
          <a href={`/api/reports/orders?show=${id}`} className="btn">Orders CSV</a>
          <Link href={`/reports?show=${id}`} className="btn">Report / PDF</Link>
        </div>
      </header>

      {/* §2 show record */}
      <section className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Kpi big label="Estimated profit" value={formatUsd(m.operatingProfit)} toneClass={tone(m.operatingProfit)} est={est} />
        <Kpi big label="Final reconciled profit" value={m.reconciledProfit ? formatUsd(m.reconciledProfit) : "Pending"} toneClass={m.reconciledProfit ? tone(m.reconciledProfit) : "text-muted"} hint={`${m.settledOrders} of ${m.orders} orders settled`} />
        <Kpi label="Product revenue" value={formatUsd(m.netMerchandise)} />
        <Kpi label="Profit / minute" value={formatUsd(m.profitPerMinute)} toneClass={tone(m.profitPerMinute)} />
        <Kpi label="Profit / hour" value={formatUsd(m.profitPerHour)} toneClass={tone(m.profitPerHour)} />
        <Kpi label="Margin" value={formatPct(m.marginPct)} />
        <Kpi label="Orders" value={String(m.orders)} hint={`${m.ordersPerMinute?.toFixed(2) ?? "—"} / min${m.cancelledOrders ? ` · ${m.cancelledOrders} cancelled` : ""}`} />
        <Kpi label="Units sold" value={String(m.itemsSold)} hint={`${m.unitsPerMinute?.toFixed(2) ?? "—"} / min${m.giveawayUnits ? ` · +${m.giveawayUnits} giveaway` : ""}${m.unitsRefunded ? ` · ${m.unitsRefunded} refunded` : ""}`} />
        <Kpi label={m.avgBasis === "auction" ? "Avg auction price" : "Avg selling price"} value={formatUsd(m.avgSellingPrice)} hint={m.avgBasis === "auction" ? "auction items only" : "giveaways excluded"} />
        <Kpi label={m.avgBasis === "auction" ? "Avg auction order" : "Avg order value"} value={formatUsd(m.avgOrderValue)} hint="product only · no giveaways" />
        <Kpi label="Product cost" value={formatUsd(m.costs.product)} est={m.flags.productCostEstimated} />
        <Kpi label="Presenter pay" value={formatUsd(m.labor.presenter)} />
        <Kpi label="Assistant pay" value={formatUsd(m.labor.assistant)} />
        <Kpi label="TikTok fees" value={formatUsd(m.platformFees)} est={m.flags.feesEstimated} />
        <Kpi label="Giveaways & misc." value={formatUsd(m.costs.hourlyExpenses.plus(m.costs.fixedExpenses))} />
        <Kpi label="Shipping" value={m.flags.shippingUnknownOrders === m.orders && m.orders > 0 ? "Pending" : formatUsd(m.netShippingCost)} est={m.flags.shippingEstimated} hint={m.flags.shippingUnknownOrders ? `${m.flags.shippingUnknownOrders} orders pending reconciliation` : undefined} />
        <Kpi label="Total expenses" value={formatUsd(m.totalExpenses)} est={est} />
        <Kpi label="Break-even" value={m.breakEven.reached ? "Reached" : m.breakEven.unitsRemaining !== null ? `${m.breakEven.unitsRemaining} more items` : "—"} />
      </section>

      <div className="mb-4">
        <MoneyIn profit={m} />
      </div>

      <ScanReportCard
        showId={id}
        report={scanReport as ScanReportRow | null}
        unitsOut={m.itemsSold + m.giveawayUnits}
        productCost={formatUsd(m.costs.product)}
        canWrite={canWrite}
        tz={tz}
      />

      {/* original vs final */}
      {original && originalTotals && (
        <section className="card mb-4 p-5">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <div className="label">Live estimate vs. now</div>
            <span className="text-xs text-faint">
              {original.frozen ? "Saved when the show ended — never changed by later data." : "Rebuilt from data that had arrived by the end of the show."}
            </span>
            <div className="ml-auto flex gap-2">
              <Link href={qs({ view: "final" })} className={!viewOriginal ? "btn-primary" : "btn"}>Final view</Link>
              <Link href={qs({ view: "original" })} className={viewOriginal ? "btn-primary" : "btn"}>Original live estimate</Link>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr><th></th><th className="text-right">At show end</th><th className="text-right">Now</th><th className="text-right">Adjustment</th></tr>
              </thead>
              <tbody>
                {(
                  [
                    ["Product revenue", originalTotals.revenue, m.netMerchandise, false],
                    ["Staff pay", originalTotals.staff, m.labor.presenter.plus(m.labor.assistant), true],
                    ["Platform fees", originalTotals.fees, m.platformFees, true],
                    ["Net shipping", originalTotals.shipping, m.netShippingCost, true],
                    ["Total expenses", originalTotals.expenses, m.totalExpenses, true],
                    ["Estimated profit", originalTotals.profit, m.operatingProfit, false],
                  ] as [string, Decimal, Decimal, boolean][]
                ).map(([label, a, b, isCost]) => {
                  const delta = b.minus(a);
                  const good = isCost ? delta.isNegative() : !delta.isNegative();
                  return (
                    <tr key={label}>
                      <td className={label === "Estimated profit" ? "font-semibold" : ""}>{label}</td>
                      <td className="num text-right">{formatUsd(a)}</td>
                      <td className="num text-right">{formatUsd(b)}</td>
                      <td className={`num text-right ${delta.isZero() ? "text-faint" : good ? "text-pos" : "text-neg"}`}>
                        {delta.isZero() ? "—" : `${delta.isNegative() ? "−" : "+"}${formatUsd(delta.abs())}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-faint">Late orders, refunds, cancellations and TikTok settlements update the final view; the original minute history is kept as it was.</p>
        </section>
      )}

      {/* minute analytics */}
      <section className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Mini label="Best minute" value={stats.bestMinute ? formatUsd(stats.bestMinute.profit) : "—"} sub={stats.bestMinute ? hhmm(stats.bestMinute.start, tz) : undefined} toneClass="text-pos" />
        <Mini label="Worst minute" value={stats.worstMinute ? formatUsd(stats.worstMinute.profit) : "—"} sub={stats.worstMinute ? hhmm(stats.worstMinute.start, tz) : undefined} toneClass={tone(stats.worstMinute?.profit)} />
        <Mini label="Best 15 minutes" value={stats.best15 ? formatUsd(stats.best15.profit) : "—"} sub={stats.best15 ? `${hhmm(stats.best15.start, tz)} · ${formatUsd(stats.best15.revenue)} rev` : undefined} toneClass={tone(stats.best15?.profit)} />
        <Mini label="Avg revenue / min" value={formatUsd(stats.avgRevenuePerMinute)} />
        <Mini label="Avg profit / min" value={formatUsd(stats.avgProfitPerMinute)} toneClass={tone(stats.avgProfitPerMinute)} />
        <Mini label="Minutes with a sale" value={`${minutes.filter((x) => x.orders > 0).length} / ${minutes.length}`} />
        <Mini label="Total profit" value={formatUsd(stats.totalProfit)} toneClass={tone(stats.totalProfit)} />
      </section>

      <section className="mb-4 grid gap-4 xl:grid-cols-2">
        <div className="card p-5">
          <div className="label mb-1">Profit by minute {viewOriginal && <EstTag text="original" />}</div>
          <div className="mb-2 text-xs text-faint">Highlighted: most profitable 15 minutes. Red: minutes that lost money.</div>
          <BarChart labels={labels} values={minutes.map((x) => x.profit.toNumber())} format="money" color="#34d399" highlight={stats.best15 ? [stats.best15.startIndex, stats.best15.endIndex] : undefined} />
        </div>
        <div className="card p-5">
          <div className="label mb-3">Cumulative revenue, expenses and profit</div>
          <LineChart
            labels={labels}
            series={[
              { name: "Revenue", color: "#d9b26b", values: minutes.map((x) => x.cumulativeRevenue.toNumber()) },
              { name: "Expenses", color: "#f87171", values: minutes.map((x) => x.cumulativeExpenses.toNumber()) },
              { name: "Profit", color: "#34d399", values: minutes.map((x) => x.cumulativeProfit.toNumber()) },
            ]}
          />
        </div>
        <div className="card p-5">
          <div className="label mb-3">Revenue by minute</div>
          <BarChart labels={labels} values={minutes.map((x) => x.revenue.toNumber())} format="money" />
        </div>
        <div className="card p-5">
          <div className="label mb-3">Units sold by minute</div>
          <BarChart labels={labels} values={minutes.map((x) => x.units)} unit="items" color="#60a5fa" />
        </div>
      </section>

      <section className="card mb-4 p-5">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="label">Minute by minute {viewOriginal && <EstTag text="original live estimate" />}</div>
          <span className="text-xs text-faint">{sp.minutes === "all" ? `All ${minutes.length} minutes` : `Last ${tableMinutes.length} of ${minutes.length} minutes`}</span>
          <Link href={qs({ minutes: sp.minutes === "all" ? undefined : "all" })} className="btn ml-auto">{sp.minutes === "all" ? "Show last 30" : "Show all minutes"}</Link>
        </div>
        <div className="max-h-[560px] overflow-auto">
          <table className="table whitespace-nowrap">
            <thead className="sticky top-0 bg-panel">
              <tr>
                <th>Minute</th>
                <th className="text-right">Elapsed</th>
                <th className="text-right">Orders</th>
                <th className="text-right">Units</th>
                <th className="text-right">Revenue</th>
                <th className="text-right">Product</th>
                <th className="text-right">Commission</th>
                <th className="text-right">Fees</th>
                <th className="text-right">Labor</th>
                <th className="text-right">Hourly exp.</th>
                <th className="text-right">Fixed exp.</th>
                <th className="text-right">Shipping</th>
                <th className="text-right">Minute profit</th>
                <th className="text-right">Cumulative</th>
                <th className="text-right">Avg / min</th>
              </tr>
            </thead>
            <tbody>
              {[...tableMinutes].reverse().map((x) => (
                <tr key={x.index} className={x.activeSeconds === 0 ? "text-faint" : ""}>
                  <td className="num">{hhmm(x.start, tz)}–{hhmm(x.end, tz)}</td>
                  <td className="num text-right">{x.elapsedMinutes}m</td>
                  <td className="num text-right">{x.orders || ""}</td>
                  <td className="num text-right">{x.units || ""}</td>
                  <td className="num text-right">{x.revenue.isZero() ? "" : formatUsd(x.revenue)}</td>
                  <td className="num text-right">{x.cogs.isZero() ? "" : formatUsd(x.cogs)}</td>
                  <td className="num text-right">{x.commission.isZero() ? "" : formatUsd(x.commission)}</td>
                  <td className="num text-right">{x.fees.isZero() ? "" : formatUsd(x.fees)}</td>
                  <td className="num text-right">{formatUsd(x.labor)}</td>
                  <td className="num text-right">{formatUsd(x.hourlyExpenses)}</td>
                  <td className="num text-right">{x.fixedExpenses.isZero() ? "" : formatUsd(x.fixedExpenses)}</td>
                  <td className="num text-right">{x.shipping.isZero() ? "" : formatUsd(x.shipping)}</td>
                  <td className={`num text-right font-medium ${tone(x.profit)}`}>{formatUsd(x.profit)}</td>
                  <td className={`num text-right ${tone(x.cumulativeProfit)}`}>{formatUsd(x.cumulativeProfit)}</td>
                  <td className="num text-right text-muted">{formatUsd(x.avgProfitPerMinute)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-faint">
          Revenue is placed by order {n.revenueBasis === "paid" ? "payment" : "creation"} time (Settings → accounting basis). Hourly pay and expenses accrue every active second, so a quiet minute shows a loss.
        </p>
      </section>

      <section className="mb-4 grid gap-4 lg:grid-cols-2">
        <CostBreakdown profit={m} />
        <ShippingAndFees profit={m} />
      </section>
      <Flags profit={m} />

      {/* staff / payroll */}
      <section className="card my-4 overflow-x-auto p-5">
        <div className="label mb-3">Staff and pay for this show</div>
        <table className="table">
          <thead>
            <tr>
              <th>Person</th>
              <th>Shift</th>
              <th className="text-right">Minutes</th>
              <th className="text-right">Units credited</th>
              <th className="text-right">Commission</th>
              <th className="text-right">Hourly</th>
              <th className="text-right">Flat</th>
              <th className="text-right">Total pay</th>
            </tr>
          </thead>
          <tbody>
            {m.labor.byStaff.map((s, i) => {
              const shift = meta.staff[i];
              return (
                <tr key={i}>
                  <td>{s.name}<div className="text-xs text-faint">{s.role === "host" ? "presenter" : "assistant"}</div></td>
                  <td className="text-sm text-muted">
                    {fmtTime(shift?.joinedAt ?? meta.startedAt, tz)} – {shift?.leftAt ? fmtTime(shift.leftAt, tz) : meta.endedAt ? fmtTime(meta.endedAt, tz) : "now"}
                    {shift && (
                      <div className="text-xs text-faint">
                        {s.unitsCredited > 0 || Number(shift.comp.perUnit) > 0 ? `$${s.perUnitRate.toFixed(2)}/item` : ""}
                        {Number(shift.comp.pctOfAvgPrice ?? 0) > 0 ? ` (≥ $${shift.comp.perUnit} or ${(Number(shift.comp.pctOfAvgPrice) * 100).toFixed(0)}% of avg)` : ""}
                        {Number(shift.comp.perHour) > 0 ? ` · $${shift.comp.perHour}/h` : ""}
                        {Number(shift.comp.percentOfSales) > 0 ? ` · ${(Number(shift.comp.percentOfSales) * 100).toFixed(1)}% of sales` : ""}
                        {Number(shift.comp.flatPerShow) > 0 ? ` · $${shift.comp.flatPerShow} flat` : ""}
                      </div>
                    )}
                  </td>
                  <td className="num text-right">{s.minutes}</td>
                  <td className="num text-right">{s.unitsCredited}</td>
                  <td className="num text-right">{formatUsd(s.commission)}</td>
                  <td className="num text-right">{formatUsd(s.hourly)}</td>
                  <td className="num text-right">{formatUsd(s.flat)}</td>
                  <td className="num text-right font-medium">{formatUsd(s.total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!meta.staff.length && <p className="mt-2 text-xs text-faint">No named staff — the show&apos;s default presenter and assistant rates apply for the whole show.</p>}
        {canWrite && meta.staff.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-muted hover:text-ink">Edit shifts and pay (admins)</summary>
            <div className="mt-3 space-y-3">
              {meta.staff.map((s) => (
                <ActionForm key={s.id} action={editShift} className="grid items-end gap-2 rounded-lg border border-line p-3 md:grid-cols-[1.2fr_repeat(2,1.4fr)_repeat(5,0.8fr)_auto]">
                  <input type="hidden" name="shiftId" value={s.id} />
                  <div className="text-sm">{s.name}<div className="text-xs text-faint">{s.role === "host" ? "presenter" : "assistant"}</div></div>
                  <L label="Joined"><input type="datetime-local" name="joinedAt" defaultValue={utcToLocalInput(s.joinedAt ?? meta.startedAt, tz)} className="input" /></L>
                  <L label="Left (blank = show end)"><input type="datetime-local" name="leftAt" defaultValue={utcToLocalInput(s.leftAt, tz)} className="input" /></L>
                  <L label="$ / item (min)"><input name="perUnit" defaultValue={s.comp.perUnit} inputMode="decimal" className="input" /></L>
                  <L label="% of avg price"><input name="pctOfAvg" defaultValue={(Number(s.comp.pctOfAvgPrice ?? 0) * 100).toString()} inputMode="decimal" className="input" /></L>
                  <L label="$ / hour"><input name="perHour" defaultValue={s.comp.perHour} inputMode="decimal" className="input" /></L>
                  <L label="% of sales"><input name="percentOfSales" defaultValue={(Number(s.comp.percentOfSales) * 100).toString()} inputMode="decimal" className="input" /></L>
                  <L label="Flat $"><input name="flatPerShow" defaultValue={s.comp.flatPerShow} inputMode="decimal" className="input" /></L>
                  <button className="btn">Save</button>
                </ActionForm>
              ))}
            </div>
          </details>
        )}
      </section>

      {/* expenses */}
      <section className="card mb-4 p-5">
        <div className="label mb-3">Fixed expenses on this show</div>
        <ul className="mb-3 divide-y divide-line/60 text-sm">
          {(expenseRows ?? []).map((e) => (
            <li key={e.id} className="flex items-center gap-3 py-1.5">
              <span className="w-28 text-muted">{EXPENSE_CATEGORIES.find((c) => c.id === e.category)?.label ?? "Other"}</span>
              <span className="flex-1 truncate">{e.description}</span>
              <span className="text-xs text-faint">{fmtTime(e.incurred_at, tz)}</span>
              <span className="num">{formatUsd(new Decimal(e.amount))}</span>
              {canWrite && (
                <ActionForm action={deleteExpense} confirm="Remove this expense?">
                  <input type="hidden" name="expenseId" value={e.id} />
                  <button className="text-xs text-faint hover:text-neg" aria-label="Remove">✕</button>
                </ActionForm>
              )}
            </li>
          ))}
          {!expenseRows?.length && <li className="py-2 text-faint">None</li>}
        </ul>
        {canWrite && (
          <ActionForm action={addExpense} resetOnSuccess className="flex flex-wrap gap-2">
            <input type="hidden" name="showId" value={id} />
            <select name="category" className="input w-auto">
              {EXPENSE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <input name="description" placeholder="What" className="input min-w-0 flex-1" required />
            <input name="amount" placeholder="0.00" inputMode="decimal" className="input w-28" required />
            <button className="btn-primary">Add expense</button>
          </ActionForm>
        )}
      </section>

      {/* products */}
      <section className="card mb-4 overflow-x-auto p-5">
        <div className="label mb-3">Products ({products.length})</div>
        <table className="table">
          <thead>
            <tr>
              <th>SKU / product</th>
              <th className="text-right">Units</th>
              <th className="text-right">Revenue</th>
              <th className="text-right">Avg price</th>
              <th className="text-right">Item cost</th>
              <th className="text-right">Contribution</th>
              <th className="text-right">Margin</th>
            </tr>
          </thead>
          <tbody>
            {products.map((r) => (
              <tr key={r.sku + r.title}>
                <td>
                  <div>{r.title}</div>
                  <div className="text-xs text-faint">{r.sku}{r.costEstimated && <span className="text-gold"> · default cost (estimated)</span>}</div>
                </td>
                <td className="num text-right">{r.units}</td>
                <td className="num text-right">{formatUsd(r.netRevenue)}</td>
                <td className="num text-right">{formatUsd(r.avgPrice)}</td>
                <td className="num text-right">{formatUsd(r.productCost)}</td>
                <td className={`num text-right ${tone(r.contribution)}`}>{formatUsd(r.contribution)}</td>
                <td className="num text-right">{formatPct(r.marginPct)}</td>
              </tr>
            ))}
            {!products.length && <tr><td colSpan={7} className="py-6 text-center text-faint">No sales</td></tr>}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-faint">Contribution = revenue − item cost − presenter commission − packing − platform fees. Hourly show costs are not split across products.</p>
      </section>

      {/* orders */}
      <section className="card mb-4 overflow-x-auto p-5">
        <div className="label mb-3 flex justify-between">
          <span>Orders ({m.orders + m.cancelledOrders})</span>
          <Link href={`/orders?show=${id}`} className="normal-case tracking-normal text-muted hover:text-ink">Open in Orders →</Link>
        </div>
        <table className="table">
          <thead>
            <tr><th>Time</th><th>TikTok order</th><th>Items</th><th className="text-right">Revenue</th><th className="text-right">Fees</th><th className="text-right">Settled</th><th>Matched by</th></tr>
          </thead>
          <tbody>
            {(orderRows ?? []).map((o: any) => {
              const rev = (o.order_items ?? [])
                .reduce((a: Decimal, i: any) => a.plus(new Decimal(i.unit_price).times(i.quantity)).minus(i.seller_discount), ZERO)
                .minus((o.refunds ?? []).reduce((a: Decimal, r: any) => a.plus(r.amount), ZERO));
              return (
                <tr key={o.id} className={o.status === "cancelled" ? "text-faint line-through" : ""}>
                  <td className="num text-muted">{fmtTime(o.created_at_platform, tz)}</td>
                  <td><Link href={`/orders/${o.id}`} className="num hover:text-gold">{o.external_order_id}</Link></td>
                  <td className="max-w-[260px] truncate">{(o.order_items ?? []).map((i: any) => `${i.quantity}× ${i.title}`).join(", ")}</td>
                  <td className="num text-right">{formatUsd(rev)}</td>
                  <td className="num text-right">{o.actual_platform_fees !== null ? formatUsd(new Decimal(o.actual_platform_fees)) : <span className="text-faint">est.</span>}</td>
                  <td className="num text-right">{o.settlement_amount !== null ? formatUsd(new Decimal(o.settlement_amount)) : <span className="text-faint">Pending</span>}</td>
                  <td className="text-xs text-muted">{o.attribution_method === "platform_live_id" ? "TikTok LIVE id" : o.attribution_method === "time_window" ? "Show window" : o.attribution_method === "manual" ? "Manual" : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* admin */}
      {canWrite && (
        <section className="mb-8 grid gap-4 lg:grid-cols-2">
          <div className="card p-5">
            <div className="label mb-3">Show details</div>
            <ActionForm action={editShow} className="grid gap-3" successText="Saved">
              <input type="hidden" name="showId" value={id} />
              <L label="Title"><input name="title" defaultValue={meta.title} className="input" required /></L>
              <div className="grid gap-3 sm:grid-cols-2">
                <L label="Start"><input type="datetime-local" name="startedAt" defaultValue={utcToLocalInput(meta.startedAt, tz)} className="input" required /></L>
                <L label="End"><input type="datetime-local" name="endedAt" defaultValue={utcToLocalInput(meta.endedAt, tz)} className="input" disabled={running} /></L>
              </div>
              <L label="Notes"><textarea name="notes" defaultValue={meta.notes ?? ""} rows={2} className="input" /></L>
              <button className="btn w-fit">Save details</button>
              <p className="text-xs text-faint">Changing times re-checks unassigned orders against the new window. Every change is audited.</p>
            </ActionForm>
          </div>
          <div className="card p-5">
            <div className="label mb-3">Cost rules for this show</div>
            <ActionForm action={updateShowCosts} className="grid gap-3" successText="Saved — this show's numbers now use these rules">
              <input type="hidden" name="showId" value={id} />
              <div className="grid gap-3 sm:grid-cols-2">
                <L label="Fallback product cost / unit"><input name="defaultProductCost" defaultValue={n.defaultProductCost} inputMode="decimal" className="input" /></L>
                <L label="TikTok commission %"><input name="percentFeePct" defaultValue={(Number(n.percentFee) * 100).toString()} inputMode="decimal" className="input" /></L>
                <L label="Packing / unit"><input name="packingPerItem" defaultValue={n.packingPerItem} inputMode="decimal" className="input" /></L>
                <L label="Shipping estimate / package (blank = pending)"><input name="shippingEstimate" defaultValue={n.shippingEstimatePerPackage ?? ""} inputMode="decimal" className="input" /></L>
                {n.hourlyExpenses.map((h, i) => (
                  <L key={i} label={`${h.label} $ / hour`}><input name={`hourly_${i}`} defaultValue={h.perHour} inputMode="decimal" className="input" /></L>
                ))}
              </div>
              <button className="btn w-fit">Save cost rules</button>
              <p className="text-xs text-faint">
                These were frozen when the show started{meta.recalculatedAt ? ` (recalculated ${fmtTime(meta.recalculatedAt, tz, true)})` : ""}. SKU-specific costs set: {Object.keys(n.skuCosts).length}. Staff pay is edited per shift above.
              </p>
            </ActionForm>
            {user?.role === "owner" && !running && (
              <ActionForm action={recalculateShow} confirm="Replace this show's frozen cost rules (incl. SKU costs) with today's settings? This changes its historical profit." className="mt-4">
                <input type="hidden" name="showId" value={id} />
                <button className="btn w-full">Recalculate with current settings</button>
              </ActionForm>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[11px] text-muted">{label}</span>
      {children}
    </label>
  );
}

function Mini({ label, value, toneClass = "text-ink", sub }: { label: string; value: string; toneClass?: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-line/70 bg-panel/60 px-3 py-2.5">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted">{label}</div>
      <div className={`num mt-1 text-base font-semibold ${toneClass}`}>{value}</div>
      {sub && <div className="num text-[11px] text-faint">{sub}</div>}
    </div>
  );
}

type ScanReportRow = {
  file_name: string;
  report_date: string | null;
  show_label: string | null;
  units: number;
  total_cogs: string;
  lines: { brand: string; product: string; upc: string; lots: string; count: number; cogs: string }[];
  warnings: string[];
  uploaded_at: string;
};

/** End-of-show scan report: upload it and the show's product cost becomes the report's total COGS. */
function ScanReportCard({ showId, report, unitsOut, productCost, canWrite, tz }: { showId: string; report: ScanReportRow | null; unitsOut: number; productCost: string; canWrite: boolean; tz: string }) {
  const upload = canWrite && (
    <ActionForm action={uploadScanReport} className="flex flex-wrap items-center gap-2" resetOnSuccess successText="Uploaded — product cost updated.">
      <input type="hidden" name="showId" value={showId} />
      <input type="file" name="file" accept=".pdf,.csv,application/pdf,text/csv" required className="max-w-[230px] text-xs file:mr-2 file:rounded-md file:border-0 file:bg-panel-2 file:px-3 file:py-1.5 file:text-ink" />
      <button className="btn-primary py-1.5">{report ? "Replace" : "Upload"}</button>
    </ActionForm>
  );
  if (!report)
    return (
      <section className="card mb-4 flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1 basis-64">
          <div className="font-medium">End-of-show scan report</div>
          <div className="text-xs text-muted">Upload the scan report (PDF or CSV) after the show — its Total COGS becomes this show&apos;s product cost. Until then product cost uses the default rules.</div>
        </div>
        {upload}
      </section>
    );
  const diff = report.units - unitsOut;
  return (
    <section className="card mb-4 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <div className="label">End-of-show scan report</div>
          <div className="num mt-1 text-2xl font-semibold">{formatUsd(d(report.total_cogs))} <span className="text-sm font-normal text-muted">product cost · {report.units} units scanned</span></div>
          <div className="text-xs text-faint">
            {report.file_name}
            {report.show_label ? ` · ${report.show_label}` : ""}
            {report.report_date ? ` · ${report.report_date}` : ""} · uploaded {fmtTime(report.uploaded_at, tz, true)}
          </div>
        </div>
        {upload}
        {canWrite && (
          <ActionForm action={removeScanReport} confirm="Remove the scan report? Product cost goes back to the default rules.">
            <input type="hidden" name="showId" value={showId} />
            <button className="btn py-1.5">Remove</button>
          </ActionForm>
        )}
      </div>
      <div className="mt-2 space-y-1 text-xs">
        <p className="text-muted">Product cost used for this show: <span className="num text-ink">{productCost}</span></p>
        {diff !== 0 && (
          <p className="text-warn">
            The report scanned {report.units} units but TikTok recorded {unitsOut} (incl. giveaways) — {Math.abs(diff)} {diff > 0 ? "more scanned than sold" : "sold but not scanned"}. Product cost still uses the report&apos;s total.
          </p>
        )}
        {report.warnings.map((w) => (
          <p key={w} className="text-warn">{w}</p>
        ))}
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-muted">{report.lines.length} products in the report</summary>
        <div className="mt-2 max-h-80 overflow-auto">
          <table className="table text-xs">
            <thead>
              <tr><th>Brand</th><th>Product</th><th>UPC</th><th className="text-right">Count</th><th className="text-right">COGS</th></tr>
            </thead>
            <tbody>
              {report.lines.map((l, i) => (
                <tr key={l.upc + i}>
                  <td className="text-muted">{l.brand}</td>
                  <td>{l.product}</td>
                  <td className="num text-faint">{l.upc}</td>
                  <td className="num text-right">{l.count}</td>
                  <td className="num text-right">{formatUsd(d(l.cogs))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
