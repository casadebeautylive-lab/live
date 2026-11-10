import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestOrder } from "@/lib/ingest/ingest";
import { SupabaseIngestRepo } from "@/lib/ingest/supabase-repo";
import { addDays, localDate } from "@/lib/dates";
import { freezeOriginalEstimate } from "@/lib/lifecycle";
import { getLiveSessions, getOrderDetails, getOrderStatement, getPackage, getUnsettled, searchOrderIds, searchReturns, shopCipher } from "./client";
import { fromSettledOrder, fromUnsettledTransaction, mapLiveSessions, orderFinanceUpdate } from "./finance";
import { mapTikTokOrder, mapTikTokReturns } from "./map";

/**
 * TikTok Shop background sync (Phase 2). Each job is idempotent: re-running it
 * updates the same rows, never duplicates them. Jobs are recorded in sync_jobs.
 */

type JobKind = "orders" | "finance" | "packages" | "live_sessions";

async function track<T extends Record<string, unknown>>(sb: SupabaseClient, kind: JobKind, fn: () => Promise<T>): Promise<T | { error: string }> {
  const { data: job } = await sb.from("sync_jobs").insert({ platform: "tiktok", kind }).select("id").single();
  try {
    const stats = await fn();
    await sb.from("sync_jobs").update({ status: "succeeded", stats, finished_at: new Date().toISOString() }).eq("id", job?.id);
    await sb.from("platform_connections").update({ last_sync_at: new Date().toISOString() }).eq("platform", "tiktok");
    return stats;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await sb.from("sync_jobs").update({ status: "failed", error, finished_at: new Date().toISOString() }).eq("id", job?.id);
    await sb.from("platform_connections").update({ last_error: `${kind} sync: ${error}`, last_error_at: new Date().toISOString() }).eq("platform", "tiktok");
    return { error };
  }
}

/**
 * Import orders created in [from, to). Orders with a TikTok LIVE room id are
 * attributed (creating detected shows); orders without one stay unassigned —
 * historical imports are never matched to shows by time alone.
 */
export async function importOrders(sb: SupabaseClient, from: Date, to: Date, maxPages = 40) {
  return track(sb, "orders", async () => {
    const { cipher, externalShopId } = await shopCipher();
    const repo = new SupabaseIngestRepo(sb);
    let token: string | undefined;
    let seen = 0;
    let assigned = 0;
    let failed = 0;
    for (let page = 0; page < maxPages; page++) {
      const { ids, next } = await searchOrderIds(cipher, from, to, token);
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        const [details, returns] = await Promise.all([getOrderDetails(cipher, batch), searchReturns(cipher, batch).catch(() => [])]);
        for (const raw of details) {
          seen++;
          try {
            const n = mapTikTokOrder(raw, externalShopId);
            if (!n) continue;
            n.refunds = mapTikTokReturns(returns, n.externalOrderId);
            const r = await ingestOrder(repo, { ...n, source: "import" });
            if (r.ok && r.showId) assigned++;
            if (!r.ok) failed++;
          } catch {
            failed++;
          }
        }
      }
      if (!next) break;
      token = next;
    }
    return { seen, assigned, failed };
  });
}

/** Pull TikTok's settled totals (or its own estimates) for orders on recent shows. */
export async function syncFinance(sb: SupabaseClient, limit = 150) {
  return track(sb, "finance", async () => {
    const { cipher } = await shopCipher();
    const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const { data: orders } = await sb
      .from("orders")
      .select("id, external_order_id, customer_shipping, platform_shipping_subsidy")
      .eq("platform", "tiktok")
      .eq("is_test", false)
      .eq("status", "active")
      .is("settlement_amount", null)
      .gte("created_at_platform", since)
      .order("created_at_platform", { ascending: true })
      .limit(limit);
    let settled = 0;
    const pending = new Map<string, any>();
    for (const o of orders ?? []) {
      const data = await getOrderStatement(cipher, o.external_order_id);
      const f = data ? fromSettledOrder(data) : null;
      if (f?.settled) {
        await sb.from("orders").update(orderFinanceUpdate(f, String(o.customer_shipping), o.platform_shipping_subsidy)).eq("id", o.id);
        await sb.from("finance_transactions").upsert(
          {
            platform: "tiktok",
            external_transaction_id: `order-settled:${o.external_order_id}`,
            order_id: o.id,
            external_order_id: o.external_order_id,
            type: "ORDER",
            settled: true,
            revenue_amount: f.revenue,
            platform_fee_amount: f.platformFees,
            shipping_cost_amount: f.netShippingCost,
            settlement_amount: f.settlement,
            raw: data,
          },
          { onConflict: "platform,external_transaction_id" },
        );
        settled++;
      } else {
        pending.set(o.external_order_id, o);
      }
    }

    // TikTok's own estimates for the rest (replace our 6% guess with their numbers)
    let estimated = 0;
    if (pending.size) {
      let token: string | undefined;
      for (let page = 0; page < 20 && pending.size; page++) {
        const { transactions, next } = await getUnsettled(cipher, token);
        for (const t of transactions) {
          const o = pending.get(String(t.order_id ?? ""));
          if (!o || t.type !== "ORDER") continue;
          const f = fromUnsettledTransaction(t);
          const upd = orderFinanceUpdate(f, String(o.customer_shipping), o.platform_shipping_subsidy);
          await sb
            .from("orders")
            .update({ actual_platform_fees: upd.actual_platform_fees, seller_shipping_cost: upd.seller_shipping_cost })
            .eq("id", o.id);
          await sb.from("finance_transactions").upsert(
            {
              platform: "tiktok",
              external_transaction_id: `order-unsettled:${o.external_order_id}`,
              order_id: o.id,
              external_order_id: o.external_order_id,
              type: "ORDER",
              settled: false,
              revenue_amount: f.revenue,
              platform_fee_amount: f.platformFees,
              shipping_cost_amount: f.netShippingCost,
              raw: t,
            },
            { onConflict: "platform,external_transaction_id" },
          );
          pending.delete(o.external_order_id);
          estimated++;
        }
        if (!next) break;
        token = next;
      }
    }
    return { checked: orders?.length ?? 0, settled, estimated };
  });
}

