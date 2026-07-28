import { z } from "zod";
import { fetchJson, json } from "./http";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const QUOTA_COMMAND = /^\/quota(?:@([A-Za-z0-9_]+))?$/i;

const telegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number().int(),
      message_thread_id: z.number().int().optional(),
      chat: z.object({
        id: z.number().int(),
        type: z.enum(["private", "group", "supergroup", "channel"]),
      }),
      text: z.string().optional(),
    })
    .optional(),
});

const telegramApiResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false) }),
]);

export type TelegramReply = {
  readonly chatId: number;
  readonly messageId: number;
  readonly messageThreadId?: number;
  readonly text: string;
};

export type TelegramWebhookConfig = {
  readonly webhookSecret: string;
  readonly allowedChatIds: ReadonlySet<string>;
  readonly botUsername: string;
};

export type TelegramWebhookConfigInput = {
  readonly webhookSecret: string;
  readonly allowedChatIds: string;
  readonly botUsername: string;
};

export type TelegramCommandServices = {
  readonly getQuotaMessage: () => Promise<string>;
  readonly sendMessage: (reply: TelegramReply) => Promise<void>;
  readonly waitUntil: (task: Promise<void>) => void;
};

export class TelegramConfigurationError extends Error {
  constructor(
    readonly field:
      | "TELEGRAM_WEBHOOK_SECRET"
      | "TELEGRAM_ALLOWED_CHAT_IDS"
      | "TELEGRAM_BOT_USERNAME",
  ) {
    super(`${field} 配置无效`);
    this.name = "TelegramConfigurationError";
  }
}

export class TelegramApiError extends Error {
  constructor(readonly code: "request_failed" | "invalid_response" | "api_rejected") {
    const messages = {
      request_failed: "Telegram API 请求失败",
      invalid_response: "Telegram API 返回无效响应",
      api_rejected: "Telegram API 拒绝请求",
    } as const;
    super(messages[code]);
    this.name = "TelegramApiError";
  }
}

export function parseAllowedTelegramChatIds(value: string): ReadonlySet<string> {
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  if (ids.length === 0 || ids.some((id) => !/^-[1-9]\d*$/.test(id))) {
    throw new TelegramConfigurationError("TELEGRAM_ALLOWED_CHAT_IDS");
  }
  return new Set(ids);
}

export function parseTelegramWebhookConfig(
  input: TelegramWebhookConfigInput,
): TelegramWebhookConfig {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(input.webhookSecret)) {
    throw new TelegramConfigurationError("TELEGRAM_WEBHOOK_SECRET");
  }
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(input.botUsername)) {
    throw new TelegramConfigurationError("TELEGRAM_BOT_USERNAME");
  }
  return {
    webhookSecret: input.webhookSecret,
    allowedChatIds: parseAllowedTelegramChatIds(input.allowedChatIds),
    botUsername: input.botUsername,
  };
}

function isQuotaCommand(text: string, botUsername: string): boolean {
  const match = QUOTA_COMMAND.exec(text.trim());
  if (match === null) return false;
  const addressedUsername = match[1];
  return (
    addressedUsername === undefined || addressedUsername.toLowerCase() === botUsername.toLowerCase()
  );
}

export async function handleTelegramWebhook(
  request: Request,
  config: TelegramWebhookConfig,
  services: TelegramCommandServices,
): Promise<Response> {
  if (request.headers.get("x-telegram-bot-api-secret-token") !== config.webhookSecret) {
    return json({ error: "unauthorized" }, 401);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: "invalid_update" }, 400);
    throw error;
  }
  const parsed = telegramUpdateSchema.safeParse(payload);
  if (!parsed.success) return json({ error: "invalid_update" }, 400);

  const message = parsed.data.message;
  if (
    message === undefined ||
    (message.chat.type !== "group" && message.chat.type !== "supergroup") ||
    !config.allowedChatIds.has(String(message.chat.id)) ||
    message.text === undefined ||
    !isQuotaCommand(message.text, config.botUsername)
  ) {
    return json({ ok: true });
  }

  services.waitUntil(
    services.getQuotaMessage().then((text) =>
      services.sendMessage({
        chatId: message.chat.id,
        messageId: message.message_id,
        ...(message.message_thread_id === undefined
          ? {}
          : { messageThreadId: message.message_thread_id }),
        text,
      }),
    ),
  );
  return json({ ok: true });
}

export async function sendTelegramMessage(token: string, reply: TelegramReply): Promise<void> {
  let payload: unknown;
  try {
    payload = await fetchJson(
      `${TELEGRAM_API_BASE}/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: reply.chatId,
          text: reply.text,
          ...(reply.messageThreadId === undefined
            ? {}
            : { message_thread_id: reply.messageThreadId }),
          reply_parameters: { message_id: reply.messageId },
        }),
      },
      "Telegram sendMessage",
    );
  } catch {
    throw new TelegramApiError("request_failed");
  }
  const response = telegramApiResponseSchema.safeParse(payload);
  if (!response.success) throw new TelegramApiError("invalid_response");
  if (!response.data.ok) throw new TelegramApiError("api_rejected");
}
