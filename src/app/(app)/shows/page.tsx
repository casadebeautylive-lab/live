import Link from "next/link";
import { currentUser, supabaseAdmin, supabaseServer } from "@/lib/supabase/clients";
import { sweepIdleShows } from "@/lib/lifecycle";
import { getTimezone } from "@/lib/data/context";
import { loadShowSnapshot, type ShowSnapshot } from "@/lib/data/shows";
import { computeProfit } from "@/lib/engine/profit";
import { normalizeCosts } from "@/lib/engine/defaults";
import { EXPENSE_CATEGORIES } from "@/lib/engine/types";
import { Decimal, formatUsd } from "@/lib/engine/money";
import { fmtDuration, fmtTime, PLATFORM_LABEL } from "@/lib/format";
import { ActionForm } from "@/components/ActionForm";
import { PageHeader, StatusPill, tone } from "@/components/ui";
import {
  addExpense,
  addShift,
  deleteExpense,
  endShift,
  endShow,
  goLive,
  pauseShow,
  removeShift,
  resumeShow,
  simulateAdjustment,
  simulateSales,
  startShow,
} from "./actions";

export default async function ShowsPage() {
  await sweepIdleShows(supabaseAdmin());
  const sb = await supabaseServer();
  const user = await currentUser();
  const tz = await getTimezone(sb);
  const [{ data: running }, { data: scheduled }, { data: recent }, { data: staff }, { data: profile }] = await Promise.all([
    sb.from("live_shows").select("id").in("status", ["live", "paused"]).order("started_at", { ascending: false }),
    sb.from("live_shows").select("id, title, platform, is_test, scheduled_start, scheduled_end").eq("status", "scheduled").order("scheduled_start"),
    sb
      .from("live_shows")
      .select("id, title, platform, is_test, started_at, ended_at, status, detection")
      .not("status", "in", "(live,paused,scheduled)")
      .order("started_at", { ascending: false })
      .limit(10),
    sb.from("staff").select("id, name, role").eq("active", true).order("name"),
    sb.from("cost_profiles").select("hourly_expenses").eq("platform", "tiktok").eq("is_active", true).maybeSingle(),
  ]);
  const hosts = (staff ?? []).filter((s) => s.role === "host");
  const assistants = (staff ?? []).filter((s) => s.role === "assistant");
  const snaps = (await Promise.all((running ?? []).map((r) => loadShowSnapshot(sb, r.id)))).filter((s): s is ShowSnapshot => s !== null);
  const now = new Date();
  const canWrite = user?.canWrite ?? false;
  const defaultHourly = (profile?.hourly_expenses as any[] | undefined)?.[0]?.perHour ?? "30.00";
  const todayTitle = `Jewelry LIVE ${new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(now)}`;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Shows" sub="Run, schedule and staff your LIVE shows">
        <Link href="/history" className="btn">LIVE history</Link>
      </PageHeader>

      {snaps.map((snap) => (
        <RunningShow key={snap.meta.id} snap={snap} tz={tz} now={now} canWrite={canWrite} hosts={hosts} assistants={assistants} />
      ))}

      {(scheduled ?? []).length > 0 && (
        <section className="card mb-6 p-5">
          <div className="label mb-3">Scheduled</div>
          <ul className="divide-y divide-line/60">
            {(scheduled ?? []).map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <StatusPill status="scheduled" />
                <span className="font-medium">{s.is_test && <span className="text-info">TEST · </span>}{s.title}</span>
                <span className="text-muted">
                  {PLATFORM_LABEL[s.platform]} · {fmtTime(s.scheduled_start, tz, true)}
                  {s.scheduled_end ? ` – ${fmtTime(s.scheduled_end, tz)}` : ""}
                </span>
                {canWrite && (
                  <ActionForm action={goLive} className="ml-auto">
                    <input type="hidden" name="showId" value={s.id} />
                    <button className="btn-primary">Go LIVE now</button>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {canWrite && (
        <section className="card mb-8 p-5">
          <h2 className="mb-1 font-semibold">Start or schedule a show</h2>
          <p className="mb-4 text-sm text-muted">
            With TikTok Shop connected, LIVEs open automatically from their first order. Start one here to count hourly costs from the very first
            minute, or schedule it ahead. Cost rules are frozen onto the show when it starts.
          </p>
          <ActionForm action={startShow} className="grid gap-3 md:grid-cols-2">
            <Field label="Title">
              <input name="title" required className="input" defaultValue={todayTitle} />
            </Field>
            <Field label="Platform">
              <select name="platform" className="input">
                <option value="tiktok">TikTok Shop</option>
                <option value="whatnot">Whatnot</option>
                <option value="manual">Manual / other</option>
              </select>
            </Field>
            <Field label="Presenter">
              <select name="hostId" className="input">
                <option value="">Default presenter ($1.00 / item unless changed in Settings)</option>
                {hosts.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
            </Field>
            <Field label="Assistant">
              <select name="assistantId" className="input">
                <option value="">Default assistant ($20 / hour unless changed in Settings)</option>
                {assistants.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                <option value="none">No assistant this show</option>
              </select>
            </Field>
            <Field label="Giveaways / misc. $ per hour (this show)">
              <input name="giveawaysPerHour" inputMode="decimal" className="input" placeholder={`Default $${defaultHourly}`} />
            </Field>
            <Field label="Schedule for later (optional)">
              <div className="flex gap-2">
                <input type="datetime-local" name="scheduledStart" className="input" aria-label="Scheduled start" />
                <input type="datetime-local" name="scheduledEnd" className="input" aria-label="Scheduled end" />
              </div>
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="isTest" className="h-4 w-4 accent-[#60a5fa]" />
              Test show (simulated data only, never mixed with real orders)
            </label>
            <div className="md:col-span-2">
              <button className="btn-primary">Start / schedule show</button>
              <span className="ml-3 text-xs text-faint">Times are {tz.replace("_", " ")}.</span>
            </div>
          </ActionForm>
        </section>
      )}

      <h2 className="label mb-2">Recent shows</h2>
      <div className="card overflow-x-auto">
        <table className="table">
          <tbody>
            {(recent ?? []).map((s) => (
              <tr key={s.id}>
                <td>
                  <Link href={`/shows/${s.id}`} className="hover:text-gold">
                    {s.is_test && <span className="text-info">TEST · </span>}
                    {s.title}
                  </Link>
                  {s.detection === "platform" && <span className="ml-2 text-xs text-faint">auto-detected</span>}
                </td>
                <td><StatusPill status={s.status} /></td>
                <td className="text-muted">{PLATFORM_LABEL[s.platform]}</td>
                <td className="text-muted">{fmtTime(s.started_at, tz, true)}</td>
              </tr>
            ))}
            {!recent?.length && (
              <tr><td className="py-6 text-center text-faint">No shows yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}

function RunningShow({
  snap,
  tz,
  now,
  canWrite,
  hosts,
  assistants,
}: {
  snap: ShowSnapshot;
  tz: string;
  now: Date;
  canWrite: boolean;
  hosts: { id: string; name: string }[];
  assistants: { id: string; name: string }[];
}) {
  const m = computeProfit(snap.input, now);
  const meta = snap.meta;
  const n = normalizeCosts(snap.input.costs);
  return (
    <section className="card mb-6 p-5">
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <div className="label">
            {meta.isTest && <span className="text-info">TEST · </span>}
            {PLATFORM_LABEL[meta.platform]} · started {fmtTime(meta.startedAt, tz)}
            {meta.detection === "platform" && " · auto-detected"}
          </div>
          <h2 className="text-lg font-semibold">{meta.title}</h2>
          <div className="mt-1 text-sm text-muted">
            <StatusPill status={meta.status} /> {fmtDuration(m.activeSeconds)} · {m.itemsSold} items · profit{" "}
            <span className={tone(m.operatingProfit)}>{formatUsd(m.operatingProfit)}</span> · {formatUsd(m.profitPerMinute)}/min
          </div>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Link href={`/live?show=${meta.id}`} className="btn">Live dashboard</Link>
          {canWrite && (
            <>
              <ActionForm action={meta.status === "paused" ? resumeShow : pauseShow}>
                <input type="hidden" name="showId" value={meta.id} />
                <button className="btn">{meta.status === "paused" ? "Resume cost clock" : "Pause cost clock"}</button>
              </ActionForm>
              <ActionForm action={endShow} confirm="End this show? Hourly costs stop and the live estimate is saved for later comparison.">
                <input type="hidden" name="showId" value={meta.id} />
                <button className="btn-danger">End show</button>
              </ActionForm>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-5 border-t border-line pt-4 md:grid-cols-2">
        <div>
          <div className="label mb-2">Staff on this show</div>
          <ul className="mb-3 space-y-1.5 text-sm">
            {meta.staff.length === 0 && (
              <li className="text-muted">
                Default presenter (${n.presenter.perUnit}/item) and assistant (${n.assistant.perHour}/h) for the whole show
              </li>
            )}
            {meta.staff.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2">
                <span className={s.leftAt ? "text-faint" : ""}>{s.name}</span>
                <span className="text-xs text-muted">{s.role === "host" ? "presenter" : "assistant"}</span>
                <span className="text-xs text-faint">
                  {fmtTime(s.joinedAt ?? meta.startedAt, tz)} – {s.leftAt ? fmtTime(s.leftAt, tz) : "now"}
                </span>
                {canWrite && !s.leftAt && (
                  <ActionForm action={endShift} confirm={`${s.name} leaves now?`} className="ml-auto">
                    <input type="hidden" name="shiftId" value={s.id} />
                    <button className="text-xs text-muted hover:text-ink">Left now</button>
                  </ActionForm>
                )}
                {canWrite && s.leftAt && (
                  <ActionForm action={removeShift} confirm="Remove this shift entirely?" className="ml-auto">
                    <input type="hidden" name="shiftId" value={s.id} />
                    <button className="text-xs text-faint hover:text-neg">Remove</button>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
          {canWrite && (
            <ActionForm action={addShift} className="flex flex-wrap gap-2">
              <input type="hidden" name="showId" value={meta.id} />
              <select name="role" className="input w-auto">
                <option value="host">Presenter</option>
                <option value="assistant">Assistant</option>
              </select>
              <select name="staffId" className="input w-auto min-w-0 flex-1">
                <option value="">Default (show rates)</option>
                {[...hosts, ...assistants].map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
              <button className="btn">Joins now</button>
            </ActionForm>
          )}
        </div>

        <div>
          <div className="label mb-2">Expenses and giveaways</div>
          {canWrite && (
            <ActionForm action={addExpense} resetOnSuccess className="flex flex-wrap gap-2">
              <input type="hidden" name="showId" value={meta.id} />
              <select name="category" className="input w-auto">
                {EXPENSE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
              <input name="description" placeholder="What" className="input min-w-0 flex-1" required />
              <input name="amount" placeholder="0.00" inputMode="decimal" className="input w-24" required />
              <button className="btn-primary">Add</button>
            </ActionForm>
          )}
          <ExpenseList showId={meta.id} canWrite={canWrite} />
          <p className="mt-2 text-xs text-faint">
            Hourly costs running: {n.hourlyExpenses.map((h) => `${h.label} $${h.perHour}/h`).join(", ") || "none"}. Change them for this show on its page.
          </p>
          {meta.isTest && canWrite && (
            <div className="mt-4 rounded-lg border border-info/30 bg-info/5 p-3">
              <div className="label mb-2 text-info">Simulated test events</div>
              <div className="flex flex-wrap gap-2">
                {[1, 5, 20].map((c) => (
                  <ActionForm key={c} action={simulateSales}>
                    <input type="hidden" name="showId" value={meta.id} />
                    <input type="hidden" name="count" value={c} />
                    <button className="btn">+{c} sale{c > 1 ? "s" : ""}</button>
                  </ActionForm>
                ))}
                <ActionForm action={simulateAdjustment}>
                  <input type="hidden" name="showId" value={meta.id} />
                  <input type="hidden" name="kind" value="refund" />
                  <button className="btn">Refund last</button>
                </ActionForm>
                <ActionForm action={simulateAdjustment}>
                  <input type="hidden" name="showId" value={meta.id} />
                  <input type="hidden" name="kind" value="cancel" />
                  <button className="btn">Cancel last</button>
                </ActionForm>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

async function ExpenseList({ showId, canWrite }: { showId: string; canWrite: boolean }) {
  const sb = await supabaseServer();
  const { data } = await sb.from("show_expenses").select("id, category, kind, description, amount").eq("show_id", showId).order("incurred_at");
  if (!data?.length) return null;
  const label = (c: string | null, k: string) => EXPENSE_CATEGORIES.find((x) => x.id === c)?.label ?? (k === "giveaway" ? "Giveaways" : "Other");
  return (
    <ul className="mt-3 space-y-1 text-sm">
      {data.map((e) => (
        <li key={e.id} className="flex items-center gap-2">
          <span className="text-muted">{label(e.category, e.kind)}</span>
          <span className="flex-1 truncate">{e.description}</span>
          <span className="num">{formatUsd(new Decimal(e.amount))}</span>
          {canWrite && (
            <ActionForm action={deleteExpense} confirm="Remove this expense?">
              <input type="hidden" name="expenseId" value={e.id} />
              <button className="text-xs text-faint hover:text-neg" aria-label="Remove">✕</button>
            </ActionForm>
          )}
        </li>
      ))}
    </ul>
  );
}
