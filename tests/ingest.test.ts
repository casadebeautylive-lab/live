import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { handleWebhook, ingestOrder } from "@/lib/ingest/ingest";
import { MemoryRepo } from "@/lib/ingest/memory-repo";
import type { NormalizedOrderInput } from "@/lib/ingest/normalized";
import { signRequest, verifyWebhookSignature } from "@/lib/integrations/tiktok/sign";
import { mapTikTokOrder } from "@/lib/integrations/tiktok/map";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

const order = (over: Partial<NormalizedOrderInput> = {}): NormalizedOrderInput => ({
  platform: "tiktok",
  externalOrderId: "T-100",
  createdAt: "2026-10-08T23:10:00Z",
  status: "active",
  isTest: true,
  items: [{ externalItemId: "L1", sku: "HOOP", title: "Hoop", quantity: 1, unitPrice: "12.00" }],
  ...over,
});

function repoWithShow() {
  const repo = new MemoryRepo();
  repo.shows.push({ id: "show1", platform: "tiktok", isTest: true, startedAt: "2026-10-08T23:00:00Z", endedAt: null });
  return repo;
}

describe("idempotent ingestion", () => {
  it("the same order ingested twice is one order", async () => {
    const repo = repoWithShow();
    const a = await ingestOrder(repo, order());
    const b = await ingestOrder(repo, order());
    expect(a).toMatchObject({ ok: true, outcome: "created", showId: "show1" });
    expect(b).toMatchObject({ ok: true, outcome: "updated" });
    expect(repo.orders.size).toBe(1);
  });

  it("duplicate webhook deliveries are processed once", async () => {
    const repo = repoWithShow();
    let calls = 0;
    const rec = { platform: "tiktok" as const, idempotencyKey: "n-1", eventType: "type_1", signatureValid: true, isTest: true, payload: {} };
    const toOrder = async () => (calls++, order());
    expect((await handleWebhook(repo, rec, toOrder)).status).toBe("processed");
    expect((await handleWebhook(repo, rec, toOrder)).status).toBe("duplicate");
    expect(calls).toBe(1);
  });

  it("invalid signatures are logged and rejected, never ingested", async () => {
    const repo = repoWithShow();
    const r = await handleWebhook(
      repo,
      { platform: "tiktok", idempotencyKey: "n-2", eventType: "type_1", signatureValid: false, isTest: false, payload: {} },
      async () => order(),
    );
    expect(r.status).toBe("rejected");
    expect(repo.orders.size).toBe(0);
  });

  it("malformed payloads fail validation with a reason", async () => {
    const r = await ingestOrder(repoWithShow(), { ...order(), items: [] });
    expect(r.ok).toBe(false);
  });
});

describe("refunds and cancellations update the existing order", () => {
  it("a later refund event attaches to the same order and keeps its show", async () => {
    const repo = repoWithShow();
    await ingestOrder(repo, order());
    repo.shows[0].endedAt = "2026-10-09T00:00:00Z";
    await ingestOrder(
      repo,
      order({ refunds: [{ externalRefundId: "R1", externalItemId: "L1", quantity: 1, amount: "12.00", refundedAt: "2026-10-10T10:00:00Z" }] }),
    );
    const saved = [...repo.orders.values()][0];
    expect(saved.refunds).toHaveLength(1);
    expect(saved.showId).toBe("show1");
  });

  it("a cancellation flips status without creating a new order", async () => {
    const repo = repoWithShow();
    await ingestOrder(repo, order());
    await ingestOrder(repo, order({ status: "cancelled" }));
    expect(repo.orders.size).toBe(1);
    expect([...repo.orders.values()][0].status).toBe("cancelled");
  });
});

describe("test vs real separation", () => {
  it("real orders never attach to test shows", async () => {
    const repo = repoWithShow();
    const r = await ingestOrder(repo, order({ isTest: false }));
    expect(r).toMatchObject({ ok: true, showId: null });
  });
});

describe("TikTok signatures", () => {
  it("webhook: HMAC-SHA256(app_secret, app_key + raw body)", () => {
    const body = '{"type":1,"tts_notification_id":"7","shop_id":"9","timestamp":1,"data":{"order_id":"5"}}';
    const sig = createHmac("sha256", "secret").update("key" + body).digest("hex");
    expect(verifyWebhookSignature("key", "secret", body, sig)).toBe(true);
    expect(verifyWebhookSignature("key", "secret", body + " ", sig)).toBe(false);
    expect(verifyWebhookSignature("key", "secret", body, null)).toBe(false);
  });

  it("request: secret + path + sorted params (minus sign/access_token) + secret", () => {
    const expected = createHmac("sha256", "S")
      .update("S/authorization/202309/shopsapp_keyAKtimestamp100version202309S")
      .digest("hex");
    expect(
      signRequest("S", "/authorization/202309/shops", { version: "202309", timestamp: "100", app_key: "AK", access_token: "x" }),
    ).toBe(expected);
  });
});

describe("TikTok order mapping", () => {
  const raw = {
    id: "5769",
    status: "AWAITING_SHIPMENT",
    create_time: 1791500000,
    payment: { currency: "USD", shipping_fee: "5.99", shipping_fee_platform_discount: "1.00" },
    line_items: [
      { id: "a", seller_sku: "HOOP", product_name: "Hoop", original_price: "15.00", seller_discount: "2.00", platform_discount: "3.00" },
      { id: "b", seller_sku: "HOOP", product_name: "Hoop", original_price: "15.00" },
    ],
  };

  it("maps units, discounts by funder and shipping without inventing GMV or fees", () => {
    const n = mapTikTokOrder(raw, "shop1")!;
    expect(n.items).toHaveLength(2);
    expect(n.items[0]).toMatchObject({ quantity: 1, unitPrice: "15.00", sellerDiscount: "2.00", platformDiscount: "3.00" });
    expect(n.customerShipping).toBe("5.99");
    expect(n.platformShippingSubsidy).toBe("1.00");
    expect(n.platformGmv).toBeNull();
    expect(n.actualPlatformFees).toBeNull();
    expect(n.isTest).toBe(false);
  });

  it("unpaid orders are not sales yet", () => {
    expect(mapTikTokOrder({ ...raw, status: "UNPAID" }, "shop1")).toBeNull();
  });

  it("unexpected shapes fail loudly", () => {
    expect(() => mapTikTokOrder({ id: "1" }, null)).toThrow();
  });
});

describe("token encryption", () => {
  it("round-trips and detects tampering", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const blob = encryptSecret("tok", key);
    expect(decryptSecret(blob, key)).toBe("tok");
    const parts = blob.split(".");
    parts[3] = Buffer.from("xxx").toString("base64");
    expect(() => decryptSecret(parts.join("."), key)).toThrow();
  });
});
