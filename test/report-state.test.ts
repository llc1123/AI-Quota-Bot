import { describe, expect, it } from "vitest";
import {
  type ReportStateStore,
  reportBaseline,
  saveReportBaseline,
  shouldSendForReportChange,
  shouldSendScheduledReport,
} from "../src/report-state";

describe("scheduled report state", () => {
  it("suppresses scheduled sends when every window and balance change stays within threshold", () => {
    // Given
    const previous = {
      windows: {
        "Codex:7d": 10,
        "ZenMux:5h": 0,
        "ZenMux:7d": 94,
      },
      balances: {
        "Krill AI": 100,
        ZenMux: 33.65,
      },
    };
    const current = {
      windows: {
        "Codex:7d": 14.9,
        "ZenMux:5h": 0,
        "ZenMux:7d": 99,
      },
      balances: {
        "Krill AI": 90,
        ZenMux: 23.65,
      },
    };

    // When
    const shouldSend = shouldSendForReportChange(previous, current);

    // Then
    expect(shouldSend).toBe(false);
  });

  it("sends scheduled reports when any window changes by more than five percentage points", () => {
    // Given
    const previous = { windows: { "Codex:7d": 10, "ZenMux:7d": 95 }, balances: {} };
    const current = { windows: { "Codex:7d": 15.1, "ZenMux:7d": 100 }, balances: {} };

    // When
    const shouldSend = shouldSendForReportChange(previous, current);

    // Then
    expect(shouldSend).toBe(true);
  });

  it("sends scheduled reports when any window newly reaches one hundred percent", () => {
    // Given
    const previous = { windows: { "ZenMux:7d": 96 }, balances: {} };
    const current = { windows: { "ZenMux:7d": 100 }, balances: {} };

    // When
    const shouldSend = shouldSendForReportChange(previous, current);

    // Then
    expect(shouldSend).toBe(true);
  });

  it("suppresses scheduled reports when a window remains at one hundred percent", () => {
    // Given
    const previous = { windows: { "ZenMux:7d": 100 }, balances: {} };
    const current = { windows: { "ZenMux:7d": 100 }, balances: {} };

    // When
    const shouldSend = shouldSendForReportChange(previous, current);

    // Then
    expect(shouldSend).toBe(false);
  });

  it("sends scheduled reports when any PAYG balance changes by more than ten dollars", () => {
    // Given
    const previous = { windows: {}, balances: { "Krill AI": 100, ZenMux: 33.65 } };
    const current = { windows: {}, balances: { "Krill AI": 110.01, ZenMux: 33.65 } };

    // When
    const shouldSend = shouldSendForReportChange(previous, current);

    // Then
    expect(shouldSend).toBe(true);
  });

  it("extracts window usage and PAYG balances into the persisted baseline", () => {
    // Given
    const snapshots = [
      {
        kind: "windowed",
        provider: "Codex",
        windows: [{ kind: "7d", usagePercent: 3, timePercent: 10, remainingMs: 60_000 }],
      },
      { kind: "balance", provider: "Krill AI", balance: "$1.00" },
      { kind: "error", provider: "ZenMux", message: "downstream failed" },
    ] as const;

    // When
    const baseline = reportBaseline(snapshots);

    // Then
    expect(baseline).toEqual({ windows: { "Codex:7d": 3 }, balances: { "Krill AI": 1 } });
  });

  it("keeps the last sent baseline until a scheduled report actually sends", async () => {
    // Given
    const store = new Map<string, string>();
    const state = {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    } satisfies ReportStateStore;
    const sent = [
      {
        kind: "windowed",
        provider: "Codex",
        windows: [{ kind: "7d", usagePercent: 10, timePercent: 0, remainingMs: 60_000 }],
      },
    ] as const;
    const unsent = [
      {
        kind: "windowed",
        provider: "Codex",
        windows: [{ kind: "7d", usagePercent: 14, timePercent: 0, remainingMs: 60_000 }],
      },
    ] as const;
    const cumulative = [
      {
        kind: "windowed",
        provider: "Codex",
        windows: [{ kind: "7d", usagePercent: 16, timePercent: 0, remainingMs: 60_000 }],
      },
    ] as const;
    await saveReportBaseline(state, sent);

    // When
    const firstCheck = await shouldSendScheduledReport(state, unsent);
    const secondCheck = await shouldSendScheduledReport(state, cumulative);

    // Then
    expect(firstCheck).toBe(false);
    expect(secondCheck).toBe(true);
  });
});
