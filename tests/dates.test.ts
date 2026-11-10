import { describe, expect, it } from "vitest";
import { startOfLocalDay } from "@/lib/dates";

describe("time zone day boundaries", () => {
  it("New York midnight in EDT and EST", () => {
    expect(startOfLocalDay("America/New_York", "2026-10-08").toISOString()).toBe("2026-10-08T04:00:00.000Z");
    expect(startOfLocalDay("America/New_York", "2026-12-08").toISOString()).toBe("2026-12-08T05:00:00.000Z");
  });
  it("DST change day", () => {
    expect(startOfLocalDay("America/New_York", "2026-11-01").toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });
});

import { localToUtc, utcToLocalInput } from "@/lib/dates";

describe("account-time-zone form times", () => {
  it("New York wall clock ↔ UTC across DST", () => {
    expect(localToUtc("America/New_York", "2026-10-14T20:30").toISOString()).toBe("2026-10-15T00:30:00.000Z"); // EDT
    expect(localToUtc("America/New_York", "2026-12-14T20:30").toISOString()).toBe("2026-12-15T01:30:00.000Z"); // EST
    expect(utcToLocalInput("2026-10-15T00:30:00.000Z", "America/New_York")).toBe("2026-10-14T20:30");
  });
});
