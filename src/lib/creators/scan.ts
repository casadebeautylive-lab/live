import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Decimal } from "@/lib/engine/money";
import { serverEnv } from "@/lib/env";
import { lookupProfiles } from "./apify";
import {
  budgetCheck,
  estimateCost,
  monthStartUtc,
  parseProfileItems,
  planLookups,
  uniqueBuyers,
  verifyBuyer,
  type CachedProfile,
  type LookupResult,
} from "./core";

/**
 * Creator scan pipeline (background, idempotent):
 *   show ends → queueShowScan (one job per show, enforced by a unique index)
 *   → processCreatorQueue: buyers → usernames → 30-day cache → Apify (profile-only, only
 *     new/stale usernames) → tiktok_profiles → creator_opportunities (15K+) → notification.
 * A single DB lock (app_settings.creator_scan_lock_until) stops overlapping workers.
 */

const CHUNK = 200;
const LOCK_MINUTES = 15;

type Settings = {
  creator_scan_enabled: boolean;
  creator_min_followers: number;
  creator_cache_days: number;
  apify_actor: string;
  apify_price_per_result: string;
  apify_monthly_limit_usd: string;
  creator_approval_over_usd: string;
};

async function settings(sb: SupabaseClient): Promise<Settings> {
  const { data } = await sb
    .from("app_settings")
    .select("creator_scan_enabled, creator_min_followers, creator_cache_days, apify_actor, apify_price_per_result, apify_monthly_limit_usd, creator_approval_over_usd")
    .eq("id", 1)
    .single();
  return data as Settings;
}

/**
 * Called when a show ends. Never throws: a scan problem must not block closing a show.
 */
export async function onShowEnded(sb: SupabaseClient, showId: string): Promise<void> {
  try {
    await queueShowScan(sb, showId);
    kickCreatorScans(sb);
  } catch (e) {
    console.error("[creators] could not queue scan", e);
  }
}

/** Queue the automatic scan for a finished show. Safe to call any number of times. */
export async function queueShowScan(sb: SupabaseClient, showId: string): Promise<void> {
  // Queued even while scans are paused, so resuming picks the show up.
  const { data: show } = await sb.from("live_shows").select("is_test").eq("id", showId).maybeSingle();
  if (!show || show.is_test) return;
  const { error } = await sb.from("creator_scan_jobs").insert({ kind: "show", show_id: showId });
  if (error && error.code !== "23505") throw error; // 23505 = already queued for this show
}

/** Start processing in the background without making the caller wait. */
export function kickCreatorScans(sb: SupabaseClient) {
  if (process.env.NODE_ENV === "test") return;
  void processCreatorQueue(sb).catch((e) => console.error("[creators] queue failed", e));
}

export async function spentThisMonth(sb: SupabaseClient, now = new Date()): Promise<Decimal> {
  const { data } = await sb
    .from("creator_scan_jobs")
    .select("actual_cost_usd, estimated_cost_usd, status")
    .gte("started_at", monthStartUtc(now))
    .in("status", ["running", "done", "failed"]);
  // A running job counts at its estimate so two jobs can't both squeeze under the limit.
  // Unknown/unsettled cost counts at the estimate, so jobs can't squeeze under the limit together.
  return (data ?? []).reduce((a, j: any) => a.plus(j.actual_cost_usd ?? j.estimated_cost_usd ?? 0), new Decimal(0));
}

async function acquireLock(sb: SupabaseClient): Promise<boolean> {
  const now = new Date();
  const until = new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString();
  const { data } = await sb
    .from("app_settings")
    .update({ creator_scan_lock_until: until })
    .eq("id", 1)
    .or(`creator_scan_lock_until.is.null,creator_scan_lock_until.lt.${now.toISOString()}`)
    .select("id");
  return (data?.length ?? 0) > 0;
}
const releaseLock = (sb: SupabaseClient) => sb.from("app_settings").update({ creator_scan_lock_until: null }).eq("id", 1);

