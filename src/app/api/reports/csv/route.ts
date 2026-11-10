import { supabaseServer } from "@/lib/supabase/clients";
import { getTimezone } from "@/lib/data/context";
import { loadReport, toCsv } from "@/lib/data/report";
import { resolveRange, type RangeKey } from "@/lib/dates";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const sb = await supabaseServer();
  const tz = await getTimezone(sb);
  const key = (u.searchParams.get("range") ?? "7d") as RangeKey;
  const range = resolveRange(tz, key, u.searchParams.get("from") ?? undefined, u.searchParams.get("to") ?? undefined);
  const platform = u.searchParams.get("platform");
  const rows = await loadReport(sb, {
    from: range.from,
    to: range.to,
    platform: platform && ["tiktok", "whatnot", "manual"].includes(platform) ? platform : undefined,
    includeTest: u.searchParams.get("test") === "1",
  });
  const name = `casadebeauty-shows-${range.from.toISOString().slice(0, 10)}-to-${range.to.toISOString().slice(0, 10)}.csv`;
  return new Response(toCsv(rows, tz), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` },
  });
}
