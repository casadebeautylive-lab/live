import { z } from "zod";

/**
 * TikTok Shop webhook envelope. Only ORDER_STATUS_CHANGE (type 1) is handled;
 * its data carries order_id and order_status, so we fetch full order detail.
 */
export const TikTokWebhook = z.object({
  type: z.number().int(),
  tts_notification_id: z.string(),
  shop_id: z.string(),
  timestamp: z.number().int(),
  data: z.record(z.string(), z.unknown()),
});
export type TikTokWebhookT = z.infer<typeof TikTokWebhook>;

export const ORDER_STATUS_CHANGE = 1;

export function orderIdFrom(evt: TikTokWebhookT): string | null {
  const id = evt.data.order_id;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
}
