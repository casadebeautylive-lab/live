import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { currentUser } from "@/lib/supabase/clients";
import { serverEnv } from "@/lib/env";

/** Begin TikTok Shop seller authorization. Admins only. CSRF-protected with a state cookie. */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user?.canWrite) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!serverEnv.tiktok.configured()) {
    return NextResponse.redirect(new URL("/integrations?error=tiktok_not_configured", req.url));
  }
  const state = randomBytes(24).toString("base64url");
  const target = new URL(serverEnv.tiktok.authorizeUrl());
  target.searchParams.set("state", state);
  const res = NextResponse.redirect(target);
  res.cookies.set("tt_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/integrations/tiktok/callback",
    maxAge: 600,
  });
  return res;
}
