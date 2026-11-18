import { z } from "zod";
import type { CodexUsageRelay } from "./codex-http";

const OUTPUT_LIMIT = 32_768;
// Per-token SSE metadata can exceed 256 KiB for a short fingerprint answer.
const STREAM_LIMIT = 2_097_152;
const outputItemSchema = z.object({
  status: z.string().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
});
const eventSchema = z.object({
  type: z.string(),
  delta: z.string().optional(),
  text: z.string().optional(),
  output_index: z.number().int().nonnegative().optional(),
  content_index: z.number().int().nonnegative().optional(),
  item: outputItemSchema.optional(),
  response: z
    .object({
      status: z.string(),
      output: z.array(outputItemSchema).optional(),
    })
    .optional(),
});

export class CodexInferenceError extends Error {
  constructor(
    readonly code:
      | "http"
      | "blocked"
      | "transport"
      | "protocol"
      | "failed"
      | "incomplete"
      | "refusal"
      | "oversized"
      | "unterminated",
    readonly httpStatus?: number,
    readonly requestId?: string,
    readonly bodyHint?: string,
  ) {
    super(
      `Codex probe ${code}${httpStatus === undefined ? "" : ` (HTTP ${httpStatus})`}${bodyHint === undefined ? "" : ` [${bodyHint}]`}`,
    );
    this.name = "CodexInferenceError";
  }
}

type ProbeCredentials = {
  readonly accessToken: string;
  readonly accountId?: string;
};

export type CodexProbe = {
  readonly model: string;
  readonly prompt: string;
};

export async function codexInference(
  credentials: ProbeCredentials,
  probe: CodexProbe,
  relay?: CodexUsageRelay,
): Promise<string> {
  try {
    const url = relay
      ? new URL("/codex/responses", relay.url).toString()
      : "https://chatgpt.com/backend-api/codex/responses";
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        ...(relay ? { "x-relay-token": relay.token } : {}),
        ...(credentials.accountId ? { "chatgpt-account-id": credentials.accountId } : {}),
        originator: "codex_cli_rs",
        "user-agent": "codex-cli",
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: probe.model,
        input: [{ role: "user", content: [{ type: "input_text", text: probe.prompt }] }],
        instructions: "",
        stream: true,
        store: false,
        reasoning: { effort: "low" },
      }),
      // Four attempts must fit inside the detection alarm's 15-minute lifetime.
      signal: AbortSignal.timeout(180_000),
      redirect: "manual",
    });
    if (!response.ok || !response.body) {
      let blocked = false;
      const contentType = response.headers.get("content-type") ?? "";
      let bodyHint = contentType.includes("html")
        ? "html"
        : contentType.includes("json")
          ? "json"
          : undefined;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          const chunk = await reader.read();
          const sample = chunk.done
            ? ""
            : new TextDecoder().decode(chunk.value.subarray(0, 16_384));
          blocked = /Unable to load site|Just a moment|cf-chl|Sorry, you have been blocked/.test(
            sample,
          );
          if (bodyHint === "json") {
            try {
              const parsed = z
                .object({
                  error: z.union([
                    z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/i) }),
                    z.enum([
                      "not_found",
                      "unauthorized",
                      "missing_openai_token",
                      "unsupported_transfer_encoding",
                      "invalid_content_length",
                      "request_too_large",
                      "request_read_failed",
                      "invalid_request",
                      "response_too_large",
                      "openai_timeout",
                      "openai_unreachable",
                    ]),
                  ]),
                })
                .safeParse(JSON.parse(sample));
              if (parsed.success)
                bodyHint = `json:${typeof parsed.data.error === "string" ? parsed.data.error : parsed.data.error.code}`;
            } catch (error) {
              if (!(error instanceof SyntaxError)) throw error;
            }
          }
        } finally {
          try {
            await reader.cancel();
          } finally {
            reader.releaseLock();
          }
        }
      }
      throw new CodexInferenceError(
        blocked ? "blocked" : "http",
        response.status,
        response.headers.get("cf-ray") ?? undefined,
        bodyHint,
      );
    }
    return await readResponse(response.body);
  } catch (error) {
    if (error instanceof CodexInferenceError) throw error;
    throw new CodexInferenceError("transport");
  }
}

async function readResponse(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const parts = new Map<string, string>();
  let buffer = "";
  let data: string[] = [];
  let bytes = 0;

  function consumeEvent(): string | undefined {
    if (data.length === 0) return undefined;
    const payload = data.join("\n");
    data = [];
    if (payload === "[DONE]") throw new CodexInferenceError("unterminated");
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch (error) {
      if (error instanceof SyntaxError) throw new CodexInferenceError("protocol");
      throw error;
    }
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) throw new CodexInferenceError("protocol");
    const event = parsed.data;
    const items = [...(event.response?.output ?? []), ...(event.item ? [event.item] : [])];
    for (const item of items) {
      if (item.status === "incomplete") throw new CodexInferenceError("incomplete");
      if (item.status === "failed") throw new CodexInferenceError("failed");
      if (item.content?.some((content) => content.type === "refusal"))
        throw new CodexInferenceError("refusal");
    }
    switch (event.type) {
      case "error":
      case "response.failed":
        throw new CodexInferenceError("failed");
      case "response.incomplete":
        throw new CodexInferenceError("incomplete");
      case "response.refusal.delta":
      case "response.refusal.done":
        throw new CodexInferenceError("refusal");
      case "response.output_text.delta":
      case "response.output_text.done": {
        const key = `${event.output_index ?? 0}:${event.content_index ?? 0}`;
        const text = event.type === "response.output_text.delta" ? event.delta : event.text;
        if (text === undefined) throw new CodexInferenceError("protocol");
        parts.set(
          key,
          event.type === "response.output_text.delta" ? (parts.get(key) ?? "") + text : text,
        );
        if ([...parts.values()].reduce((length, part) => length + part.length, 0) > OUTPUT_LIMIT)
          throw new CodexInferenceError("oversized");
        return undefined;
      }
      case "response.completed": {
        if (event.response?.status !== "completed") throw new CodexInferenceError("incomplete");
        const text = [...parts.values()].join("");
        if (!text.trim()) throw new CodexInferenceError("protocol");
        return text;
      }
      default:
        return undefined;
    }
  }

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new CodexInferenceError("unterminated");
      bytes += chunk.value.byteLength;
      if (bytes > STREAM_LIMIT) throw new CodexInferenceError("oversized");
      buffer += decoder.decode(chunk.value, { stream: true });
      while (true) {
        const lineEnd = buffer.search(/[\r\n]/);
        if (lineEnd < 0 || (buffer[lineEnd] === "\r" && lineEnd === buffer.length - 1)) break;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + (buffer.slice(lineEnd, lineEnd + 2) === "\r\n" ? 2 : 1));
        if (line === "") {
          const text = consumeEvent();
          if (text !== undefined) return text;
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
