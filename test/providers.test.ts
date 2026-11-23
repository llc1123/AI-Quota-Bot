import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectSnapshots,
  parseZenmuxPaygBalance,
  parseZenmuxSubscription,
} from "../src/providers";

vi.mock("../src/env", () => ({
  krillApiBase: vi.fn(() => "https://krill.test"),
  requiredEnv: vi.fn(() => "test-key"),
  zenmuxApiBase: vi.fn(() => "https://zenmux.test"),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("quota provider parsers", () => {
  it("parses ZenMux documented subscription detail quotas", () => {
    // Given
    const now = Date.parse("2026-03-24T03:35:09.000Z");

    // When
    const windows = parseZenmuxSubscription(
      {
        success: true,
        data: {
          quota_5_hour: { usage_percentage: 0.0715, resets_at: "2026-03-24T08:35:09.000Z" },
          quota_7_day: { usage_percentage: 0.0673, resets_at: "2026-03-26T03:35:09.000Z" },
        },
      },
      now,
    );

    // Then
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ kind: "5h", timePercent: 0, remainingMs: 18_000_000 });
    expect(windows[0]?.usagePercent).toBeCloseTo(7.15);
    expect(windows[1]).toMatchObject({ kind: "7d", remainingMs: 172_800_000 });
    expect(windows[1]?.usagePercent).toBeCloseTo(6.73);
    expect(windows[1]?.timePercent).toBeCloseTo(71.43, 2);
  });

  it("keeps ZenMux idle windows at zero time progress when reset is null", () => {
    // Given
    const now = Date.parse("2026-07-15T00:00:00.000Z");

    // When
    const windows = parseZenmuxSubscription(
      {
        success: true,
        data: {
          quota_5_hour: { usage_percentage: 0, resets_at: null },
          quota_7_day: { usage_percentage: 0, resets_at: null },
        },
      },
      now,
    );

    // Then
    expect(windows).toEqual([
      { kind: "5h", usagePercent: 0, timePercent: 0, remainingMs: 18_000_000, timing: "idle" },
      {
        kind: "7d",
        usagePercent: 0,
        timePercent: 0,
        remainingMs: 604_800_000,
        timing: "idle",
      },
    ]);
  });

  it("parses ZenMux documented PAYG total balance", () => {
    // Given
    const payload = {
      success: true,
      data: {
        currency: "usd",
        total_credits: 33.654865253,
        top_up_credits: 33.624698853,
        bonus_credits: 0.0301664,
      },
    };

    // When
    const balance = parseZenmuxPaygBalance(payload);

    // Then
    expect(balance).toBe("$33.65");
  });

  it("paces concurrent ZenMux PAYG requests by five seconds while collecting Krill directly", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const paygStarts: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/api/v1/management/payg/balance")) {
          paygStarts.push(Date.now());
          return Response.json({ data: { total_credits: 1 } });
        }
        if (url.endsWith("/api/v1/management/subscription/detail")) {
          return Response.json({ data: {} });
        }
        if (url === "https://krill.test/api/subscription") {
          expect(init?.headers).toEqual({ authorization: "Bearer test-key" });
          return Response.json({ data: { credit_balance_usd: 100, welfare_balance_usd: 25 } });
        }
        throw new Error(`Unexpected provider URL: ${url}`);
      }),
    );
    const env = {} as unknown as Env;

    const reports = Promise.all([collectSnapshots(env), collectSnapshots(env)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(paygStarts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(paygStarts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    const snapshots = await reports;

    expect(paygStarts).toEqual([0, 5_000]);
    for (const report of snapshots) {
      expect(report).toEqual([
        { kind: "windowed", provider: "ZenMux", windows: [] },
        { kind: "balance", provider: "ZenMux", balance: "$1.00" },
        {
          kind: "balance",
          provider: "Krill AI",
          balance: "$100.00",
          breakdown: { wallet: "$75.00", welfare: "$25.00" },
        },
      ]);
    }
  });
});
