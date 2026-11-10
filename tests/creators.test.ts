import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/engine/money";
import {
  budgetCheck,
  estimateCost,
  fillTemplate,
  fmtFollowers,
  verifyBuyer,
  avatarKey,
  normalizeUsername,
  parseOrderExport,
  parseProfileItems,
  planLookups,
  tierOf,
  uniqueBuyers,
  type CachedProfile,
} from "@/lib/creators/core";
import { chargedUsd } from "@/lib/creators/apify";

describe("username normalization", () => {
  it("lowercases, strips @ and profile URLs", () => {
    expect(normalizeUsername(" @Sarah_Jewels ")).toBe("sarah_jewels");
    expect(normalizeUsername("https://www.tiktok.com/@Nasa?lang=en")).toBe("nasa");
  });
  it("rejects anything that can't be a TikTok username (never guessed)", () => {
    expect(normalizeUsername("Sarah 💎")).toBeNull();
    expect(normalizeUsername("Mary Smith")).toBeNull();
    expect(normalizeUsername("a")).toBeNull();
    expect(normalizeUsername("name.")).toBeNull();
    expect(normalizeUsername(null)).toBeNull();
  });
});

describe("buyers of a show", () => {
  it("dedupes by username and counts orders; display names are kept apart", () => {
    const { buyers, noHandle } = uniqueBuyers([
      { nickname: "sarah_jewels", customerId: "u1" },
      { nickname: "@Sarah_Jewels", customerId: "u1" },
      { nickname: "Mary Smith", customerId: "u2" },
      { nickname: "Mary Smith", customerId: "u2" },
      { nickname: null, customerId: "u3" },
    ]);
    expect(buyers).toEqual([{ username: "sarah_jewels", source: "nickname", nickname: "sarah_jewels", customerId: "u1", avatar: null, orders: 2 }]);
    expect(noHandle).toBe(2);
  });
});

describe("30-day cache", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const c = (username: string, daysAgo: number, lookup: CachedProfile["lookup"] = "found"): [string, CachedProfile] => [
    username,
    { username, lookup, followers: lookup === "found" ? 20000 : null, scannedAt: new Date(now.getTime() - daysAgo * 86_400_000).toISOString() },
  ];
  const cache = new Map([c("fresh", 3), c("stale", 31), c("gone", 5, "not_found"), c("broke", 1, "failed")]);

  it("only new, stale or failed usernames go to Apify", () => {
    const r = planLookups(["fresh", "stale", "gone", "broke", "new", "new"], cache, 30, now);
    expect(r.fresh.sort()).toEqual(["fresh", "gone"]);
    expect(r.toScan.sort()).toEqual(["broke", "new", "stale"]);
  });
  it("rescan ignores the cache", () => {
    expect(planLookups(["fresh"], cache, 30, now, true).toScan).toEqual(["fresh"]);
  });
});

describe("cost controls", () => {
  const base = { spentThisMonth: new Decimal("5"), monthlyLimit: new Decimal("20"), approvalOver: new Decimal("1"), approved: false };
  it("estimates at the per-profile price", () => {
    expect(estimateCost(1000, "0.00075").toFixed(4)).toBe("0.7500");
  });
  it("small jobs run", () => {
    expect(budgetCheck({ ...base, estimate: new Decimal("0.30") })).toEqual({ ok: true });
  });
  it("large jobs wait for approval", () => {
    expect(budgetCheck({ ...base, estimate: new Decimal("2") })).toMatchObject({ ok: false, reason: "approval" });
    expect(budgetCheck({ ...base, estimate: new Decimal("2"), approved: true })).toEqual({ ok: true });
  });
  it("never passes the monthly limit, even when approved", () => {
    expect(budgetCheck({ ...base, estimate: new Decimal("15.01"), approved: true })).toMatchObject({ ok: false, reason: "budget" });
  });
  it("reads Apify's real charge for a run", () => {
    // shape of the real test run cSaDzqbQnVygXZd9T (2 profiles)
    expect(chargedUsd({ usageTotalUsd: 0.0015, eventUsage: { "apify-default-dataset-item": { eventTotalUsd: 0.0015 } } })).toBe(0.0015);
    expect(chargedUsd({ eventUsage: { a: { eventTotalUsd: 0.001 }, b: { eventTotalUsd: 0.0005 } } })).toBeCloseTo(0.0015);
    expect(chargedUsd({})).toBeNull();
  });
});

