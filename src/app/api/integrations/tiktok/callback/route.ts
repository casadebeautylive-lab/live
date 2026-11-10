import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { audit, currentUser, supabaseAdmin } from "@/lib/supabase/clients";
import { exchangeAuthCode, storeTokens, syncAuthorizedShops } from "@/lib/integrations/tiktok/client";

/**
 * OAuth callback: https://<your-app-domain>/api/integrations/tiktok/callback
 * Verifies state, exchanges the code server-side, stores encrypted tokens, syncs shops.
 */
export async function GET(req: NextRequest) {
  const back = (q: string) => {
    const res = NextResponse.redirect(new URL(`/integrations?${q}`, req.url));
    res.cookies.delete({ name: "tt_oauth_state", path: "/api/integrations/tiktok/callback" });
    return res;
  };

  const user = await currentUser();
  if (!user?.canWrite) return back("error=forbidden");

  const state = req.nextUrl.searchParams.get("state") ?? "";
  const expected = req.cookies.get("tt_oauth_state")?.value ?? "";
  const ok = state.length > 0 && state.length === expected.length && timingSafeEqual(Buffer.from(state), Buffer.from(expected));
  if (!ok) return back("error=invalid_state");

  const code = req.nextUrl.searchParams.get("code");
  if (!code) return back("error=missing_code");

  try {
    await storeTokens(await exchangeAuthCode(code));
    const shops = await syncAuthorizedShops();
    await audit(user.id, "integration.connect", "platform_connections", "tiktok", null, { shops });
    return back(`connected=tiktok&shops=${shops}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabaseAdmin()
      .from("platform_connections")
      .update({ status: "error", last_error: msg, last_error_at: new Date().toISOString() })
      .eq("platform", "tiktok");
    return back(`error=${encodeURIComponent(msg.slice(0, 200))}`);
  }
}
