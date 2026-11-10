export function fmtDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined) return "—";
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function fmtTime(iso: string | null | undefined, tz: string, withDate = false): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    second: withDate ? undefined : "2-digit",
    ...(withDate ? { month: "short", day: "numeric" } : {}),
  }).format(new Date(iso));
}

export const PLATFORM_LABEL: Record<string, string> = {
  tiktok: "TikTok Shop",
  whatnot: "Whatnot",
  manual: "Manual / other",
};
