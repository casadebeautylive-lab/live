import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { currentUser, supabaseServer } from "@/lib/supabase/clients";
import { getTimezone } from "@/lib/data/context";
import { d, formatUsd } from "@/lib/engine/money";
import { fmtTime, PLATFORM_LABEL } from "@/lib/format";
import { ActionForm } from "@/components/ActionForm";
import { PageHeader } from "@/components/ui";
import { ATTRIBUTION_LABEL, candidateShows, loadFeeRules, METHOD_LABEL, ORDER_SELECT, orderFees, orderMoney, type AttributionStatus } from "@/lib/data/orders";
import { assignOrderToShow, markNotLive } from "../actions";

export default async function OrderDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const sb = await supabaseServer();
  const [tz, user, { data: o }] = await Promise.all([getTimezone(sb), currentUser(), sb.from("orders").select(ORDER_SELECT).eq("id", id).maybeSingle() as PromiseLike<{ data: any }>]);
  if (!o) notFound();
  const canWrite = !!user?.canWrite;

  const [{ data: txns }, { data: links }, { data: history }, rules, cands, { data: recentShows }] = await Promise.all([
    sb.from("finance_transactions").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    sb.from("package_orders").select("packages(id, external_package_id, status, carrier, tracking_number, label_cost, label_cost_source, reimbursement, package_orders(count))").eq("order_id", id),
    sb.from("order_show_attributions").select("*, live_shows(id, title), users:decided_by(email)").eq("order_id", id).order("created_at", { ascending: false }),
    loadFeeRules(sb),
    candidateShows(sb, [o]),
    sb.from("live_shows").select("id, title, started_at, is_test").eq("is_test", o.is_test).neq("status", "scheduled").order("started_at", { ascending: false }).limit(40),
  ]);
  const m = orderMoney(o);
  const fees = orderFees(o, m.net, rules);
  const [attrLabel, attrCls] = ATTRIBUTION_LABEL[o.attribution as AttributionStatus] ?? ["—", ""];
  const options = new Map<string, { id: string; title: string; startedAt: string }>();
  for (const s of cands.get(id) ?? []) options.set(s.id, { id: s.id, title: s.title, startedAt: s.startedAt });
  for (const s of recentShows ?? []) if (!options.has(s.id)) options.set(s.id, { id: s.id, title: s.title, startedAt: s.started_at });
  const pkgs = (links ?? []).map((l: any) => l.packages).filter(Boolean);
  const credit = d(o.customer_shipping).plus(d(o.platform_shipping_subsidy));

  return (
    <div className="mx-auto max-w-[1200px]">
      <div className="mb-2 text-sm"><Link href="/orders" className="text-muted hover:text-gold">← Orders</Link></div>
      <PageHeader
        title={`Order ${o.external_order_id}`}
        sub={
          <>
            {PLATFORM_LABEL[o.platform]} · created {fmtTime(o.created_at_platform, tz, true)}
            {o.paid_at && <> · paid {fmtTime(o.paid_at, tz, true)}</>} · received {fmtTime(o.received_at, tz, true)}
            {o.is_test && <span className="text-info"> · TEST</span>}
          </>
        }
      >
        <span className={`rounded-full border px-2.5 py-0.5 text-xs ${o.status === "cancelled" ? "border-neg/40 text-neg" : "border-line text-muted"}`}>
          {o.status === "cancelled" ? "Cancelled" : "Active"}{o.platform_status ? ` · ${o.platform_status}` : ""}
        </span>
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card overflow-x-auto p-5 lg:col-span-2">
          <div className="label mb-2">Line items</div>
          <table className="table">
            <thead><tr><th>Item</th><th>SKU</th><th className="text-right">Qty</th><th className="text-right">Unit price</th><th className="text-right">Seller discount</th><th className="text-right">Platform discount</th></tr></thead>
            <tbody>
              {(o.order_items ?? []).map((i: any) => (
                <tr key={i.id}>
                  <td>{i.title}</td>
                  <td className="font-mono text-xs text-muted">{i.sku ?? "—"}</td>
                  <td className="num text-right">{i.quantity}</td>
                  <td className="num text-right">{formatUsd(d(i.unit_price))}</td>
                  <td className="num text-right">{formatUsd(d(i.seller_discount))}</td>
                  <td className="num text-right text-muted">{formatUsd(d(i.platform_discount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(o.refunds ?? []).length > 0 && (
            <>
              <div className="label mb-2 mt-5">Refunds</div>
              <table className="table">
                <tbody>
                  {(o.refunds ?? []).map((r: any) => (
                    <tr key={r.id}>
                      <td className="num text-muted">{fmtTime(r.refunded_at, tz, true)}</td>
                      <td className="font-mono text-xs">{r.external_refund_id}</td>
                      <td className="num text-right">{r.quantity} unit{r.quantity === 1 ? "" : "s"}</td>
                      <td className="num text-right text-warn">−{formatUsd(d(r.amount))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>

        <section className="card p-5 text-sm">
          <div className="label mb-2">Money</div>
          <Line label="Product revenue" value={formatUsd(m.net)} strong />
          <Line label="Refunds" value={m.refunds.gt(0) ? `−${formatUsd(m.refunds)}` : "—"} />
          <Line label="Platform fees" value={fees ? `${formatUsd(fees.amount)}${fees.estimated ? " (est.)" : ""}` : "—"} />
          <Line label="Platform GMV (reported)" value={o.platform_gmv !== null ? formatUsd(d(o.platform_gmv)) : "Not reported"} />
          <Line label="Settlement" value={o.settlement_amount !== null ? formatUsd(d(o.settlement_amount)) : "Pending"} />
          <div className="my-2 border-t border-line" />
          <div className="label mb-1">Shipping</div>
          <Line label="Paid by customer (not revenue)" value={formatUsd(d(o.customer_shipping))} />
          <Line label="Platform shipping subsidy" value={o.platform_shipping_subsidy !== null ? formatUsd(d(o.platform_shipping_subsidy)) : "—"} />
          <Line label="Seller shipping charges" value={o.seller_shipping_cost !== null ? formatUsd(d(o.seller_shipping_cost)) : "Pending"} />
          <Line label="Net seller shipping cost" value={o.seller_shipping_cost !== null ? formatUsd(d(o.seller_shipping_cost).minus(credit)) : "Pending"} strong />
          <div className="my-2 border-t border-line" />
          <div className="label mb-1">Customer</div>
          {o.customers ? (
            <Link href={`/customers/${o.customers.id}`} className="hover:text-gold">
              {o.customers.display_name || "Name unavailable"} <span className="font-mono text-xs text-faint">{o.customers.external_customer_id}</span>
            </Link>
          ) : (
            <span className="text-faint">Unavailable — TikTok did not provide a buyer id</span>
          )}
        </section>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="card p-5 text-sm">
          <div className="label mb-2">LIVE show</div>
          {o.live_shows ? (
            <Link href={`/shows/${o.live_shows.id}`} className="text-base hover:text-gold">{o.live_shows.title}</Link>
          ) : (
            <span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs ${attrCls}`}>{attrLabel}</span>
          )}
          <div className="mt-1 text-xs text-muted">
            {o.attribution_method ? `Matched by: ${METHOD_LABEL[o.attribution_method]}` : ""}
            {o.attribution_note ? ` — ${o.attribution_note}` : ""}
          </div>
          <div className="mt-1 text-xs text-faint">TikTok LIVE id on the order: {o.live_room_id === null ? "not reported" : o.live_room_id === "" ? "none (not bought in a LIVE)" : o.live_room_id}</div>
          {canWrite && (
            <div className="mt-4 flex flex-wrap gap-2">
              <ActionForm action={assignOrderToShow} className="flex flex-wrap gap-2" successText="Saved">
                <input type="hidden" name="orderId" value={id} />
                <select name="showId" defaultValue={o.show_id ?? ""} className="input w-auto max-w-[280px]">
                  <option value="">No show (unassigned)</option>
                  {[...options.values()].map((s) => <option key={s.id} value={s.id}>{s.title} · {fmtTime(s.startedAt, tz, true)}</option>)}
                </select>
                <input name="note" placeholder="Reason (optional)" className="input w-48" />
                <button className="btn">Save</button>
              </ActionForm>
              {o.attribution !== "not_live" && (
                <ActionForm action={markNotLive} confirm="Remove this order from any show and mark it as not a LIVE order?">
                  <input type="hidden" name="orderId" value={id} />
                  <button className="btn">Not a LIVE order</button>
                </ActionForm>
              )}
            </div>
          )}
          <div className="label mb-2 mt-5">Attribution history</div>
          <ul className="space-y-1.5">
            {(history ?? []).map((h: any) => (
              <li key={h.id} className="text-xs">
                <span className="num text-muted">{fmtTime(h.created_at, tz, true)}</span>{" "}
                <b className="font-medium">{ATTRIBUTION_LABEL[h.status as AttributionStatus]?.[0] ?? h.status}</b>
                {h.live_shows && <> → <Link href={`/shows/${h.live_shows.id}`} className="hover:text-gold">{h.live_shows.title}</Link></>}
                {h.note && <span className="text-muted"> — {h.note}</span>}
                <span className="text-faint"> · {h.decided_by ? h.users?.email ?? "user" : "automatic"}</span>
              </li>
            ))}
            {!history?.length && <li className="text-faint">No decisions logged</li>}
          </ul>
        </section>

        <section className="card overflow-x-auto p-5 text-sm">
          <div className="label mb-2">Packages</div>
          {pkgs.length ? (
            <table className="table">
              <thead><tr><th>Package</th><th>Carrier / tracking</th><th className="text-right">Orders</th><th className="text-right">Label</th></tr></thead>
              <tbody>
                {pkgs.map((p: any) => (
                  <tr key={p.id}>
                    <td className="font-mono text-xs">{p.external_package_id}<div className="text-faint">{p.status ?? ""}</div></td>
                    <td>{p.carrier ?? <span className="text-faint">Unavailable</span>}<div className="font-mono text-xs text-muted">{p.tracking_number ?? "—"}</div></td>
                    <td className="num text-right">{p.package_orders?.[0]?.count ?? 1}</td>
                    <td className="num text-right">{p.label_cost !== null ? `${formatUsd(d(p.label_cost))} (${p.label_cost_source})` : <span className="text-faint">Pending</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-faint">No package information yet.</p>
          )}
          {pkgs.some((p: any) => (p.package_orders?.[0]?.count ?? 1) > 1) && <p className="mt-2 text-xs text-faint">Combined package: its label is paid once and split across its orders.</p>}

          <div className="label mb-2 mt-5">TikTok finance</div>
          {(txns ?? []).length ? (
            <table className="table">
              <thead><tr><th>Type</th><th className="text-right">Revenue</th><th className="text-right">Fees</th><th className="text-right">Shipping</th><th className="text-right">Settlement</th></tr></thead>
              <tbody>
                {(txns ?? []).map((t: any) => (
                  <tr key={t.id}>
                    <td>{t.type}<div className="text-xs text-faint">{t.settled ? "settled" : "TikTok estimate"}</div></td>
                    <td className="num text-right">{t.revenue_amount !== null ? formatUsd(d(t.revenue_amount)) : "—"}</td>
                    <td className="num text-right">{t.platform_fee_amount !== null ? formatUsd(d(t.platform_fee_amount)) : "—"}</td>
                    <td className="num text-right">{t.shipping_cost_amount !== null ? formatUsd(d(t.shipping_cost_amount)) : "—"}</td>
                    <td className="num text-right">{t.settlement_amount !== null ? formatUsd(d(t.settlement_amount)) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-faint">No finance data yet — fees and shipping are estimates until TikTok reports them.</p>
          )}
          {txns?.some((t: any) => t.revenue_amount !== null && !d(t.revenue_amount).minus(m.net).abs().lte("0.02")) && (
            <p className="mt-2 text-xs text-warn">TikTok&apos;s revenue for this order differs from the order lines — check discounts/refunds in Seller Center.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3 py-1">
      <span className="text-muted">{label}</span>
      <span className={`num whitespace-nowrap ${strong ? "font-semibold" : ""}`}>{value}</span>
    </div>
  );
}
