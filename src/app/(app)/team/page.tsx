import Link from "next/link";
import { currentUser, supabaseServer } from "@/lib/supabase/clients";
import { getTimezone } from "@/lib/data/context";
import { loadShowsBulk } from "@/lib/data/shows";
import { computeProfit } from "@/lib/engine/profit";
import { resolveRange, type RangeKey } from "@/lib/dates";
import { div, formatUsd, Decimal, ZERO } from "@/lib/engine/money";
import { fmtTime } from "@/lib/format";
import { ActionForm } from "@/components/ActionForm";
import { Empty, Kpi, PageHeader, PeriodFilter, tone } from "@/components/ui";
import { deactivateStaff, saveStaff } from "./actions";

type SP = { range?: RangeKey; from?: string; to?: string; role?: string; test?: string; sort?: string; dir?: string };

type Person = {
  key: string;
  label: string;
  role: "host" | "assistant";
  generic: boolean;
  showIds: Set<string>;
  minutes: number;
  sales: Decimal;
  units: number;
  comp: Decimal;
  profitShare: Decimal;
  best: { id: string; title: string; startedAt: string; profit: Decimal } | null;
};

type Row = Person & {
  shows: number;
  hours: Decimal;
  revenuePerHour: Decimal | null;
  profitPerHour: Decimal | null;
  profitPerMinute: Decimal | null;
  contribution: Decimal;
  asp: Decimal | null;
  unitsPerHour: Decimal | null;
};

const GENERIC = new Set(["Presenter", "Assistant"]);

const COLUMNS: { key: string; label: string; get: (r: Row) => Decimal | number | null }[] = [
  { key: "shows", label: "Shows", get: (r) => r.shows },
  { key: "hours", label: "Hours", get: (r) => r.hours },
  { key: "sales", label: "Sales on shift", get: (r) => r.sales },
  { key: "units", label: "Units", get: (r) => r.units },
  { key: "rph", label: "Revenue/h", get: (r) => r.revenuePerHour },
  { key: "uph", label: "Units/h", get: (r) => r.unitsPerHour },
  { key: "asp", label: "Avg price", get: (r) => r.asp },
  { key: "comp", label: "Pay earned", get: (r) => r.comp },
  { key: "profit", label: "Show profit (after all pay)", get: (r) => r.profitShare },
  { key: "pph", label: "Profit/h", get: (r) => r.profitPerHour },
  { key: "ppm", label: "Profit/min", get: (r) => r.profitPerMinute },
  { key: "contrib", label: "Contribution before own pay", get: (r) => r.contribution },
];

const num = (v: Decimal | number | null) => (v === null ? null : typeof v === "number" ? new Decimal(v) : v);
const pctIn = (v: unknown) => (v === null || v === undefined ? "" : new Decimal(String(v)).times(100).toDecimalPlaces(4).toString());
const m2 = (v: unknown) => (v === null || v === undefined ? "" : new Decimal(String(v)).toDecimalPlaces(4).toString());

