import { isRecord } from "./http";
import type { ProviderSnapshot, QuotaWindow, WindowKind } from "./providers";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;
const MAX_SUBSCRIPTIONS = 20;
const MAX_SUBSCRIPTION_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 48;
const LABEL_FIELDS = [
  "name",
  "title",
  "display_name",
  "displayName",
  "product_name",
  "productName",
  "nickname",
] as const;

function numberLike(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function dateMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function progress(
  startMs: number | undefined,
  resetMs: number | undefined,
  fallbackWindowMs: number,
  nowMs: number,
): Pick<QuotaWindow, "timePercent" | "remainingMs"> {
  if (resetMs === undefined || resetMs <= nowMs) return { timePercent: 100, remainingMs: 0 };
  const windowMs =
    startMs === undefined || startMs >= resetMs ? fallbackWindowMs : resetMs - startMs;
  const elapsed = Math.max(0, nowMs - (startMs ?? resetMs - fallbackWindowMs));
  return {
    timePercent: Math.max(0, Math.min(100, (elapsed / windowMs) * 100)),
    remainingMs: resetMs - nowMs,
  };
}

function usagePercent(used: number | undefined, limit: number | undefined): number | undefined {
  if (used === undefined || limit === undefined || limit <= 0) return undefined;
  return Math.max(0, (used / limit) * 100);
}

function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\r\n]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return undefined;
  return Array.from(cleaned).slice(0, MAX_LABEL_LENGTH).join("");
}

function krillWindowLabel(raw: Record<string, unknown>, plan: Record<string, unknown> | undefined) {
  for (const field of LABEL_FIELDS) {
    const label = cleanLabel(raw[field]) ?? cleanLabel(plan?.[field]);
    if (label !== undefined) return label;
  }
  return undefined;
}

function krillWindowKind(billingType: string | undefined): WindowKind | undefined {
  if (billingType === "usd_daily") return "1d";
  if (billingType === "usd_weekly" || billingType === "usd_monthly") return "cycle";
  return undefined;
}

function krillFallbackWindowMs(kind: WindowKind): number {
  return kind === "1d" ? ONE_DAY_MS : SEVEN_DAYS_MS;
}

function krillCycleWindow(raw: unknown, nowMs: number): QuotaWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const plan = isRecord(raw["plan"]) ? raw["plan"] : undefined;
  const billingType = typeof plan?.["billing_type"] === "string" ? plan["billing_type"] : undefined;
  const kind = krillWindowKind(billingType);
  if (kind === undefined) return undefined;
  const quota = isRecord(raw["quota"]) ? raw["quota"] : undefined;
  if (kind === "cycle" && quota === undefined) return undefined;

  const used = kind === "1d" ? numberLike(raw["total_used_usd"]) : numberLike(quota?.["used_usd"]);
  const limit =
    kind === "1d" ? numberLike(raw["total_limit_usd"]) : numberLike(quota?.["daily_limit_usd"]);
  const percent = usagePercent(used, limit);
  if (percent === undefined) return undefined;

  const startMs = dateMs(quota?.["window_start_at"]);
  const resetMs = dateMs(quota?.["window_reset_at"]) ?? dateMs(raw["subscription_end_at"]);
  const rawId = typeof raw["subscription_id"] === "string" ? raw["subscription_id"].trim() : "";
  const id = rawId.length <= MAX_SUBSCRIPTION_ID_LENGTH ? rawId : "";
  const label = krillWindowLabel(raw, plan);
  return {
    ...(id === "" ? {} : { id }),
    ...(label === undefined ? {} : { label }),
    kind,
    usagePercent: percent,
    ...progress(startMs, resetMs, krillFallbackWindowMs(kind), nowMs),
  };
}

export function parseKrillCycleWindows(raw: unknown, nowMs = Date.now()): readonly QuotaWindow[] {
  const data = isRecord(raw) && isRecord(raw["data"]) ? raw["data"] : raw;
  if (!isRecord(data) || !Array.isArray(data["subscriptions"])) return [];
  return data["subscriptions"].slice(0, MAX_SUBSCRIPTIONS).flatMap((value) => {
    const window = krillCycleWindow(value, nowMs);
    return window === undefined ? [] : [window];
  });
}

export function parseKrillBalance(
  raw: unknown,
): Extract<ProviderSnapshot, { readonly kind: "balance" }> | undefined {
  if (!isRecord(raw) || !isRecord(raw["data"])) return undefined;
  const total = numberLike(raw["data"]["credit_balance_usd"]);
  const welfare = numberLike(raw["data"]["welfare_balance_usd"]) ?? 0;
  if (total === undefined) return undefined;
  return {
    kind: "balance",
    provider: "Krill AI",
    balance: `$${total.toFixed(2)}`,
    breakdown: { wallet: `$${(total - welfare).toFixed(2)}`, welfare: `$${welfare.toFixed(2)}` },
  };
}
