import Link from "next/link";
import { currentUser, supabaseServer } from "@/lib/supabase/clients";
import { getTimezone } from "@/lib/data/context";
import { loadReport } from "@/lib/data/report";
import { resolveRange, utcToLocalInput, type RangeKey } from "@/lib/dates";
import { EXPENSE_CATEGORIES } from "@/lib/engine/types";
import { d, Decimal, formatUsd, ZERO } from "@/lib/engine/money";
import { fmtTime } from "@/lib/format";
import { ActionForm } from "@/components/ActionForm";
import { Empty, Kpi, PageHeader, PeriodFilter } from "@/components/ui";
import { addShowExpense, deleteShowExpense, updateShowExpense } from "./actions";

type SP = { range?: RangeKey; from?: string; to?: string; category?: string; test?: string };

const catLabel = (c: string | null, kind?: string) => EXPENSE_CATEGORIES.find((x) => x.id === c)?.label ?? (kind === "giveaway" ? "Giveaways" : "Other");

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const sb = await supabaseServer();
  const [tz, user] = await Promise.all([getTimezone(sb), currentUser()]);
  const canWrite = !!user?.canWrite;
  const key = sp.range ?? "30d";
  const range = resolveRange(tz, key, sp.from, sp.to);
  const includeTest = sp.test === "1";

  const rows = await loadReport(sb, { from: range.from, to: range.to, includeTest });
  const showIds = rows.map((r) => r.id);
  const [{ data: expenses }, { data: recentShows }] = await Promise.all([
    showIds.length
      ? (() => {
          let q = sb.from("show_expenses").select("*, users:created_by(email)").in("show_id", showIds.slice(0, 500)).order("incurred_at", { ascending: false });
          if (sp.category) q = q.eq("category", sp.category);
          return q;
        })()
      : Promise.resolve({ data: [] as any[] }),
    sb
      .from("live_shows")
      .select("id, title, started_at, is_test")
      .neq("status", "scheduled")
      .gte("started_at", new Date(Date.now() - 60 * 86_400_000).toISOString())
      .order("started_at", { ascending: false })
      .limit(100),
  ]);
  const showTitle = new Map(rows.map((r) => [r.id, r]));

  // totals by category — fixed (show_expenses) + hourly (accrued over LIVE time) + staff pay
  const fixedByCat = new Map<string, Decimal>();
  for (const e of expenses ?? []) fixedByCat.set(e.category ?? "other", (fixedByCat.get(e.category ?? "other") ?? ZERO).plus(d(e.amount)));
  const hourlyByLabel = new Map<string, Decimal>();
  for (const r of rows) for (const h of r.metrics.hourlyExpenseBreakdown) hourlyByLabel.set(h.label, (hourlyByLabel.get(h.label) ?? ZERO).plus(h.amount));
  const fixedTotal = [...fixedByCat.values()].reduce((a, v) => a.plus(v), ZERO);
  const hourlyTotal = [...hourlyByLabel.values()].reduce((a, v) => a.plus(v), ZERO);
  const staffTotal = rows.reduce((a, r) => a.plus(r.metrics.labor.presenter).plus(r.metrics.labor.assistant), ZERO);
  const product = rows.reduce((a, r) => a.plus(r.metrics.costs.product), ZERO);
  const fees = rows.reduce((a, r) => a.plus(r.metrics.platformFees), ZERO);
  const shipping = rows.reduce((a, r) => a.plus(r.metrics.netShippingCost), ZERO);
  const nowLocal = utcToLocalInput(new Date().toISOString(), tz);

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader title="Expenses" sub={`${range.label} · ${rows.length} shows`}>
        <a href={`/api/reports/expenses?${new URLSearchParams(Object.entries({ range: sp.range, from: sp.from, to: sp.to, test: sp.test }).filter(([, v]) => v) as [string, string][])}`} className="btn">Export CSV</a>
      </PageHeader>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <PeriodFilter path="/expenses" current={key} from={sp.from} to={sp.to} extra={{ category: sp.category, test: sp.test }} />
        <div className="ml-auto flex flex-wrap gap-2">
          <Link href={`/expenses?${new URLSearchParams(Object.entries({ ...sp, category: undefined }).filter(([, v]) => v) as [string, string][])}`} className={!sp.category ? "btn-primary" : "btn"}>All</Link>
          {EXPENSE_CATEGORIES.map((c) => (
            <Link key={c.id} href={`/expenses?${new URLSearchParams(Object.entries({ ...sp, category: c.id }).filter(([, v]) => v) as [string, string][])}`} className={sp.category === c.id ? "btn-primary" : "btn"}>{c.label}</Link>
          ))}
        </div>
      </div>

      <section className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Kpi label="Product cost" value={formatUsd(product)} />
        <Kpi label="Staff pay" value={formatUsd(staffTotal)} hint="Commission + hourly + flat" />
        <Kpi label="Hourly expenses" value={formatUsd(hourlyTotal)} hint="Prorated to actual LIVE time" />
        <Kpi label="Fixed show expenses" value={formatUsd(fixedTotal)} />
        <Kpi label="Platform fees" value={formatUsd(fees)} est={rows.some((r) => r.metrics.flags.feesEstimated)} />
        <Kpi label="Net shipping" value={formatUsd(shipping)} est={rows.some((r) => r.metrics.flags.shippingEstimated)} />
        <Kpi label="All expenses" value={formatUsd(rows.reduce((a, r) => a.plus(r.totalExpenses), ZERO))} />
      </section>

      <section className="mb-5 grid gap-4 lg:grid-cols-2">
        <div className="card p-5 text-sm">
          <div className="label mb-2">Fixed expenses by category</div>
          {EXPENSE_CATEGORIES.filter((c) => fixedByCat.get(c.id)).map((c) => (
            <div key={c.id} className="flex justify-between py-1"><span className="text-muted">{c.label}</span><span className="num">{formatUsd(fixedByCat.get(c.id)!)}</span></div>
          ))}
          {!fixedTotal.gt(0) && <div className="text-faint">None in this period</div>}
        </div>
        <div className="card p-5 text-sm">
          <div className="label mb-2">Hourly expenses accrued</div>
          {[...hourlyByLabel.entries()].map(([label, v]) => (
            <div key={label} className="flex justify-between py-1"><span className="text-muted">{label}</span><span className="num">{formatUsd(v)}</span></div>
          ))}
          {!hourlyByLabel.size && <div className="text-faint">None</div>}
          <p className="mt-2 text-xs text-faint">
            Hourly rates (e.g. giveaways $30/h) are set in <Link href="/settings" className="text-gold">Settings</Link> and can be changed per show on its page. They accrue every
            active minute, sales or not.
          </p>
        </div>
      </section>

      {canWrite && (
        <section className="card mb-5 p-5">
          <div className="label mb-3">Add an expense to a show</div>
          <ActionForm action={addShowExpense} resetOnSuccess successText="Added" className="grid gap-2 md:grid-cols-[2fr_1fr_2fr_1fr_1.4fr_auto]">
            <select name="showId" className="input" required aria-label="Show">
              {(recentShows ?? []).map((s) => <option key={s.id} value={s.id}>{s.is_test ? "TEST · " : ""}{s.title} · {fmtTime(s.started_at, tz, true)}</option>)}
            </select>
            <select name="category" className="input" aria-label="Category">
              {EXPENSE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <input name="description" placeholder="What" className="input" required />
            <input name="amount" placeholder="0.00" inputMode="decimal" className="input" required />
            <input type="datetime-local" name="at" defaultValue={nowLocal} className="input" aria-label="When" />
            <button className="btn-primary">Add</button>
          </ActionForm>
          <p className="mt-2 text-xs text-faint">The time places the expense in that minute of the show (times are {tz.replace("_", " ")}).</p>
        </section>
      )}

      {!(expenses ?? []).length ? (
        <Empty>No fixed expenses in this period.</Empty>
      ) : (
        <section className="card overflow-x-auto">
          <table className="table min-w-[900px]">
            <thead>
              <tr><th>When</th><th>Show</th><th>Category</th><th>Description</th><th className="text-right">Amount</th><th>Added by</th>{canWrite && <th></th>}</tr>
            </thead>
            <tbody>
              {(expenses ?? []).map((e: any) => {
                const s = showTitle.get(e.show_id);
                return (
                  <tr key={e.id}>
                    <td className="num whitespace-nowrap text-muted">{fmtTime(e.incurred_at, tz, true)}</td>
                    <td className="max-w-[200px] truncate"><Link href={`/shows/${e.show_id}`} className="hover:text-gold">{s?.title ?? "Show"}</Link></td>
                    <td>{catLabel(e.category, e.kind)}</td>
                    <td className="max-w-[260px] truncate">{e.description}</td>
                    <td className="num text-right">{formatUsd(d(e.amount))}</td>
                    <td className="text-xs text-muted">{e.users?.email ?? "—"}</td>
                    {canWrite && (
                      <td className="min-w-[200px]">
                        <details>
                          <summary className="cursor-pointer text-xs text-muted hover:text-ink">Edit</summary>
                          <ActionForm action={updateShowExpense} className="mt-2 grid gap-1.5" successText="Saved">
                            <input type="hidden" name="id" value={e.id} />
                            <select name="category" defaultValue={e.category ?? "other"} className="input py-1 text-xs">
                              {EXPENSE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                            </select>
                            <input name="description" defaultValue={e.description} className="input py-1 text-xs" />
                            <input name="amount" defaultValue={d(e.amount).toFixed(2)} inputMode="decimal" className="input py-1 text-xs" />
                            <button className="btn py-1 text-xs">Save</button>
                          </ActionForm>
                        </details>
                        <ActionForm action={deleteShowExpense} confirm="Delete this expense?" className="mt-1">
                          <input type="hidden" name="id" value={e.id} />
                          <button className="text-xs text-faint hover:text-neg">Delete</button>
                        </ActionForm>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
      <p className="mt-3 text-xs text-faint">Every add, edit and delete is recorded in the audit log.</p>
    </div>
  );
}
