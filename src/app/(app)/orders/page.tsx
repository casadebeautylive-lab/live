import Link from "next/link";
import { currentUser, supabaseServer } from "@/lib/supabase/clients";
import { getTimezone } from "@/lib/data/context";
import { resolveRange, type RangeKey } from "@/lib/dates";
import { d, formatUsd } from "@/lib/engine/money";
import { fmtTime } from "@/lib/format";
import { ActionForm } from "@/components/ActionForm";
import { Empty, PageHeader, PeriodFilter } from "@/components/ui";
import {
  ATTRIBUTION_LABEL,
  candidateShows,
  customerLabel,
  loadFeeRules,
  loadShowsInRange,
  METHOD_LABEL,
  ORDER_SELECT,
  orderFees,
  orderMoney,
  type AttributionStatus,
} from "@/lib/data/orders";
import { assignOrderToShow, markNotLive } from "./actions";

type SP = { range?: RangeKey; from?: string; to?: string; show?: string; attr?: string; status?: string; q?: string; test?: string; page?: string };

const TABS: [string, string][] = [
  ["", "All"],
  ["needs_review", "Needs review"],
  ["unassigned", "Unassigned"],
  ["not_live", "Not from a LIVE"],
  ["assigned", "Assigned"],
];
const PAGE = 100;

