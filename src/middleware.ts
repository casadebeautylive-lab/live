import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Public paths: login, inbound webhooks (signature-verified), cron (secret-verified).
const PUBLIC = [/^\/login/, /^\/api\/webhooks\//, /^\/api\/cron\//];

export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: req });
  if (PUBLIC.some((r) => r.test(req.nextUrl.pathname))) return res;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    return new NextResponse("Supabase environment variables are not configured. See README.", { status: 500 });
  }

  const sb = createServerClient(url, key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => req.cookies.set(name, value));
        res = NextResponse.next({ request: req });
        list.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      },
    },
  });

  // getClaims verifies the session token locally (signing keys) and refreshes it when needed —
  // no round trip to the auth server on every page load. Falls back to a server check
  // for projects still on a shared JWT secret.
  const { data } = await sb.auth.getClaims();
  if (!data?.claims?.sub) {
    if (req.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const login = req.nextUrl.clone();
    login.pathname = "/login";
    login.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(login);
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