export default async function TeamPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const sb = await supabaseServer();
  const [tz, user] = await Promise.all([getTimezone(sb), currentUser()]);
  const canWrite = !!user?.canWrite;
  const key: RangeKey = sp.range ?? "30d";
  const range = resolveRange(tz, key, sp.from, sp.to);
  const includeTest = sp.test === "1";
  const roleFilter = sp.role === "host" || sp.role === "assistant" ? sp.role : "";

  let q = sb
    .from("live_shows")
    .select("*")
    .gte("started_at", range.from.toISOString())
    .lt("started_at", range.to.toISOString())
    .neq("status", "scheduled")
    .order("started_at", { ascending: false })
    .limit(1000);
  if (!includeTest) q = q.eq("is_test", false);
  const [{ data: shows }, { data: staffRows }] = await Promise.all([q, sb.from("staff").select("*").order("active", { ascending: false }).order("name")]);
  const bulk = await loadShowsBulk(sb, shows ?? []);
  const now = new Date();

  // ---- aggregate per person ----
  const people = new Map<string, Person>();
  let periodProfit = ZERO;
  let periodPay = ZERO;
  for (const { meta, input } of bulk) {
    const p = computeProfit(input, now);
    periodProfit = periodProfit.plus(p.operatingProfit);
    // Show profit is split among people of the same role by their share of on-shift minutes.
    const roleMinutes = { host: 0, assistant: 0 };
    const roleCount = { host: 0, assistant: 0 };
    for (const s of p.labor.byStaff) {
      roleMinutes[s.role] += s.minutes;
      roleCount[s.role]++;
    }
    for (const s of p.labor.byStaff) {
      periodPay = periodPay.plus(s.total);
      const generic = s.staffId === null && GENERIC.has(s.name);
      const k = s.staffId ?? `name:${s.role}:${s.name}`;
      const label = generic ? `Default ${s.role === "host" ? "presenter" : "assistant"} (unnamed)` : s.name;
      const person =
        people.get(k) ??
        ({ key: k, label, role: s.role, generic, showIds: new Set(), minutes: 0, sales: ZERO, units: 0, comp: ZERO, profitShare: ZERO, best: null } as Person);
      const share = roleMinutes[s.role] > 0 ? new Decimal(s.minutes).div(roleMinutes[s.role]) : new Decimal(1).div(roleCount[s.role]);
      person.showIds.add(meta.id);
      person.minutes += s.minutes;
      person.sales = person.sales.plus(s.salesCredited);
      person.units += s.unitsCredited;
      person.comp = person.comp.plus(s.total);
      person.profitShare = person.profitShare.plus(p.operatingProfit.times(share));
      if (!person.best || p.operatingProfit.gt(person.best.profit)) person.best = { id: meta.id, title: meta.title, startedAt: meta.startedAt, profit: p.operatingProfit };
      people.set(k, person);
    }
  }

  const all: Row[] = [...people.values()].map((p) => {
    const hours = new Decimal(p.minutes).div(60);
    return {
      ...p,
      shows: p.showIds.size,
      hours,
      revenuePerHour: div(p.sales, hours),
      profitPerHour: div(p.profitShare, hours),
      profitPerMinute: div(p.profitShare, new Decimal(p.minutes)),
      contribution: p.profitShare.plus(p.comp),
      asp: p.units > 0 ? p.sales.div(p.units) : null,
      unitsPerHour: div(new Decimal(p.units), hours),
    };
  });
  const rows = all.filter((r) => !roleFilter || r.role === roleFilter);

  const sortCol = COLUMNS.find((c) => c.key === sp.sort) ?? COLUMNS.find((c) => c.key === "pph")!;
  const asc = sp.dir === "asc";
  rows.sort((a, b) => {
    const x = num(sortCol.get(a));
    const y = num(sortCol.get(b));
    if (x === null && y === null) return a.label.localeCompare(b.label);
    if (x === null) return 1; // nulls last
    if (y === null) return -1;
    return asc ? x.comparedTo(y) : y.comparedTo(x);
  });

  const hosts = all.filter((r) => r.role === "host").sort((a, b) => (b.profitPerHour ?? ZERO).comparedTo(a.profitPerHour ?? ZERO));
  const maxPph = hosts.reduce((m, r) => Decimal.max(m, r.profitPerHour?.abs() ?? ZERO), ZERO);

  const base: Record<string, string | undefined> = { range: sp.range, from: sp.from, to: sp.to, role: roleFilter || undefined, test: includeTest ? "1" : undefined, sort: sp.sort, dir: sp.dir };
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams(Object.entries({ ...base, ...patch }).filter(([, v]) => v) as [string, string][]);
    const s = p.toString();
    return s ? `/team?${s}` : "/team";
  };
  const totalHours = all.reduce((a, r) => a.plus(r.hours), ZERO);
  const totalUnits = all.filter((r) => r.role === "host").reduce((a, r) => a + r.units, 0);

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader title="Hosts & staff" sub={`${range.label} · ${bulk.length} shows${includeTest ? " · including test shows" : ""}`} />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <PeriodFilter path="/team" current={key} from={sp.from} to={sp.to} extra={{ role: base.role, test: base.test, sort: base.sort, dir: base.dir }} />
        <div className="ml-auto flex flex-wrap gap-2">
          {[["", "Everyone"], ["host", "Hosts"], ["assistant", "Assistants"]].map(([r, label]) => (
            <Link key={r || "all"} href={qs({ role: r || undefined })} className={roleFilter === r ? "btn-primary" : "btn"}>
              {label}
            </Link>
          ))}
          <Link href={qs({ test: includeTest ? undefined : "1" })} className="btn">
            {includeTest ? "Hide test shows" : "Show test shows"}
          </Link>
        </div>
      </div>

      <section className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Show profit (after all pay)" value={formatUsd(periodProfit)} toneClass={tone(periodProfit)} est />
        <Kpi label="Staff pay earned" value={formatUsd(periodPay)} hint="Commission + hourly + flat, all staff" />
        <Kpi label="Staff hours on shift" value={totalHours.toFixed(1)} hint="Active LIVE time, pauses excluded" />
        <Kpi label="Units credited to hosts" value={String(totalUnits)} />
      </section>

      {!rows.length ? (
        <Empty>No staff shifts in this period.</Empty>
      ) : (
        <>
          <section className="card mb-5 overflow-x-auto">
            <table className="table min-w-[1300px]">
              <thead>
                <tr>
                  <th>Person</th>
                  {COLUMNS.map((c) => (
                    <th key={c.key} className="text-right">
                      <Link href={qs({ sort: c.key, dir: sortCol.key === c.key && !asc ? "asc" : undefined })} className={sortCol.key === c.key ? "text-gold" : "hover:text-ink"}>
                        {c.label}
                        {sortCol.key === c.key ? (asc ? " ↑" : " ↓") : ""}
                      </Link>
                    </th>
                  ))}
                  <th>Best show</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td className="min-w-[160px]">
                      <div className={r.generic ? "text-muted" : ""}>{r.label}</div>
                      <div className="text-xs capitalize text-faint">{r.role}</div>
                    </td>
                    <td className="num text-right">{r.shows}</td>
                    <td className="num text-right">{r.hours.toFixed(1)}</td>
                    <td className="num text-right">{formatUsd(r.sales)}</td>
                    <td className="num text-right">{r.units}</td>
                    <td className="num text-right">{formatUsd(r.revenuePerHour)}</td>
                    <td className="num text-right">{r.unitsPerHour?.toFixed(1) ?? "—"}</td>
                    <td className="num text-right">{formatUsd(r.asp)}</td>
                    <td className="num text-right">{formatUsd(r.comp)}</td>
                    <td className={`num text-right ${tone(r.profitShare)}`}>{formatUsd(r.profitShare)}</td>
                    <td className={`num text-right ${tone(r.profitPerHour)}`}>{formatUsd(r.profitPerHour)}</td>
                    <td className={`num text-right ${tone(r.profitPerMinute)}`}>{formatUsd(r.profitPerMinute)}</td>
                    <td className={`num text-right ${tone(r.contribution)}`}>{formatUsd(r.contribution)}</td>
                    <td className="min-w-[180px]">
                      {r.best ? (
                        <Link href={`/shows/${r.best.id}`} className="hover:text-gold">
                          {r.best.title}
                          <div className="text-xs text-faint">
                            {fmtTime(r.best.startedAt, tz, true)} · <span className={tone(r.best.profit)}>{formatUsd(r.best.profit)}</span>
                          </div>
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <p className="-mt-3 mb-5 text-xs text-faint">
            Show profit is the shows&apos; estimated operating profit (after product cost, fees, expenses and all staff pay), split among people of the same role by their share
            of on-shift minutes. &ldquo;Contribution before own pay&rdquo; adds the person&apos;s own pay back. Sales and units are those made while the person was on shift.
          </p>
        </>
      )}

      {hosts.length > 0 && (
        <section className="card mb-5 p-5">
          <div className="label mb-3">Profit per hour by host</div>
          <div className="space-y-2.5">
            {hosts.map((h) => {
              const w = maxPph.isZero() || !h.profitPerHour ? 0 : h.profitPerHour.abs().div(maxPph).times(100).toNumber();
              return (
                <div key={h.key} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm sm:grid-cols-[minmax(0,14rem)_1fr_auto]">
                  <div className={`truncate ${h.generic ? "text-muted" : ""}`} title={h.label}>{h.label}</div>
                  <div className="h-3 rounded bg-line">
                    <div className={`h-3 rounded ${h.profitPerHour?.isNegative() ? "bg-neg" : "bg-gold"}`} style={{ width: `${w}%` }} />
                  </div>
                  <div className={`num w-24 text-right ${tone(h.profitPerHour)}`}>{formatUsd(h.profitPerHour)}</div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="card p-5">
        <h2 className="label mb-2">Staff & pay rates</h2>
        <p className="mb-4 text-sm text-muted">
          Blank rates use the show defaults from <Link href="/settings" className="text-gold hover:underline">Settings</Link>. Rate changes apply to future shifts only — shifts
          already worked keep the rates frozen when the person was assigned. Per-unit and flat pay apply to hosts; assistants are paid hourly and/or a % of sales.
        </p>
        <div className="overflow-x-auto">
          <table className="table mb-4 min-w-[760px]">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th className="text-right">$/unit</th>
                <th className="text-right">$/hour</th>
                <th className="text-right">% of sales</th>
                <th className="text-right">Flat/show</th>
                <th>Status</th>
                {canWrite && <th></th>}
              </tr>
            </thead>
            <tbody>
              {(staffRows ?? []).map((s: any) => {
                const isHost = s.role === "host";
                const perHour = isHost ? s.host_per_hour : s.hourly_rate;
                const show = (v: unknown, applies = true) => (!applies ? "—" : v === null || v === undefined ? <span className="text-faint">default</span> : formatUsd(new Decimal(String(v))));
                return (
                  <tr key={s.id} className={s.active ? "" : "opacity-60"}>
                    <td>{s.name}</td>
                    <td className="capitalize text-muted">{s.role}</td>
                    <td className="num text-right">{show(s.host_per_item, isHost)}</td>
                    <td className="num text-right">{show(perHour)}</td>
                    <td className="num text-right">{s.percent_of_sales === null ? <span className="text-faint">default</span> : `${pctIn(s.percent_of_sales)}%`}</td>
                    <td className="num text-right">{show(s.host_flat_per_show, isHost)}</td>
                    <td className={s.active ? "text-pos" : "text-faint"}>{s.active ? "Active" : "Inactive"}</td>
                    {canWrite && (
                      <td className="min-w-[220px]">
                        <details>
                          <summary className="cursor-pointer text-xs text-muted hover:text-ink">Edit</summary>
                          <ActionForm action={saveStaff} className="mt-2 grid gap-2 sm:grid-cols-2" successText="Saved.">
                            <input type="hidden" name="id" value={s.id} />
                            <StaffFields s={s} />
                            <button className="btn-primary sm:col-span-2">Save</button>
                          </ActionForm>
                        </details>
                        <ActionForm
                          action={deactivateStaff}
                          className="mt-1"
                          confirm={s.active ? `Deactivate ${s.name}? Past shows keep their history.` : undefined}
                        >
                          <input type="hidden" name="id" value={s.id} />
                          {!s.active && <input type="hidden" name="reactivate" value="1" />}
                          <button className={`text-xs ${s.active ? "text-faint hover:text-neg" : "text-faint hover:text-pos"}`}>{s.active ? "Deactivate" : "Reactivate"}</button>
                        </ActionForm>
                      </td>
                    )}
                  </tr>
                );
              })}
              {!staffRows?.length && (
                <tr>
                  <td colSpan={canWrite ? 8 : 7} className="py-4 text-center text-faint">No staff yet</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {canWrite ? (
          <ActionForm action={saveStaff} resetOnSuccess successText="Staff member added." className="grid gap-2 sm:grid-cols-4 lg:grid-cols-7">
            <StaffFields />
            <button className="btn-primary">Add</button>
          </ActionForm>
        ) : (
          <p className="text-xs text-faint">Only owners and admins can change staff or pay rates.</p>
        )}
      </section>
    </div>
  );
}

function StaffFields({ s }: { s?: any }) {
  const perHour = s ? (s.role === "host" ? s.host_per_hour : s.hourly_rate) : null;
  return (
    <>
      <input name="name" placeholder="Name" defaultValue={s?.name ?? ""} className="input" required aria-label="Name" />
      <select name="role" defaultValue={s?.role ?? "host"} className="input" aria-label="Role">
        <option value="host">Host</option>
        <option value="assistant">Assistant</option>
      </select>
      <input name="perUnit" placeholder="$/unit (host)" defaultValue={m2(s?.host_per_item)} inputMode="decimal" className="input" aria-label="Per-unit commission" />
      <input name="perHour" placeholder="$/hour" defaultValue={m2(perHour)} inputMode="decimal" className="input" aria-label="Hourly rate" />
      <input name="percentOfSales" placeholder="% of sales" defaultValue={pctIn(s?.percent_of_sales)} inputMode="decimal" className="input" aria-label="Percent of sales" />
      <input name="flatPerShow" placeholder="Flat $/show (host)" defaultValue={m2(s?.host_flat_per_show)} inputMode="decimal" className="input" aria-label="Flat per show" />
    </>
  );
}
