import { describe, expect, it } from "vitest";
import { decideAttribution, type CandidateShow } from "@/lib/attribution";
import { ingestOrder } from "@/lib/ingest/ingest";
import { MemoryRepo } from "@/lib/ingest/memory-repo";
import { mapTikTokOrder } from "@/lib/integrations/tiktok/map";

const T = "2026-10-14T23:30:00Z";
const show = (id: string, over: Partial<CandidateShow> = {}): CandidateShow => ({
  id,
  platform: "tiktok",
  isTest: false,
  startedAt: "2026-10-14T23:00:00Z",
  endedAt: null,
  liveRoomId: null,
  detection: "manual",
  ...over,
});
const cfg = { beforeMinutes: 0, afterMinutes: 5 };
const now = new Date("2026-10-15T00:00:00Z");
const order = (liveRoomId?: string | null, source: "webhook" | "import" = "webhook") => ({
  platform: "tiktok" as const,
  isTest: false,
  createdAt: T,
  liveRoomId,
  source,
});

describe("attribution — verified TikTok LIVE id first", () => {
  it("known room → its show", () => {
    const d = decideAttribution(order("R1"), [show("a"), show("b", { liveRoomId: "R1" })], cfg, now);
    expect(d).toMatchObject({ kind: "assign", showId: "b", method: "platform_live_id" });
  });

  it("new room during a manually started show → links the room to that show", () => {
    const d = decideAttribution(order("R9"), [show("a")], cfg, now);
    expect(d).toMatchObject({ kind: "assign", showId: "a", linkRoomId: "R9" });
  });

  it("new room with no show running → auto-detect a new show", () => {
    expect(decideAttribution(order("R9"), [], cfg, now)).toMatchObject({ kind: "create_show", liveRoomId: "R9" });
  });
});

describe("attribution — never silently assign uncertain orders", () => {
  it("overlapping show windows → needs review", () => {
    const d = decideAttribution(order(null), [show("a"), show("b", { platform: "manual" })], cfg, now);
    expect(d).toMatchObject({ kind: "needs_review" });
    if (d.kind === "needs_review") expect(d.candidateIds.sort()).toEqual(["a", "b"]);
  });

  it("TikTok says not a LIVE order but it's inside a show → needs review", () => {
    expect(decideAttribution(order(""), [show("a")], cfg, now)).toMatchObject({ kind: "needs_review" });
  });

  it("not a LIVE order and no show running → not_live", () => {
    expect(decideAttribution(order(""), [], cfg, now)).toMatchObject({ kind: "unassigned", status: "not_live" });
  });

  it("historical import without a LIVE id stays unassigned even inside a window", () => {
    expect(decideAttribution(order(null, "import"), [show("a")], cfg, now)).toMatchObject({ kind: "unassigned" });
  });

  it("exactly one window and no LIVE info → time-window match", () => {
    expect(decideAttribution(order(null), [show("a")], cfg, now)).toMatchObject({ kind: "assign", method: "time_window" });
  });

  it("orders a few minutes after a show ends still match (configurable buffer)", () => {
    const ended = show("a", { endedAt: "2026-10-14T23:27:00Z" });
    expect(decideAttribution(order(null), [ended], cfg, now)).toMatchObject({ kind: "assign" });
    expect(decideAttribution(order(null), [ended], { beforeMinutes: 0, afterMinutes: 1 }, now)).toMatchObject({ kind: "unassigned" });
  });

  it("test and real never mix", () => {
    expect(decideAttribution(order(null), [show("a", { isTest: true })], cfg, now)).toMatchObject({ kind: "unassigned" });
  });
});

describe("ingestion with auto-detected LIVEs", () => {
  const o = (id: string, room: string, at = T) => ({
    platform: "tiktok",
    externalOrderId: id,
    createdAt: at,
    status: "active",
    isTest: false,
    liveRoomId: room,
    items: [{ externalItemId: `${id}-1`, sku: "HOOP", title: "Hoop", quantity: 1, unitPrice: "12.00" }],
  });

  it("first order of a LIVE creates the show; later orders join it; previous shows are untouched", async () => {
    const repo = new MemoryRepo();
    const a = await ingestOrder(repo, o("1", "ROOM-A"));
    const b = await ingestOrder(repo, o("2", "ROOM-A", "2026-10-14T23:40:00Z"));
    expect(repo.shows).toHaveLength(1);
    expect(a.ok && b.ok && a.showId === b.showId).toBe(true);

    repo.shows[0].endedAt = "2026-10-15T00:30:00Z";
    const c = await ingestOrder(repo, o("3", "ROOM-B", "2026-10-15T20:00:00Z"));
    expect(repo.shows).toHaveLength(2);
    expect(c.ok && c.showId).not.toBe(a.ok && a.showId);
    expect([...repo.orders.values()].filter((x) => x.showId === repo.shows[0].id)).toHaveLength(2);
  });

  it("a refund arriving days later stays on the original show", async () => {
    const repo = new MemoryRepo();
    const first = await ingestOrder(repo, o("1", "ROOM-A"));
    const late = await ingestOrder(repo, {
      ...o("1", "ROOM-A"),
      refunds: [{ externalRefundId: "R", externalItemId: "1-1", quantity: 1, amount: "12.00", refundedAt: "2026-10-20T10:00:00Z" }],
    });
    expect(late.ok && first.ok && late.showId === first.showId).toBe(true);
  });
});

