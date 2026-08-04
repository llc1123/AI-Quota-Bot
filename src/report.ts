import type { ProviderSnapshot, QuotaWindow, WindowKind } from "./providers";

const BAR_WIDTH = 10;
type FontColor = "comment" | "info" | "warning";
type MainSnapshot = Exclude<ProviderSnapshot, { readonly kind: "balance" }>;

function percent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function remaining(ms: number): string {
  if (ms <= 0) return "0分钟";
  const minutes = Math.ceil(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${rest}分钟`;
  return `${rest}分钟`;
}

function label(kind: WindowKind): string {
  switch (kind) {
    case "1d":
      return "24小时窗口";
    case "5h":
      return "5小时窗口";
    case "7d":
      return "7天窗口";
    case "cycle":
      return "周期窗口";
  }
}

function windowLabel(window: QuotaWindow): string {
  return window.label ?? label(window.kind);
}

function providerRank(provider: string): number {
  switch (provider) {
    case "Codex":
      return 0;
    case "Krill AI":
      return 1;
    case "ZenMux":
      return 2;
    default:
      return 3;
  }
}

function orderedMainSnapshots(snapshots: readonly MainSnapshot[]): readonly MainSnapshot[] {
  return [...snapshots].sort(
    (left, right) => providerRank(left.provider) - providerRank(right.provider),
  );
}

function color(value: number): FontColor {
  return value >= 80 ? "warning" : "info";
}

function colorText(value: string, fontColor: FontColor): string {
  return `<font color="${fontColor}">${value}</font>`;
}

function bar(value: number, fontColor: FontColor): string {
  const clamped = Math.max(0, Math.min(100, value));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const filledText = "#".repeat(filled);
  const emptyText = "-".repeat(BAR_WIDTH - filled);
  const parts = [
    filledText ? colorText(filledText, fontColor) : "",
    emptyText ? colorText(emptyText, "comment") : "",
  ];
  return `[${parts.join("")}]`;
}

function line(window: QuotaWindow): string {
  const suffix =
    window.timing === "idle" ? "尚未开始计时" : `剩余 ${remaining(window.remainingMs)}`;
  return `> ${windowLabel(window)}：用量 ${bar(window.usagePercent, color(window.usagePercent))} ${percent(window.usagePercent)}；${suffix}`;
}

export function buildMarkdown(
  snapshots: readonly ProviderSnapshot[],
  now = new Date(),
  title = "AI 额度播报",
): string {
  const parts = [
    `**${title}**`,
    `> 时间：${now.toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}`,
  ];
  const balances: Extract<ProviderSnapshot, { readonly kind: "balance" }>[] = [];
  const mainSnapshots: MainSnapshot[] = [];
  for (const snapshot of snapshots) {
    if (snapshot.kind === "balance") {
      balances.push(snapshot);
      continue;
    }
    mainSnapshots.push(snapshot);
  }
  for (const snapshot of orderedMainSnapshots(mainSnapshots)) {
    if (snapshot.kind === "windowed") {
      parts.push(`\n**${snapshot.provider}**`);
      parts.push(
        ...(snapshot.windows.length > 0 ? snapshot.windows.map(line) : ["> 未返回窗口额度"]),
      );
      continue;
    }
    parts.push(
      `\n**${snapshot.provider}**`,
      `> <font color="warning">获取失败</font>：${snapshot.message}`,
    );
  }
  if (balances.length > 0) {
    parts.push(
      "\n**备用按量渠道**",
      ...balances.map((snapshot) => `> ${snapshot.provider}：${snapshot.balance}`),
    );
  }
  return parts.join("\n");
}

export function buildTelegramMessage(
  snapshots: readonly ProviderSnapshot[],
  now = new Date(),
): string {
  const parts = [
    "AI 额度",
    `时间：${now.toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}`,
  ];
  const balances: Extract<ProviderSnapshot, { readonly kind: "balance" }>[] = [];
  const mainSnapshots: MainSnapshot[] = [];
  for (const snapshot of snapshots) {
    if (snapshot.kind === "balance") {
      balances.push(snapshot);
      continue;
    }
    mainSnapshots.push(snapshot);
  }
  for (const snapshot of orderedMainSnapshots(mainSnapshots)) {
    if (snapshot.kind === "windowed") {
      parts.push(`\n${snapshot.provider}`);
      parts.push(
        ...(snapshot.windows.length > 0
          ? snapshot.windows.map((window) => {
              const suffix =
                window.timing === "idle" ? "尚未开始计时" : `剩余 ${remaining(window.remainingMs)}`;
              return `• ${windowLabel(window)}：已用 ${percent(window.usagePercent)}；${suffix}`;
            })
          : ["• 未返回窗口额度"]),
      );
      continue;
    }
    parts.push(`\n${snapshot.provider}`, `• 获取失败：${snapshot.message}`);
  }
  if (balances.length > 0) {
    parts.push(
      "\n备用按量渠道",
      ...balances.map((snapshot) => `• ${snapshot.provider}：${snapshot.balance}`),
    );
  }
  const message = Array.from(parts.join("\n"));
  return message.length <= 4_096 ? message.join("") : `${message.slice(0, 4_095).join("")}…`;
}
