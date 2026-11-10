import { currentUser, supabaseServer } from "@/lib/supabase/clients";
import { getTimezone } from "@/lib/data/context";
import { INTEGRATIONS } from "@/lib/integrations/registry";
import { serverEnv } from "@/lib/env";
import { fmtTime } from "@/lib/format";
import { ActionForm } from "@/components/ActionForm";
import { disconnectTikTok, retryFailed, syncNow, syncShops } from "./actions";

const STATUS_STYLE: Record<string, string> = {
  connected: "border-pos/40 bg-pos/10 text-pos",
  pending_access: "border-warn/40 bg-warn/10 text-warn",
  disconnected: "border-line bg-panel-2 text-muted",
  error: "border-neg/40 bg-neg/10 text-neg",
};

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ error?: string; connected?: string; shops?: string }> }) {
  const sp = await searchParams;
  const sb = await supabaseServer();
  const user = await currentUser();
  const tz = await getTimezone(sb);
  const [{ data: conns }, { data: shops }, { data: events }, { count: failedCount }] = await Promise.all([
    sb.from("platform_connections").select("platform, status, last_sync_at, last_event_at, last_error, last_error_at, scopes"),
    sb.from("shops").select("platform, external_shop_id, name, region"),
    sb.from("webhook_events").select("id, platform, event_type, status, signature_valid, is_test, attempts, error, received_at").order("received_at", { ascending: false }).limit(30),
    sb.from("webhook_events").select("id", { count: "exact", head: true }).eq("status", "failed"),
  ]);
  const { data: jobs } = await sb.from("sync_jobs").select("*").order("started_at", { ascending: false }).limit(20);
  const tiktokConfigured = serverEnv.tiktok.configured();
  const canWrite = user?.canWrite ?? false;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">TikTok connection</h1>
        <p className="mt-1 text-sm text-muted">A platform shows Connected only after authorization succeeds. Nothing here is simulated.</p>
      </div>

      {sp.connected && <div className="rounded-lg border border-pos/40 bg-pos/10 px-4 py-2.5 text-sm text-pos">TikTok Shop authorized — {sp.shops ?? 0} shop(s) synced.</div>}
      {sp.error && (
        <div className="rounded-lg border border-neg/40 bg-neg/10 px-4 py-2.5 text-sm text-neg">
          {sp.error === "tiktok_not_configured"
            ? "TikTok app credentials are not set on the server (TIKTOK_APP_KEY, TIKTOK_APP_SECRET, TIKTOK_AUTHORIZE_URL)."
            : sp.error === "invalid_state"
              ? "Authorization was rejected: the security state did not match. Start again from this page."
              : `Authorization failed: ${sp.error}`}
        </div>
      )}

      {INTEGRATIONS.map((info) => {
        const c = conns?.find((x) => x.platform === info.platform);
        const status = c?.status ?? "pending_access";
        const platformShops = (shops ?? []).filter((s) => s.platform === info.platform);
        return (
          <section key={info.platform} className="card p-5">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-semibold">{info.name}</h2>
              <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider ${STATUS_STYLE[status]}`}>
                {status.replace("_", " ")}
              </span>
              <div className="ml-auto flex flex-wrap gap-2">
                {info.platform === "tiktok" && canWrite && (
                  <>
                    {status !== "connected" ? (
                      tiktokConfigured ? (
                        <a href="/api/integrations/tiktok/start" className="btn-primary">Authorize TikTok Shop</a>
                      ) : (
                        <span className="text-sm text-warn">Add TikTok app credentials on the server to enable authorization</span>
                      )
                    ) : (
                      <>
                        <ActionForm action={syncShops}><button className="btn">Re-sync shops</button></ActionForm>
                        <ActionForm action={disconnectTikTok} confirm="Disconnect TikTok Shop? Stored tokens are deleted."><button className="btn-danger">Disconnect</button></ActionForm>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
              <div><dt className="label">Last sync</dt><dd>{c?.last_sync_at ? fmtTime(c.last_sync_at, tz, true) : "never"}</dd></div>
              <div><dt className="label">Last order event</dt><dd>{c?.last_event_at ? fmtTime(c.last_event_at, tz, true) : "never"}</dd></div>
              <div><dt className="label">Orders</dt><dd>{info.realtimeOrders === "webhook" ? "Webhook + Order API" : "Not available"}</dd></div>
              <div><dt className="label">LIVE detection</dt><dd>{info.showDetection === "platform" ? "Automatic (room id)" : "Manual"}</dd></div>
            </dl>

            {c?.last_error && (
              <p className="mt-3 rounded-lg border border-neg/30 bg-neg/5 px-3 py-2 text-sm text-neg">
                Last error {c.last_error_at ? `(${fmtTime(c.last_error_at, tz, true)})` : ""}: {c.last_error}
              </p>
            )}
            {platformShops.length > 0 && (
              <p className="mt-3 text-sm text-muted">Shops: {platformShops.map((s) => `${s.name ?? s.external_shop_id} (${s.region ?? "?"})`).join(", ")}</p>
            )}
            {info.platform === "tiktok" && (
              <p className="mt-3 text-sm text-muted">
                Webhook URL to register in Partner Center: <code className="rounded bg-bg px-1.5 py-0.5 text-ink">{serverEnv.appUrl()}/api/webhooks/tiktok</code> (Order Status Change)
              </p>
            )}
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
              {info.notes.map((n) => <li key={n}>{n}</li>)}
            </ul>
          </section>
        );
      })}

      <section className="card p-5">
        <h2 className="label mb-1">Sync</h2>
        <p className="mb-3 text-sm text-muted">
          Runs automatically when the scheduler calls <code className="rounded bg-bg px-1 text-ink">/api/cron/sync</code> (every 5 min: <code className="text-ink">?job=live</code> · hourly:{" "}
          <code className="text-ink">?job=finance</code> · daily: <code className="text-ink">?job=daily</code>). You can also run a job now.
        </p>
        {canWrite && conns?.find((x) => x.platform === "tiktok")?.status === "connected" && (
          <div className="mb-4 flex flex-wrap gap-2">
            <ActionForm action={syncNow} className="flex gap-2" successText="Done.">
              <input type="hidden" name="job" value="orders" />
              <select name="days" defaultValue="2" className="input w-auto" aria-label="Days">
                {[1, 2, 7, 14, 30].map((d) => <option key={d} value={d}>last {d} day{d > 1 ? "s" : ""}</option>)}
              </select>
              <button className="btn">Import orders</button>
            </ActionForm>
            <ActionForm action={syncNow} successText="Done."><input type="hidden" name="job" value="finance" /><button className="btn">Sync fees & settlements</button></ActionForm>
            <ActionForm action={syncNow} successText="Done."><input type="hidden" name="job" value="packages" /><button className="btn">Sync packages</button></ActionForm>
            <ActionForm action={syncNow} successText="Done."><input type="hidden" name="job" value="live_sessions" /><input type="hidden" name="days" value="3" /><button className="btn">Confirm LIVE times</button></ActionForm>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Started</th><th>Job</th><th>Status</th><th>Result</th></tr></thead>
            <tbody>
              {(jobs ?? []).map((j: any) => (
                <tr key={j.id}>
                  <td className="num whitespace-nowrap text-muted">{fmtTime(j.started_at, tz, true)}</td>
                  <td>{j.kind.replace("_", " ")}</td>
                  <td className={j.status === "succeeded" ? "text-pos" : j.status === "failed" ? "text-neg" : "text-muted"}>{j.status}</td>
                  <td className="max-w-[420px] truncate text-xs text-muted" title={j.error ?? JSON.stringify(j.stats ?? {})}>{j.error ?? (j.stats ? Object.entries(j.stats).map(([k, v]) => `${k}: ${v}`).join(" · ") : "")}</td>
                </tr>
              ))}
              {!jobs?.length && <tr><td colSpan={4} className="py-4 text-center text-faint">No sync jobs yet</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card p-5">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="label">Incoming events</h2>
          {failedCount ? <span className="text-sm text-neg">{failedCount} failed</span> : <span className="text-sm text-muted">no failures</span>}
          {canWrite && !!failedCount && (
            <ActionForm action={retryFailed} className="ml-auto" successText="Retried.">
              <button className="btn">Retry failed TikTok events</button>
            </ActionForm>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Received</th><th>Source</th><th>Type</th><th>Status</th><th>Signature</th><th>Attempts</th><th>Error</th></tr></thead>
            <tbody>
              {(events ?? []).map((e) => (
                <tr key={e.id}>
                  <td className="num whitespace-nowrap text-muted">{fmtTime(e.received_at, tz, true)}</td>
                  <td>{e.platform}{e.is_test && <span className="text-info"> · test</span>}</td>
                  <td className="text-muted">{e.event_type}</td>
                  <td className={e.status === "processed" ? "text-pos" : e.status === "failed" || e.status === "rejected" ? "text-neg" : "text-muted"}>{e.status}</td>
                  <td>{e.signature_valid ? "valid" : <span className="text-neg">invalid</span>}</td>
                  <td className="num">{e.attempts}</td>
                  <td className="max-w-[320px] truncate text-xs text-muted" title={e.error ?? ""}>{e.error}</td>
                </tr>
              ))}
              {!events?.length && <tr><td colSpan={7} className="py-6 text-center text-faint">No events received yet</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
