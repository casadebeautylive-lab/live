import { NormalizedOrderSchema, type NormalizedOrder } from "./normalized";
import {
  decideAttribution,
  DEFAULT_ATTRIBUTION,
  type AttributionDecision,
  type AttributionSettings,
  type AttributionStatus,
  type CandidateShow,
} from "@/lib/attribution";

export type WebhookRecord = {
  platform: NormalizedOrder["platform"];
  idempotencyKey: string;
  eventType: string;
  signatureValid: boolean;
  isTest: boolean;
  payload: unknown;
};

export type AttributionWrite = {
  status: AttributionStatus;
  method: string | null;
  note: string;
  candidates: string[];
};

/** Persistence port. Implemented by Supabase (production) and in-memory (tests). */
export interface IngestRepo {
  /** Insert the webhook log row. Returns false if (platform, key) already exists. */
  insertWebhookEvent(e: WebhookRecord): Promise<{ inserted: boolean; id: string | null }>;
  markWebhookEvent(id: string, status: "processed" | "failed" | "rejected", error?: string): Promise<void>;
  /** Shows that could own an order created at `createdAt` (same platform or manual, same test mode), plus any show with this room id. */
  candidateShows(platform: string, isTest: boolean, createdAt: string, liveRoomId: string | null): Promise<CandidateShow[]>;
  attributionSettings(): Promise<AttributionSettings>;
  /** Auto-create a show for a newly detected platform LIVE. Returns its id (existing one on a race). */
  createDetectedShow(platform: NormalizedOrder["platform"], isTest: boolean, liveRoomId: string, startedAt: string): Promise<string>;
  linkShowRoom(showId: string, liveRoomId: string): Promise<void>;
  /** Upsert order on (platform, externalOrderId); never moves an assigned order. Returns the show it ended up on. */
  upsertOrder(order: NormalizedOrder, showId: string | null, attr: AttributionWrite): Promise<{ orderId: string; created: boolean; showId: string | null }>;
  touchConnection(platform: string): Promise<void>;
}

export type IngestResult =
  | { ok: true; outcome: "created" | "updated"; orderId: string; showId: string | null; attribution: AttributionDecision["kind"] }
  | { ok: false; outcome: "invalid"; error: string };

/**
 * Ingest one normalized order (create or update). Idempotent: replaying the same
 * order updates the same row, never creates a second one. Show attribution is
 * decided by the attribution service — uncertain orders are flagged, not guessed.
 */
export async function ingestOrder(repo: IngestRepo, input: unknown): Promise<IngestResult> {
  const parsed = NormalizedOrderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, outcome: "invalid", error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const order = parsed.data;
  const [shows, cfg] = await Promise.all([
    repo.candidateShows(order.platform, order.isTest, order.createdAt, order.liveRoomId || null),
    repo.attributionSettings().catch(() => DEFAULT_ATTRIBUTION),
  ]);
  const decision = decideAttribution(
    { platform: order.platform, isTest: order.isTest, createdAt: order.createdAt, liveRoomId: order.liveRoomId, source: order.source },
    shows,
    cfg,
  );

  let showId: string | null = null;
  let attr: AttributionWrite;
  switch (decision.kind) {
    case "assign":
      showId = decision.showId;
      if (decision.linkRoomId) await repo.linkShowRoom(decision.showId, decision.linkRoomId);
      attr = { status: "assigned", method: decision.method, note: decision.note, candidates: [] };
      break;
    case "create_show":
      showId = await repo.createDetectedShow(order.platform, order.isTest, decision.liveRoomId, order.createdAt);
      attr = { status: "assigned", method: "platform_live_id", note: decision.note, candidates: [] };
      break;
    case "needs_review":
      attr = { status: "needs_review", method: null, note: decision.note, candidates: decision.candidateIds };
      break;
    case "unassigned":
      attr = { status: decision.status, method: null, note: decision.note, candidates: [] };
      break;
  }

  const res = await repo.upsertOrder(order, showId, attr);
  if (!order.isTest) await repo.touchConnection(order.platform);
  return { ok: true, outcome: res.created ? "created" : "updated", orderId: res.orderId, showId: res.showId, attribution: decision.kind };
}

/**
 * Webhook flow: record first (dedupe), then process. Duplicate deliveries are
 * acknowledged without reprocessing.
 */
export async function handleWebhook(
  repo: IngestRepo,
  record: WebhookRecord,
  toOrder: () => Promise<unknown | null>,
): Promise<{ status: "duplicate" | "processed" | "failed" | "rejected"; detail?: string }> {
  const { inserted, id } = await repo.insertWebhookEvent(record);
  if (!inserted || !id) return { status: "duplicate" };
  if (!record.signatureValid) {
    await repo.markWebhookEvent(id, "rejected", "invalid signature");
    return { status: "rejected" };
  }
  try {
    const order = await toOrder();
    if (order === null) {
      // e.g. an unpaid order: not a sale yet; the platform re-notifies on status change
      await repo.markWebhookEvent(id, "processed", "skipped: not a completed sale yet");
      return { status: "processed", detail: "skipped" };
    }
    const result = await ingestOrder(repo, order);
    if (!result.ok) {
      await repo.markWebhookEvent(id, "failed", result.error);
      return { status: "failed", detail: result.error };
    }
    await repo.markWebhookEvent(id, "processed");
    return { status: "processed" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await repo.markWebhookEvent(id, "failed", msg);
    return { status: "failed", detail: msg };
  }
}
