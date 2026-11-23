import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleTelegramWebhook,
  parseAllowedTelegramChatIds,
  parseTelegramWebhookConfig,
  sendTelegramMessage,
} from "../src/telegram";

const config = {
  webhookSecret: "telegram-secret",
  allowedChatIds: new Set(["-1001234567890"]),
  botUsername: "ai_quota_bot",
};

function webhookRequest(payload: unknown, secret = "telegram-secret"): Request {
  return new Request("https://worker.example/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify(payload),
  });
}

describe("handleTelegramWebhook", () => {
  it.each(["/detect", "/detect gpt-5.6-luna", "/detect@ai_quota_bot gpt-5.6-luna"])(
    "silently ignores removed command %s in allowed groups",
    async (text) => {
      const getQuotaMessage = vi.fn();
      const sendMessage = vi.fn();
      const waitUntil = vi.fn();
      const response = await handleTelegramWebhook(
        webhookRequest({
          update_id: 201,
          message: {
            message_id: 91,
            message_thread_id: 7,
            chat: { id: -1001234567890, type: "supergroup" },
            text,
          },
        }),
        config,
        {
          getQuotaMessage,
          sendMessage,
          waitUntil,
        },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(getQuotaMessage).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(waitUntil).not.toHaveBeenCalled();
    },
  );

  it("acknowledges immediately and schedules a quota reply for an allowed supergroup", async () => {
    // Given
    let resolveQuota: ((message: string) => void) | undefined;
    const getQuotaMessage = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveQuota = resolve;
        }),
    );
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const tasks: Promise<void>[] = [];

    // When
    const response = await handleTelegramWebhook(
      webhookRequest({
        update_id: 100,
        message: {
          message_id: 42,
          message_thread_id: 7,
          chat: { id: -1001234567890, type: "supergroup" },
          text: "/quota@ai_quota_bot",
        },
      }),
      config,
      {
        getQuotaMessage,
        sendMessage,
        waitUntil: (task) => tasks.push(task),
      },
    );

    // Then
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(resolveQuota).toBeTypeOf("function");
    resolveQuota?.("current quota");
    await Promise.all(tasks);
    expect(getQuotaMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -1001234567890,
      messageId: 42,
      messageThreadId: 7,
      text: "current quota",
    });
  });

  it("ignores commands from chats outside the allowlist", async () => {
    // Given
    const getQuotaMessage = vi.fn().mockResolvedValue("current quota");
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const tasks: Promise<void>[] = [];

    // When
    const response = await handleTelegramWebhook(
      webhookRequest({
        update_id: 101,
        message: {
          message_id: 43,
          chat: { id: -1009999999999, type: "group" },
          text: "/quota",
        },
      }),
      config,
      {
        getQuotaMessage,
        sendMessage,
        waitUntil: (task) => tasks.push(task),
      },
    );

    // Then
    expect(response.status).toBe(200);
    expect(getQuotaMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(tasks).toEqual([]);
  });

  it("ignores quota commands addressed to another bot", async () => {
    // Given
    const getQuotaMessage = vi.fn().mockResolvedValue("current quota");
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const tasks: Promise<void>[] = [];

    // When
    const response = await handleTelegramWebhook(
      webhookRequest({
        update_id: 103,
        message: {
          message_id: 44,
          chat: { id: -1001234567890, type: "supergroup" },
          text: "/quota@another_bot",
        },
      }),
      config,
      {
        getQuotaMessage,
        sendMessage,
        waitUntil: (task) => tasks.push(task),
      },
    );

    // Then
    expect(response.status).toBe(200);
    expect(getQuotaMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(tasks).toEqual([]);
  });

  it("rejects requests without the configured webhook secret", async () => {
    // Given
    const getQuotaMessage = vi.fn().mockResolvedValue("current quota");
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const tasks: Promise<void>[] = [];

    // When
    const response = await handleTelegramWebhook(
      webhookRequest({ update_id: 102 }, "wrong-secret"),
      config,
      {
        getQuotaMessage,
        sendMessage,
        waitUntil: (task) => tasks.push(task),
      },
    );

    // Then
    expect(response.status).toBe(401);
    expect(getQuotaMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("returns bad request for malformed Telegram updates", async () => {
    // Given
    const getQuotaMessage = vi.fn().mockResolvedValue("current quota");
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const tasks: Promise<void>[] = [];

    // When
    const response = await handleTelegramWebhook(webhookRequest({ update_id: "invalid" }), config, {
      getQuotaMessage,
      sendMessage,
      waitUntil: (task) => tasks.push(task),
    });

    // Then
    expect(response.status).toBe(400);
    expect(getQuotaMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("parseAllowedTelegramChatIds", () => {
  it("parses multiple negative group IDs", () => {
    // Given / When
    const ids = parseAllowedTelegramChatIds("-1001234567890, -987654321");

    // Then
    expect([...ids]).toEqual(["-1001234567890", "-987654321"]);
  });

  it("rejects positive private chat IDs", () => {
    // Given / When / Then
    expect(() => parseAllowedTelegramChatIds("123456789")).toThrow(
      "TELEGRAM_ALLOWED_CHAT_IDS 配置无效",
    );
  });

  it("rejects zero as a group ID", () => {
    // Given / When / Then
    expect(() => parseAllowedTelegramChatIds("-0")).toThrow("TELEGRAM_ALLOWED_CHAT_IDS 配置无效");
  });
});

describe("parseTelegramWebhookConfig", () => {
  it("rejects webhook secrets that Telegram cannot send", () => {
    // Given
    const parse = () =>
      parseTelegramWebhookConfig({
        webhookSecret: "contains spaces",
        allowedChatIds: "-1001234567890",
        botUsername: "ai_quota_bot",
      });

    // When / Then
    expect(parse).toThrow("TELEGRAM_WEBHOOK_SECRET 配置无效");
    expect(parse).not.toThrow("contains spaces");
  });
});

describe("sendTelegramMessage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers the quota reply through Telegram Bot API", async () => {
    // Given
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, result: { message_id: 99 } }));
    vi.stubGlobal("fetch", fetchMock);

    // When
    const messageId = await sendTelegramMessage("bot-token", {
      chatId: -1001234567890,
      messageId: 42,
      messageThreadId: 7,
      text: "current quota",
    });

    // Then
    expect(messageId).toBe(99);
    expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/botbot-token/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: expect.any(AbortSignal),
      body: JSON.stringify({
        chat_id: -1001234567890,
        text: "current quota",
        message_thread_id: 7,
        reply_parameters: { message_id: 42 },
      }),
    });
  });

  it("does not expose the bot token when Telegram rejects a message", async () => {
    // Given
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("bad request", { status: 400 })),
    );

    // When
    const error = await sendTelegramMessage("super-secret-token", {
      chatId: -1001234567890,
      messageId: 42,
      text: "current quota",
    }).catch((caught: unknown) => caught);

    // Then
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toBe("Telegram API 请求失败");
      expect(error.message).not.toContain("super-secret-token");
    }
  });

  it("redacts the bot token from network-level fetch failures", async () => {
    // Given
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(
          new TypeError("fetch https://api.telegram.org/botsuper-secret-token/sendMessage failed"),
        ),
    );

    // When
    const error = await sendTelegramMessage("super-secret-token", {
      chatId: -1001234567890,
      messageId: 42,
      text: "current quota",
    }).catch((caught: unknown) => caught);

    // Then
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toBe("Telegram API 请求失败");
      expect(error.message).not.toContain("super-secret-token");
    }
  });

  it("rejects Telegram API responses with ok false even when HTTP succeeds", async () => {
    // Given
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ ok: false, description: "rejected" })),
    );

    // When / Then
    await expect(
      sendTelegramMessage("bot-token", {
        chatId: -1001234567890,
        messageId: 42,
        text: "current quota",
      }),
    ).rejects.toThrow("Telegram API 拒绝请求");
  });
});
