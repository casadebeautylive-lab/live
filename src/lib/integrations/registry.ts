/**
 * Integration registry. Each platform declares what it can actually do today,
 * so the UI never implies a capability that has not been verified.
 */
export type IntegrationInfo = {
  platform: "tiktok" | "whatnot";
  name: string;
  authorization: "oauth" | "none_available";
  realtimeOrders: "webhook" | "unavailable";
  showDetection: "platform" | "manual_only";
  notes: string[];
};

export const INTEGRATIONS: IntegrationInfo[] = [
  {
    platform: "tiktok",
    name: "TikTok Shop",
    authorization: "oauth",
    realtimeOrders: "webhook",
    showDetection: "platform",
    notes: [
      "Orders arrive via the ORDER_STATUS_CHANGE webhook; full detail (Order API 202507) includes the LIVE room_id of each item.",
      "A new room_id opens a show automatically; it closes after the configured quiet period. TikTok LIVE analytics later confirm the exact start/end and title (about a day behind).",
      "Fees, shipping and settlements come from the Finance API: TikTok's estimates while unsettled, settled totals afterwards. Until then the app's fee rule is used and marked estimated.",
      "Orders TikTok says were not bought in a LIVE, or that overlap two shows, go to Orders → Needs review instead of being guessed.",
    ],
  },
  {
    platform: "whatnot",
    name: "Whatnot",
    authorization: "none_available",
    realtimeOrders: "unavailable",
    showDetection: "manual_only",
    notes: [
      "No authorized Whatnot API access is configured. The connection stays Pending Access — nothing is faked.",
      "When Whatnot grants seller API access, implement an adapter that emits NormalizedOrder and reuse the same ingestion pipeline.",
      "Meanwhile, Whatnot shows can still be tracked manually for time-based costs and expenses.",
    ],
  },
];
