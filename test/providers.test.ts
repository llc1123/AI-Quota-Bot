import { describe, expect, it } from "vitest";
import { KRILL_SUBSCRIPTION_URL } from "../src/env";
import {
  codexUsageJson,
  parseCodexUsage,
  parseKrillBalance,
  parseZenmuxPaygBalance,
  parseZenmuxSubscription,
} from "../src/providers";

describe("quota provider parsers", () => {
  it("parses Codex wham usage rate limit windows", () => {
    // Given
    const now = Date.parse("2026-07-15T00:00:00.000Z");

    // When
    const windows = parseCodexUsage(
      {
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: 12.5,
            reset_at: now / 1000 + 60 * 60,
            limit_window_seconds: 18_000,
          },
          secondary_window: {
            used_percent: 80,
            reset_after_seconds: 86_400,
            limit_window_seconds: 604_800,
          },
        },
      },
      now,
    );

    // Then
    expect(windows).toEqual([
      { kind: "5h", usagePercent: 12.5, timePercent: 80, remainingMs: 3_600_000 },
      {
        kind: "7d",
        usagePercent: 80,
        timePercent: expect.closeTo(85.714, 3),
        remainingMs: 86_400_000,
      },
    ]);
  });

  it("classifies Codex windows by their actual window length", () => {
    // Given
    const now = Date.parse("2026-07-15T00:00:00.000Z");

    // When
    const windows = parseCodexUsage(
      {
        rate_limit: {
          primary_window: {
            used_percent: 2,
            reset_after_seconds: 86_400,
            limit_window_seconds: 604_800,
          },
          secondary_window: null,
        },
      },
      now,
    );

    // Then
    expect(windows).toEqual([
      {
        kind: "7d",
        usagePercent: 2,
        timePercent: expect.closeTo(85.714, 3),
        remainingMs: 86_400_000,
      },
    ]);
  });

  it("discovers any Codex rate limit window by its actual duration", () => {
    // Given
    const now = Date.parse("2026-07-15T00:00:00.000Z");

    // When
    const windows = parseCodexUsage(
      {
        rate_limit: {
          weekly_window: {
            used_percent: 3,
            reset_after_seconds: 86_400,
            limit_window_seconds: 604_800,
          },
          rolling_five_hour_window: {
            used_percent: 40,
            reset_after_seconds: 9_000,
            limit_window_seconds: 18_000,
          },
        },
      },
      now,
    );

    // Then
    expect(windows.map((window) => window.kind)).toEqual(["7d", "5h"]);
    expect(windows[1]).toMatchObject({ kind: "5h", usagePercent: 40, remainingMs: 9_000_000 });
  });

  it("reports Codex usage egress blocks as a short error", async () => {
    // Given
    const response = Response.json(
      { error: "Codex usage blocked by OpenAI before authentication in Worker fetch" },
      { status: 502 },
    );

    // When / Then
    await expect(codexUsageJson(response)).rejects.toThrow(
      "Codex usage blocked by OpenAI before authentication in Worker fetch",
    );
  });

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

  it("parses Krill subscription balances from numeric strings", () => {
    // Given
    const payload = { data: { credit_balance_usd: "364.055239", welfare_balance_usd: "0" } };

    // When
    const balance = parseKrillBalance(payload);

    // Then
    expect(balance).toBe("$364.06");
  });

  it("uses the Krill final API host so Authorization survives the request", () => {
    // Given / When / Then
    expect(KRILL_SUBSCRIPTION_URL).toBe("https://www.krill-ai.net/api/subscription");
  });
});
