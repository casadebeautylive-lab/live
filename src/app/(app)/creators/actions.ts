"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit, requireWriter, supabaseAdmin } from "@/lib/supabase/clients";
import { run, type ActionState } from "@/lib/action-state";
import { normalizeUsername, parseOrderExport, STATUSES } from "@/lib/creators/core";
import { kickCreatorScans, processCreatorQueue } from "@/lib/creators/scan";

const username = z.string().transform((v, ctx) => {
  const u = normalizeUsername(v);
  if (!u) ctx.addIssue({ code: "custom", message: "Not a valid TikTok username" });
  return u ?? "";
});

async function _setStatus(form: FormData) {
  const user = await requireWriter();
  const f = z.object({ username, status: z.enum(STATUSES.map((s) => s.id) as [string, ...string[]]) }).parse(Object.fromEntries(form));
  const sb = supabaseAdmin();
  const { data: before } = await sb.from("creator_opportunities").select("status, contacted_at").eq("username", f.username).single();
  const now = new Date().toISOString();
  await sb
    .from("creator_opportunities")
    .update({ status: f.status, updated_at: now, contacted_at: f.status !== "not_contacted" && !before?.contacted_at ? now : before?.contacted_at ?? null })
    .eq("username", f.username);
  await audit(user.id, "creator.status", "creator_opportunities", null, { username: f.username, status: before?.status }, { status: f.status });
  revalidatePath("/creators");
}

async function _saveNotes(form: FormData) {
  const user = await requireWriter();
  const f = z.object({ username, notes: z.string().max(2000) }).parse(Object.fromEntries(form));
  await supabaseAdmin().from("creator_opportunities").update({ notes: f.notes.trim() || null, updated_at: new Date().toISOString() }).eq("username", f.username);
  await audit(user.id, "creator.notes", "creator_opportunities", null, null, { username: f.username });
  revalidatePath("/creators");
}

async function _rescan(form: FormData) {
  const user = await requireWriter();
  const u = username.parse(form.get("username"));
  const sb = supabaseAdmin();
  await sb.from("creator_scan_jobs").insert({ kind: "rescan", usernames: [u] });
  await audit(user.id, "creator.rescan", "creator_scan_jobs", null, null, { username: u });
  kickCreatorScans(sb);
  revalidatePath("/creators");
}

/** Re-queue failed / budget-paused show scans and look up again every username whose lookup failed. */
async function _retryFailed() {
  const user = await requireWriter();
  const sb = supabaseAdmin();
  const { data: jobs } = await sb
    .from("creator_scan_jobs")
    .update({ status: "queued", error: null })
    .in("status", ["failed", "paused_budget"])
    .in("kind", ["show", "retry"])
    .select("id");
  const { data: failed } = await sb.from("tiktok_profiles").select("username").eq("lookup", "failed").limit(1000);
  if (failed?.length) await sb.from("creator_scan_jobs").insert({ kind: "retry", usernames: failed.map((r) => r.username) });
  await audit(user.id, "creator.retry_failed", "creator_scan_jobs", null, null, { jobs: jobs?.length ?? 0, usernames: failed?.length ?? 0 });
  kickCreatorScans(sb);
  revalidatePath("/creators");
}

async function _approve(form: FormData) {
  const user = await requireWriter();
  const id = z.uuid().parse(form.get("jobId"));
  const sb = supabaseAdmin();
  await sb.from("creator_scan_jobs").update({ status: "queued", approved_by: user.id, error: null }).eq("id", id).in("status", ["needs_approval", "paused_budget"]);
  await audit(user.id, "creator.approve_scan", "creator_scan_jobs", id);
  kickCreatorScans(sb);
  revalidatePath("/creators");
}

async function _cancel(form: FormData) {
  const user = await requireWriter();
  const id = z.uuid().parse(form.get("jobId"));
  await supabaseAdmin().from("creator_scan_jobs").update({ status: "cancelled", finished_at: new Date().toISOString() }).eq("id", id).in("status", ["queued", "needs_approval", "paused_budget", "failed"]);
  await audit(user.id, "creator.cancel_scan", "creator_scan_jobs", id);
  revalidatePath("/creators");
}

/** Scan an earlier show by hand (shows that ended before this feature existed are never scanned automatically). */
async function _scanShow(form: FormData) {
  const user = await requireWriter();
  const showId = z.uuid().parse(form.get("showId"));
  const sb = supabaseAdmin();
  const { data: existing } = await sb.from("creator_scan_jobs").select("id, status").eq("kind", "show").eq("show_id", showId).maybeSingle();
  if (existing && !["failed", "cancelled", "paused_budget"].includes(existing.status)) throw new Error("This show is already scanned or queued.");
  if (existing) await sb.from("creator_scan_jobs").update({ status: "queued", error: null }).eq("id", existing.id);
  else await sb.from("creator_scan_jobs").insert({ kind: "show", show_id: showId });
  await audit(user.id, "creator.scan_show", "live_shows", showId);
  kickCreatorScans(sb);
  revalidatePath("/creators");
}

