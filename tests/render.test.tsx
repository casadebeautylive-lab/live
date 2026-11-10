import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { LiveDashboard } from "@/components/LiveDashboard";
import { evenOrders, ONE_HOUR_LATER, show } from "./helpers";
import type { ShowSnapshot } from "@/lib/data/shows";

function snapshot(isTest: boolean): ShowSnapshot {
  const input = show(evenOrders(100, "10.00"), { endedAt: ONE_HOUR_LATER.toISOString() });
  return {
    meta: { id: "s1", title: "Friday gold drop", platform: "tiktok", status: "ended", isTest, startedAt: input.startedAt, endedAt: input.endedAt, recalculatedAt: null, staff: [], detection: "manual", liveRoomId: null, timesVerified: false, notes: null },
    input,
    recent: [{ id: "o1", at: input.orders[99].createdAt, title: "Gold hoop", units: 1, amount: "10.00", shipping: "4.99", refunded: "0.00", externalId: "T-1", status: "active" }],
  };
}

const conn = { platform: "tiktok", status: "pending_access" as const, lastEventAt: null, lastSyncAt: null, lastError: null };

describe("dashboard server render (spec §4 example: 100 units at $10, 60 min)", () => {
  it("shows the spec's profit, profit per minute/hour and margin", () => {
    const html = renderToString(<LiveDashboard initial={snapshot(true)} timezone="America/New_York" connection={conn} alertRules={[]} />);
    expect(html).toContain("$540.00"); // estimated net profit and profit/hour
    expect(html).toContain("$9.00"); // profit per minute
    expect(html).toContain("54.0%");
    expect(html).toContain("$460.00"); // total expenses
    expect(html).toContain("Profit by minute");
    expect(html).toContain("Money in from buyers");
    expect(html).toContain("$14.99"); // recent sale: $10 product + $4.99 shipping
    expect(html).toContain("TEST SHOW");
    expect(html).toContain("Not reported"); // GMV never derived
  });

  it("warns prominently when a real show's platform is not connected", () => {
    const html = renderToString(<LiveDashboard initial={snapshot(false)} timezone="America/New_York" connection={conn} alertRules={[]} />);
    expect(html).toContain("pending access");
    expect(html).not.toContain("TEST SHOW");
  });
});

import { readFileSync } from "node:fs";
describe("server pages never hand Decimals to client components", () => {
  it("profit panels used by the show page are server-safe", () => {
    const src = readFileSync("src/components/ProfitPanels.tsx", "utf8");
    expect(src.startsWith('"use client"')).toBe(false);
    expect(src).not.toMatch(/\buse(State|Effect|Memo|Ref|Callback)\b/);
    const page = readFileSync("src/app/(app)/shows/[id]/page.tsx", "utf8");
    expect(page).not.toMatch(/from "@\/components\/LiveDashboard"/);
  });
});
