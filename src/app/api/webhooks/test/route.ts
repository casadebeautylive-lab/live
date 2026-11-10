import { NextResponse } from "next/server";
import { handleWebhook } from "@/lib/ingest/ingest";
import { SupabaseIngestRepo } from "@/lib/ingest/supabase-repo";
import { supabaseAdmin } from "@/lib/supabase/clients";
import { serverEnv } from "@/lib/env";
import { hmacSha256Hex, safeEqualHex } from "@/lib/crypto";

export const dynamic = "force-dynamic";

/**
 * Development webhook for simulated payloads (normalized order JSON).
 *   X-Jewelar-Signature: hex(HMAC-SHA256(TEST_WEBHOOK_SECRET, raw body))
 *   X-Jewelar-Event-Id:  unique id used for deduplication
 * Everything received here is forced to isTest=true and only attaches to test shows.
 * Disabled unless TEST_WEBHOOK_SECRET is set.
 */
export async function POST(req: Request) {
  const secret = serverEnv.testWebhookSecret();
  if (!secret) return NextResponse.json({ error: "test webhook disabled" }, { status: 404 });
  const raw = await req.text();
  const sig = req.headers.get("x-jewelar-signature") ?? "";
  const eventId = req.headers.get("x-jewelar-event-id") ?? "";
  if (!eventId) return NextResponse.json({ error: "missing X-Jewelar-Event-Id" }, { status: 400 });
  const valid = sig.length > 0 && safeEqualHex(hmacSha256Hex(secret, raw), sig);

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const platform = ["tiktok", "whatnot", "manual"].includes(payload?.platform) ? payload.platform : "manual";
  const result = await handleWebhook(
    new SupabaseIngestRepo(supabaseAdmin()),
    { platform, idempotencyKey: `test:${eventId}`, eventType: "test.order", signatureValid: valid, isTest: true, payload },
    async () => ({ ...payload, platform, isTest: true }),
  );
  const status = result.status === "rejected" ? 401 : result.status === "failed" ? 422 : 200;
  return NextResponse.json(result, { status });
}
