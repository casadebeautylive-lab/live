import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { cache } from "react";
import { env, serverEnv } from "@/lib/env";

/** Per-request client acting as the signed-in user. RLS applies. */
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(env.supabaseUrl(), env.supabaseAnonKey(), {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // called from a Server Component; middleware refreshes the session instead
        }
      },
    },
  });
}

/** Service-role client. Bypasses RLS — server-only, used for webhooks and tokens. */
export function supabaseAdmin() {
  return createClient(env.supabaseUrl(), serverEnv.serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type AppUser = { id: string; email: string; role: "owner" | "admin" | "viewer"; canWrite: boolean };

/** Current user with role, or null. Cached for the request: layout and page share one lookup. */
export const currentUser = cache(async (): Promise<AppUser | null> => {
  const sb = await supabaseServer();
  const { data } = await sb.auth.getClaims();
  const uid = data?.claims?.sub;
  if (!uid) return null;
  const { data: row } = await sb.from("users").select("email, role_id").eq("id", uid).single();
  if (!row) return null;
  const role = row.role_id as AppUser["role"];
  return { id: uid, email: row.email, role, canWrite: role === "owner" || role === "admin" };
});

export async function requireWriter(): Promise<AppUser> {
  const u = await currentUser();
  if (!u?.canWrite) throw new Error("Not authorized");
  return u;
}

export async function audit(actorId: string | null, action: string, entity: string, entityId: string | null, before?: unknown, after?: unknown) {
  await supabaseAdmin().from("audit_logs").insert({
    actor_id: actorId,
    action,
    entity,
    entity_id: entityId,
    before: before ?? null,
    after: after ?? null,
  });
}