/** Look up 1–5 usernames right now (end-to-end check). Respects the budget; never adds them as opportunities. */
async function _testLookup(form: FormData) {
  const user = await requireWriter();
  const list = String(form.get("usernames") ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((u) => normalizeUsername(u));
  if (!list.length || list.length > 5 || list.some((u) => !u)) throw new Error("Enter 1–5 valid TikTok usernames.");
  const sb = supabaseAdmin();
  const { data: job } = await sb.from("creator_scan_jobs").insert({ kind: "test", usernames: [...new Set(list as string[])] }).select("id").single();
  await audit(user.id, "creator.test_lookup", "creator_scan_jobs", job?.id ?? null, null, { usernames: list });
  await processCreatorQueue(sb);
  revalidatePath("/creators");
}

const pct = z.coerce.number();
async function _saveSettings(form: FormData) {
  const user = await requireWriter();
  const f = z
    .object({
      enabled: z.string().optional(),
      min_followers: z.coerce.number().int().min(1000).max(100_000_000),
      monthly_limit: pct.min(0).max(1000),
      approval_over: pct.min(0).max(1000),
      price: pct.min(0).max(1),
      template: z.string().trim().min(1).max(1000),
    })
    .parse(Object.fromEntries(form));
  const row = {
    creator_scan_enabled: f.enabled === "on",
    creator_min_followers: f.min_followers,
    apify_monthly_limit_usd: f.monthly_limit.toFixed(2),
    creator_approval_over_usd: f.approval_over.toFixed(2),
    apify_price_per_result: f.price.toFixed(5),
    creator_message_template: f.template,
  };
  const sb = supabaseAdmin();
  await sb.from("app_settings").update(row).eq("id", 1);
  await audit(user.id, "creator.settings", "app_settings", null, null, row);
  if (row.creator_scan_enabled) kickCreatorScans(sb);
  revalidatePath("/creators");
}

export const setCreatorStatus = async (_p: ActionState, f: FormData) => run(_setStatus, f);
export const saveCreatorNotes = async (_p: ActionState, f: FormData) => run(_saveNotes, f);
export const rescanCreator = async (_p: ActionState, f: FormData) => run(_rescan, f);
export const retryFailedScans = async (_p: ActionState, f: FormData) => run(_retryFailed, f);
export const approveScan = async (_p: ActionState, f: FormData) => run(_approve, f);
export const cancelScan = async (_p: ActionState, f: FormData) => run(_cancel, f);
export const scanShow = async (_p: ActionState, f: FormData) => run(_scanShow, f);
export const testLookup = async (_p: ActionState, f: FormData) => run(_testLookup, f);
export const saveCreatorSettings = async (_p: ActionState, f: FormData) => run(_saveSettings, f);

/**
 * Upload a TikTok Seller Center order export: saves order id → buyer @username only,
 * then (re)scans every LIVE those orders belong to. Budget and approval rules still apply.
 */
async function _importExport(form: FormData) {
  const user = await requireWriter();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) throw new Error("Choose the CSV file you exported from Seller Center.");
  if (file.size > 20 * 1024 * 1024) throw new Error("File is too large (max 20 MB).");
  if (!/\.csv$/i.test(file.name)) throw new Error("Upload the CSV export (in Seller Center choose CSV when exporting).");
  const parsed = parseOrderExport(await file.text());
  if (parsed.error) throw new Error(parsed.error);
  if (!parsed.rows.length) throw new Error("No buyer usernames found in this file.");
  const sb = supabaseAdmin();
  for (let i = 0; i < parsed.rows.length; i += 500)
    await sb.from("order_buyer_usernames").upsert(
      parsed.rows.slice(i, i + 500).map((r) => ({ external_order_id: r.orderId, username: r.username, imported_at: new Date().toISOString() })),
      { onConflict: "external_order_id" },
    );
  // which LIVEs do these orders belong to?
  const showIds = new Set<string>();
  const ids = parsed.rows.map((r) => r.orderId);
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await sb.from("orders").select("show_id").eq("platform", "tiktok").eq("is_test", false).not("show_id", "is", null).in("external_order_id", ids.slice(i, i + 300));
    for (const r of data ?? []) showIds.add(r.show_id as string);
  }
  const { data: ended } = showIds.size ? await sb.from("live_shows").select("id").in("id", [...showIds]).not("ended_at", "is", null).eq("is_test", false) : { data: [] as any[] };
  for (const s of ended ?? []) {
    const { data: job } = await sb.from("creator_scan_jobs").select("id, status").eq("kind", "show").eq("show_id", s.id).maybeSingle();
    if (!job) await sb.from("creator_scan_jobs").insert({ kind: "show", show_id: s.id });
    else if (job.status !== "running") await sb.from("creator_scan_jobs").update({ status: "queued", error: null, finished_at: null }).eq("id", job.id);
  }
  await audit(user.id, "creator.import_export", "order_buyer_usernames", null, null, {
    file: file.name,
    orders: parsed.orders,
    usernames: parsed.rows.length,
    missing: parsed.missingUsername,
    shows: ended?.length ?? 0,
  });
  kickCreatorScans(sb);
  revalidatePath("/creators");
}

export const importOrderExport = async (_p: ActionState, f: FormData) => run(_importExport, f);
