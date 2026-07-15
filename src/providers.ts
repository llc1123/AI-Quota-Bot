import { codexStub, KRILL_SUBSCRIPTION_URL, requiredEnv, ZENMUX_API_BASE } from "./env";
import { asNumber, asString, fetchJson, isRecord, joinUrl } from "./http";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export type WindowKind = "5h" | "7d";

export type QuotaWindow = {
  readonly kind: WindowKind;
  readonly usagePercent: number;
  readonly timePercent: number;
  readonly remainingMs: number;
  readonly timing?: "idle";
};

export type ProviderSnapshot =
  | {
      readonly kind: "windowed";
      readonly provider: "Codex" | "ZenMux";
      readonly windows: readonly QuotaWindow[];
    }
  | { readonly kind: "balance"; readonly provider: "ZenMux" | "Krill AI"; readonly balance: string }
  | { readonly kind: "error"; readonly provider: string; readonly message: string };

function numberLike(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function progressFromReset(
  resetMs: number | undefined,
  windowMs: number,
  nowMs: number,
): Pick<QuotaWindow, "timePercent" | "remainingMs"> {
  if (!resetMs || resetMs <= nowMs) return { timePercent: 100, remainingMs: 0 };
  const elapsed = windowMs - (resetMs - nowMs);
  return {
    timePercent: Math.max(0, Math.min(100, (elapsed / windowMs) * 100)),
    remainingMs: resetMs - nowMs,
  };
}

function windowKind(seconds: number | undefined, fallback: WindowKind): WindowKind | undefined {
  if (seconds === undefined) return fallback;
  const windowMs = seconds * 1000;
  if (Math.abs(windowMs - FIVE_HOURS_MS) <= 60_000) return "5h";
  if (Math.abs(windowMs - SEVEN_DAYS_MS) <= 60_000) return "7d";
  return undefined;
}

function codexWindow(
  raw: unknown,
  fallbackKind: WindowKind,
  nowMs: number,
): QuotaWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const used = asNumber(raw["used_percent"]);
  const resetAtSeconds = asNumber(raw["reset_at"]);
  const resetAfterSeconds = asNumber(raw["reset_after_seconds"]);
  const limitWindowSeconds = asNumber(raw["limit_window_seconds"]);
  const kind = windowKind(limitWindowSeconds, fallbackKind);
  if (used === undefined) return undefined;
  if (kind === undefined) return undefined;
  const windowMs = kind === "5h" ? FIVE_HOURS_MS : SEVEN_DAYS_MS;
  const resetMs =
    resetAfterSeconds !== undefined
      ? nowMs + resetAfterSeconds * 1000
      : resetAtSeconds === undefined
        ? undefined
        : resetAtSeconds * 1000;
  return {
    kind,
    usagePercent: used,
    ...progressFromReset(resetMs, windowMs, nowMs),
  };
}

export function parseCodexUsage(raw: unknown, nowMs = Date.now()): readonly QuotaWindow[] {
  if (!isRecord(raw)) return [];
  if (isRecord(raw["rate_limit"])) {
    const limit = raw["rate_limit"];
    return [
      codexWindow(limit["primary_window"], "5h", nowMs),
      codexWindow(limit["secondary_window"], "7d", nowMs),
    ].filter((value): value is QuotaWindow => value !== undefined);
  }
  return [];
}

export async function codexUsageJson(response: Response): Promise<unknown> {
  if (response.ok) return response.json<unknown>();
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const error = isRecord(parsed) ? asString(parsed["error"]) : undefined;
  throw new Error(error ?? `Codex usage failed: HTTP ${response.status}`);
}

function zenmuxWindow(raw: unknown, kind: WindowKind, nowMs: number): QuotaWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const usageFraction = asNumber(raw["usage_percentage"]);
  const reset = asString(raw["resets_at"]);
  if (usageFraction === undefined) return undefined;
  const windowMs = kind === "5h" ? FIVE_HOURS_MS : SEVEN_DAYS_MS;
  const progress =
    reset === undefined && usageFraction === 0
      ? { timePercent: 0, remainingMs: windowMs, timing: "idle" as const }
      : progressFromReset(reset ? Date.parse(reset) : undefined, windowMs, nowMs);
  return {
    kind,
    usagePercent: usageFraction * 100,
    ...progress,
  };
}

