import { hmacSha256Hex, safeEqualHex } from "@/lib/crypto";

/**
 * TikTok Shop Open API request signature (API version 202309).
 *
 *   string = app_secret + path + Σ(sorted key + value, excluding sign & access_token) + body + app_secret
 *   sign   = hex(HMAC-SHA256(key = app_secret, string))
 *
 * Path/params/HMAC steps confirmed against a published reference implementation
 * (authorized-shops call). The JSON body term applies to non-multipart POST/PUT
 * requests — confirm in Partner Center docs before enabling any POST call.
 */
export function signRequest(
  appSecret: string,
  path: string,
  params: Record<string, string>,
  body: string = "",
): string {
  const keys = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "access_token")
    .sort();
  const concatenated = keys.map((k) => k + params[k]).join("");
  return hmacSha256Hex(appSecret, appSecret + path + concatenated + body + appSecret);
}

/**
 * Webhook authenticity: the `Authorization` header (no "Bearer") equals
 * hex(HMAC-SHA256(key = app_secret, app_key + raw_body)). Must use the raw bytes as received.
 */
export function verifyWebhookSignature(appKey: string, appSecret: string, rawBody: string, header: string | null): boolean {
  if (!header || !appKey || !appSecret) return false;
  return safeEqualHex(hmacSha256Hex(appSecret, appKey + rawBody), header.trim());
}
