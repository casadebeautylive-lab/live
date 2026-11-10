import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/clients";

export async function POST(req: Request) {
  const sb = await supabaseServer();
  await sb.auth.signOut();
  return NextResponse.redirect(new URL("/login", req.url), { status: 303 });
}
