import "server-only";
import { handleWebhook } from "@/lib/ingest/ingest";
import { SupabaseIngestRepo } from "@/lib/ingest/supabase-repo";
import { serverEnv } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/clients";
import { ingestOrder } from "@/lib/ingest/ingest";
import { getOrderDetail, searchReturns, shopCipher } from "./client";
import { mapTikTokOrder, mapTikTokReturns } from "./map";
import { verifyWebhookSignature } from "./sign";
import { ORDER_STATUS_CHANGE, orderIdFrom, TikTokWebhook } from "./webhook";

/**
 * Any order-related event (status change, cancellation, return/refund, package
 * update) refreshes the whole order from TikTok, including its completed refunds.
 * Events without an order id are logged only.
 */
async function toNormalized(payload: unknown) {
  const evt = TikTokWebhook.parse(payload);
  const orderId = orderIdFrom(evt);
  if (!orderId) {
    if (evt.type === ORDER_STATUS_CHANGE) throw new Error("webhook has no order_id");
    return null;
  }
  const raw = await getOrderDetail(evt.shop_id, orderId);
  const n = mapTikTokOrder(raw, evt.shop_id);
  if (!n) return null;
  try {
    const { cipher } = await shopCipher(evt.shop_id);
    n.refunds = mapTikTokReturns(await searchReturns(cipher, [orderId]), orderId);
  } catch {
    // returns are best-effort here; the order itself is still recorded and the next event retries
  }
  return n;
}

/** Verify, log (dedupe), then fetch + ingest. */
export async function processTikTokWebhook(rawBody: string, authHeader: string | null) {
  const signatureValid = verifyWebhookSignature(
    serverEnv.tiktok.appKey(),
    serverEnv.tiktok.appSecret(),
    rawBody,
    authHeader,
  );
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: "rejected" as const, detail: "invalid JSON" };
  }
  const parsed = TikTokWebhook.safeParse(payload);
  const key = parsed.success ? parsed.data.tts_notification_id : `invalid:${Date.now()}`;
  const repo = new SupabaseIngestRepo(supabaseAdmin());
  const result = await handleWebhook(
    repo,
    {
      platform: "tiktok",
      idempotencyKey: key,
      eventType: parsed.success ? `type_${parsed.data.type}` : "invalid",
      signatureValid: signatureValid && parsed.success,
      isTest: false,
      payload,
    },
    () => toNormalized(payload),
  );
  if (result.status === "failed") {
    await supabaseAdmin()
      .from("platform_connections")
      .update({ last_error: result.detail ?? "processing failed", last_error_at: new Date().toISOString() })
      .eq("platform", "tiktok");
  }
  return result;
}

/** Re-run failed, signature-valid TikTok events (button on Integrations page). */
export async function retryFailedTikTokEvents(limit = 50) {
  const sb = supabaseAdmin();
  const { data: rows } = await sb
    .from("webhook_events")
    .select("id, payload, attempts")
    .eq("platform", "tiktok")
    .eq("status", "failed")
    .eq("signature_valid", true)
    .order("received_at")
    .limit(limit);
  const repo = new SupabaseIngestRepo(sb);
  let ok = 0;
  for (const row of rows ?? []) {
    await sb.from("webhook_events").update({ attempts: (row.attempts ?? 0) + 1 }).eq("id", row.id);
    try {
      const order = await toNormalized(row.payload);
      if (order) {
        const r = await ingestOrder(repo, order);
        if (!r.ok) throw new Error(r.error);
      }
      await repo.markWebhookEvent(row.id, "processed");
      ok++;
    } catch (e) {
      await repo.markWebhookEvent(row.id, "failed", e instanceof Error ? e.message : String(e));
    }
  }
  return { attempted: rows?.length ?? 0, succeeded: ok };
}
