import { after, NextResponse } from "next/server";
import { processTikTokWebhook } from "@/lib/integrations/tiktok/process";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * TikTok Shop webhook receiver. TikTok expects a fast 200; verification and
 * order fetching run after the response. Every delivery is logged in
 * webhook_events (deduplicated by tts_notification_id), so nothing is lost if
 * processing fails — failures can be retried from the Connections page.
 */
export async function POST(req: Request) {
  const raw = await req.text(); // raw bytes are required for signature verification
  if (raw.length > 256_000) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  const auth = req.headers.get("authorization");
  after(async () => {
    try {
      await processTikTokWebhook(raw, auth);
    } catch (e) {
      console.error("tiktok webhook processing error", e);
    }
  });
  return new NextResponse(null, { status: 200 });
}
