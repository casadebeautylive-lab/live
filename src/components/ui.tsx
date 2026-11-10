import Link from "next/link";
import type { Decimal } from "@/lib/engine/money";
import type { DataStatus } from "@/lib/engine/profit";
import type { RangeKey } from "@/lib/dates";

/** Shared building blocks for every page. Server-safe (no hooks). */

export const tone = (v: Decimal | null | undefined) => (v === null || v === undefined ? "text-ink" : v.isNegative() ? "text-neg" : "text-pos");

export function PageHeader({ title, sub, children }: { title: string; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {sub && <div className="text-sm text-muted">{sub}</div>}
      </div>
      {children && <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function EstTag({ text = "estimated" }: { text?: string }) {
  return <span className="rounded border border-gold-dim/60 px-1.5 py-px text-[10px] font-medium normal-case tracking-normal text-gold">{text}</span>;
}

export function Kpi({ label, value, hint, toneClass = "text-ink", est, big }: { label: string; value: string; hint?: React.ReactNode; toneClass?: string; est?: boolean; big?: boolean }) {
  return (
    <div className="card p-4">
      <div className="label flex items-center gap-1.5 leading-tight">
        {label} {est && <EstTag />}
      </div>
      <div className={`num mt-2 font-semibold ${big ? "text-3xl" : "text-xl"} ${toneClass}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-faint">{hint}</div>}
    </div>
  );
}

const STATUS: Record<string, [string, string]> = {
  scheduled: ["Scheduled", "border-info/40 bg-info/10 text-info"],
  live: ["Active", "border-pos/40 bg-pos/10 text-pos"],
  paused: ["Paused", "border-warn/40 bg-warn/10 text-warn"],
  ended: ["Ended", "border-line bg-panel-2 text-muted"],
  awaiting_reconciliation: ["Awaiting reconciliation", "border-gold-dim/60 bg-gold/10 text-gold"],
  finalized: ["Finalized", "border-pos/30 bg-panel-2 text-pos"],
};

export function StatusPill({ status }: { status: string }) {
  const [label, cls] = STATUS[status] ?? [status, "border-line text-muted"];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${cls}`}>
      {status === "live" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-pos" />}
      {label}
    </span>
  );
}

const DATA: Record<DataStatus, [string, string, string]> = {
  live: ["Live estimate", "text-pos", "Updating as orders arrive. Fees and shipping are estimates."],
  estimated: ["Estimated", "text-gold", "No TikTok settlements yet — fees and shipping are estimates."],
  partially_reconciled: ["Partly reconciled", "text-info", "Some orders are settled; the rest are estimates."],
  finalized: ["Finalized", "text-pos", "Every order is settled with TikTok."],
};

export function DataStatusBadge({ status, detail }: { status: DataStatus; detail?: string }) {
  const [label, cls, hint] = DATA[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${cls}`} title={detail ?? hint}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

export const RANGE_OPTIONS: [RangeKey, string][] = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
];

/**
 * Period filter as plain links + a custom-range form (works without JS).
 * `extra` holds the other search params to preserve.
 */
export function PeriodFilter({ path, current, from, to, extra = {} }: { path: string; current: RangeKey; from?: string; to?: string; extra?: Record<string, string | undefined> }) {
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams(Object.entries({ ...extra, ...patch }).filter(([, v]) => v) as [string, string][]);
    const s = p.toString();
    return s ? `${path}?${s}` : path;
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {RANGE_OPTIONS.map(([k, label]) => (
        <Link key={k} href={qs({ range: k })} className={current === k ? "btn-primary" : "btn"}>
          {label}
        </Link>
      ))}
      <form className="flex flex-wrap items-center gap-2" action={path}>
        <input type="hidden" name="range" value="custom" />
        {Object.entries(extra).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
        <input type="date" name="from" defaultValue={from} className="input w-auto" aria-label="From" />
        <input type="date" name="to" defaultValue={to} className="input w-auto" aria-label="To" />
        <button className={current === "custom" ? "btn-primary" : "btn"}>Apply</button>
      </form>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="card px-5 py-12 text-center text-sm text-faint">{children}</div>;
}

export function Unavailable({ reason }: { reason: string }) {
  return (
    <span className="text-faint" title={reason}>
      Unavailable
    </span>
  );
}
