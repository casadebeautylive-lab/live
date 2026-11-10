import "server-only";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/clients";
import { signRequest } from "./sign";

const VERSION = "202309";
/** Order detail 202507 is the first version that returns line_items[].room_id (LIVE session). */
const ORDER_DETAIL_VERSION = "202507";

type TokenResponse = {
  access_token: string;
  access_token_expire_in: number; // unix seconds
  refresh_token: string;
  refresh_token_expire_in: number;
  granted_scopes?: string[];
};

async function fetchJson(url: string, init?: RequestInit, attempt = 0): Promise<any> {
  const res = await fetch(url, { ...init, cache: "no-store" });
  // rate limits and transient errors: exponential backoff, 3 attempts
  if ((res.status === 429 || res.status >= 500) && attempt < 2) {
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    return fetchJson(url, init, attempt + 1);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json.code !== undefined && json.code !== 0)) {
    throw new Error(`TikTok API ${res.status} code=${json.code ?? "?"} ${json.message ?? ""}`.trim());
  }
  return json;
}

/**
 * Exchange an authorization code for tokens.
 * Endpoint: {authBase}/api/v2/token/get — confirm in Partner Center; override base with TIKTOK_AUTH_BASE.
 */
export async function exchangeAuthCode(code: string): Promise<TokenResponse> {
  const u = new URL("/api/v2/token/get", serverEnv.tiktok.authBase());
  u.searchParams.set("app_key", serverEnv.tiktok.appKey());
  u.searchParams.set("app_secret", serverEnv.tiktok.appSecret());
  u.searchParams.set("auth_code", code);
  u.searchParams.set("grant_type", "authorized_code");
  return (await fetchJson(u.toString())).data as TokenResponse;
}

async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  const u = new URL("/api/v2/token/refresh", serverEnv.tiktok.authBase());
  u.searchParams.set("app_key", serverEnv.tiktok.appKey());
  u.searchParams.set("app_secret", serverEnv.tiktok.appSecret());
  u.searchParams.set("refresh_token", refreshToken);
  u.searchParams.set("grant_type", "refresh_token");
  return (await fetchJson(u.toString())).data as TokenResponse;
}

