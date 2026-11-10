import type { SupabaseClient } from "@supabase/supabase-js";
import type { AlertRule } from "@/lib/engine/alerts";
import type { ConnectionInfo } from "@/components/LiveDashboard";

export async function getTimezone(sb: SupabaseClient): Promise<string> {
  const { data } = await sb.from("app_settings").select("timezone").eq("id", 1).maybeSingle();
  return data?.timezone ?? "America/New_York";
}

export async function getAlertRules(sb: SupabaseClient): Promise<AlertRule[]> {
  const { data } = await sb.from("alert_rules").select("id, kind, threshold, enabled");
  return (data ?? []).map((r: any) => ({ id: r.id, kind: r.kind, threshold: Number(r.threshold), enabled: r.enabled }));
}

export async function getConnection(sb: SupabaseClient, platform: string): Promise<ConnectionInfo> {
  if (platform === "manual") return { platform, status: "manual", lastEventAt: null, lastSyncAt: null, lastError: null };
  const { data } = await sb
    .from("platform_connections")
    .select("platform, status, last_event_at, last_sync_at, last_error")
    .eq("platform", platform)
    .maybeSingle();
  return {
    platform,
    status: (data?.status as ConnectionInfo["status"]) ?? "pending_access",
    lastEventAt: data?.last_event_at ?? null,
    lastSyncAt: data?.last_sync_at ?? null,
    lastError: data?.last_error ?? null,
  };
}