export function parseZenmuxSubscription(raw: unknown, nowMs = Date.now()): readonly QuotaWindow[] {
  const data = isRecord(raw) && isRecord(raw["data"]) ? raw["data"] : raw;
  if (!isRecord(data)) return [];
  return [
    zenmuxWindow(data["quota_5_hour"], "5h", nowMs),
    zenmuxWindow(data["quota_7_day"], "7d", nowMs),
  ].filter((value): value is QuotaWindow => value !== undefined);
}

export function parseZenmuxPaygBalance(raw: unknown): string | undefined {
  const data = isRecord(raw) && isRecord(raw["data"]) ? raw["data"] : raw;
  if (!isRecord(data)) return undefined;
  const total = numberLike(data["total_credits"]);
  return total === undefined ? undefined : `$${total.toFixed(2)}`;
}

export function parseKrillBalance(raw: unknown): string | undefined {
  if (isRecord(raw) && isRecord(raw["data"])) {
    const paid = numberLike(raw["data"]["credit_balance_usd"]);
    const welfare = numberLike(raw["data"]["welfare_balance_usd"]);
    if (paid !== undefined || welfare !== undefined)
      return `$${((paid ?? 0) + (welfare ?? 0)).toFixed(2)}`;
  }
  const queue: unknown[] = [raw];
  const keys = new Set(["balance", "credit", "credits", "remaining", "amount"]);
  while (queue.length > 0) {
    const value = queue.shift();
    if (!isRecord(value)) continue;
    for (const [key, candidate] of Object.entries(value)) {
      if (keys.has(key.toLowerCase())) {
        if (typeof candidate === "number") return candidate.toString();
        if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
      }
      if (isRecord(candidate)) queue.push(candidate);
    }
  }
  return undefined;
}

async function provider<T extends ProviderSnapshot>(
  fallback: ProviderSnapshot,
  read: () => Promise<T>,
): Promise<ProviderSnapshot> {
  try {
    return await read();
  } catch (error) {
    return {
      ...fallback,
      kind: "error",
      message: error instanceof Error ? error.message : "unknown error",
    };
  }
}

export async function collectSnapshots(
  env: Env,
  nowMs = Date.now(),
): Promise<readonly ProviderSnapshot[]> {
  const codex = provider({ kind: "error", provider: "Codex", message: "" }, async () => {
    const raw = await codexStub(env)
      .fetch("https://codex-auth.internal/usage")
      .then(codexUsageJson);
    return { kind: "windowed", provider: "Codex", windows: parseCodexUsage(raw, nowMs) };
  });
  const zenmux = provider({ kind: "error", provider: "ZenMux", message: "" }, async () => {
    const raw = await fetchJson(
      joinUrl(ZENMUX_API_BASE, "/api/v1/management/subscription/detail"),
      {
        headers: { authorization: `Bearer ${requiredEnv(env, "ZENMUX_MANAGEMENT_KEY")}` },
      },
    );
    return { kind: "windowed", provider: "ZenMux", windows: parseZenmuxSubscription(raw, nowMs) };
  });
  const zenmuxPayg = provider({ kind: "error", provider: "ZenMux PAYG", message: "" }, async () => {
    const raw = await fetchJson(joinUrl(ZENMUX_API_BASE, "/api/v1/management/payg/balance"), {
      headers: { authorization: `Bearer ${requiredEnv(env, "ZENMUX_MANAGEMENT_KEY")}` },
    });
    const balance = parseZenmuxPaygBalance(raw);
    if (!balance) throw new Error("ZenMux PAYG balance field not found");
    return { kind: "balance", provider: "ZenMux", balance };
  });
  const krill = provider({ kind: "error", provider: "Krill AI", message: "" }, async () => {
    const raw = await fetchJson(KRILL_SUBSCRIPTION_URL, {
      headers: { authorization: `Bearer ${requiredEnv(env, "KRILL_JWT")}` },
    });
    const balance = parseKrillBalance(raw);
    if (!balance) throw new Error("Krill balance field not found");
    return { kind: "balance", provider: "Krill AI", balance };
  });
  return Promise.all([codex, zenmux, zenmuxPayg, krill]);
}
