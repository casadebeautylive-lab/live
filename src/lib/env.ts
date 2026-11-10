function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

/** Safe for the browser (NEXT_PUBLIC_*). Literal access so Next inlines them. */
export const env = {
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
  supabaseAnonKey: () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
};

/** Server-only secrets. Never prefix these with NEXT_PUBLIC_. */
export const serverEnv = {
  serviceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY),
  tokenKey: () => required("TOKEN_ENCRYPTION_KEY", process.env.TOKEN_ENCRYPTION_KEY),
  appUrl: () => process.env.APP_URL ?? "http://localhost:3000",
  testWebhookSecret: () => process.env.TEST_WEBHOOK_SECRET ?? "",
  cronSecret: () => process.env.CRON_SECRET ?? "",
  /** Apify API token for creator follower lookups. Unset = scans wait with a clear message. */
  apifyToken: () => process.env.APIFY_TOKEN ?? "",
  tiktok: {
    appKey: () => process.env.TIKTOK_APP_KEY ?? "",
    appSecret: () => process.env.TIKTOK_APP_SECRET ?? "",
    /** Seller authorization link for your app, copied from TikTok Shop Partner Center. */
    authorizeUrl: () => process.env.TIKTOK_AUTHORIZE_URL ?? "",
    apiBase: () => process.env.TIKTOK_API_BASE ?? "https://open-api.tiktokglobalshop.com",
    authBase: () => process.env.TIKTOK_AUTH_BASE ?? "https://auth.tiktok-shops.com",
    configured: () => Boolean(process.env.TIKTOK_APP_KEY && process.env.TIKTOK_APP_SECRET && process.env.TIKTOK_AUTHORIZE_URL),
  },
};
