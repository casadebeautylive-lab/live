import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AttributionWrite, IngestRepo, WebhookRecord } from "./ingest";
import type { NormalizedOrder } from "./normalized";
import { DEFAULT_ATTRIBUTION, type CandidateShow } from "@/lib/attribution";
import { buildCostSnapshot } from "@/lib/data/costs";
import { formatShowDate } from "@/lib/dates";

/** Service-role implementation of the ingestion port. */
export class SupabaseIngestRepo implements IngestRepo {
  constructor(private sb: SupabaseClient) {}

  async insertWebhookEvent(e: WebhookRecord) {
    const { data, error } = await this.sb
      .from("webhook_events")
      .insert({
        platform: e.platform,
        idempotency_key: e.idempotencyKey,
        event_type: e.eventType,
        signature_valid: e.signatureValid,
        is_test: e.isTest,
        payload: e.payload ?? {},
        attempts: 1,
      })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") return { inserted: false, id: null }; // unique violation = duplicate
      throw new Error(`webhook log insert failed: ${error.message}`);
    }
    return { inserted: true, id: data.id as string };
  }

  async markWebhookEvent(id: string, status: "processed" | "failed" | "rejected", error?: string) {
    await this.sb
      .from("webhook_events")
      .update({ status, error: error ?? null, processed_at: new Date().toISOString() })
      .eq("id", id);
  }

  async candidateShows(platform: string, isTest: boolean, createdAt: string, liveRoomId: string | null): Promise<CandidateShow[]> {
    const t = Date.parse(createdAt);
    // generous pre-filter; the attribution service applies the exact window rules
    const lo = new Date(t - 6 * 3_600_000).toISOString();
    const hi = new Date(t + 6 * 3_600_000).toISOString();
    const cols = "id, platform, is_test, started_at, ended_at, live_room_id, detection";
    const [windowed, byRoom] = await Promise.all([
      this.sb
        .from("live_shows")
        .select(cols)
        .in("platform", [platform, "manual"])
        .eq("is_test", isTest)
        .neq("status", "scheduled")
        .lte("started_at", hi)
        .or(`ended_at.is.null,ended_at.gte.${lo}`)
        .limit(50),
      liveRoomId
        ? this.sb.from("live_shows").select(cols).eq("platform", platform).eq("live_room_id", liveRoomId).limit(1)
        : Promise.resolve({ data: [] as any[] }),
    ]);
    const rows = new Map<string, any>();
    for (const r of [...(windowed.data ?? []), ...(byRoom.data ?? [])]) rows.set(r.id, r);
    return [...rows.values()].map((r) => ({
      id: r.id,
      platform: r.platform,
      isTest: r.is_test,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      liveRoomId: r.live_room_id,
      detection: r.detection,
    }));
  }

  async attributionSettings() {
    const { data } = await this.sb.from("app_settings").select("attribution_before_minutes, attribution_after_minutes").eq("id", 1).maybeSingle();
    if (!data) return DEFAULT_ATTRIBUTION;
    return { beforeMinutes: data.attribution_before_minutes, afterMinutes: data.attribution_after_minutes };
  }

  async createDetectedShow(platform: NormalizedOrder["platform"], isTest: boolean, liveRoomId: string, startedAt: string) {
    const { snapshot, costProfileId, feeRuleId } = await buildCostSnapshot(this.sb, platform);
    const { data: tz } = await this.sb.from("app_settings").select("timezone").eq("id", 1).maybeSingle();
    const { data, error } = await this.sb
      .from("live_shows")
      .insert({
        platform,
        is_test: isTest,
        title: `TikTok LIVE · ${formatShowDate(startedAt, tz?.timezone ?? "America/New_York")}`,
        status: "live",
        detection: "platform",
        live_room_id: liveRoomId,
        started_at: startedAt,
        last_activity_at: startedAt,
        cost_snapshot: snapshot,
        cost_profile_id: costProfileId,
        fee_rule_id: feeRuleId,
        notes: "Detected automatically from TikTok order data. Start/end times are estimated until TikTok LIVE analytics confirm them.",
      })
      .select("id")
      .single();
    if (!error) return data.id as string;
    if (error.code === "23505") {
      const { data: existing } = await this.sb.from("live_shows").select("id").eq("platform", platform).eq("live_room_id", liveRoomId).single();
      if (existing) return existing.id as string;
    }
    throw new Error(`could not create detected show: ${error.message}`);
  }

  async linkShowRoom(showId: string, liveRoomId: string) {
    await this.sb.from("live_shows").update({ live_room_id: liveRoomId }).eq("id", showId).is("live_room_id", null);
  }

  async upsertOrder(o: NormalizedOrder, showId: string | null, attr: AttributionWrite) {
    // Atomic: order + items + refunds + customer + decision log (see 0003_profit_tracker.sql).
    const { data, error } = await this.sb.rpc("ingest_order_v3", { p: o, p_show: showId, p_attr: attr });
    if (error) throw new Error(`order ingest failed: ${error.message}`);
    const row = (data as { out_order_id: string; out_created: boolean; out_show_id: string | null }[])[0];
    return { orderId: row.out_order_id, created: row.out_created, showId: row.out_show_id };
  }

  async touchConnection(platform: string) {
    const now = new Date().toISOString();
    await this.sb.from("platform_connections").update({ last_event_at: now, last_sync_at: now }).eq("platform", platform);
  }
}