/** Package detail for orders that reference packages we haven't stored yet. */
export async function syncPackages(sb: SupabaseClient, limit = 100) {
  return track(sb, "packages", async () => {
    const { cipher } = await shopCipher();
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const { data: orders } = await sb
      .from("orders")
      .select("id, raw")
      .eq("platform", "tiktok")
      .eq("is_test", false)
      .gte("created_at_platform", since)
      .limit(1000);
    const wanted = new Set<string>();
    for (const o of orders ?? []) {
      const raw = o.raw as any;
      for (const p of raw?.packages ?? []) if (p?.id) wanted.add(String(p.id));
      for (const li of raw?.line_items ?? []) if (li?.package_id) wanted.add(String(li.package_id));
    }
    const { data: known } = await sb.from("packages").select("external_package_id").eq("platform", "tiktok").in("external_package_id", [...wanted]);
    const have = new Set((known ?? []).map((k) => k.external_package_id));
    let stored = 0;
    for (const id of [...wanted].filter((w) => !have.has(w)).slice(0, limit)) {
      const p = await getPackage(cipher, id);
      if (!p) continue;
      await sb.rpc("upsert_package", {
        p: {
          platform: "tiktok",
          externalPackageId: id,
          status: p.package_status ?? null,
          carrier: p.shipping_provider_name ?? null,
          trackingNumber: p.tracking_number ?? null,
          orderIds: (p.orders ?? []).map((o: any) => String(o.id)),
          labelCost: null, // TikTok's label price is an estimate; actual cost comes from finance per order
          raw: p,
        },
      });
      stored++;
    }
    return { referenced: wanted.size, stored };
  });
}

/**
 * Official LIVE sessions (start, end, title) from TikTok analytics. Confirms the
 * times of auto-detected shows, links manual shows to their LIVE, and creates
 * a show for any LIVE we had no orders for yet. Data is about a day behind.
 */
export async function syncLiveSessions(sb: SupabaseClient, days = 3) {
  return track(sb, "live_sessions", async () => {
    const { cipher } = await shopCipher();
    const { data: settings } = await sb.from("app_settings").select("timezone").eq("id", 1).maybeSingle();
    const tz = settings?.timezone ?? "America/New_York";
    const today = localDate(tz);
    let token: string | undefined;
    let confirmed = 0;
    let created = 0;
    for (let page = 0; page < 10; page++) {
      const { data, next } = await getLiveSessions(cipher, addDays(today, -days), addDays(today, 1), token);
      for (const s of mapLiveSessions(data)) {
        if (!s.startedAt) continue;
        const { data: show } = await sb.from("live_shows").select("id, detection, title, ended_at").eq("platform", "tiktok").eq("live_room_id", s.id).maybeSingle();
        if (show) {
          await sb
            .from("live_shows")
            .update({
              started_at: s.startedAt,
              ended_at: s.endedAt ?? show.ended_at,
              times_verified: Boolean(s.endedAt),
              platform_stats: s.stats,
              ...(show.detection === "platform" && s.title ? { title: s.title } : {}),
            })
            .eq("id", show.id);
          if (s.endedAt && !show.ended_at) await freezeOriginalEstimate(sb, show.id);
          confirmed++;
        } else if (s.endedAt) {
          const { buildCostSnapshot } = await import("@/lib/data/costs");
          const { snapshot, costProfileId, feeRuleId } = await buildCostSnapshot(sb, "tiktok");
          const { data: ins } = await sb
            .from("live_shows")
            .insert({
              platform: "tiktok",
              title: s.title ?? "TikTok LIVE",
              status: "awaiting_reconciliation",
              detection: "platform",
              live_room_id: s.id,
              started_at: s.startedAt,
              ended_at: s.endedAt,
              times_verified: true,
              platform_stats: s.stats,
              cost_snapshot: snapshot,
              cost_profile_id: costProfileId,
              fee_rule_id: feeRuleId,
            })
            .select("id")
            .single();
          if (ins) {
            // attach orders already stored with this room id
            await sb.from("orders").update({ show_id: ins.id, attribution: "assigned", attribution_method: "platform_live_id", attribution_note: `TikTok LIVE ${s.id}` }).eq("platform", "tiktok").eq("live_room_id", s.id).is("show_id", null);
            await freezeOriginalEstimate(sb, ins.id);
            created++;
          }
        }
      }
      if (!next) break;
      token = next;
    }
    return { confirmed, created };
  });
}
