import { describe, expect, it } from "vitest";
import { codexUsageRequest } from "../src/codex-http";

describe("Codex usage HTTP request", () => {
  it("uses the minimal authenticated request shape", async () => {
    // Given
    const originalFetch = globalThis.fetch;
    const calls: RequestInit[] = [];
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return Response.json({ rate_limit: {} });
    };

    try {
      // When
      await codexUsageRequest("https://chatgpt.com/backend-api/wham/usage", "token-1");
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Then
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toEqual({
      authorization: "Bearer token-1",
      "user-agent": "codex-cli",
    });
  });

  it("falls back to the relay only when Worker fetch is blocked", async () => {
    // Given
    const originalFetch = globalThis.fetch;
    const calls: Array<{ readonly input: RequestInfo | URL; readonly init: RequestInit }> = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init: init ?? {} });
      return calls.length === 1
        ? new Response("<p>Unable to load site</p>", { status: 403 })
        : Response.json({ rate_limit: { primary_window: { used_percent: 3 } } });
    };

    try {
      // When
      const result = await codexUsageRequest(
        "https://chatgpt.com/backend-api/wham/usage",
        "token-1",
        {
          url: "http://relay.local/wham/usage",
          token: "relay-secret",
        },
      );

      // Then
      expect(result).toEqual({ rate_limit: { primary_window: { used_percent: 3 } } });
      expect(calls).toHaveLength(2);
      expect(calls[1]?.input).toBe("http://relay.local/wham/usage");
      expect(calls[1]?.init.headers).toEqual({
        authorization: "Bearer token-1",
        "x-relay-token": "relay-secret",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
