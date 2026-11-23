export const ZENMUX_API_BASE = "https://zenmux.dev";
export const KRILL_API_BASE = "https://www.krill-code.com";

export function textEnv(value: string | undefined, fallback = ""): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export type SecretName =
  | "WECOM_WEBHOOK_URL"
  | "ADMIN_TOKEN"
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

export function krillApiBase(env: { KRILL_API_BASE?: string | undefined }): string {
  return textEnv(env.KRILL_API_BASE, KRILL_API_BASE);
}

export function zenmuxApiBase(env: { ZENMUX_API_BASE?: string | undefined }): string {
  return textEnv(env.ZENMUX_API_BASE, ZENMUX_API_BASE);
}
