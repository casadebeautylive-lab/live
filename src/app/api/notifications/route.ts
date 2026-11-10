import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser, supabaseAdmin } from "@/lib/supabase/clients";

const Body = z.object({
  showId: z.uuid(),
  alerts: z
    .array(
      z.object({
        ruleId: z.uuid(),
        kind: z.string().max(64),
        severity: z.enum(["warning", "critical"]),
        message: z.string().max(300),
        dedupeKey: z.string().max(200),
      }),
    )
    .max(20),
});

/** Record alerts fired by an open dashboard. Duplicate keys are ignored, so many viewers produce one alert. */
export async function POST(req: Request) {
  if (!(await currentUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { showId, alerts } = parsed.data;
  await supabaseAdmin()
    .from("notification_events")
    .upsert(
      alerts.map((a) => ({ show_id: showId, rule_id: a.ruleId, kind: a.kind, severity: a.severity, message: a.message, dedupe_key: a.dedupeKey })),
      { onConflict: "dedupe_key", ignoreDuplicates: true },
    );
  return NextResponse.json({ ok: true });
}