describe("parsing profile results", () => {
  // trimmed copy of the real dataset eUdI9xkXG82MPFQMp
  const items = [
    { input: "nasa", authorMeta: { id: "7664638705177150477", name: "nasa", nickName: "NASA", fans: 2100000, verified: true, privateAccount: false } },
    { input: "tiktok", authorMeta: { id: "107955", name: "tiktok", nickName: "TikTok", fans: 96300000, verified: true, privateAccount: false } },
    { input: "nobody_here_123", error: "not_found" },
  ];
  it("maps found, not found and missing rows; missing = Unknown, never 0", () => {
    const r = parseProfileItems(["nasa", "tiktok", "nobody_here_123", "capped_user"], items);
    expect(r[0]).toMatchObject({ username: "nasa", lookup: "found", followers: 2100000, nickname: "NASA", verified: true });
    expect(r[1]).toMatchObject({ lookup: "found", followers: 96300000 });
    expect(r[2]).toMatchObject({ lookup: "not_found", followers: null });
    expect(r[3]).toMatchObject({ lookup: "failed", followers: null });
  });
  it("a row without a follower number is not a 0-follower profile", () => {
    const [r] = parseProfileItems(["x_user"], [{ input: "x_user", authorMeta: { name: "x_user" } }]);
    expect(r.lookup).toBe("failed");
    expect(r.followers).toBeNull();
  });
});

describe("display helpers", () => {
  it("tiers", () => {
    expect(tierOf(14_999)).toBeNull();
    expect(tierOf(15_000)).toBe("15k");
    expect(tierOf(50_000)).toBe("50k");
    expect(tierOf(100_000)).toBe("100k");
    expect(tierOf(null)).toBeNull();
  });
  it("formats followers and Unknown", () => {
    expect(fmtFollowers(null)).toBe("Unknown");
    expect(fmtFollowers(15400)).toBe("15.4K");
    expect(fmtFollowers(2_100_000)).toBe("2.1M");
    expect(fmtFollowers(980)).toBe("980");
  });
  it("verifies the buyer by avatar image, not by name", () => {
    const p = "https://p16-common-sign.tiktokcdn-us.com/tos-alisg-avt-0068/b485384324e9921e513258906c22f3e5~tplv-tiktokx-cropcenter:1080:1080.jpeg?x-expires=1&x-signature=a";
    const o = "https://p77-sign-va.tiktokcdn.com/tos-alisg-avt-0068/b485384324e9921e513258906c22f3e5~tplv-tiktokx-cropcenter:100:100.webp?x-signature=b";
    const other = "https://p19-common-sign.tiktokcdn-us.com/musically-maliva-obj/1594805258216454~tplv-tiktokx-cropcenter:1080:1080.jpeg";
    expect(avatarKey(p)).toBe("b485384324e9921e513258906c22f3e5");
    expect(verifyBuyer(o, p)).toBe("confirmed");
    expect(verifyBuyer(other, p)).toBe("mismatch");
    expect(verifyBuyer(null, p)).toBe("unverified");
    expect(verifyBuyer("not a url", p)).toBe("unverified");
  });
  it("message template", () => {
    expect(fillTemplate("Hi {name} ({username})!", { username: "nasa", nickname: "NASA" })).toBe("Hi NASA (@nasa)!");
    expect(fillTemplate("Hi {name}", { username: "nasa", nickname: null })).toBe("Hi @nasa");
  });
});

describe("Seller Center order export", () => {
  const csv = [
    "Order ID,Order Status,Buyer Nickname,Buyer Username,Recipient,Phone #",
    "Platform unique order ID.,,,,,", // TikTok's description row
    '577624956360691821\t,To ship,Jennifer Quillia,jennalu26,"Jennifer Q",(+1)555',
    "577624956360691821\t,To ship,Jennifer Quillia,jennalu26,Jennifer Q,(+1)555", // 2nd line item
    "577624957561770640\t,To ship,yessie_yess,yessie_yess5,Y,1",
    "577624958580527577\t,To ship,Marie,,M,1",
  ].join("\r\n");
  it("keeps only order id → username, one per order", () => {
    const r = parseOrderExport(csv);
    expect(r.error).toBeNull();
    expect(r.rows).toEqual([
      { orderId: "577624956360691821", username: "jennalu26" },
      { orderId: "577624957561770640", username: "yessie_yess5" },
    ]);
    expect(r.orders).toBe(3);
    expect(r.missingUsername).toBe(1);
    expect(JSON.stringify(r)).not.toContain("555"); // no phone/recipient kept
  });
  it("rejects files without the columns", () => {
    expect(parseOrderExport("a,b\n1,2").error).toMatch(/Buyer Username/);
  });
  it("exact export usernames win over nickname guesses", () => {
    const { buyers, noHandle } = uniqueBuyers([
      { nickname: "yessie_yess", customerId: "u1", exportUsername: "yessie_yess5" },
      { nickname: "Paola | Gynecology PA", customerId: "u2", exportUsername: "paola.gyn" },
      { nickname: "Mary Smith", customerId: "u3" },
    ]);
    expect(buyers.map((b) => [b.username, b.source])).toEqual([
      ["yessie_yess5", "export"],
      ["paola.gyn", "export"],
    ]);
    expect(noHandle).toBe(1);
  });
});
