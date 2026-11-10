import { z } from "zod";
import type { NormalizedOrderInput } from "@/lib/ingest/normalized";

/**
 * Mapping from a TikTok Shop order (Get Order Detail, version 202507) to the
 * normalized order.
 *
 * LIVE attribution: 202507 returns `line_items[].room_id` — the LIVE session the
 * item was bought in, or "" when it was not bought in a LIVE. Orders carry the
 * room id of their line items; if the field is absent entirely (older API
 * version) we report null = "unknown", which falls back to time-window matching.
 *
 * Buyer: `user_id` is TikTok's stable buyer id (never the display name).
 *
 * Field provenance:
 *  - payment.{currency, original_total_product_price, sub_total, shipping_fee,
 *    original_shipping_fee, seller_discount, platform_discount,
 *    shipping_fee_seller_discount, shipping_fee_platform_discount}
 *    — documented order-total fields.
 *  - line_items[].{id, sku_id, seller_sku, product_name, original_price,
 *    seller_discount, platform_discount, display_status}
 *    — MUST be confirmed against your first real order response. Parsing is strict:
 *    if TikTok's shape differs, ingestion fails loudly (visible on Integrations)
 *    instead of recording wrong numbers.
 *
 * Not available from the order API (left null, never invented):
 *  - platform GMV (an analytics metric), seller shipping label cost, commission,
 *    settlement — these come from finance/statement APIs (Phase 2b).
 */

const amount = z.string().regex(/^-?\d+(\.\d+)?$/);

const LineItem = z.object({
  id: z.string(),
  sku_id: z.string().optional(),
  seller_sku: z.string().optional(),
  product_name: z.string(),
  original_price: amount,
  seller_discount: amount.optional(),
  platform_discount: amount.optional(),
  display_status: z.string().optional(),
  room_id: z.string().optional(),
  package_id: z.string().optional(),
});

export const TikTokOrder = z.object({
  id: z.string(),
  status: z.string(),
  create_time: z.number().int(),
  paid_time: z.number().int().optional(),
  user_id: z.string().optional(),
  packages: z.array(z.object({ id: z.string() })).optional(),
  payment: z.object({
    currency: z.string(),
    shipping_fee: amount,
    shipping_fee_platform_discount: amount.optional(),
  }),
  line_items: z.array(LineItem).min(1),
});

export type TikTokOrderT = z.infer<typeof TikTokOrder>;

/** Statuses that are not yet a sale. Re-sent by webhook when the status changes. */
const NOT_YET_SOLD = new Set(["UNPAID"]);
const CANCELLED = new Set(["CANCELLED"]);

export function mapTikTokOrder(raw: unknown, shopId: string | null): NormalizedOrderInput | null {
  const o = TikTokOrder.parse(raw);
  if (NOT_YET_SOLD.has(o.status)) return null;

  const items = o.line_items
    .filter((li) => li.display_status !== "CANCELLED")
    .map((li) => ({
      externalItemId: li.id,
      sku: li.seller_sku || li.sku_id || null,
      title: li.product_name,
      // TikTok 202309 returns one line item per unit; quantity is therefore 1.
      quantity: 1,
      unitPrice: li.original_price,
      sellerDiscount: li.seller_discount ?? "0",
      platformDiscount: li.platform_discount ?? "0",
    }));

  const fullyCancelled = CANCELLED.has(o.status) || items.length === 0;

  const rooms = o.line_items.map((li) => li.room_id);
  const liveRoomId = rooms.every((r) => r === undefined) ? null : (rooms.find((r) => r) ?? "");
  const packageIds = [
    ...new Set([...(o.packages ?? []).map((p) => p.id), ...o.line_items.map((li) => li.package_id).filter((x): x is string => !!x)]),
  ];

  return {
    platform: "tiktok",
    externalOrderId: o.id,
    paidAt: o.paid_time ? new Date(o.paid_time * 1000).toISOString() : null,
    customerId: o.user_id || null,
    liveRoomId,
    packageIds,
    source: "webhook",
    externalShopId: shopId,
    createdAt: new Date(o.create_time * 1000).toISOString(),
    status: fullyCancelled ? "cancelled" : "active",
    platformStatus: o.status,
    isTest: false,
    currency: o.payment.currency,
    // keep at least one item row so a cancelled order is still recorded
    items: items.length ? items : o.line_items.slice(0, 1).map((li) => ({
      externalItemId: li.id,
      sku: li.seller_sku || li.sku_id || null,
      title: li.product_name,
      quantity: 1,
      unitPrice: li.original_price,
      sellerDiscount: li.seller_discount ?? "0",
      platformDiscount: li.platform_discount ?? "0",
    })),
    refunds: [],
    customerShipping: o.payment.shipping_fee,
    platformShippingSubsidy: o.payment.shipping_fee_platform_discount ?? null,
    sellerShippingCost: null,
    platformGmv: null,
    actualPlatformFees: null,
    settlementAmount: null,
    raw,
  };
}

/**
 * Refunds from POST /return_refund/202309/returns/search (return_orders[]).
 * Only returns TikTok has completed/approved count. The merchandise amount is
 * refund_amount.refund_subtotal (shipping and tax refunds are excluded — they
 * are not product revenue). One refund per returned line item (TikTok line
 * items are one unit each); order-level refunds without line items carry no
 * quantity.
 */
const REFUNDED = new Set(["RETURN_OR_REFUND_REQUEST_SUCCESS", "RETURN_OR_REFUND_REQUEST_COMPLETE"]);
const amt = (v: unknown) => (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? v : null);

export function mapTikTokReturns(returnOrders: any[], orderId: string): NonNullable<NormalizedOrderInput["refunds"]> {
  const out: NonNullable<NormalizedOrderInput["refunds"]> = [];
  for (const r of returnOrders ?? []) {
    if (String(r?.order_id ?? "") !== orderId || !REFUNDED.has(r?.return_status) || !r?.return_id) continue;
    const at = new Date(((r.update_time ?? r.create_time ?? 0) as number) * 1000).toISOString();
    const lines = (r.return_line_items ?? []) as any[];
    const withAmounts = lines.filter((li) => amt(li?.refund_amount?.refund_subtotal) !== null);
    if (withAmounts.length) {
      for (const li of withAmounts) {
        out.push({
          externalRefundId: `${r.return_id}:${li.return_line_item_id ?? li.order_line_item_id}`,
          externalItemId: li.order_line_item_id ?? null,
          quantity: 1,
          amount: amt(li.refund_amount.refund_subtotal)!,
          refundedAt: at,
        });
      }
    } else if (amt(r.refund_amount?.refund_subtotal) !== null) {
      out.push({ externalRefundId: String(r.return_id), externalItemId: null, quantity: 0, amount: amt(r.refund_amount.refund_subtotal)!, refundedAt: at });
    }
  }
  return out;
}