describe("TikTok 202507 mapping", () => {
  const base = {
    id: "5769",
    status: "AWAITING_SHIPMENT",
    create_time: 1791500000,
    paid_time: 1791500030,
    user_id: "7000123",
    payment: { currency: "USD", shipping_fee: "0" },
    packages: [{ id: "PKG-1" }],
  };
  const li = (room?: string) => ({ id: "a", seller_sku: "HOOP", product_name: "Hoop", original_price: "15.00", ...(room === undefined ? {} : { room_id: room }) });

  it("room_id → LIVE id, user_id → stable buyer id, paid time and package", () => {
    const n = mapTikTokOrder({ ...base, line_items: [li("7311")] }, "shop")!;
    expect(n.liveRoomId).toBe("7311");
    expect(n.customerId).toBe("7000123");
    expect(n.paidAt).toBe(new Date(1791500030 * 1000).toISOString());
    expect(n.packageIds).toEqual(["PKG-1"]);
  });

  it('empty room_id = "not from a LIVE"; missing field = unknown', () => {
    expect(mapTikTokOrder({ ...base, line_items: [li("")] }, "shop")!.liveRoomId).toBe("");
    expect(mapTikTokOrder({ ...base, line_items: [li()] }, "shop")!.liveRoomId).toBeNull();
  });
});

import { fromSettledOrder, fromUnsettledTransaction, mapLiveSessions, orderFinanceUpdate } from "@/lib/integrations/tiktok/finance";

describe("TikTok finance mapping", () => {
  it("settled order totals (signed convention) → fees and net shipping as costs", () => {
    const f = fromSettledOrder({ revenue_amount: "30.00", fee_and_tax_amount: "-2.40", shipping_cost_amount: "-3.10", settlement_amount: "24.50" });
    expect(f).toMatchObject({ settled: true, platformFees: "2.4", netShippingCost: "3.1", settlement: "24.5" });
  });

  it("positive convention is recognised by the settlement identity", () => {
    const f = fromSettledOrder({ revenue_amount: "30.00", fee_and_tax_amount: "2.40", shipping_cost_amount: "3.10", settlement_amount: "24.50" });
    expect(f.platformFees).toBe("2.4");
    expect(f.netShippingCost).toBe("3.1");
  });

  it("a shipping credit (seller recovered more than it paid) stays a negative cost", () => {
    const f = fromSettledOrder({ revenue_amount: "30.00", fee_and_tax_amount: "-2.40", shipping_cost_amount: "1.00", settlement_amount: "28.60" });
    expect(f.netShippingCost).toBe("-1");
  });

  it("unsettled estimates fill fees/shipping but never the settlement", () => {
    const f = fromUnsettledTransaction({ est_revenue_amount: "10", est_fee_tax_amount: "-0.80", est_shipping_cost_amount: "0", est_adjustment_amount: "0", est_settlement_amount: "9.20" });
    expect(f).toMatchObject({ settled: false, platformFees: "0.8", settlement: null });
  });

  it("engine shipping net equals TikTok's net shipping cost", () => {
    const u = orderFinanceUpdate({ settled: true, revenue: "30", platformFees: "2.4", netShippingCost: "3.1", settlement: "24.5" }, "5.99", "1.00");
    // engine net = seller cost − customer shipping − subsidy = 10.09 − 5.99 − 1.00 = 3.10
    expect(u.seller_shipping_cost).toBe("10.09");
  });

  it("LIVE sessions: id, title and unix times", () => {
    const [s] = mapLiveSessions({ live_stream_sessions: [{ id: "7311", title: "Evening Jewelry LIVE", start_time: "1791500000", end_time: "1791510800", creator: { nick_name: "Jewelar" } }] });
    expect(s).toMatchObject({ id: "7311", title: "Evening Jewelry LIVE", creator: "Jewelar" });
    expect(Date.parse(s.endedAt!) - Date.parse(s.startedAt!)).toBe(3 * 3_600_000);
  });
});

import { mapTikTokReturns } from "@/lib/integrations/tiktok/map";

describe("TikTok returns → refunds", () => {
  const ret = (status: string, lines: any[], extra: any = {}) => ({ order_id: "O1", return_id: "R1", return_status: status, update_time: 1791500000, return_line_items: lines, ...extra });

  it("completed returns become per-line refunds of the merchandise subtotal only", () => {
    const r = mapTikTokReturns([ret("RETURN_OR_REFUND_REQUEST_COMPLETE", [{ return_line_item_id: "RL1", order_line_item_id: "a", refund_amount: { refund_subtotal: "12.00", refund_shipping_fee: "4.99", refund_total: "16.99" } }])], "O1");
    expect(r).toEqual([{ externalRefundId: "R1:RL1", externalItemId: "a", quantity: 1, amount: "12.00", refundedAt: new Date(1791500000 * 1000).toISOString() }]);
  });

  it("pending, rejected or other orders' returns are ignored", () => {
    expect(mapTikTokReturns([ret("RETURN_OR_REFUND_REQUEST_PENDING", [])], "O1")).toEqual([]);
    expect(mapTikTokReturns([ret("RETURN_OR_REFUND_REQUEST_REJECT", [])], "O1")).toEqual([]);
    expect(mapTikTokReturns([ret("RETURN_OR_REFUND_REQUEST_SUCCESS", [], { order_id: "O2", refund_amount: { refund_subtotal: "5" } })], "O1")).toEqual([]);
  });

  it("order-level refund without line items carries no quantity", () => {
    const [x] = mapTikTokReturns([ret("RETURN_OR_REFUND_REQUEST_SUCCESS", [], { refund_amount: { refund_subtotal: "7.50" } })], "O1");
    expect(x).toMatchObject({ externalRefundId: "R1", quantity: 0, amount: "7.50" });
  });
});
