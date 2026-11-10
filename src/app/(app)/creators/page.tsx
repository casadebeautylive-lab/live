import Link from "next/link";
import { currentUser, supabaseAdmin, supabaseServer } from "@/lib/supabase/clients";
import { getTimezone } from "@/lib/data/context";
import { fmtTime } from "@/lib/format";
import { ActionForm } from "@/components/ActionForm";
import { CopyMessage, NotesField, StatusSelect } from "@/components/CreatorControls";
import { Empty, Kpi, PageHeader } from "@/components/ui";
import { fillTemplate, fmtFollowers, monthStartUtc, STATUSES, tierOf } from "@/lib/creators/core";
import {
  approveScan,
  cancelScan,
  importOrderExport,
  rescanCreator,
  retryFailedScans,
  saveCreatorNotes,
  saveCreatorSettings,
  scanShow,
  setCreatorStatus,
  testLookup,
} from "./actions";

type SP = { q?: string; tier?: string; status?: string; show?: string; sort?: string };

const SORTS: [string, string][] = [
  ["followers", "Most followers"],
  ["newest", "Newest"],
  ["recent_show", "Most recent LIVE"],
];
const TIERS: [string, string, number][] = [
  ["15k", "15K+", 15_000],
  ["50k", "50K+", 50_000],
  ["100k", "100K+", 100_000],
];
const JOB_LABEL: Record<string, [string, string]> = {
  queued: ["Queued", "text-info"],
  needs_approval: ["Needs approval", "text-warn"],
  running: ["Running", "text-pos"],
  done: ["Done", "text-muted"],
  failed: ["Failed", "text-neg"],
  paused_budget: ["Paused — limit", "text-warn"],
  cancelled: ["Cancelled", "text-faint"],
};

