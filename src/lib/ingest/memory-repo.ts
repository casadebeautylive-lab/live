import type { AttributionWrite, IngestRepo, WebhookRecord } from "./ingest";
import type { NormalizedOrder } from "./normalized";
import { DEFAULT_ATTRIBUTION, type CandidateShow } from "@/lib/attribution";

/** In-memory repo for tests. Mirrors the uniqueness rules of the SQL schema. */
export class MemoryRepo implements IngestRepo {
  webhooks = new Map<string, WebhookRecord & { id: string; status: string; error?: string }>();
  orders = new Map<string, NormalizedOrder & { id: string; showId: string | null; attribution: AttributionWrite }>();
  shows: (Omit<CandidateShow, "liveRoomId" | "detection"> & { liveRoomId?: string | null; detection?: "manual" | "platform" })[] = [];
  touched: string[] = [];
  settings = DEFAULT_ATTRIBUTION;
  private seq = 0;

  async insertWebhookEvent(e: WebhookRecord) {
    const key = `${e.platform}:${e.idempotencyKey}`;
    if (this.webhooks.has(key)) return { inserted: false, id: null };
    const id = `wh${++this.seq}`;
    this.webhooks.set(key, { ...e, id, status: "received" });
    return { inserted: true, id };
  }

  async markWebhookEvent(id: string, status: string, error?: string) {
    for (const w of this.webhooks.values()) if (w.id === id) Object.assign(w, { status, error });
  }

  async candidateShows() {
    return this.shows.map((s) => ({ liveRoomId: null, detection: "manual" as const, ...s }));
  }

  async attributionSettings() {
    return this.settings;
  }

  async createDetectedShow(platform: NormalizedOrder["platform"], isTest: boolean, liveRoomId: string, startedAt: string) {
    const existing = this.shows.find((s) => s.platform === platform && s.liveRoomId === liveRoomId);
    if (existing) return existing.id;
    const id = `show${++this.seq}`;
    this.shows.push({ id, platform, isTest, startedAt, endedAt: null, liveRoomId, detection: "platform" });
    return id;
  }

  async linkShowRoom(showId: string, liveRoomId: string) {
    const s = this.shows.find((x) => x.id === showId);
    if (s && !s.liveRoomId) s.liveRoomId = liveRoomId;
  }

  async upsertOrder(order: NormalizedOrder, showId: string | null, attribution: AttributionWrite) {
    const key = `${order.platform}:${order.externalOrderId}`;
    const existing = this.orders.get(key);
    const id = existing?.id ?? `ord${++this.seq}`;
    // keep the original show assignment on updates (refund/cancel arrive after the show ends)
    const refunds = new Map((existing?.refunds ?? []).map((r) => [r.externalRefundId, r]));
    for (const r of order.refunds) refunds.set(r.externalRefundId, r);
    const keep = existing?.showId ?? null;
    const finalShow = keep ?? showId;
    this.orders.set(key, {
      ...order,
      refunds: [...refunds.values()],
      id,
      showId: finalShow,
      attribution: keep ? existing!.attribution : attribution,
    });
    return { orderId: id, created: !existing, showId: finalShow };
  }

  async touchConnection(platform: string) {
    this.touched.push(platform);
  }
}
