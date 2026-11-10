/**
 * Creator Opportunities — pure logic (no I/O), unit-tested in tests/creators.test.ts.
 */
import { Decimal } from "@/lib/engine/money";
import { parseCsv } from "@/lib/data/products";

/** TikTok usernames: 2–24 chars of letters, digits, "_" and "." (can't end with "."). */
const HANDLE = /^[a-z0-9_.]{2,24}$/;

/**
 * Turn what an order calls the buyer into a TikTok username we can look up.
 * Returns null when it can't be a username (spaces, emoji, …) — those buyers stay
 * Unknown and are never sent to Apify (no cost, no guessed match).
 */
export function normalizeUsername(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  const url = s.match(/tiktok\.com\/@([^/?#\s]+)/i);
  if (url) s = url[1];
  s = s.replace(/^@+/, "").toLowerCase();
  if (!HANDLE.test(s) || s.endsWith(".")) return null;
  return s;
}

export type Buyer = { username: string | null; nickname: string | null; customerId: string | null };

export type ShowBuyer = {
  username: string;
  /** 'export' = exact @username from the Seller Center file; 'nickname' = guessed from the display name. */
  source: "export" | "nickname";
  nickname: string | null;
  customerId: string | null;
  avatar: string | null;
  orders: number;
};

/**
 * Group a show's orders into unique buyers. An exact username from the Seller Center
 * export wins; otherwise the display nickname is used only if it can be a username.
 * Buyers with neither are counted apart (never sent to Apify).
 */
export function uniqueBuyers(orders: { nickname: string | null; customerId: string | null; avatar?: string | null; exportUsername?: string | null }[]) {
  const byUser = new Map<string, ShowBuyer>();
  const noHandle = new Set<string>();
  for (const o of orders) {
    const exact = normalizeUsername(o.exportUsername);
    const u = exact ?? normalizeUsername(o.nickname);
    if (!u) {
      noHandle.add(o.customerId ?? o.nickname ?? "?");
      continue;
    }
    const cur = byUser.get(u);
    if (cur) {
      cur.orders++;
      cur.customerId ??= o.customerId;
      cur.avatar ??= o.avatar ?? null;
      if (exact) cur.source = "export";
    } else byUser.set(u, { username: u, source: exact ? "export" : "nickname", nickname: o.nickname, customerId: o.customerId, avatar: o.avatar ?? null, orders: 1 });
  }
  // a buyer counted as "no username" on one order but known on another is not missing
  return { buyers: [...byUser.values()], noHandle: [...noHandle].filter((k) => ![...byUser.values()].some((b) => b.customerId === k)).length };
}

export type ExportRow = { orderId: string; username: string };

/**
 * Read a TikTok Seller Center order export (CSV). Needs the "Order ID" and
 * "Buyer Username" columns; one row per line item, so orders repeat.
 * Returns only order id → username — nothing else from the file is kept.
 */
export function parseOrderExport(text: string): { rows: ExportRow[]; orders: number; missingUsername: number; error: string | null } {
  const table = parseCsv(text);
  const head = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const iId = head.indexOf("order id");
  const iUser = head.indexOf("buyer username");
  if (iId < 0 || iUser < 0)
    return { rows: [], orders: 0, missingUsername: 0, error: 'This file has no "Order ID" / "Buyer Username" columns. Export orders from TikTok Seller Center → Orders → Export.' };
  const byOrder = new Map<string, string | null>();
  for (const r of table.slice(1)) {
    const id = (r[iId] ?? "").replace(/[^0-9]/g, ""); // the export pads ids with a tab
    if (!id) continue; // blank or description rows
    const u = normalizeUsername(r[iUser]);
    if (u) byOrder.set(id, u);
    else if (!byOrder.has(id)) byOrder.set(id, null);
  }
  const rows: ExportRow[] = [];
  let missing = 0;
  for (const [orderId, username] of byOrder) username ? rows.push({ orderId, username }) : missing++;
  return { rows, orders: byOrder.size, missingUsername: missing, error: null };
}

export type CachedProfile = { username: string; lookup: "found" | "not_found" | "failed"; followers: number | null; scannedAt: string };

/**
 * Which usernames actually need Apify: anything never looked up, older than the
 * cache window, or a previous failure (failures cost nothing at Apify and are retried).
 * `force` (Rescan) ignores the cache.
 */
export function planLookups(usernames: string[], cache: Map<string, CachedProfile>, cacheDays: number, now: Date, force = false) {
  const fresh: string[] = [];
  const toScan: string[] = [];
  const cutoff = now.getTime() - cacheDays * 86_400_000;
  for (const u of new Set(usernames)) {
    const c = cache.get(u);
    if (!force && c && c.lookup !== "failed" && Date.parse(c.scannedAt) >= cutoff) fresh.push(u);
    else toScan.push(u);
  }
  return { fresh, toScan };
}

export const estimateCost = (n: number, pricePerResult: string | number) => new Decimal(pricePerResult).times(n).toDecimalPlaces(4);

export type BudgetDecision = { ok: true } | { ok: false; reason: "budget" | "approval"; message: string };

/** Never spend past the monthly limit; large jobs wait for an explicit approval. */
export function budgetCheck(opts: { estimate: Decimal; spentThisMonth: Decimal; monthlyLimit: Decimal; approvalOver: Decimal; approved: boolean }): BudgetDecision {
  const { estimate, spentThisMonth, monthlyLimit, approvalOver, approved } = opts;
  if (spentThisMonth.plus(estimate).gt(monthlyLimit)) {
    return {
      ok: false,
      reason: "budget",
      message: `Paused: this scan (~$${estimate.toFixed(2)}) would pass the $${monthlyLimit.toFixed(2)} monthly Apify limit ($${spentThisMonth.toFixed(2)} used).`,
    };
  }
  if (!approved && estimate.gt(approvalOver)) {
    return { ok: false, reason: "approval", message: `Waiting for approval: estimated $${estimate.toFixed(2)}.` };
  }
  return { ok: true };
}

export type LookupResult = {
  username: string;
  lookup: "found" | "not_found" | "failed";
  followers: number | null;
  nickname: string | null;
  tiktokUserId: string | null;
  verified: boolean | null;
  privateAccount: boolean | null;
  avatarUrl: string | null;
  bioLink: string | null;
  error: string | null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/**
 * Map the profile scraper's dataset to one result per requested username.
 * A username with no row (run capped, crashed, …) is "failed" = Unknown, never 0 followers.
 */
export function parseProfileItems(requested: string[], items: unknown[]): LookupResult[] {
  const rows = new Map<string, Record<string, any>>();
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const r = it as Record<string, any>;
    const key = normalizeUsername(str(r.input) ?? str(r.authorMeta?.name) ?? str(r.username));
    if (key && !rows.has(key)) rows.set(key, r);
  }
  return requested.map((username) => {
    const r = rows.get(username);
    const base: LookupResult = {
      username,
      lookup: "failed",
      followers: null,
      nickname: null,
      tiktokUserId: null,
      verified: null,
      privateAccount: null,
      avatarUrl: null,
      bioLink: null,
      error: null,
    };
    if (!r) return { ...base, error: "No result returned for this username" };
    const a = r.authorMeta ?? {};
    const followers = num(a.fans);
    if (str(a.name) && followers !== null) {
      return {
        ...base,
        lookup: "found",
        followers,
        nickname: str(a.nickName),
        tiktokUserId: str(a.id),
        verified: typeof a.verified === "boolean" ? a.verified : null,
        privateAccount: typeof a.privateAccount === "boolean" ? a.privateAccount : null,
        avatarUrl: str(a.avatar),
        bioLink: str(a.bioLink),
      };
    }
    const err = str(r.error) ?? str(r.errorDescription) ?? str(r.reason) ?? str(r.error_kind) ?? str(r.status);
    const notFound = err !== null && /not.?found|doesn.?t exist|does not exist|no such|banned|unavailable/i.test(err);
    return { ...base, lookup: notFound ? "not_found" : "failed", error: err ?? "Profile data missing" };
  });
}

/**
 * The image id inside a TikTok avatar URL (the path segment before "~tplv…"), which stays
 * the same across sizes and signed links. null when there's no usable id.
 */
export function avatarKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const seg = new URL(url).pathname.split("/").pop() ?? "";
    const key = seg.split("~")[0].replace(/\.(jpe?g|png|webp|image)$/i, "");
    return key.length >= 8 ? key : null;
  } catch {
    return null;
  }
}

/**
 * Is the TikTok profile we found really this buyer? The order's display nickname often
 * equals someone else's @username (a buyer named "jello" is not @jello with 109K followers),
 * so the buyer's order avatar is compared with the profile's avatar.
 *   confirmed  – same avatar image
 *   mismatch   – both avatars known and different → a different person, never flagged
 *   unverified – no avatar on the order (or a default one) → shown with a "check" warning
 */
export function verifyBuyer(buyerAvatar: string | null | undefined, profileAvatar: string | null | undefined): "confirmed" | "mismatch" | "unverified" {
  const a = avatarKey(buyerAvatar);
  const b = avatarKey(profileAvatar);
  if (!a || !b) return "unverified";
  return a === b ? "confirmed" : "mismatch";
}

export type Tier = "100k" | "50k" | "15k";
export function tierOf(followers: number | null): Tier | null {
  if (followers === null) return null;
  if (followers >= 100_000) return "100k";
  if (followers >= 50_000) return "50k";
  if (followers >= 15_000) return "15k";
  return null;
}

export const STATUSES: { id: string; label: string }[] = [
  { id: "not_contacted", label: "Not Contacted" },
  { id: "contacted", label: "Contacted" },
  { id: "interested", label: "Interested" },
  { id: "agreed", label: "Collaboration Agreed" },
  { id: "video_posted", label: "Video Posted" },
  { id: "not_interested", label: "Not Interested" },
];

export function fillTemplate(tpl: string, c: { username: string; nickname: string | null }) {
  const name = c.nickname?.trim() || `@${c.username}`;
  return tpl.replaceAll("{name}", name).replaceAll("{username}", `@${c.username}`);
}

export function fmtFollowers(n: number | null): string {
  if (n === null) return "Unknown";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(n);
}

/** Start of the current month in UTC (Apify bills by calendar month). */
export const monthStartUtc = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
