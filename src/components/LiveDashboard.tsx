"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { computeMinutes } from "@/lib/engine/minutes";
import { computeVelocity } from "@/lib/engine/velocity";
import { evaluateAlerts, type AlertRule } from "@/lib/engine/alerts";
import { d, formatPct, formatUsd, type Decimal } from "@/lib/engine/money";
import type { ProfitMetrics } from "@/lib/engine/profit";
import { fmtDuration, fmtTime, PLATFORM_LABEL } from "@/lib/format";
import type { ShowSnapshot } from "@/lib/data/shows";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { BarChart, LineChart } from "./Charts";
import { Notifications } from "./Notifications";
import { DataStatusBadge, EstTag, StatusPill } from "./ui";
import { CostBreakdown, Flags, MoneyIn, ShippingAndFees } from "./ProfitPanels";

export type ConnectionInfo = {
  platform: string;
  status: "connected" | "pending_access" | "disconnected" | "error" | "manual";
  lastEventAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
};

type Props = {
  initial: ShowSnapshot;
  timezone: string;
  connection: ConnectionInfo;
  alertRules: AlertRule[];
  /** Quiet minutes after which an auto-detected LIVE counts as finished. */
  idleMinutes?: number;
};

const sign = (v: Decimal | null) => (v === null ? "text-ink" : v.isNegative() ? "text-neg" : "text-pos");
const hhmm = (iso: string, tz: string) => fmtTime(iso, tz).replace(/:\d\d (?=[AP]M)/, " ");

