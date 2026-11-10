import "server-only";
import { serverEnv } from "@/lib/env";

const API = "https://api.apify.com/v2";
/**
 * Top-level fields only (the dataset API can't pick nested fields — "authorMeta.fans" returns
 * nothing). Profile-only mode returns no videos, comments or follower lists anyway.
 */
const FIELDS = "input,error,errorDescription,reason,error_kind,status,authorMeta";

export type ApifyRun = { runId: string; status: string; items: unknown[]; costUsd: number | null };

async function call(path: string, init?: RequestInit) {
  const token = serverEnv.apifyToken();
  if (!token) throw new Error("APIFY_TOKEN is not set in Railway variables");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Apify ${res.status}: ${body?.error?.message ?? res.statusText}`);
  return body;
}

/**
 * Look up TikTok profiles in profile-only mode (resultsPerPage 0 = one row per
 * username, no posts). Waits for the run, then reads the dataset and Apify's own
 * charge for the run.
 */
export async function lookupProfiles(actor: string, usernames: string[], maxChargeUsd: number): Promise<ApifyRun> {
  const input = { profiles: usernames, resultsPerPage: 0, excludePinnedPosts: true };
  // Hard caps enforced by Apify itself: never more rows than usernames, never more than the approved spend.
  const q = `waitForFinish=60&maxItems=${usernames.length}&maxTotalChargeUsd=${maxChargeUsd.toFixed(4)}`;
  const started = await call(`/acts/${actor.replace("/", "~")}/runs?${q}`, { method: "POST", body: JSON.stringify(input) });
  let run = started.data;
  const deadline = Date.now() + 8 * 60_000;
  while (!["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(run.status) && Date.now() < deadline) {
    run = (await call(`/actor-runs/${run.id}?waitForFinish=60`)).data;
  }
  if (!["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(run.status)) {
    await call(`/actor-runs/${run.id}/abort`, { method: "POST" }).catch(() => {});
    run.status = "ABORTED";
  }
  const items = run.defaultDatasetId
    ? ((await call(`/datasets/${run.defaultDatasetId}/items?clean=true&format=json&fields=${encodeURIComponent(FIELDS)}`)) as unknown[])
    : [];
  // Re-read the run: Apify settles the charge a moment after the run finishes
  // (right away it can still say $0 for a run that returned paid results).
  let final = run;
  let cost: number | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    final = (await call(`/actor-runs/${run.id}`).catch(() => ({ data: final }))).data;
    cost = chargedUsd(final);
    if (cost !== null && (cost > 0 || items.length === 0)) break;
    cost = null; // not settled yet → unknown, never a false $0
    await new Promise((r) => setTimeout(r, 2500));
  }
  return { runId: run.id, status: final.status ?? run.status, items: Array.isArray(items) ? items : [], costUsd: cost };
}

/**
 * What the run charged you. For pay-per-event Actors Apify reports the event charges
 * in usageTotalUsd (platform usage is paid by the developer), e.g. 2 profiles → 0.0015.
 * null when Apify didn't report it.
 */
export function chargedUsd(run: any): number | null {
  if (typeof run?.usageTotalUsd === "number") return run.usageTotalUsd;
  const ev = run?.eventUsage;
  if (ev && typeof ev === "object") {
    const vals = Object.values(ev).map((e: any) => e?.eventTotalUsd);
    if (vals.length && vals.every((v) => typeof v === "number")) return (vals as number[]).reduce((a, b) => a + b, 0);
  }
  return null;
}