/** Run queued jobs one at a time. Returns how many jobs it processed. */
export async function processCreatorQueue(sb: SupabaseClient, maxJobs = 10): Promise<number> {
  if (!(await acquireLock(sb))) return 0; // another worker is running
  let n = 0;
  try {
    // A job left 'running' by a crashed worker (lock expired) goes back to the queue; its usernames are re-checked against the cache.
    await sb
      .from("creator_scan_jobs")
      .update({ status: "queued" })
      .eq("status", "running")
      .lt("started_at", new Date(Date.now() - LOCK_MINUTES * 60_000).toISOString());
    for (; n < maxJobs; n++) {
      const cfg = await settings(sb);
      if (!cfg.creator_scan_enabled) break;
      const { data: job } = await sb.from("creator_scan_jobs").select("*").eq("status", "queued").order("created_at").limit(1).maybeSingle();
      if (!job) break;
      await runJob(sb, job, cfg).catch(async (e) => {
        await sb
          .from("creator_scan_jobs")
          .update({ status: "failed", error: String(e?.message ?? e).slice(0, 500), finished_at: new Date().toISOString() })
          .eq("id", job.id);
      });
      // keep the lock alive between jobs
      await sb.from("app_settings").update({ creator_scan_lock_until: new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() }).eq("id", 1);
    }
  } finally {
    await releaseLock(sb);
  }
  return n;
}

async function loadShowBuyers(sb: SupabaseClient, showId: string) {
  const rows: { orderId: string; nickname: string | null; customerId: string | null; avatar: string | null; exportUsername?: string | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("orders")
      .select("external_order_id, nickname:raw->>buyer_nickname, buyer:raw->>user_id, avatar:raw->>buyer_avatar")
      .eq("show_id", showId)
      .eq("status", "active")
      .range(from, from + 999);
    if (error) throw error;
    for (const r of data ?? []) rows.push({ orderId: String((r as any).external_order_id), nickname: (r as any).nickname ?? null, customerId: (r as any).buyer ?? null, avatar: (r as any).avatar ?? null });
    if (!data || data.length < 1000) break;
  }
  // exact @usernames uploaded from the Seller Center export
  const ids = rows.map((r) => r.orderId);
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await sb.from("order_buyer_usernames").select("external_order_id, username").in("external_order_id", ids.slice(i, i + 300));
    const m = new Map((data ?? []).map((d: any) => [d.external_order_id, d.username]));
    for (const r of rows) if (m.has(r.orderId)) r.exportUsername = m.get(r.orderId);
  }
  return rows;
}

async function orderAvatar(sb: SupabaseClient, showId: string, buyerId: string): Promise<string | null> {
  const { data } = await sb.from("orders").select("avatar:raw->>buyer_avatar").eq("show_id", showId).eq("raw->>user_id", buyerId).limit(1).maybeSingle();
  return (data as any)?.avatar ?? null;
}

async function loadCache(sb: SupabaseClient, usernames: string[]) {
  const m = new Map<string, CachedProfile & { scanCount: number; nickname: string | null; avatarUrl: string | null }>();
  for (let i = 0; i < usernames.length; i += 500) {
    const { data } = await sb
      .from("tiktok_profiles")
      .select("username, lookup, followers, scanned_at, scan_count, nickname, avatar_url")
      .in("username", usernames.slice(i, i + 500));
    for (const r of data ?? [])
      m.set(r.username, { username: r.username, lookup: r.lookup, followers: r.followers === null ? null : Number(r.followers), scannedAt: r.scanned_at, scanCount: r.scan_count, nickname: r.nickname, avatarUrl: r.avatar_url });
  }
  return m;
}

type JobRow = { id: string; kind: "show" | "retry" | "rescan" | "test"; show_id: string | null; usernames: string[]; approved_by: string | null };