export default async function CreatorsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const sb = await supabaseServer();
  const user = await currentUser();
  const canWrite = user?.canWrite ?? false;
  const tz = await getTimezone(sb);

  const [{ data: cfg }, { data: opps }, { data: jobs }, { data: monthJobs }, { data: lastScan }, { data: recentShows }, { data: alerts }] = await Promise.all([
    sb
      .from("app_settings")
      .select("creator_scan_enabled, creator_min_followers, creator_cache_days, apify_actor, apify_price_per_result, apify_monthly_limit_usd, creator_approval_over_usd, creator_message_template")
      .eq("id", 1)
      .single(),
    sb.from("creator_opportunities").select("*").order("created_at", { ascending: false }).limit(2000),
    sb.from("creator_scan_jobs").select("id, kind, show_id, status, buyers, cached, no_handle, found, not_found, failed, flagged, usernames, estimated_cost_usd, actual_cost_usd, error, created_at, finished_at, live_shows(title)").order("created_at", { ascending: false }).limit(15),
    sb.from("creator_scan_jobs").select("actual_cost_usd, estimated_cost_usd, usernames").gte("started_at", monthStartUtc(new Date())).in("status", ["running", "done", "failed"]),
    sb.from("creator_scan_jobs").select("show_id, finished_at, live_shows(title, started_at)").eq("kind", "show").eq("status", "done").order("finished_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("live_shows").select("id, title, started_at").eq("is_test", false).not("ended_at", "is", null).order("started_at", { ascending: false }).limit(30),
    sb.from("notification_events").select("id, message, severity, created_at").like("kind", "creator_%").order("created_at", { ascending: false }).limit(5),
  ]);

  // opening this page = the creator notifications have been seen
  await supabaseAdmin().from("notification_events").update({ read_at: new Date().toISOString() }).like("kind", "creator_%").is("read_at", null);

  const { data: lastImport } = await sb.from("order_buyer_usernames").select("imported_at").order("imported_at", { ascending: false }).limit(1).maybeSingle();

  const usernames = (opps ?? []).map((o) => o.username);
  const showIds = [...new Set((opps ?? []).flatMap((o) => [o.first_show_id, o.last_show_id]).filter(Boolean))] as string[];
  const lastShowId = (lastScan as any)?.show_id ?? null;
  const jobUsers = (jobs ?? []).filter((j: any) => j.kind !== "show").flatMap((j: any) => j.usernames as string[]);
  const lookupNames = [...new Set([...usernames, ...jobUsers])];
  const [{ data: profiles }, { data: shows }, { data: lastBuyers }, { data: scannedShows }] = await Promise.all([
    lookupNames.length ? sb.from("tiktok_profiles").select("username, followers, nickname, verified, scanned_at, lookup").in("username", lookupNames) : Promise.resolve({ data: [] as any[] }),
    showIds.length ? sb.from("live_shows").select("id, title, started_at").in("id", showIds) : Promise.resolve({ data: [] as any[] }),
    lastShowId ? sb.from("show_buyers").select("username").eq("show_id", lastShowId) : Promise.resolve({ data: [] as any[] }),
    sb.from("creator_scan_jobs").select("show_id").eq("kind", "show").not("status", "in", "(failed,cancelled)"),
  ]);
  const prof = new Map((profiles ?? []).map((p: any) => [p.username, p]));
  const showMap = new Map((shows ?? []).map((s: any) => [s.id, s]));
  const lastSet = new Set((lastBuyers ?? []).map((b: any) => b.username));
  const scanned = new Set((scannedShows ?? []).map((j: any) => j.show_id));
  const unscanned = (recentShows ?? []).filter((s) => !scanned.has(s.id));

  const rows = (opps ?? []).map((o) => {
    const p = prof.get(o.username);
    const followers: number | null = p?.lookup === "found" && p.followers !== null ? Number(p.followers) : o.followers_at_flag !== null ? Number(o.followers_at_flag) : null;
    return { ...o, followers, profile: p, lastShow: showMap.get(o.last_show_id), firstShow: showMap.get(o.first_show_id) };
  });

  const atLeast = (n: number) => rows.filter((r) => (r.followers ?? 0) >= n).length;
  const cards = {
    lastShow: rows.filter((r) => lastSet.has(r.username)).length,
    k15: atLeast(15_000),
    k50: atLeast(50_000),
    k100: atLeast(100_000),
    total: rows.length,
    notContacted: rows.filter((r) => r.status === "not_contacted").length,
  };

  // filters
  const q = (sp.q ?? "").trim().toLowerCase().replace(/^@/, "");
  const tierMin = TIERS.find(([k]) => k === sp.tier)?.[2] ?? 0;
  let list = rows.filter(
    (r) =>
      (!q || r.username.includes(q) || (r.buyer_nickname ?? "").toLowerCase().includes(q) || (r.profile?.nickname ?? "").toLowerCase().includes(q)) &&
      (r.followers ?? 0) >= tierMin &&
      (!sp.status || r.status === sp.status) &&
      (sp.show !== "last" || lastSet.has(r.username)),
  );
  const sort = SORTS.some(([k]) => k === sp.sort) ? sp.sort! : "followers";
  list = [...list].sort((a, b) =>
    sort === "newest"
      ? b.created_at.localeCompare(a.created_at)
      : sort === "recent_show"
        ? (b.lastShow?.started_at ?? "").localeCompare(a.lastShow?.started_at ?? "")
        : (b.followers ?? -1) - (a.followers ?? -1),
  );

  const spent = (monthJobs ?? []).reduce((a, j: any) => a + Number(j.actual_cost_usd ?? j.estimated_cost_usd ?? 0), 0);
  const looked = (monthJobs ?? []).reduce((a, j: any) => a + (j.usernames?.length ?? 0), 0);
  const limit = Number(cfg?.apify_monthly_limit_usd ?? 20);
  const tpl = cfg?.creator_message_template ?? "";
  const hasFailed = (jobs ?? []).some((j: any) => j.status === "failed" || j.status === "paused_budget" || j.failed > 0);
  const qs = (over: Partial<SP>) => {
    const p = new URLSearchParams(Object.entries({ ...sp, ...over }).filter(([, v]) => v) as [string, string][]);
    const s = p.toString();
    return s ? `/creators?${s}` : "/creators";
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Creator Opportunities"
        sub={`Buyers with ${fmtFollowers(cfg?.creator_min_followers ?? 15000)}+ TikTok followers, found automatically after each LIVE. Unknown means the lookup failed — never zero.`}
      >
        {canWrite && hasFailed && (
          <ActionForm action={retryFailedScans}>
            <button className="btn">Retry failed scans</button>
          </ActionForm>
        )}
      </PageHeader>

      {!!alerts?.length && (
        <div className="space-y-1.5">
          {alerts.slice(0, 2).map((a) => (
            <div key={a.id} className={`rounded-lg border px-3 py-2 text-sm ${a.severity === "warning" ? "border-warn/40 bg-warn/10 text-warn" : "border-info/40 bg-info/10 text-info"}`}>
              <span className="num mr-2 text-xs opacity-70">{fmtTime(a.created_at, tz, true)}</span>
              {a.message}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Link href={qs({ show: sp.show === "last" ? undefined : "last" })}>
          <Kpi label="Last LIVE" value={String(cards.lastShow)} hint={(lastScan as any)?.live_shows?.title ?? "No scan yet"} toneClass={sp.show === "last" ? "text-gold" : "text-ink"} />
        </Link>
        {TIERS.map(([k, label]) => (
          <Link key={k} href={qs({ tier: sp.tier === k ? undefined : k })}>
            <Kpi label={label} value={String(k === "15k" ? cards.k15 : k === "50k" ? cards.k50 : cards.k100)} toneClass={sp.tier === k ? "text-gold" : "text-ink"} />
          </Link>
        ))}
        <Link href={qs({ tier: undefined, status: undefined, show: undefined, q: undefined })}>
          <Kpi label="Total" value={String(cards.total)} />
        </Link>
        <Link href={qs({ status: sp.status === "not_contacted" ? undefined : "not_contacted" })}>
          <Kpi label="Not contacted" value={String(cards.notContacted)} toneClass={sp.status === "not_contacted" ? "text-gold" : "text-ink"} />
        </Link>
      </div>

      {canWrite && (
        <div className="card flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-0 flex-1 basis-64">
            <div className="font-medium">Upload the TikTok orders file after each LIVE</div>
            <div className="text-xs text-muted">
              Seller Center → Orders → Export (CSV). It has every buyer&apos;s real @username, so all buyers can be looked up, not just the ones whose name looks like a username.
              Only order numbers and usernames are saved.
              {lastImport?.imported_at && <> Last upload: {fmtTime(lastImport.imported_at, tz, true)}.</>}
            </div>
          </div>
          <ActionForm action={importOrderExport} className="flex flex-wrap items-center gap-2" resetOnSuccess successText="Uploaded — the LIVE is being scanned. See Scans below.">
            <input type="file" name="file" accept=".csv,text/csv" required className="max-w-[220px] text-xs file:mr-2 file:rounded-md file:border-0 file:bg-panel-2 file:px-3 file:py-1.5 file:text-ink" />
            <button className="btn-primary py-1.5">Upload</button>
          </ActionForm>
        </div>
      )}

      {/* filters */}
      <form className="card flex flex-wrap items-end gap-2 p-3" action="/creators">
        <input name="q" defaultValue={sp.q ?? ""} placeholder="Search @username or name" className="input min-w-0 flex-1 basis-48 py-1.5 text-sm" />
        <select name="tier" defaultValue={sp.tier ?? ""} className="input w-auto py-1.5 text-sm" aria-label="Followers">
          <option value="">All followers</option>
          {TIERS.map(([k, l]) => (
            <option key={k} value={k}>{l}</option>
          ))}
        </select>
        <select name="status" defaultValue={sp.status ?? ""} className="input w-auto py-1.5 text-sm" aria-label="Status">
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        <select name="sort" defaultValue={sort} className="input w-auto py-1.5 text-sm" aria-label="Sort">
          {SORTS.map(([k, l]) => (
            <option key={k} value={k}>{l}</option>
          ))}
        </select>
        {sp.show === "last" && <input type="hidden" name="show" value="last" />}
        <button className="btn-primary py-1.5">Filter</button>
        {(sp.q || sp.tier || sp.status || sp.show) && (
          <Link href="/creators" className="btn py-1.5">Clear</Link>
        )}
      </form>

      {/* opportunities */}
      {list.length === 0 ? (
        <Empty>
          {rows.length === 0
            ? "No creators yet. After a LIVE ends its buyers are looked up automatically; anyone with enough followers shows up here."
            : "No creators match these filters."}
        </Empty>
      ) : (
        <div className="space-y-2">
          <div className="hidden grid-cols-[minmax(0,1.6fr)_90px_minmax(0,1.1fr)_150px_minmax(0,1.3fr)_120px] gap-3 px-4 text-[11px] uppercase tracking-wider text-faint lg:grid">
            <span>Creator</span>
            <span className="text-right">Followers</span>
            <span>Bought in</span>
            <span>Status</span>
            <span>Notes</span>
            <span />
          </div>
          {list.map((r) => {
            const tier = tierOf(r.followers);
            return (
              <div key={r.username} className="card grid gap-3 p-3 lg:grid-cols-[minmax(0,1.6fr)_90px_minmax(0,1.1fr)_150px_minmax(0,1.3fr)_120px] lg:items-start lg:px-4">
                <div className="min-w-0">
                  <a href={`https://www.tiktok.com/@${r.username}`} target="_blank" rel="noopener noreferrer" className="font-medium text-ink hover:text-gold">
                    @{r.username}
                  </a>
                  {r.profile?.verified && <span className="ml-1 text-info" title="Verified">✓</span>}
                  <div className="truncate text-xs text-muted">
                    {r.profile?.nickname ?? "—"}
                    {r.buyer_nickname && r.buyer_nickname !== r.username && <span className="text-faint"> · order name: {r.buyer_nickname}</span>}
                  </div>
                  {r.match === "name_match" && <div className="mt-0.5 text-[11px] text-pos">✓ Confirmed buyer (same profile photo)</div>}
                  {r.match === "handle_only" && (
                    <div className="mt-0.5 text-[11px] text-warn" title="The order only had a nickname. Open the profile to confirm it's your buyer before reaching out.">
                      Check it&apos;s the same person
                    </div>
                  )}
                </div>
                <div className="flex items-baseline justify-between lg:block lg:text-right">
                  <span className="text-xs text-faint lg:hidden">Followers</span>
                  <span>
                    <span className={`num font-semibold ${tier === "100k" ? "text-gold" : "text-ink"}`}>{fmtFollowers(r.followers)}</span>
                    {r.profile?.scanned_at && <div className="text-[10px] text-faint">{fmtTime(r.profile.scanned_at, tz, true).split(",")[0]}</div>}
                  </span>
                </div>
                <div className="min-w-0 text-xs">
                  {r.lastShow ? (
                    <Link href={`/shows/${r.last_show_id}`} className="block truncate text-muted hover:text-ink">{r.lastShow.title}</Link>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                  {r.firstShow && r.first_show_id !== r.last_show_id && <div className="truncate text-faint">first: {r.firstShow.title}</div>}
                </div>
                <StatusSelect action={setCreatorStatus} username={r.username} value={r.status} options={STATUSES} disabled={!canWrite} />
                <NotesField action={saveCreatorNotes} username={r.username} value={r.notes ?? ""} disabled={!canWrite} />
                <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-1">
                  <CopyMessage text={fillTemplate(tpl, { username: r.username, nickname: r.profile?.nickname ?? null })} />
                  {canWrite && (
                    <ActionForm action={rescanCreator} confirm={`Look up @${r.username} again? (~$${Number(cfg?.apify_price_per_result ?? 0.00075).toFixed(5)})`}>
                      <input type="hidden" name="username" value={r.username} />
                      <button className="btn w-full py-1.5 text-xs">Rescan</button>
                    </ActionForm>
                  )}
                </div>
              </div>
            );
          })}
          {list.length > 0 && <p className="px-1 text-xs text-faint">{list.length} creator{list.length === 1 ? "" : "s"}</p>}
        </div>
      )}

      {/* scans & cost */}
      <section className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="card p-4">
          <div className="mb-3 flex flex-wrap items-baseline gap-2">
            <h2 className="label">Scans</h2>
            <span className="ml-auto text-xs text-faint">{cfg?.creator_scan_enabled ? "Automatic after every LIVE" : "Paused"}</span>
          </div>
          {!jobs?.length ? (
            <p className="text-sm text-muted">No scans yet.</p>
          ) : (
            <div className="divide-y divide-line/60 text-sm">
              {jobs.map((j: any) => {
                const [label, cls] = JOB_LABEL[j.status] ?? [j.status, "text-muted"];
                const title = j.kind === "show" ? j.live_shows?.title ?? "LIVE" : j.kind === "test" ? `Test: ${j.usernames.map((u: string) => "@" + u).join(", ")}` : j.kind === "rescan" ? `Rescan @${j.usernames[0] ?? ""}` : `Retry ${j.usernames.length} failed`;
                return (
                  <div key={j.id} className="py-2">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="min-w-0 flex-1 truncate">{title}</span>
                      <span className={`text-xs font-medium ${cls}`}>{label}</span>
                    </div>
                    <div className="num mt-0.5 text-xs text-faint">
                      {fmtTime(j.created_at, tz, true)}
                      {j.kind === "show" && ` · ${j.buyers} buyers`}
                      {j.cached > 0 && ` · ${j.cached} cached`}
                      {j.no_handle > 0 && ` · ${j.no_handle} no username`}
                      {j.status === "done" && ` · ${j.found} found${j.not_found ? `, ${j.not_found} not found` : ""}${j.failed ? `, ${j.failed} unknown` : ""} · ${j.flagged} flagged`}
                      {" · "}
                      {j.actual_cost_usd !== null ? `$${Number(j.actual_cost_usd).toFixed(4)} charged` : `~$${Number(j.estimated_cost_usd).toFixed(4)} est.`}
                    </div>
                    {j.kind !== "show" && j.status === "done" && (
                      <div className="num mt-0.5 text-xs text-muted">
                        {j.usernames.map((u: string) => {
                          const p = prof.get(u);
                          return `@${u}: ${p?.lookup === "found" ? fmtFollowers(p.followers === null ? null : Number(p.followers)) + " followers" : p?.lookup === "not_found" ? "not found" : "Unknown"}`;
                        }).join(" · ")}
                      </div>
                    )}
                    {j.error && <div className="mt-0.5 text-xs text-warn">{j.error}</div>}
                    {canWrite && ["needs_approval", "paused_budget"].includes(j.status) && (
                      <div className="mt-1.5 flex gap-2">
                        <ActionForm action={approveScan} confirm={`Approve this scan for about $${Number(j.estimated_cost_usd).toFixed(2)}?`}>
                          <input type="hidden" name="jobId" value={j.id} />
                          <button className="btn-primary py-1 text-xs">Approve ~${Number(j.estimated_cost_usd).toFixed(2)}</button>
                        </ActionForm>
                        <ActionForm action={cancelScan}>
                          <input type="hidden" name="jobId" value={j.id} />
                          <button className="btn py-1 text-xs">Cancel</button>
                        </ActionForm>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="card p-4">
            <h2 className="label mb-2">Apify spend this month</h2>
            <div className="num text-2xl font-semibold">
              ${spent.toFixed(2)} <span className="text-sm font-normal text-faint">of ${limit.toFixed(2)}</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel-2">
              <div className={`h-full ${spent / (limit || 1) > 0.8 ? "bg-warn" : "bg-gold"}`} style={{ width: `${Math.min(100, (spent / (limit || 1)) * 100)}%` }} />
            </div>
            <p className="mt-2 text-xs text-faint">
              {looked} profile lookups · ${Number(cfg?.apify_price_per_result ?? 0).toFixed(5)} each · each username is looked up at most once per {cfg?.creator_cache_days ?? 30} days.
              Scans pause automatically at the limit.
            </p>
          </div>

          {canWrite && (
            <div className="card space-y-3 p-4">
              <h2 className="label">Scan an earlier LIVE</h2>
              {unscanned.length ? (
                <ActionForm action={scanShow} className="flex gap-2">
                  <select name="showId" className="input min-w-0 flex-1 py-1.5 text-sm" aria-label="Show">
                    {unscanned.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title} · {fmtTime(s.started_at, tz, true).split(",")[0]}
                      </option>
                    ))}
                  </select>
                  <button className="btn py-1.5">Scan</button>
                </ActionForm>
              ) : (
                <p className="text-sm text-muted">Every recent LIVE has been scanned.</p>
              )}
              <p className="text-xs text-faint">Shows that ended before this feature are never scanned on their own. Scans over ${Number(cfg?.creator_approval_over_usd ?? 1).toFixed(2)} wait for your approval.</p>
              <h2 className="label border-t border-line/60 pt-3">Test lookup</h2>
              <ActionForm action={testLookup} className="flex gap-2" successText="Done — see Scans.">
                <input name="usernames" placeholder="1–5 usernames, e.g. nasa" className="input min-w-0 flex-1 py-1.5 text-sm" />
                <button className="btn py-1.5">Look up</button>
              </ActionForm>
            </div>
          )}
        </div>
      </section>

      {canWrite && (
        <details className="card p-4">
          <summary className="label cursor-pointer">Creator settings & message</summary>
          <ActionForm action={saveCreatorSettings} className="mt-4 grid gap-3 md:grid-cols-2" successText="Saved.">
            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <input type="checkbox" name="enabled" defaultChecked={cfg?.creator_scan_enabled ?? true} className="h-4 w-4 accent-[#d9b26b]" />
              Scan buyers automatically after each LIVE
            </label>
            <Num name="min_followers" label="Flag buyers with at least (followers)" value={String(cfg?.creator_min_followers ?? 15000)} />
            <Num name="monthly_limit" label="Monthly Apify limit ($)" value={Number(cfg?.apify_monthly_limit_usd ?? 20).toFixed(2)} />
            <Num name="approval_over" label="Ask before scans estimated over ($)" value={Number(cfg?.creator_approval_over_usd ?? 1).toFixed(2)} />
            <Num name="price" label="Apify price per profile ($, from your plan)" value={Number(cfg?.apify_price_per_result ?? 0.00075).toFixed(5)} />
            <label className="block md:col-span-2">
              <span className="mb-1.5 block text-sm text-muted">Copy message — {"{name}"} becomes their TikTok name</span>
              <textarea name="template" defaultValue={tpl} rows={3} className="input w-full text-sm" />
            </label>
            <p className="text-xs text-faint md:col-span-2">Lookups use the Apify Actor {cfg?.apify_actor} in profile-only mode (no videos). Messages are only copied — nothing is ever sent on TikTok automatically.</p>
            <button className="btn-primary w-fit">Save</button>
          </ActionForm>
        </details>
      )}
    </div>
  );
}

function Num({ name, label, value }: { name: string; label: string; value: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-muted">{label}</span>
      <input name={name} defaultValue={value} inputMode="decimal" required className="input num w-full" />
    </label>
  );
}
