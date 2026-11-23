import { describe, expect, it } from "vitest";
import { buildMarkdown, buildTelegramMessage } from "../src/report";

describe("buildMarkdown", () => {
  it("renders provider windows in report order and PAYG balances at the end", () => {
    // Given
    const now = new Date("2026-07-15T00:00:00.000Z");

    // When
    const markdown = buildMarkdown(
      [
        {
          kind: "windowed",
          provider: "ZenMux",
          windows: [
            { kind: "5h", usagePercent: 12.34, timePercent: 50, remainingMs: 9_000_000 },
            { kind: "7d", usagePercent: 100, timePercent: 80, remainingMs: 86_400_000 },
            {
              kind: "5h",
              usagePercent: 0,
              timePercent: 0,
              remainingMs: 18_000_000,
              timing: "idle",
            },
          ],
        },
        {
          kind: "windowed",
          provider: "Krill AI",
          windows: [
            {
              kind: "cycle",
              label: "Krill Pro 周卡",
              usagePercent: 25,
              timePercent: 50,
              remainingMs: 302_400_000,
            },
          ],
        },
        { kind: "balance", provider: "ZenMux", balance: "$33.65" },
        {
          kind: "balance",
          provider: "Krill AI",
          balance: "$364.06",
          breakdown: { wallet: "$344.05", welfare: "$20.01" },
        },
      ],
      now,
      "测试播报",
    );

    // Then
    expect(markdown).toContain("**测试播报**");
    expect(markdown).toContain(
      '5小时窗口：用量 [<font color="info">#</font><font color="comment">---------</font>] 12.3%；剩余 2小时30分钟',
    );
    expect(markdown).toContain(
      '7天窗口：用量 [<font color="warning">##########</font>] 100.0%；剩余 1天0小时',
    );
    expect(markdown).toContain(
      '5小时窗口：用量 [<font color="comment">----------</font>] 0.0%；尚未开始计时',
    );
    expect(markdown).toContain("**Krill AI**");
    expect(markdown).toContain(
      'Krill Pro 周卡：用量 [<font color="info">###</font><font color="comment">-------</font>] 25.0%；剩余 3天12小时',
    );
    expect(markdown).not.toContain("时长");
    expect(markdown).toContain("**备用按量渠道**");
    expect(markdown).toContain("> ZenMux：$33.65");
    expect(markdown).toContain("> Krill AI：$364.06 (余额 $344.05, 赠金 $20.01)");
    expect(markdown.indexOf("**备用按量渠道**")).toBeGreaterThan(markdown.indexOf("**ZenMux**"));
    expect(markdown.indexOf("**Krill AI**")).toBeLessThan(markdown.indexOf("**ZenMux**"));
  });
});

describe("buildTelegramMessage", () => {
  it("renders current quota as Telegram-safe plain text", () => {
    // Given
    const now = new Date("2026-07-15T00:00:00.000Z");

    // When
    const message = buildTelegramMessage(
      [
        {
          kind: "windowed",
          provider: "ZenMux",
          windows: [{ kind: "5h", usagePercent: 12.34, timePercent: 50, remainingMs: 9_000_000 }],
        },
        {
          kind: "windowed",
          provider: "Krill AI",
          windows: [
            {
              kind: "cycle",
              label: "Krill Pro 周卡",
              usagePercent: 25,
              timePercent: 50,
              remainingMs: 302_400_000,
            },
          ],
        },
        {
          kind: "balance",
          provider: "Krill AI",
          balance: "$364.06",
          breakdown: { wallet: "$344.05", welfare: "$20.01" },
        },
        { kind: "error", provider: "ZenMux", message: "upstream unavailable" },
      ],
      now,
    );

    // Then
    expect(message).toContain("AI 额度\n时间：2026/7/15 08:00:00");
    expect(message).toContain("ZenMux\n• 5小时窗口：已用 12.3%；剩余 2小时30分钟");
    expect(message).toContain("Krill AI\n• Krill Pro 周卡：已用 25.0%；剩余 3天12小时");
    expect(message).toContain("ZenMux\n• 获取失败：upstream unavailable");
    expect(message).toContain("备用按量渠道\n• Krill AI：$364.06 (余额 $344.05, 赠金 $20.01)");
    expect(message).not.toContain("<font");
    expect(message).not.toContain("**");
    expect(message.indexOf("Krill AI\n• Krill Pro 周卡")).toBeLessThan(message.indexOf("ZenMux\n"));
  });

  it("limits messages to Telegram's 4096-character boundary", () => {
    // Given
    const oversizedError = "x".repeat(5_000);

    // When
    const message = buildTelegramMessage([
      { kind: "error", provider: "ZenMux", message: oversizedError },
    ]);

    // Then
    expect(Array.from(message)).toHaveLength(4_096);
    expect(message.endsWith("…")).toBe(true);
  });
});