export async function storeTokens(t: TokenResponse) {
  const key = serverEnv.tokenKey();
  await supabaseAdmin()
    .from("platform_connections")
    .update({
      status: "connected",
      access_token_enc: encryptSecret(t.access_token, key),
      refresh_token_enc: encryptSecret(t.refresh_token, key),
      access_token_expires_at: new Date(t.access_token_expire_in * 1000).toISOString(),
      refresh_token_expires_at: new Date(t.refresh_token_expire_in * 1000).toISOString(),
      scopes: t.granted_scopes ?? null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("platform", "tiktok");
}

/** Valid access token, refreshing it when it expires within 10 minutes. */
export async function getAccessToken(): Promise<string> {
  const { data } = await supabaseAdmin()
    .from("platform_connections")
    .select("access_token_enc, refresh_token_enc, access_token_expires_at")
    .eq("platform", "tiktok")
    .single();
  if (!data?.access_token_enc || !data.refresh_token_enc) throw new Error("TikTok Shop is not authorized");
  const key = serverEnv.tokenKey();
  const expires = Date.parse(data.access_token_expires_at ?? "0");
  if (expires - Date.now() > 10 * 60_000) return decryptSecret(data.access_token_enc, key);
  const fresh = await refreshTokens(decryptSecret(data.refresh_token_enc, key));
  await storeTokens(fresh);
  return fresh.access_token;
}

/** Signed GET against the Open API. */
export async function apiGet(path: string, query: Record<string, string> = {}, version = VERSION): Promise<any> {
  const token = await getAccessToken();
  const params: Record<string, string> = {
    app_key: serverEnv.tiktok.appKey(),
    timestamp: Math.floor(Date.now() / 1000).toString(),
    version,
    ...query,
  };
  params.sign = signRequest(serverEnv.tiktok.appSecret(), path, params);
  const u = new URL(path, serverEnv.tiktok.apiBase());
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return fetchJson(u.toString(), { headers: { "x-tts-access-token": token, "content-type": "application/json" } });
}

/** Signed POST with a JSON body (the body is part of the signature). */
export async function apiPost(path: string, query: Record<string, string>, body: unknown, version = VERSION): Promise<any> {
  const token = await getAccessToken();
  const raw = JSON.stringify(body ?? {});
  const params: Record<string, string> = {
    app_key: serverEnv.tiktok.appKey(),
    timestamp: Math.floor(Date.now() / 1000).toString(),
    version,
    ...query,
  };
  params.sign = signRequest(serverEnv.tiktok.appSecret(), path, params, raw);
  const u = new URL(path, serverEnv.tiktok.apiBase());
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return fetchJson(u.toString(), {
    method: "POST",
    body: raw,
    headers: { "x-tts-access-token": token, "content-type": "application/json" },
  });
}

export async function shopCipher(externalShopId?: string): Promise<{ cipher: string; externalShopId: string }> {
  let q = supabaseAdmin().from("shops").select("shop_cipher, external_shop_id").eq("platform", "tiktok");
  if (externalShopId) q = q.eq("external_shop_id", externalShopId);
  const { data } = await q.limit(1).maybeSingle();
  if (!data?.shop_cipher) throw new Error("No authorized TikTok shop — re-sync authorized shops on Connections");
  return { cipher: data.shop_cipher, externalShopId: data.external_shop_id };
}

/** GET /order/202507/orders?ids=a,b,… (up to 50) — batch order detail with LIVE room ids. */
export async function getOrderDetails(cipher: string, ids: string[]): Promise<any[]> {
  if (!ids.length) return [];
  const json = await apiGet(`/order/${ORDER_DETAIL_VERSION}/orders`, { ids: ids.join(","), shop_cipher: cipher }, ORDER_DETAIL_VERSION);
  return json.data?.orders ?? [];
}

/** POST /order/202309/orders/search — order ids created in [from, to). */
export async function searchOrderIds(cipher: string, from: Date, to: Date, pageToken?: string): Promise<{ ids: string[]; next: string | null }> {
  const query: Record<string, string> = { shop_cipher: cipher, page_size: "50" };
  if (pageToken) query.page_token = pageToken;
  const json = await apiPost(`/order/${VERSION}/orders/search`, query, {
    create_time_ge: Math.floor(from.getTime() / 1000),
    create_time_lt: Math.floor(to.getTime() / 1000),
  });
  return { ids: (json.data?.orders ?? []).map((o: any) => String(o.id)), next: json.data?.next_page_token || null };
}

/** POST /return_refund/202309/returns/search — returns/refunds for up to 50 orders. */
export async function searchReturns(cipher: string, orderIds: string[]): Promise<any[]> {
  if (!orderIds.length) return [];
  const json = await apiPost(`/return_refund/${VERSION}/returns/search`, { shop_cipher: cipher, page_size: "50" }, { order_ids: orderIds });
  return json.data?.return_orders ?? [];
}

/** GET /finance/202501/orders/{order_id}/statement_transactions — settled totals for one order. */
export async function getOrderStatement(cipher: string, orderId: string): Promise<any | null> {
  try {
    const json = await apiGet(`/finance/202501/orders/${encodeURIComponent(orderId)}/statement_transactions`, { shop_cipher: cipher }, "202501");
    return json.data ?? null;
  } catch (e) {
    // not settled yet → TikTok returns an error/empty; unsettled estimates are fetched separately
    if (e instanceof Error && /code=(?!0)/.test(e.message)) return null;
    throw e;
  }
}

/** GET /finance/202507/orders/unsettled — TikTok's own estimates for orders not yet settled. */
export async function getUnsettled(cipher: string, pageToken?: string): Promise<{ transactions: any[]; next: string | null }> {
  const q: Record<string, string> = { shop_cipher: cipher, page_size: "100", sort_field: "order_create_time" };
  if (pageToken) q.page_token = pageToken;
  const json = await apiGet(`/finance/202507/orders/unsettled`, q, "202507");
  return { transactions: json.data?.transactions ?? [], next: json.data?.next_page_token || null };
}

/** GET /fulfillment/202309/packages/{package_id} — orders in the package, tracking, carrier, status. */
export async function getPackage(cipher: string, packageId: string): Promise<any> {
  const json = await apiGet(`/fulfillment/${VERSION}/packages/${encodeURIComponent(packageId)}`, { shop_cipher: cipher });
  return json.data ?? null;
}

/** GET /analytics/202609/shop_lives/performance — official LIVE sessions (start/end/title), ~1 day delayed. */
export async function getLiveSessions(cipher: string, fromYmd: string, toYmdExclusive: string, pageToken?: string) {
  const q: Record<string, string> = {
    shop_cipher: cipher,
    start_date_ge: fromYmd,
    end_date_lt: toYmdExclusive,
    account_type: "OFFICIAL_ACCOUNTS",
    page_size: "100",
    currency: "USD",
  };
  if (pageToken) q.page_token = pageToken;
  const json = await apiGet(`/analytics/202609/shop_lives/performance`, q, "202609");
  return { data: json.data ?? {}, next: (json.data?.next_page_token as string) || null };
}

/** GET /authorization/202309/shops — confirmed endpoint; returns shops with `cipher`. */
export async function syncAuthorizedShops() {
  const json = await apiGet(`/authorization/${VERSION}/shops`);
  const shops = (json.data?.shops ?? []) as { id: string; name: string; region: string; cipher: string }[];
  const sb = supabaseAdmin();
  const { data: conn } = await sb.from("platform_connections").select("id").eq("platform", "tiktok").single();
  for (const s of shops) {
    await sb.from("shops").upsert(
      { platform: "tiktok", external_shop_id: s.id, name: s.name, region: s.region, shop_cipher: s.cipher, connection_id: conn?.id },
      { onConflict: "platform,external_shop_id" },
    );
  }
  await sb.from("platform_connections").update({ last_sync_at: new Date().toISOString() }).eq("platform", "tiktok");
  return shops.length;
}

/** GET /order/202507/orders?ids=… — order detail (with LIVE room_id). Returns the raw order object. */
export async function getOrderDetail(externalShopId: string, orderId: string): Promise<unknown> {
  const { data: shop } = await supabaseAdmin()
    .from("shops")
    .select("shop_cipher")
    .eq("platform", "tiktok")
    .eq("external_shop_id", externalShopId)
    .single();
  if (!shop?.shop_cipher) throw new Error(`Unknown TikTok shop ${externalShopId} — re-sync authorized shops`);
  const json = await apiGet(`/order/${ORDER_DETAIL_VERSION}/orders`, { ids: orderId, shop_cipher: shop.shop_cipher }, ORDER_DETAIL_VERSION);
  const order = json.data?.orders?.[0];
  if (!order) throw new Error(`Order ${orderId} not returned by TikTok`);
  return order;
}
