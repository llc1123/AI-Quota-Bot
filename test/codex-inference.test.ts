import { Miniflare, Response as MiniflareResponse } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexInferenceError, codexInference } from "../src/codex-inference";

const credentials = { accessToken: "private-access", accountId: "account-1" };
const probe = { model: "gpt-5", prompt: "Return 300 numbers." };
const completed = { type: "response.completed", response: { status: "completed" } };

function event(value: unknown): string {
  return `data: ${JSON.stringify(value)}\r\n\r\n`;
}

function streamResponse(text: string, byteChunks = false) {
  const bytes = new TextEncoder().encode(text);
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (byteChunks) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      } else {
        controller.enqueue(bytes);
      }
    },
    cancel,
  });
  const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
  return { response, body, cancel };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Codex Responses probe transport", () => {
  it("sends a probe with fetch options accepted by the real Worker runtime", async () => {
    let upstreamCalls = 0;
    const runtime = new Miniflare({
      workers: [
        {
          config: {
            name: "probe-transport",
            compatibilityDate: "2026-07-15",
            manifest: {
              mainModule: "worker.mjs",
              modules: {
                "worker.mjs": {
                  type: "esm",
                  contents: `export default { async fetch(request) {
        const options = await request.json();
        return fetch("https://chatgpt.com/backend-api/codex/responses", options);
      } };`,
                },
              },
            },
          },
          dev: {
            outboundService: {
              type: "fetcher",
              handler: () => {
                upstreamCalls += 1;
                return new MiniflareResponse(
                  event({ type: "response.output_text.done", text: "10,20,30" }) + event(completed),
                );
              },
            },
          },
        },
      ],
    });
    await runtime.ready;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
        const { signal: _signal, ...serializable } = options ?? {};
        const response = await runtime.dispatchFetch("https://runtime.test", {
          method: "POST",
          body: JSON.stringify(serializable),
        });
        return new Response(await response.arrayBuffer(), {
          status: response.status,
          headers: Array.from(response.headers.entries()),
        });
      }),
    );
    try {
      await expect(codexInference(credentials, probe)).resolves.toBe("10,20,30");
      expect(upstreamCalls).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      await runtime.dispose();
    }
  });

  it("decodes split UTF-8 and CRLF events without duplicating done text and cancels after completion", async () => {
    const source = streamResponse(
      ": keepalive\r\n\r\n" +
        event({ type: "response.output_text.delta", delta: "1,2," }) +
        event({ type: "response.output_text.delta", delta: "三" }) +
        event({ type: "response.output_text.done", text: "1,2,三" }) +
        event(completed),
      true,
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(source.response);
    vi.stubGlobal("fetch", fetchMock);
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await expect(codexInference(credentials, probe)).resolves.toBe("1,2,三");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("Missing Responses request");
    const request = new Request(call[0], call[1]);
    expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(request.headers.get("authorization")).toBe("Bearer private-access");
    expect(request.headers.get("chatgpt-account-id")).toBe("account-1");
    expect(request.headers.get("originator")).toBe("codex_cli_rs");
    expect(request.headers.get("user-agent")).toBe("codex-cli");
    await expect(request.json()).resolves.toEqual({
      model: "gpt-5",
      input: [{ role: "user", content: [{ type: "input_text", text: "Return 300 numbers." }] }],
      instructions: "",
      stream: true,
      store: false,
      reasoning: { effort: "low" },
    });
    expect(timeout).toHaveBeenCalledWith(240_000);
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(source.body.locked).toBe(false);
  });

  it("accepts a done text event with multiline SSE data and omits an absent account id", async () => {
    const source = streamResponse(
      `data: {"type":"response.output_text.done",\ndata: "text":"10,20,30"}\n\n${event(completed)}`,
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(source.response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(codexInference({ accessToken: "private-access" }, probe)).resolves.toBe(
      "10,20,30",
    );

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("Missing Responses request");
    expect(new Headers(call[1]?.headers).has("chatgpt-account-id")).toBe(false);
  });

  it("accepts a complete fingerprint stream larger than 256 KiB", async () => {
    const text = Array.from({ length: 332 }, (_, index) => index).join(", ");
    const stream =
      Array.from(text, (delta, sequence_number) =>
        event({
          type: "response.output_text.delta",
          item_id: `msg_${"a".repeat(64)}`,
          output_index: 0,
          content_index: 0,
          sequence_number,
          delta,
        }),
      ).join("") + event(completed);
    expect(new TextEncoder().encode(stream).byteLength).toBeGreaterThan(262_144);
    const source = streamResponse(stream);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(source.response));
    await expect(codexInference(credentials, probe)).resolves.toBe(text);
  });

  it.each([
    [
      { type: "response.failed", response: { status: "failed" }, error: "private-access" },
      "failed",
    ],
    [{ type: "response.incomplete", response: { status: "incomplete" } }, "incomplete"],
    [{ type: "response.completed", response: { status: "incomplete" } }, "incomplete"],
    [{ type: "response.refusal.delta", delta: "private-access" }, "refusal"],
    [{ type: "response.refusal.done" }, "refusal"],
    [{ type: "error", message: "private-access" }, "failed"],
    [
      {
        type: "response.completed",
        response: { status: "completed", output: [{ content: [{ type: "refusal" }] }] },
      },
      "refusal",
    ],
    [{ type: "response.output_item.done", item: { status: "incomplete" } }, "incomplete"],
  ])("rejects terminal error event %j without leaking upstream detail", async (terminal, code) => {
    const source = streamResponse(
      event({ type: "response.output_text.delta", delta: "1,2" }) + event(terminal),
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(source.response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(codexInference(credentials, probe)).rejects.toMatchObject({
      name: "CodexInferenceError",
      code,
      message: `Codex probe ${code}`,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(source.body.locked).toBe(false);
  });

  it.each([
    ["data: not-json\n\n", "protocol"],
    [event({ type: "response.output_text.delta" }), "protocol"],
    [event(completed), "protocol"],
    ["data: [DONE]\n\n", "unterminated"],
    [event({ type: "response.output_text.delta", delta: "x".repeat(32_769) }), "oversized"],
    [`:${"x".repeat(2_097_152)}`, "oversized"],
  ])("rejects malformed or bounded stream case %#", async (text, code) => {
    const source = streamResponse(text);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(source.response));

    await expect(codexInference(credentials, probe)).rejects.toMatchObject({
      name: "CodexInferenceError",
      code,
      message: `Codex probe ${code}`,
    });

    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(source.body.locked).toBe(false);
  });

  it("rejects EOF after text without a completed event", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(event({ type: "response.output_text.done", text: "1,2,3" })),
        );
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));

    await expect(codexInference(credentials, probe)).rejects.toEqual(
      new CodexInferenceError("unterminated"),
    );

    expect(body.locked).toBe(false);
  });

  it("cancels HTTP error bodies without returning their contents or retrying", async () => {
    const source = streamResponse("private-access");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(source.body, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(codexInference(credentials, probe)).rejects.toEqual(
      new CodexInferenceError("http", 429),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

  it("sanitizes transport failures without retrying", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("private-access upstream body"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(codexInference(credentials, probe)).rejects.toEqual(
      new CodexInferenceError("transport"),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("identifies the known OpenAI edge blocker without exposing its response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response("<html>Unable to load site private-access</html>", {
          status: 403,
          headers: { "cf-ray": "ray-1" },
        }),
      ),
    );
    await expect(codexInference(credentials, probe)).rejects.toEqual(
      new CodexInferenceError("blocked", 403, "ray-1"),
    );
  });

  it.each([
    ["openai_timeout", "json:openai_timeout"],
    ["private-access", "json"],
  ])("preserves known relay error codes and sanitizes %s", async (error, hint) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error }, { status: 502 })),
    );
    await expect(codexInference(credentials, probe)).rejects.toEqual(
      new CodexInferenceError("http", 502, undefined, hint),
    );
  });
});
