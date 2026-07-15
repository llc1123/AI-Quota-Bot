import { isRecord } from "./http";
import type { ProviderSnapshot } from "./providers";

const LAST_REPORT_BASELINE_KEY = "last-report-baseline";
const USAGE_CHANGE_THRESHOLD = 5;
const BALANCE_CHANGE_THRESHOLD = 10;

export type ReportBaseline = {
  readonly windows: Readonly<Record<string, number>>;
  readonly balances: Readonly<Record<string, number>>;
};

export interface ReportStateStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

function dollars(value: string): number | undefined {
  const match = /^\$(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? amount : undefined;
}

export function reportBaseline(snapshots: readonly ProviderSnapshot[]): ReportBaseline {
  const windows: Record<string, number> = {};
  const balances: Record<string, number> = {};
  for (const snapshot of snapshots) {
    if (snapshot.kind === "windowed") {
      for (const window of snapshot.windows) {
        windows[`${snapshot.provider}:${window.kind}`] = window.usagePercent;
      }
      continue;
    }
    if (snapshot.kind === "balance") {
      const amount = dollars(snapshot.balance);
      if (amount !== undefined) balances[snapshot.provider] = amount;
    }
  }
  return { windows, balances };
}

export function shouldSendForReportChange(
  previous: ReportBaseline | undefined,
  current: ReportBaseline,
): boolean {
  if (previous === undefined) return true;
  const windowChanged = Object.entries(current.windows).some(([key, after]) => {
    const before = previous.windows[key];
    return (
      before === undefined ||
      Math.abs(after - before) > USAGE_CHANGE_THRESHOLD ||
      (before < 100 && after >= 100)
    );
  });
  const balanceChanged = Object.entries(current.balances).some(([key, after]) => {
    const before = previous.balances[key];
    return before !== undefined && Math.abs(after - before) > BALANCE_CHANGE_THRESHOLD;
  });
  return windowChanged || balanceChanged;
}

function parseNumberRecord(value: unknown): Readonly<Record<string, number>> {
  if (!isRecord(value)) return {};
  const parsed: Record<string, number> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) parsed[key] = candidate;
  }
  return parsed;
}

function parseBaseline(raw: string | null): ReportBaseline | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!isRecord(parsed)) return undefined;
  return {
    windows: parseNumberRecord(parsed["windows"]),
    balances: parseNumberRecord(parsed["balances"]),
  };
}

export async function shouldSendScheduledReport(
  state: ReportStateStore,
  snapshots: readonly ProviderSnapshot[],
): Promise<boolean> {
  const previous = parseBaseline(await state.get(LAST_REPORT_BASELINE_KEY));
  return shouldSendForReportChange(previous, reportBaseline(snapshots));
}

export async function saveReportBaseline(
  state: ReportStateStore,
  snapshots: readonly ProviderSnapshot[],
): Promise<void> {
  await state.put(LAST_REPORT_BASELINE_KEY, JSON.stringify(reportBaseline(snapshots)));
}
