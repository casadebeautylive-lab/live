import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadShowSnapshot } from "@/lib/data/shows";
import { computeMinutes } from "@/lib/engine/minutes";
import { kickCreatorScans, maybeDailySummary, onShowEnded } from "@/lib/creators/scan";

const m4 = (v: { toFixed: (n: number) => string }) => v.toFixed(4);

/**
 * Freeze the "original live estimate" when a show ends: totals on the show and
 * one row per minute. Reconciliation later changes the final numbers but never
 * these, so the live picture is preserved exactly as it was.
 */
export async function freezeOriginalEstimate(sb: SupabaseClient, showId: string) {
  const snap = await loadShowSnapshot(sb, showId);
  if (!snap || !snap.input.endedAt) return;
  const v = computeMinutes(snap.input, new Date(snap.input.endedAt));
  const t = v.totals;
  const totals = {
    frozenAt: new Date().toISOString(),
    revenue: m4(t.netMerchandise),
    orders: t.orders,
    units: t.itemsSold,
    productCost: m4(t.costs.product),
    presenter: m4(t.labor.presenter),
    assistant: m4(t.labor.assistant),
    platformFees: m4(t.platformFees),
    hourlyExpenses: m4(t.costs.hourlyExpenses),
    fixedExpenses: m4(t.costs.fixedExpenses),
    packing: m4(t.costs.packing),
    netShipping: m4(t.netShippingCost),
    totalExpenses: m4(t.totalExpenses),
    profit: m4(t.operatingProfit),
    profitPerMinute: t.profitPerMinute ? m4(t.profitPerMinute) : null,
    activeSeconds: t.activeSeconds,
  };
  await sb.from("live_shows").update({ original_estimate: totals }).eq("id", showId);
  await sb.from("show_minute_metrics").delete().eq("show_id", showId).eq("view", "original");
  const rows = v.minutes.map((m) => ({
    show_id: showId,
    view: "original",
    minute_index: m.index,
    minute_start: m.start,
    active_seconds: m.activeSeconds,
    orders: m.orders,
    units: m.units,
    revenue: m4(m.revenue),
    cogs: m4(m.cogs),
    commission: m4(m.commission),
    fees: m4(m.fees),
    labor: m4(m.labor),
    hourly_expenses: m4(m.hourlyExpenses),
    fixed_expenses: m4(m.fixedExpenses),
    packing: m4(m.packing),
    shipping: m4(m.shipping),
    profit: m4(m.profit),
    cumulative_profit: m4(m.cumulativeProfit),
  }));
  for (let i = 0; i < rows.length; i += 500) await sb.from("show_minute_metrics").insert(rows.slice(i, i + 500));
}

/** Status after a show ends: real shows wait for settlement; test shows are simply ended. */
export function endedStatus(isTest: boolean) {
  return isTest ? "ended" : "awaiting_reconciliation";
}

/**
 * Auto-detected LIVEs have no "end" signal from TikTok, so they close after a
 * quiet period. The end time is the last order (estimated) until TikTok's LIVE
 * analytics confirm the real start/end.
 */
export async function closeIdleDetectedShows(sb: SupabaseClient): Promise<number> {
  const { data: cfg } = await sb.from("app_settings").select("auto_show_idle_minutes").eq("id", 1).maybeSingle();
  const idle = cfg?.auto_show_idle_minutes ?? 20;
  const cutoff = new Date(Date.now() - idle * 60_000).toISOString();
  const { data: shows } = await sb
    .from("live_shows")
    .select("id, is_test, last_activity_at, started_at")
    .eq("detection", "platform")
    .in("status", ["live", "paused"])
    .lt("last_activity_at", cutoff);
  for (const s of shows ?? []) {
    const end = s.last_activity_at ?? s.started_at;
    await sb.from("live_shows").update({ status: endedStatus(s.is_test), ended_at: end }).eq("id", s.id);
    await freezeOriginalEstimate(sb, s.id);
    await onShowEnded(sb, s.id);
  }
  return shows?.length ?? 0;
}

/** Finalize shows whose every active order has a confirmed settlement. */
export async function finalizeSettledShows(sb: SupabaseClient): Promise<number> {
  const { data: shows } = await sb.from("live_shows").select("id").eq("status", "awaiting_reconciliation").limit(200);
  let n = 0;
  for (const s of shows ?? []) {
    const { count: open } = await sb
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("show_id", s.id)
      .eq("status", "active")
      .is("settlement_amount", null);
    const { count: total } = await sb.from("orders").select("id", { count: "exact", head: true }).eq("show_id", s.id).eq("status", "active");
    if ((total ?? 0) > 0 && (open ?? 0) === 0) {
      const now = new Date().toISOString();
      await sb.from("live_shows").update({ status: "finalized", reconciled_at: now, finalized_at: now }).eq("id", s.id);
      n++;
    }
  }
  return n;
}

let lastIdleSweep = 0;
/** closeIdleDetectedShows at most once a minute per server — cheap enough to call on every page load. */
export async function sweepIdleShows(sb: SupabaseClient): Promise<void> {
  if (Date.now() - lastIdleSweep < 60_000) return;
  lastIdleSweep = Date.now();
  await closeIdleDetectedShows(sb).catch(() => {
    lastIdleSweep = 0; // retry on the next load
  });
  // Pick up creator scans left queued (e.g. after a restart) and the daily creator summary.
  void (async () => {
    const { count } = await sb.from("creator_scan_jobs").select("id", { count: "exact", head: true }).eq("status", "queued");
    if (count) kickCreatorScans(sb);
    const { data: cfg } = await sb.from("app_settings").select("timezone").eq("id", 1).maybeSingle();
    await maybeDailySummary(sb, cfg?.timezone ?? "America/New_York");
  })().catch(() => {});
}