export function LiveDashboard({ initial, timezone, connection, alertRules, idleMinutes = 20 }: Props) {
  const [snap, setSnap] = useState(initial);
  const [now, setNow] = useState(() => new Date());
  const [rtStatus, setRtStatus] = useState<"connecting" | "live" | "offline">("connecting");
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const sentAlerts = useRef(new Set<string>());
  const showId = initial.meta.id;
  const running = snap.meta.status === "live" || snap.meta.status === "paused";

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/shows/${showId}/snapshot`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSnap(await res.json());
      setLastRefresh(new Date());
      setRefreshError(null);
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : "refresh failed");
    }
  }, [showId]);

  // 1-second clock: hourly costs accrue continuously even with no sales.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, [running]);

  // Realtime: any change to this show's orders/expenses/pauses/staff triggers a refetch.
  useEffect(() => {
    const sb = supabaseBrowser();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 250);
    };
    const filter = `show_id=eq.${showId}`;
    const ch = sb
      .channel(`show-${showId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "orders", filter }, debounced)
      .on("postgres_changes", { event: "*", schema: "public", table: "show_expenses", filter }, debounced)
      .on("postgres_changes", { event: "*", schema: "public", table: "show_pauses", filter }, debounced)
      .on("postgres_changes", { event: "*", schema: "public", table: "show_staff", filter }, debounced)
      .on("postgres_changes", { event: "*", schema: "public", table: "live_shows", filter: `id=eq.${showId}` }, debounced)
      .subscribe((status) =>
        setRtStatus(status === "SUBSCRIBED" ? "live" : status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT" ? "offline" : "connecting"),
      );
    // safety net (30 s) in case a realtime message is missed; webhooks are the primary path
    const poll = setInterval(refresh, 30_000);
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      sb.removeChannel(ch);
    };
  }, [showId, refresh]);

  // A LIVE detected from TikTok has no "ended" signal. Once it has been quiet for the idle
  // period, stop the cost clock at its last order (the server closes it at that time too).
  const lastOrderAt = useMemo(
    () => snap.input.orders.reduce((m, o) => Math.max(m, Date.parse(o.createdAt)), Date.parse(snap.input.startedAt)),
    [snap],
  );
  const idleStopped = running && snap.meta.detection === "platform" && now.getTime() - lastOrderAt > idleMinutes * 60_000;
  const calcNow = idleStopped ? new Date(lastOrderAt) : now;

  const view = useMemo(() => computeMinutes(snap.input, calcNow), [snap, calcNow.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps
  const profit = view.totals;
  const stats = view.stats;
  const velocity = useMemo(() => computeVelocity(snap.input, now), [snap, now]);

  // Alerts (evaluated in the browser while the dashboard is open).
  useEffect(() => {
    if (!running || idleStopped) return;
    const fired = evaluateAlerts(alertRules, profit, velocity, showId).filter((a) => !sentAlerts.current.has(a.dedupeKey));
    if (!fired.length) return;
    fired.forEach((a) => sentAlerts.current.add(a.dedupeKey));
    fetch("/api/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ showId, alerts: fired }),
    }).catch(() => fired.forEach((a) => sentAlerts.current.delete(a.dedupeKey)));
  }, [Math.floor(now.getTime() / 10_000), snap]); // eslint-disable-line react-hooks/exhaustive-deps

  const meta = snap.meta;
  const est = profit.flags.feesEstimated || profit.flags.productCostEstimated || profit.flags.shippingEstimated;
  const platformConnected = connection.status === "connected";
  const minutes = view.minutes;
  const labels = minutes.map((m) => hhmm(m.start, timezone));
  const num = (v: Decimal) => v.toNumber();
  const live = running && !idleStopped;
  const quietLong = live && velocity.secondsSinceLastSale !== null && velocity.secondsSinceLastSale > 300;
  const staffLine = meta.staff.length
    ? meta.staff.map((s) => `${s.name} (${s.role === "host" ? "presenter" : "assistant"})`).join(" · ")
    : "Default presenter + assistant";

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      {/* alerts / banners */}
      {meta.isTest && <Banner tone="info"><b>TEST SHOW</b> — every sale here is simulated, not real.</Banner>}
      {!meta.isTest && meta.platform !== "manual" && !platformConnected && (
        <Banner tone="warn">
          {PLATFORM_LABEL[meta.platform]} is <b>{connection.status.replace("_", " ")}</b> — sales aren&apos;t arriving automatically. Costs still count.
        </Banner>
      )}
      {(rtStatus === "offline" || refreshError) && (
        <Banner tone="neg">Live updates interrupted — figures may be behind (last refresh {fmtTime(lastRefresh.toISOString(), timezone)}).</Banner>
      )}
      {idleStopped && (
        <Banner tone="muted">
          No orders for {idleMinutes}+ minutes — this LIVE looks finished. Costs stopped at the last order ({fmtTime(new Date(lastOrderAt).toISOString(), timezone)}).
        </Banner>
      )}

      {/* header */}
      <header className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={idleStopped ? "ended" : meta.status} />
            <DataStatusBadge status={profit.dataStatus} />
          </div>
          <h1 className="mt-1.5 truncate text-lg font-semibold sm:text-2xl">{meta.title}</h1>
          <div className="mt-0.5 truncate text-xs text-muted">{staffLine}</div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted sm:justify-end">
          <span className="flex items-center gap-1.5">
            <Dot ok={rtStatus === "live"} warn={rtStatus === "connecting"} />
            {rtStatus === "live" ? "Live updates" : rtStatus}
          </span>
          {!meta.isTest && meta.platform !== "manual" && (
            <span>Synced {connection.lastSyncAt ? fmtTime(connection.lastSyncAt, timezone) : "never"}</span>
          )}
          <span>Last order {velocity.secondsSinceLastSale !== null ? `${fmtDuration(velocity.secondsSinceLastSale)} ago` : "—"}</span>
        </div>
      </header>

      {/* hero */}
      <section className="card overflow-hidden">
        <div className="grid gap-5 p-4 sm:p-6 lg:grid-cols-[1.1fr_2fr] lg:items-center">
          <div>
            <div className="label flex items-center gap-2">Net profit {est && <EstTag />}</div>
            <div className={`num mt-1 text-[44px] font-semibold leading-none tracking-tight sm:text-6xl ${sign(profit.operatingProfit)}`}>
              {formatUsd(profit.operatingProfit)}
            </div>
            <div className="mt-2 text-sm text-muted">
              {formatPct(profit.marginPct)} margin · {fmtDuration(profit.activeSeconds)}
              {meta.status === "paused" && <span className="text-warn"> · paused</span>}
            </div>
            {profit.reconciledProfit && (
              <div className="mt-1 text-sm">
                Final (TikTok settled): <span className={`num font-semibold ${sign(profit.reconciledProfit)}`}>{formatUsd(profit.reconciledProfit)}</span>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Profit / min" value={formatUsd(profit.profitPerMinute)} tone={sign(profit.profitPerMinute)} />
            <Stat label="Profit / hour" value={formatUsd(profit.profitPerHour)} tone={sign(profit.profitPerHour)} />
            <Stat label="Revenue" value={formatUsd(profit.netMerchandise)} />
            <Stat label="Expenses" value={formatUsd(profit.totalExpenses)} />
          </div>
        </div>
        <div className="grid grid-cols-2 border-t border-line sm:grid-cols-3 lg:grid-cols-6">
          <Strip
            label="Items sold"
            value={String(profit.itemsSold)}
            sub={[profit.giveawayUnits ? `+${profit.giveawayUnits} giveaway` : "", profit.unitsRefunded ? `${profit.unitsRefunded} refunded` : ""].filter(Boolean).join(" · ") || undefined}
          />
          <Strip label="Orders" value={String(profit.orders)} sub={profit.cancelledOrders ? `${profit.cancelledOrders} cancelled` : undefined} />
          <Strip label={profit.avgBasis === "auction" ? "Avg auction order" : "Avg order"} value={formatUsd(profit.avgOrderValue)} sub="product only · no giveaways" />
          <Strip label={profit.avgBasis === "auction" ? "Avg auction price" : "Avg price / item"} value={formatUsd(profit.avgSellingPrice)} sub={profit.avgBasis === "auction" ? "auction items only" : "giveaways excluded"} />
          <Strip label="This minute" value={formatUsd(stats.currentMinuteProfit)} tone={sign(stats.currentMinuteProfit)} />
          <Strip label="Since last sale" value={fmtDuration(velocity.secondsSinceLastSale)} tone={quietLong ? "text-warn" : "text-ink"} />
        </div>
      </section>

      <Notifications showId={showId} timezone={timezone} />

      <MoneyIn profit={profit} />

      {/* minute performance chips: scroll sideways on a phone */}
      <section className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex min-w-max gap-2 sm:grid sm:min-w-0 sm:grid-cols-3 lg:grid-cols-6">
          <Chip label="Last 5 min revenue" value={formatUsd(stats.rolling5Revenue)} />
          <Chip label="Last 10 min profit" value={formatUsd(stats.rolling10Profit)} tone={sign(stats.rolling10Profit)} />
          <Chip label="Avg revenue / min" value={formatUsd(stats.avgRevenuePerMinute)} />
          <Chip label="Best minute" value={stats.bestMinute ? formatUsd(stats.bestMinute.profit) : "—"} sub={stats.bestMinute ? hhmm(stats.bestMinute.start, timezone) : undefined} tone="text-pos" />
          <Chip label="Worst minute" value={stats.worstMinute ? formatUsd(stats.worstMinute.profit) : "—"} sub={stats.worstMinute ? hhmm(stats.worstMinute.start, timezone) : undefined} tone={sign(stats.worstMinute?.profit ?? null)} />
          <Chip label="Best 15 minutes" value={stats.best15 ? formatUsd(stats.best15.profit) : "—"} sub={stats.best15 ? `from ${hhmm(stats.best15.start, timezone)}` : undefined} tone={sign(stats.best15?.profit ?? null)} />
        </div>
      </section>

      {/* charts */}
      <section className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Profit by minute" hint="Red = a minute that lost money (hourly costs keep running).">
          <BarChart labels={labels} values={minutes.map((m) => num(m.profit))} format="money" color="#34d399" highlight={stats.best15 ? [stats.best15.startIndex, stats.best15.endIndex] : undefined} />
        </ChartCard>
        <ChartCard title="Cumulative through the LIVE">
          <LineChart
            labels={labels}
            series={[
              { name: "Revenue", color: "#d9b26b", values: minutes.map((m) => num(m.cumulativeRevenue)) },
              { name: "Expenses", color: "#f87171", values: minutes.map((m) => num(m.cumulativeExpenses)) },
              { name: "Profit", color: "#34d399", values: minutes.map((m) => num(m.cumulativeProfit)) },
            ]}
          />
        </ChartCard>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1fr_1.3fr]">
        <CostBreakdown profit={profit} />
        <RecentSales snap={snap} timezone={timezone} />
      </section>

      <details className="card group p-0">
        <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-sm text-muted hover:text-ink">
          More detail: revenue & units by minute, fees, shipping
          <span className="transition group-open:rotate-180">⌄</span>
        </summary>
        <div className="grid gap-4 border-t border-line p-4 xl:grid-cols-3">
          <div>
            <div className="label mb-2">Revenue by minute</div>
            <BarChart labels={labels} values={minutes.map((m) => num(m.revenue))} format="money" />
          </div>
          <div>
            <div className="label mb-2">Units sold by minute</div>
            <BarChart labels={labels} values={minutes.map((m) => m.units)} unit="items" color="#60a5fa" />
          </div>
          <ShippingAndFees profit={profit} />
        </div>
      </details>

      <Flags profit={profit} outOfOrder={velocity.outOfOrderEvents} />
    </div>
  );
}

