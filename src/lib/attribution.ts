/**
 * LIVE attribution service (Profit Tracker spec §13).
 *
 * Decides which show an order belongs to. Never guesses silently:
 *
 *  1. Verified platform link (highest priority). TikTok's Get Order Detail
 *     (202507+) returns `line_items[].room_id` — the LIVE session the item was
 *     bought in. A known room → that show. An unknown room → link it to the
 *     manual show open at that moment, or auto-create a detected show.
 *  2. Time window (fallback, only when the platform gives no LIVE info at all):
 *     exactly one show window contains the order → assign it. Two or more
 *     overlapping windows → "needs review".
 *  3. TikTok explicitly says "not from a LIVE" (empty room_id) but the order
 *     falls inside a show window → "needs review", never auto-assigned.
 *  4. Historical imports without a LIVE id are left unassigned.
 */

export type AttributionStatus = "assigned" | "unassigned" | "needs_review" | "not_live";
export type AttributionMethod = "platform_live_id" | "time_window" | "manual";

export type CandidateShow = {
  id: string;
  platform: "tiktok" | "whatnot" | "manual";
  isTest: boolean;
  startedAt: string;
  endedAt: string | null;
  liveRoomId: string | null;
  detection: "manual" | "platform";
};

export type AttributionOrder = {
  platform: "tiktok" | "whatnot" | "manual";
  isTest: boolean;
  createdAt: string;
  /** undefined/null = platform gave no LIVE info; "" = platform says not from a LIVE. */
  liveRoomId?: string | null;
  source: "webhook" | "import" | "manual" | "test";
};

export type AttributionSettings = { beforeMinutes: number; afterMinutes: number };

export type AttributionDecision =
  | { kind: "assign"; showId: string; method: AttributionMethod; note: string; linkRoomId?: string }
  | { kind: "create_show"; liveRoomId: string; note: string }
  | { kind: "needs_review"; candidateIds: string[]; note: string }
  | { kind: "unassigned"; status: "unassigned" | "not_live"; note: string };

export const DEFAULT_ATTRIBUTION: AttributionSettings = { beforeMinutes: 0, afterMinutes: 5 };

function inWindow(s: CandidateShow, t: number, cfg: AttributionSettings, now: number) {
  const from = Date.parse(s.startedAt) - cfg.beforeMinutes * 60_000;
  const to = (s.endedAt ? Date.parse(s.endedAt) : now) + cfg.afterMinutes * 60_000;
  return t >= from && t <= to;
}

export function decideAttribution(
  order: AttributionOrder,
  shows: CandidateShow[],
  cfg: AttributionSettings = DEFAULT_ATTRIBUTION,
  now: Date = new Date(),
): AttributionDecision {
  const t = Date.parse(order.createdAt);
  const eligible = shows.filter((s) => s.isTest === order.isTest && (s.platform === order.platform || s.platform === "manual"));
  const windowed = eligible.filter((s) => inWindow(s, t, cfg, Math.max(now.getTime(), t)));
  const room = order.liveRoomId;

  // 1. Verified platform LIVE id
  if (typeof room === "string" && room !== "") {
    const exact = eligible.find((s) => s.liveRoomId === room);
    if (exact) return { kind: "assign", showId: exact.id, method: "platform_live_id", note: `TikTok LIVE ${room}` };
    const open = windowed.filter((s) => s.liveRoomId === null);
    if (open.length === 1) {
      return { kind: "assign", showId: open[0].id, method: "platform_live_id", linkRoomId: room, note: `TikTok LIVE ${room} linked to this show` };
    }
    if (open.length > 1) {
      return { kind: "needs_review", candidateIds: open.map((s) => s.id), note: `TikTok LIVE ${room} overlaps ${open.length} shows` };
    }
    return { kind: "create_show", liveRoomId: room, note: `New TikTok LIVE ${room} detected` };
  }

  // 3. Platform says this was not a LIVE purchase
  if (room === "") {
    if (windowed.length) {
      return { kind: "needs_review", candidateIds: windowed.map((s) => s.id), note: "TikTok reports this order was not placed in a LIVE, but it falls inside a show" };
    }
    return { kind: "unassigned", status: "not_live", note: "Not placed in a LIVE" };
  }

  // 4. Historical imports need a verified LIVE id
  if (order.source === "import") return { kind: "unassigned", status: "unassigned", note: "Imported order without a LIVE id" };

  // 2. Time window
  if (windowed.length === 1) {
    return { kind: "assign", showId: windowed[0].id, method: "time_window", note: "Order time falls inside this show's window" };
  }
  if (windowed.length > 1) {
    return { kind: "needs_review", candidateIds: windowed.map((s) => s.id), note: `Order time overlaps ${windowed.length} show windows` };
  }
  return { kind: "unassigned", status: "unassigned", note: "No show was running" };
}
