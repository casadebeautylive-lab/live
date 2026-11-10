"use server";

import { revalidatePath } from "next/cache";
import { audit, requireWriter, supabaseAdmin } from "@/lib/supabase/clients";
import { run, type ActionState } from "@/lib/action-state";
import { syncAuthorizedShops } from "@/lib/integrations/tiktok/client";
import { retryFailedTikTokEvents } from "@/lib/integrations/tiktok/process";
import { importOrders, syncFinance, syncLiveSessions, syncPackages } from "@/lib/integrations/tiktok/sync";
import { closeIdleDetectedShows, finalizeSettledShows } from "@/lib/lifecycle";
import { z } from "zod";

async function _syncShops() {
  const user = await requireWriter();
  try {
    const n = await syncAuthorizedShops();
    await audit(user.id, "integration.sync_shops", "platform_connections", "tiktok", null, { shops: n });
  } catch (e) {
    await supabaseAdmin()
      .from("platform_connections")
      .update({ last_error: e instanceof Error ? e.message : String(e), last_error_at: new Date().toISOString() })
      .eq("platform", "tiktok");
    throw e;
  }
  revalidatePath("/integrations");
}

async function _retryFailed() {
  const user = await requireWriter();
  const r = await retryFailedTikTokEvents();
  await audit(user.id, "integration.retry", "webhook_events", null, null, r);
  revalidatePath("/integrations");
  if (r.attempted && r.succeeded < r.attempted) throw new Error(`${r.succeeded} of ${r.attempted} events succeeded — see errors below`);
}

async function _disconnect() {
  const user = await requireWriter();
  await supabaseAdmin()
    .from("platform_connections")
    .update({ status: "disconnected", access_token_enc: null, refresh_token_enc: null, access_token_expires_at: null, refresh_token_expires_at: null })
    .eq("platform", "tiktok");
  await audit(user.id, "integration.disconnect", "platform_connections", "tiktok");
  revalidatePath("/integrations");
}

/** Manual "sync now" — the same jobs the scheduler runs. */
async function _syncNow(form: FormData) {
  const user = await requireWriter();
  const job = z.enum(["orders", "finance", "packages", "live_sessions"]).parse(form.get("job"));
  const days = z.coerce.number().int().min(1).max(60).parse(form.get("days") ?? "2");
  const sb = supabaseAdmin();
  let r: Record<string, unknown>;
  if (job === "orders") r = await importOrders(sb, new Date(Date.now() - days * 86_400_000), new Date());
  else if (job === "finance") r = { ...(await syncFinance(sb)), finalized: await finalizeSettledShows(sb) };
  else if (job === "packages") r = await syncPackages(sb);
  else r = { ...(await syncLiveSessions(sb, days)), closedIdle: await closeIdleDetectedShows(sb) };
  await audit(user.id, `integration.sync.${job}`, "sync_jobs", null, null, r);
  revalidatePath("/integrations");
  if ("error" in r && r.error) throw new Error(String(r.error));
}

export async function syncNow(_p: ActionState, f: FormData) { return run(_syncNow, f); }
export async function syncShops(_p: ActionState, f: FormData) { return run(_syncShops, f); }
export async function retryFailed(_p: ActionState, f: FormData) { return run(_retryFailed, f); }
export async function disconnectTikTok(_p: ActionState, f: FormData) { return run(_disconnect, f); }
