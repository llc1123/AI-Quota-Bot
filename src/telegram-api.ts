import { z } from "zod";

export type TelegramReply = {
  readonly chatId: number;
  readonly messageId: number;
  readonly messageThreadId?: number;
  readonly text: string;
};

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

const responseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.object({ message_id: z.number().int().positive() }) }),
  z.object({
    ok: z.literal(false),
    error_code: z.number().optional(),
    description: z.string().optional(),
  }),
]);

export async function sendTelegramMessage(token: string, reply: TelegramReply): Promise<number> {
  let payload: unknown;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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
      signal: AbortSignal.timeout(10_000),
    });
    payload = await response.json();
  } catch (error) {
    if (error instanceof Error) throw new TelegramApiError("request_failed");
    throw error;
  }
  const response = responseSchema.safeParse(payload);
  if (!response.success) throw new TelegramApiError("invalid_response");
  if (!response.data.ok) {
    throw new TelegramApiError("api_rejected");
  }
  return response.data.result.message_id;
}
