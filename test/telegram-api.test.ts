import { afterEach, expect, it, vi } from "vitest";
import { editTelegramMessage } from "../src/telegram-api";

afterEach(() => vi.unstubAllGlobals());

it("edits the existing bot reply using its returned message id", async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ ok: true, result: { message_id: 99 } }));
  vi.stubGlobal("fetch", fetchMock);
  await editTelegramMessage("bot-token", { chatId: -1001234567890, messageId: 99, text: "result" });
  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.telegram.org/botbot-token/editMessageText",
    expect.objectContaining({
      body: JSON.stringify({ chat_id: -1001234567890, message_id: 99, text: "result" }),
    }),
  );
});

it("accepts an already applied edit when a durable alarm is redelivered", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          ok: false,
          error_code: 400,
          description:
            "Bad Request: message is not modified: specified new message content and reply markup are exactly the same",
        },
        { status: 400 },
      ),
    ),
  );
  await expect(
    editTelegramMessage("bot-token", { chatId: -1001234567890, messageId: 99, text: "result" }),
  ).resolves.toBeUndefined();
});
