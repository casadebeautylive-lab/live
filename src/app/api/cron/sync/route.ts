import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { serverEnv } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/clients";
import { closeIdleDetectedShows, finalizeSettledShows } from "@/lib/lifecycle";
import { maybeDailySummary, processCreatorQueue } from "@/lib/creators/scan";
import { getTimezone } from "@/lib/data/context";
import { importOrders, syncFinance, syncLiveSessions, syncPackages } from "@/lib/integrations/tiktok/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Background sync, called by a scheduler (Railway cron) with
 *   Authorization: Bearer $CRON_SECRET
 *
 *   ?job=live     every 5 min  — close idle auto-detected LIVEs, catch missed orders (last 2 h),
 *                               run queued creator scans + the daily creator summary
 *   ?job=finance  every hour   — settlements/fees/shipping, packages, finalize settled shows
 *   ?job=daily    once a day   — official LIVE start/end/title from TikTok analytics
 */
export async function GET(req: NextRequest) {
  const secret = serverEnv.cronSecret();
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || got.length !== secret.length || !timingSafeEqual(Buffer.from(got), Buffer.from(secret))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sb = supabaseAdmin();
  const job = req.nextUrl.searchParams.get("job") ?? "live";
  const { data: conn } = await sb.from("platform_connections").select("status").eq("platform", "tiktok").maybeSingle();
  const tiktok = conn?.status === "connected";
  const out: Record<string, unknown> = { job };

  if (job === "live") {
    if (tiktok) out.orders = await importOrders(sb, new Date(Date.now() - 2 * 3_600_000), new Date(), 5);
    out.closedIdleShows = await closeIdleDetectedShows(sb);
    out.creatorJobs = await processCreatorQueue(sb);
    await maybeDailySummary(sb, await getTimezone(sb));
  } else if (job === "finance") {
    if (tiktok) {
      out.finance = await syncFinance(sb);
      out.packages = await syncPackages(sb);
    }
    out.finalized = await finalizeSettledShows(sb);
  } else if (job === "daily") {
    if (tiktok) out.liveSessions = await syncLiveSessions(sb, 3);
  } else {
    return NextResponse.json({ error: "unknown job" }, { status: 400 });
  }
  return NextResponse.json(out);
}
