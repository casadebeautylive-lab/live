import Link from "next/link";
import { supabaseAdmin, supabaseServer } from "@/lib/supabase/clients";
import { loadShowSnapshot } from "@/lib/data/shows";
import { getAlertRules, getConnection, getTimezone } from "@/lib/data/context";
import { sweepIdleShows } from "@/lib/lifecycle";
import { LiveDashboard } from "@/components/LiveDashboard";
import { fmtTime } from "@/lib/format";

/** Active LIVE dashboard. Picks the running show (real before test), or ?show=. */
export default async function LivePage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { show: requested } = await searchParams;
  // TikTok sends no "LIVE ended" event: close auto-detected LIVEs that went quiet
  // (at their last order) every time this page loads, so it never depends on the scheduler.
  await sweepIdleShows(supabaseAdmin());

  const sb = await supabaseServer();
  const [{ data: running }, { data: settings }] = await Promise.all([
    sb
      .from("live_shows")
      .select("id, title, platform, is_test, started_at")
      .in("status", ["live", "paused"])
      .order("is_test", { ascending: true })
      .order("started_at", { ascending: false }),
    sb.from("app_settings").select("auto_show_idle_minutes").eq("id", 1).maybeSingle(),
  ]);

  let pickId = running?.find((s) => s.id === requested)?.id ?? running?.[0]?.id;
  if (!pickId && requested) pickId = requested; // allow viewing any show here too
  if (!pickId) {
    const { data: last } = await sb.from("live_shows").select("id").neq("status", "scheduled").order("started_at", { ascending: false }).limit(1);
    return (
      <div className="mx-auto mt-16 max-w-md text-center">
        <div className="label">No LIVE running</div>
        <h1 className="mt-2 text-2xl font-semibold">Go LIVE on TikTok — it appears here automatically</h1>
        <p className="mt-2 text-sm text-muted">
          With TikTok Shop connected, the first order of a LIVE opens its show here by itself, and it closes {settings?.auto_show_idle_minutes ?? 20} minutes
          after the last order.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link href="/shows" className="btn-primary">Start or schedule a show</Link>
          {last?.[0] && <Link href={`/shows/${last[0].id}`} className="btn">Last LIVE</Link>}
        </div>
      </div>
    );
  }

  const snap = await loadShowSnapshot(sb, pickId);
  if (!snap) return null;
  const [tz, rules, conn] = await Promise.all([getTimezone(sb), getAlertRules(sb), getConnection(sb, snap.meta.platform)]);

  return (
    <>
      <div className="mx-auto mb-4 flex max-w-[1400px] flex-wrap items-center gap-2">
        {running && running.length > 1 && (
          <div className="-mx-4 flex w-[calc(100%+2rem)] gap-2 overflow-x-auto px-4 sm:mx-0 sm:w-auto sm:px-0">
            {running.map((s) => (
              <a
                key={s.id}
                href={`/live?show=${s.id}`}
                className={`shrink-0 rounded-lg border px-3 py-2 text-sm ${s.id === pickId ? "border-gold bg-gold/10 text-gold" : "border-line text-muted hover:text-ink"}`}
              >
                {s.is_test ? "TEST · " : ""}
                {s.title}
                <span className="ml-1.5 text-xs text-faint">{fmtTime(s.started_at, tz, true)}</span>
              </a>
            ))}
          </div>
        )}
        <Link href={`/shows/${snap.meta.id}`} className="ml-auto text-sm text-muted hover:text-ink">Minute by minute →</Link>
      </div>
      <LiveDashboard key={snap.meta.id} initial={snap} timezone={tz} connection={conn} alertRules={rules} idleMinutes={settings?.auto_show_idle_minutes ?? 20} />
    </>
  );
}
