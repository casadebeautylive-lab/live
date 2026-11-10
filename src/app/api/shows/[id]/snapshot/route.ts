import { NextResponse } from "next/server";
import { supabaseAdmin, supabaseServer } from "@/lib/supabase/clients";
import { sweepIdleShows } from "@/lib/lifecycle";
import { loadShowSnapshot } from "@/lib/data/shows";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await supabaseServer(); // RLS: members only
  const { data: auth } = await sb.auth.getClaims();
  if (auth?.claims?.sub) await sweepIdleShows(supabaseAdmin());
  const snap = await loadShowSnapshot(sb, id);
  if (!snap) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(snap, { headers: { "cache-control": "no-store" } });
}
