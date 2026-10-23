import type { CodexUsageRelay } from "./codex-http";

export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_API_BASE = "https://chatgpt.com/backend-api";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const ZENMUX_API_BASE = "https://zenmux.dev";
export const KRILL_API_BASE = "https://www.krill-code.com";

export function textEnv(value: string | undefined, fallback = ""): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export type SecretName =
  | "WECOM_WEBHOOK_URL"
  | "ADMIN_TOKEN"
  | "CODEX_TOKEN_ENCRYPTION_KEY"
  | "ZENMUX_MANAGEMENT_KEY"
  | "KRILL_JWT"
  | "TELEGRAM_BOT_TOKEN"
  | "TELEGRAM_WEBHOOK_SECRET"
  | "TELEGRAM_ALLOWED_CHAT_IDS";

export function requiredEnv(
  env: Partial<Record<SecretName, string | undefined>>,
  key: SecretName,
): string {
  const value = env[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${String(key)} 未配置`);
  return value.trim();
}

export function codexStub(env: Env): DurableObjectStub {
  return env.CODEX_AUTH.get(env.CODEX_AUTH.idFromName("codex"));
}

export function krillApiBase(env: { KRILL_API_BASE?: string | undefined }): string {
  return textEnv(env.KRILL_API_BASE, KRILL_API_BASE);
}

export function zenmuxApiBase(env: { ZENMUX_API_BASE?: string | undefined }): string {
  return textEnv(env.ZENMUX_API_BASE, ZENMUX_API_BASE);
}

export function codexUsageRelay(
  env: Pick<Env, "CODEX_USAGE_RELAY_URL" | "CODEX_USAGE_RELAY_TOKEN">,
): CodexUsageRelay | undefined {
  const url = textEnv(env.CODEX_USAGE_RELAY_URL);
  const token = textEnv(env.CODEX_USAGE_RELAY_TOKEN);
  return url && token ? { url, token } : undefined;
}
