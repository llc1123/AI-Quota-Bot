import { describe, expect, it } from "vitest";
import { KRILL_API_BASE, krillApiBase } from "../src/env";
import { joinUrl } from "../src/http";
import { parseKrillBalance, parseKrillCycleWindows } from "../src/providers";

describe("Krill provider parsers", () => {
  it.each([
    ["364.055239", "20.005239", "$364.06", "$344.05", "$20.01"],
    [100, 25, "$100.00", "$75.00", "$25.00"],
    [0, 0, "$0.00", "$0.00", "$0.00"],
    [100, 100, "$100.00", "$0.00", "$100.00"],
    [100, undefined, "$100.00", "$100.00", "$0.00"],
  ])(
    "splits total credit %s and welfare %s into wallet and gift balances",
    (credit, welfare, total, wallet, gift) => {
      // Given
      const payload = { data: { credit_balance_usd: credit, welfare_balance_usd: welfare } };

      // When
      const balance = parseKrillBalance(payload);

      // Then
      expect(balance).toEqual({
        kind: "balance",
        provider: "Krill AI",
        balance: total,
        breakdown: { wallet, welfare: gift },
      });
    },
  );

  it("parses active cycle-card quota windows", () => {
    // Given
    const now = Date.parse("2026-08-04T12:00:00.000Z");
    const payload = {
      data: {
        subscriptions: [
          {
            subscription_id: "weekly-card-1",
            subscription_end_at: "2026-08-08T00:00:00.000Z",
            plan: { billing_type: "usd_weekly", name: "Krill Pro 周卡" },
            quota: {
              used_usd: "2.50",
              daily_limit_usd: "10.00",
              window_start_at: "2026-08-01T00:00:00.000Z",
              window_reset_at: "2026-08-08T00:00:00.000Z",
            },
          },
          {
            subscription_id: "daily-card-1",
            subscription_end_at: "2026-08-05T00:00:00.000Z",
            plan: { billing_type: "usd_daily" },
            total_used_usd: "1.25",
            total_limit_usd: "5.00",
          },
        ],
      },
    };

    // When
    const windows = parseKrillCycleWindows(payload, now);

    // Then
    expect(windows).toEqual([
      {
        id: "weekly-card-1",
        kind: "cycle",
        label: "Krill Pro 周卡",
        usagePercent: 25,
        timePercent: 50,
        remainingMs: 302_400_000,
      },
      {
        id: "daily-card-1",
        kind: "1d",
        usagePercent: 25,
        timePercent: 50,
        remainingMs: 43_200_000,
      },
    ]);
  });

  it("ignores subscriptions with unsupported billing types", () => {
    // Given
    const payload = {
      data: {
        subscriptions: [
          {
            subscription_id: "future-card",
            subscription_end_at: "2026-08-08T00:00:00.000Z",
            plan: { billing_type: "usd_future" },
            quota: { used_usd: "2.50", daily_limit_usd: "10.00" },
          },
        ],
      },
    };

    // When
    const windows = parseKrillCycleWindows(payload, Date.parse("2026-08-04T12:00:00.000Z"));

    // Then
    expect(windows).toEqual([]);
  });

  it("sanitizes cycle-card labels before report rendering", () => {
    // Given
    const payload = {
      data: {
        subscriptions: [
          {
            subscription_id: "weekly-card-1",
            subscription_end_at: "2026-08-08T00:00:00.000Z",
            plan: { billing_type: "usd_weekly", display_name: "  Krill\n旗舰<周卡>  " },
            quota: { used_usd: "2.50", daily_limit_usd: "10.00" },
          },
        ],
      },
    };

    // When
    const windows = parseKrillCycleWindows(payload, Date.parse("2026-08-04T12:00:00.000Z"));

    // Then
    expect(windows[0]?.label).toBe("Krill 旗舰周卡");
  });

  it("does not guess balances from unrelated nested fields", () => {
    // Given
    const payload = { data: { invoice: { amount: "99.00" }, credit: "88.00" } };

    // When
    const balance = parseKrillBalance(payload);

    // Then
    expect(balance).toBeUndefined();
  });

  it("bounds cycle-card fan-out and persisted subscription ids", () => {
    // Given
    const now = Date.parse("2026-08-04T12:00:00.000Z");
    const subscription = (subscriptionId: string) => ({
      subscription_id: subscriptionId,
      subscription_end_at: "2026-08-08T00:00:00.000Z",
      plan: { billing_type: "usd_weekly" },
      quota: { used_usd: "2.50", daily_limit_usd: "10.00" },
    });

    // When
    const windows = parseKrillCycleWindows(
      {
        data: {
          subscriptions: Array.from({ length: 25 }, (_, index) =>
            subscription("x".repeat(index + 120)),
          ),
        },
      },
      now,
    );

    // Then
    expect(windows).toHaveLength(20);
    expect(windows[8]?.id).toBe("x".repeat(128));
    expect(windows[9]?.id).toBeUndefined();
  });

  it("targets the www.krill-code.com host directly so Authorization survives the request", () => {
    // Given / When / Then
    expect(KRILL_API_BASE).toBe("https://www.krill-code.com");
    expect(joinUrl(krillApiBase({}), "/api/subscription")).toBe(
      "https://www.krill-code.com/api/subscription",
    );
  });

  it("lets KRILL_API_BASE override the base url but keep the path fixed", () => {
    // Given / When / Then
    expect(krillApiBase({ KRILL_API_BASE: "https://staging.krill.example/" })).toBe(
      "https://staging.krill.example/",
    );
    expect(krillApiBase({ KRILL_API_BASE: "  " })).toBe(KRILL_API_BASE);
  });
});