function Banner({ tone, children }: { tone: "info" | "warn" | "neg" | "muted"; children: React.ReactNode }) {
  const cls = {
    info: "border-info/40 bg-info/10 text-info",
    warn: "border-warn/40 bg-warn/10 text-warn",
    neg: "border-neg/40 bg-neg/10 text-neg",
    muted: "border-line bg-panel-2 text-muted",
  }[tone];
  return <div className={`rounded-lg border px-4 py-2.5 text-sm ${cls}`}>{children}</div>;
}

function Dot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return <span className={`h-2 w-2 rounded-full ${ok ? "bg-pos" : warn ? "bg-warn" : "bg-neg"}`} />;
}

function Stat({ label, value, tone = "text-ink" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl bg-panel-2/60 px-3 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</div>
      <div className={`num mt-1 text-xl font-semibold sm:text-2xl ${tone}`}>{value}</div>
    </div>
  );
}

function Strip({ label, value, sub, tone = "text-ink" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="border-b border-r border-line/70 px-4 py-3 last:border-r-0 lg:border-b-0">
      <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`num mt-0.5 text-lg font-semibold ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-faint">{sub}</div>}
    </div>
  );
}

function Chip({ label, value, tone = "text-ink", sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div className="w-[150px] shrink-0 rounded-xl border border-line/70 bg-panel/60 px-3 py-2.5 sm:w-auto">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted">{label}</div>
      <div className={`num mt-1 text-base font-semibold ${tone}`}>{value}</div>
      {sub && <div className="num text-[11px] text-faint">{sub}</div>}
    </div>
  );
}

function ChartCard({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="card p-4 sm:p-5">
      <div className="label mb-1">{title}</div>
      {hint && <div className="mb-2 text-xs text-faint">{hint}</div>}
      {children}
    </div>
  );
}

function RecentSales({ snap, timezone }: { snap: ShowSnapshot; timezone: string }) {
  return (
    <div className="card p-4 sm:p-5">
      <div className="label mb-2">Recent sales</div>
      {snap.recent.length === 0 && <div className="py-6 text-center text-sm text-faint">No sales yet</div>}
      {snap.recent.length > 0 && (
        <div className="mb-1 grid grid-cols-[58px_1fr_56px_60px] gap-2 text-[10px] sm:grid-cols-[64px_1fr_64px_56px_64px] uppercase tracking-wider text-faint">
          <span>Time</span>
          <span>Items</span>
          <span className="text-right">Product</span>
          <span className="hidden text-right sm:block">Ship</span>
          <span className="text-right">Paid</span>
        </div>
      )}
      <ul className="max-h-[420px] divide-y divide-line/60 overflow-y-auto">
        {snap.recent.map((r) => {
          const cancelled = r.status === "cancelled";
          const paid = d(r.amount).plus(r.shipping).toFixed(2);
          return (
            <li key={r.id} className={`grid grid-cols-[58px_1fr_56px_60px] items-center gap-2 py-2 text-sm sm:grid-cols-[64px_1fr_64px_56px_64px] ${cancelled ? "text-faint line-through" : ""}`}>
              <span className="num whitespace-nowrap text-[11px] text-muted sm:text-xs">{hhmm(r.at, timezone)}</span>
              <a href={`/orders/${r.id}`} className="min-w-0 truncate hover:text-gold" title={`TikTok order ${r.externalId}`}>
                {r.units > 1 && <span className="text-gold">{r.units}× </span>}
                {r.title}
                {Number(r.refunded) > 0 && <span className="ml-1 text-[10px] text-warn">{`refunded $${r.refunded}`}</span>}
              </a>
              <span className="num text-right">{`$${r.amount}`}</span>
              <span className="num hidden text-right text-muted sm:block">{`$${r.shipping}`}</span>
              <span className="num text-right">{`$${paid}`}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}