async function runJob(sb: SupabaseClient, job: JobRow, cfg: Settings) {
  const now = new Date();
  // 1. who bought
  let buyers: { username: string; source?: "export" | "nickname"; nickname: string | null; customerId: string | null; avatar: string | null; orders: number; showId: string | null }[];
  let noHandle = 0;
  if (job.kind === "show" && job.show_id) {
    const u = uniqueBuyers(await loadShowBuyers(sb, job.show_id));
    buyers = u.buyers.map((b) => ({ ...b, showId: job.show_id }));
    noHandle = u.noHandle;
    // replace the show's buyer list (a re-scan after an export upload swaps guesses for exact usernames)
    await sb.from("show_buyers").delete().eq("show_id", job.show_id);
    if (buyers.length)
      await sb.from("show_buyers").upsert(
        buyers.map((b) => ({ show_id: job.show_id, username: b.username, username_source: b.source ?? "nickname", buyer_nickname: b.nickname, customer_id: b.customerId, orders: b.orders })),
        { onConflict: "show_id,username" },
      );
  } else {
    // Retry/rescan/test: reuse what the latest show knew about each buyer.
    const { data: seen } = await sb
      .from("show_buyers")
      .select("username, username_source, buyer_nickname, customer_id, show_id, live_shows(started_at)")
      .in("username", job.usernames);
    const k = new Map<string, any>();
    for (const r of (seen ?? []) as any[]) {
      const cur = k.get(r.username);
      if (!cur || (r.live_shows?.started_at ?? "") > (cur.live_shows?.started_at ?? "")) k.set(r.username, r);
    }
    buyers = await Promise.all(
      job.usernames.map(async (u) => {
        const r = k.get(u);
        return {
          username: u,
          source: (r?.username_source ?? "nickname") as "export" | "nickname",
          nickname: r?.buyer_nickname ?? null,
          customerId: r?.customer_id ?? null,
          avatar: r?.show_id && r?.customer_id ? await orderAvatar(sb, r.show_id, r.customer_id) : null,
          orders: 0,
          showId: r?.show_id ?? null,
        };
      }),
    );
  }

  // 2. cache
  const names = buyers.map((b) => b.username);
  const cache = await loadCache(sb, names);
  const { fresh, toScan } = planLookups(names, cache, cfg.creator_cache_days, now, job.kind === "rescan" || job.kind === "test");
  const estimate = estimateCost(toScan.length, cfg.apify_price_per_result);
  await sb
    .from("creator_scan_jobs")
    .update({ usernames: toScan, buyers: buyers.length, cached: fresh.length, no_handle: noHandle, estimated_cost_usd: estimate.toFixed(4) })
    .eq("id", job.id);

  // 3. budget + approval (nothing to buy → no check needed)
  if (toScan.length) {
    if (!serverEnv.apifyToken()) throw new Error("APIFY_TOKEN is not set in Railway variables — add it, then use Retry failed scans.");
    const decision = budgetCheck({
      estimate,
      spentThisMonth: await spentThisMonth(sb, now),
      monthlyLimit: new Decimal(cfg.apify_monthly_limit_usd),
      approvalOver: new Decimal(cfg.creator_approval_over_usd),
      approved: !!job.approved_by,
    });
    if (!decision.ok) {
      await sb
        .from("creator_scan_jobs")
        .update({ status: decision.reason === "budget" ? "paused_budget" : "needs_approval", error: decision.message })
        .eq("id", job.id);
      await notify(sb, {
        kind: decision.reason === "budget" ? "creator_budget" : "creator_approval",
        severity: "warning",
        message: `Creator scan ${decision.message} Open Creator Opportunities to review.`,
        dedupe: `creator_${decision.reason}:${job.id}`,
        showId: job.show_id,
      });
      return;
    }
  }
  await sb.from("creator_scan_jobs").update({ status: "running", started_at: now.toISOString(), error: null }).eq("id", job.id);

  // 4. Apify, in chunks; results saved after every chunk so a crash never pays twice
  const results: LookupResult[] = [];
  const runIds: string[] = [];
  let cost = 0;
  let costKnown = true;
  const price = Number(cfg.apify_price_per_result);
  for (let i = 0; i < toScan.length; i += CHUNK) {
    const chunk = toScan.slice(i, i + CHUNK);
    const run = await lookupProfiles(cfg.apify_actor, chunk, chunk.length * price * 1.25 + 0.01);
    runIds.push(run.runId);
    if (run.costUsd === null) costKnown = false;
    else cost += run.costUsd;
    const parsed = parseProfileItems(chunk, run.items);
    results.push(...parsed);
    await sb.from("tiktok_profiles").upsert(
      parsed.map((r) => ({
        username: r.username,
        lookup: r.lookup,
        followers: r.followers,
        nickname: r.nickname,
        tiktok_user_id: r.tiktokUserId,
        verified: r.verified,
        private_account: r.privateAccount,
        avatar_url: r.avatarUrl,
        bio_link: r.bioLink,
        error: r.error,
        scanned_at: new Date().toISOString(),
        scan_count: (cache.get(r.username)?.scanCount ?? 0) + 1,
      })),
      { onConflict: "username" },
    );
    await sb
      .from("creator_scan_jobs")
      .update({ apify_run_ids: runIds, actual_cost_usd: costKnown ? cost.toFixed(4) : null })
      .eq("id", job.id);
  }

  // 5. flag 15K+ (fresh cache hits count too)
  const profile = new Map<string, { followers: number | null; nickname: string | null; avatarUrl: string | null }>();
  for (const u of fresh) profile.set(u, { followers: cache.get(u)!.followers, nickname: cache.get(u)!.nickname, avatarUrl: cache.get(u)!.avatarUrl });
  for (const r of results) if (r.lookup === "found") profile.set(r.username, { followers: r.followers, nickname: r.nickname, avatarUrl: r.avatarUrl });
  // A different person's profile (avatar doesn't match the buyer's) is never flagged.
  const big = buyers.filter(
    (b) =>
      (profile.get(b.username)?.followers ?? -1) >= cfg.creator_min_followers &&
      (b.source === "export" || verifyBuyer(b.avatar, profile.get(b.username)?.avatarUrl) !== "mismatch"),
  );
  const flaggedNew = await flag(sb, job.kind === "test" ? [] : big, profile, job.kind === "show" ? job.show_id : null);

  const count = (k: LookupResult["lookup"]) => results.filter((r) => r.lookup === k).length;
  await sb
    .from("creator_scan_jobs")
    .update({
      status: "done",
      found: count("found"),
      not_found: count("not_found"),
      failed: count("failed"),
      flagged: big.length,
      actual_cost_usd: toScan.length === 0 ? "0" : costKnown ? cost.toFixed(4) : null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  if (big.length && job.kind === "show") {
    const { data: show } = await sb.from("live_shows").select("title").eq("id", job.show_id).maybeSingle();
    const k = (n: number) => (n >= 1000 ? `${Math.floor(n / 1000)}K` : String(n));
    await notify(sb, {
      kind: "creator_found",
      severity: "info",
      message: `${big.length} buyer${big.length === 1 ? "" : "s"} with ${k(cfg.creator_min_followers)}+ followers in “${show?.title ?? "your LIVE"}”${flaggedNew ? ` (${flaggedNew} new)` : ""}.`,
      dedupe: `creator_found:${job.id}`,
      showId: job.show_id,
    });
  }
}

async function flag(
  sb: SupabaseClient,
  big: { username: string; source?: "export" | "nickname"; nickname: string | null; customerId: string | null; avatar: string | null; showId: string | null }[],
  profile: Map<string, { followers: number | null; nickname: string | null; avatarUrl: string | null }>,
  showId: string | null,
): Promise<number> {
  if (!big.length) return 0;
  const { data: existing } = await sb.from("creator_opportunities").select("username").in("username", big.map((b) => b.username));
  const have = new Set((existing ?? []).map((r) => r.username));
  const fresh = big.filter((b) => !have.has(b.username));
  if (fresh.length)
    await sb.from("creator_opportunities").upsert(
      fresh.map((b) => ({
        username: b.username,
        buyer_nickname: b.nickname,
        customer_id: b.customerId,
        // 'name_match' = confirmed by avatar; 'handle_only' = unverified, check before contacting
        // exact username from the export, or same avatar → confirmed
        match: b.source === "export" || verifyBuyer(b.avatar, profile.get(b.username)?.avatarUrl) === "confirmed" ? "name_match" : "handle_only",
        first_show_id: b.showId,
        last_show_id: b.showId,
        followers_at_flag: profile.get(b.username)?.followers,
      })),
      { onConflict: "username", ignoreDuplicates: true },
    );
  // existing leads keep their status and notes; only "last seen in" moves
  if (showId && have.size)
    await sb
      .from("creator_opportunities")
      .update({ last_show_id: showId, updated_at: new Date().toISOString() })
      .in("username", [...have]);
  const nowExact = big.filter((b) => have.has(b.username) && b.source === "export").map((b) => b.username);
  if (nowExact.length) await sb.from("creator_opportunities").update({ match: "name_match" }).in("username", nowExact);
  return fresh.length;
}

async function notify(sb: SupabaseClient, n: { kind: string; severity: "info" | "warning"; message: string; dedupe: string; showId: string | null }) {
  await sb
    .from("notification_events")
    .upsert({ kind: n.kind, severity: n.severity, message: n.message, dedupe_key: n.dedupe, show_id: n.showId }, { onConflict: "dedupe_key", ignoreDuplicates: true });
}

/**
 * One summary notification per day (yesterday, in the reporting time zone), only if
 * something was scanned. Idempotent through the dedupe key.
 */
let lastSummaryCheck = "";
export async function maybeDailySummary(sb: SupabaseClient, tz: string, now = new Date()): Promise<void> {
  const today = now.toLocaleDateString("en-CA", { timeZone: tz });
  if (lastSummaryCheck === today) return;
  lastSummaryCheck = today;
  const y = new Date(now.getTime() - 86_400_000).toLocaleDateString("en-CA", { timeZone: tz });
  // a generous UTC window, filtered to the local date in JS
  const from = new Date(now.getTime() - 3 * 86_400_000).toISOString();
  const [{ data: jobs }, { data: opps }] = await Promise.all([
    sb.from("creator_scan_jobs").select("finished_at, found, actual_cost_usd, usernames").gte("finished_at", from).eq("status", "done"),
    sb.from("creator_opportunities").select("created_at, followers_at_flag").gte("created_at", from),
  ]);
  const local = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: tz });
  const js = (jobs ?? []).filter((j: any) => j.finished_at && local(j.finished_at) === y);
  if (!js.length) return;
  const os = (opps ?? []).filter((o: any) => local(o.created_at) === y);
  const looked = js.reduce((a, j: any) => a + (j.usernames?.length ?? 0), 0);
  const spent = js.reduce((a, j: any) => a + Number(j.actual_cost_usd ?? 0), 0);
  const big = (n: number) => os.filter((o: any) => Number(o.followers_at_flag ?? 0) >= n).length;
  await notify(sb, {
    kind: "creator_daily",
    severity: "info",
    message: `Creators yesterday: ${os.length} new opportunit${os.length === 1 ? "y" : "ies"} (${big(100_000)} with 100K+, ${big(50_000)} with 50K+). ${looked} profiles looked up for $${spent.toFixed(2)}.`,
    dedupe: `creator_daily:${y}`,
    showId: null,
  });
}