export default async function OrdersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const sb = await supabaseServer();
  const [tz, user] = await Promise.all([getTimezone(sb), currentUser()]);
  const canWrite = !!user?.canWrite;
  const includeTest = sp.test === "1";
  const key = sp.range ?? "7d";
  const range = resolveRange(tz, key, sp.from, sp.to);
  const page = Math.max(0, Number(sp.page ?? 0) || 0);
  const search = (sp.q ?? "").trim();

  // default to the review queue when there is anything to review
  let attr = sp.attr;
  if (attr === undefined) {
    const { count } = await sb.from("orders").select("id", { count: "exact", head: true }).eq("attribution", "needs_review").eq("is_test", false);
    attr = (count ?? 0) > 0 && !sp.show && !search ? "needs_review" : "";
  }

  let q = sb.from("orders").select(ORDER_SELECT, { count: "exact" });
  if (search) q = q.ilike("external_order_id", `%${search.replace(/[%_]/g, "")}%`);
  else if (sp.show) q = q.eq("show_id", sp.show);
  else if (attr !== "needs_review") q = q.gte("created_at_platform", range.from.toISOString()).lt("created_at_platform", range.to.toISOString());
  if (attr) q = q.eq("attribution", attr);
  if (sp.status === "active" || sp.status === "cancelled") q = q.eq("status", sp.status);
  if (!includeTest) q = q.eq("is_test", false);
  const { data: orders, count } = await q.order("created_at_platform", { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);

  const [shows, rules, candidates, counts] = await Promise.all([
    loadShowsInRange(sb, range.from, range.to, includeTest),
    loadFeeRules(sb),
    candidateShows(sb, (orders ?? []).filter((o: any) => o.attribution === "needs_review" || o.attribution === "unassigned")),
    Promise.all(
      (["needs_review", "unassigned", "not_live"] as const).map(async (a) => {
        let c = sb.from("orders").select("id", { count: "exact", head: true }).eq("attribution", a);
        if (!includeTest) c = c.eq("is_test", false);
        return [a, (await c).count ?? 0] as const;
      }),
    ),
  ]);
  const countOf = Object.fromEntries(counts) as Record<string, number>;

  const base = { range: sp.range, from: sp.from, to: sp.to, show: sp.show, attr, status: sp.status, q: sp.q, test: sp.test };
  const qs = (patch: Partial<SP>) => {
    // keep attr even when "" (= "All"), so the page doesn't jump back to the review queue
    const p = new URLSearchParams(Object.entries({ ...base, page: undefined, ...patch }).filter(([k, v]) => v !== undefined && (v !== "" || k === "attr")) as [string, string][]);
    return `/orders?${p.toString()}`;
  };
  const total = count ?? 0;

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader title="Orders" sub={search ? `Search: ${search}` : sp.show ? "One show" : attr === "needs_review" ? "All orders needing review" : range.label}>
        <a href={`/api/reports/orders?${new URLSearchParams(Object.entries({ range: sp.range, from: sp.from, to: sp.to, show: sp.show, test: sp.test }).filter(([, v]) => v) as [string, string][])}`} className="btn">Export CSV</a>
        <Link href={qs({ test: includeTest ? undefined : "1" })} className="btn">{includeTest ? "Hide test data" : "Show test data"}</Link>
      </PageHeader>

      <div className="mb-3 flex flex-wrap gap-2">
        {TABS.map(([k, label]) => (
          <Link key={k || "all"} href={qs({ attr: k })} className={attr === k ? "btn-primary" : "btn"}>
            {label}
            {countOf[k] ? <span className={`num rounded-full px-1.5 text-[10px] ${k === "needs_review" ? "bg-warn/20 text-warn" : "bg-line text-muted"}`}>{countOf[k]}</span> : null}
          </Link>
        ))}
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <PeriodFilter path="/orders" current={key} from={sp.from} to={sp.to} extra={{ attr, status: sp.status, test: sp.test }} />
        <form action="/orders" className="ml-auto flex flex-wrap items-center gap-2">
          {Object.entries({ range: sp.range, from: sp.from, to: sp.to, test: sp.test, attr }).map(([k, v]) => (v !== undefined ? <input key={k} type="hidden" name={k} value={v} /> : null))}
          <select name="show" defaultValue={sp.show ?? ""} className="input w-auto max-w-[240px]" aria-label="Show">
            <option value="">All shows</option>
            {shows.map((s) => <option key={s.id} value={s.id}>{s.isTest ? "TEST · " : ""}{s.title} · {fmtTime(s.startedAt, tz, true)}</option>)}
          </select>
          <select name="status" defaultValue={sp.status ?? ""} className="input w-auto" aria-label="Status">
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <input name="q" defaultValue={sp.q} placeholder="TikTok order id" className="input w-44" />
          <button className="btn">Filter</button>
        </form>
      </div>

      {attr === "needs_review" && (orders ?? []).length > 0 && (
        <p className="mb-3 text-sm text-warn">
          These orders were not added to any show because the match was uncertain (overlapping show windows, or TikTok says the order wasn&apos;t placed in a LIVE but it
          fell inside one). Pick the right show, or mark it as not a LIVE order.
        </p>
      )}

      {!(orders ?? []).length ? (
        <Empty>{attr === "needs_review" ? "Nothing needs review." : "No orders match."}</Empty>
      ) : (
        <section className="card overflow-x-auto">
          <table className="table min-w-[1250px]">
            <thead>
              <tr>
                <th>Time</th>
                <th>TikTok order</th>
                <th>Customer</th>
                <th>Items</th>
                <th className="text-right">Product revenue</th>
                <th className="text-right">Customer shipping</th>
                <th className="text-right">Seller shipping</th>
                <th className="text-right">Platform fees</th>
                <th>Status</th>
                <th>LIVE show</th>
              </tr>
            </thead>
            <tbody>
              {(orders ?? []).map((o: any) => {
                const m = orderMoney(o);
                const fees = orderFees(o, m.net, rules);
                const [label, cls] = ATTRIBUTION_LABEL[o.attribution as AttributionStatus] ?? ["—", ""];
                const cands = candidates.get(o.id) ?? [];
                const cust = customerLabel(o);
                return (
                  <tr key={o.id} className={o.status === "cancelled" ? "text-faint" : ""}>
                    <td className="num whitespace-nowrap text-muted">{fmtTime(o.created_at_platform, tz, true)}</td>
                    <td>
                      <Link href={`/orders/${o.id}`} className="num hover:text-gold">{o.external_order_id}</Link>
                      {o.is_test && <div className="text-[11px] text-info">TEST</div>}
                    </td>
                    <td className="max-w-[140px] truncate">
                      {o.customers ? <Link href={`/customers/${o.customers.id}`} className="hover:text-gold">{o.customers.display_name || `Buyer …${String(o.customers.external_customer_id).slice(-6)}`}</Link> : <span className="text-faint">{cust ?? "Unavailable"}</span>}
                    </td>
                    <td className="max-w-[240px]">
                      <div className="truncate"><span className="num text-gold">{m.units}×</span> {m.titles.join(", ")}</div>
                    </td>
                    <td className="num text-right">{formatUsd(m.net)}{m.refunds.gt(0) && <div className="text-[11px] text-warn">−{formatUsd(m.refunds)} refunded</div>}</td>
                    <td className="num text-right">{formatUsd(d(o.customer_shipping))}</td>
                    <td className="num text-right">{o.seller_shipping_cost !== null ? formatUsd(d(o.seller_shipping_cost)) : <span className="text-faint">Pending</span>}</td>
                    <td className="num text-right">
                      {fees ? formatUsd(fees.amount) : "—"}
                      {fees?.estimated && <span className="ml-1 text-[10px] text-gold">est.</span>}
                    </td>
                    <td className="whitespace-nowrap text-xs">{o.status === "cancelled" ? <span className="text-neg">Cancelled</span> : <span className="text-muted">Active</span>}</td>
                    <td className="min-w-[220px]">
                      {o.live_shows ? (
                        <Link href={`/shows/${o.live_shows.id}`} className="hover:text-gold">
                          <div className="max-w-[220px] truncate">{o.live_shows.title}</div>
                          <div className="text-[11px] text-faint">{METHOD_LABEL[o.attribution_method] ?? ""}</div>
                        </Link>
                      ) : (
                        <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] ${cls}`} title={o.attribution_note ?? ""}>{label}</span>
                      )}
                      {canWrite && (o.attribution === "needs_review" || o.attribution === "unassigned") && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <ActionForm action={assignOrderToShow} className="flex gap-1.5">
                            <input type="hidden" name="orderId" value={o.id} />
                            <select name="showId" className="input w-[170px] py-1 text-xs" required defaultValue={cands[0]?.id ?? ""}>
                              <option value="" disabled>Pick a show</option>
                              {cands.map((s) => <option key={s.id} value={s.id}>{s.title} · {fmtTime(s.startedAt, tz, true)}</option>)}
                            </select>
                            <button className="btn px-2 py-1 text-xs">Assign</button>
                          </ActionForm>
                          <ActionForm action={markNotLive}>
                            <input type="hidden" name="orderId" value={o.id} />
                            <button className="btn px-2 py-1 text-xs">Not a LIVE order</button>
                          </ActionForm>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="flex items-center gap-3 px-4 py-3 text-sm text-muted">
            <span>{page * PAGE + 1}–{Math.min(total, page * PAGE + PAGE)} of {total}</span>
            {page > 0 && <Link href={`${qs({})}&page=${page - 1}`} className="btn ml-auto">← Newer</Link>}
            {(page + 1) * PAGE < total && <Link href={`${qs({})}&page=${page + 1}`} className={page > 0 ? "btn" : "btn ml-auto"}>Older →</Link>}
          </div>
        </section>
      )}
      <p className="mt-3 text-xs text-faint">
        Product revenue = item price × quantity − seller discounts − refunds, before shipping and tax. &ldquo;est.&rdquo; fees use the show&apos;s fee rule until TikTok reports the
        actual amount; seller shipping is pending until TikTok settles the order.
      </p>
    </div>
  );
}
