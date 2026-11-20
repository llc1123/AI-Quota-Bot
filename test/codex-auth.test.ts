import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAuthState } from "../src/codex-auth";
import { openJson, type SealedBox, sealJson } from "../src/crypto";

type TestLoginAttempt = {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly intervalMs: number;
  readonly expiresAt: number;
  readonly verificationUrl: string;
};

class TestCodexStorage {
  readonly alarms: Array<number | Date> = [];
  private login: TestLoginAttempt | undefined;

  constructor(private tokens: SealedBox | undefined) {}

  async get(key: "codex.tokens"): Promise<SealedBox | undefined>;
  async get(key: "codex.login"): Promise<TestLoginAttempt | undefined>;
  async get(key: string): Promise<SealedBox | TestLoginAttempt | undefined> {
    if (key === "codex.tokens") return this.tokens;
    if (key === "codex.login") return this.login;
    return undefined;
  }

  async put(key: "codex.tokens", value: SealedBox): Promise<void>;
  async put(key: "codex.login", value: TestLoginAttempt): Promise<void>;
  async put(key: string, value: SealedBox | TestLoginAttempt): Promise<void> {
    if (key === "codex.tokens" && "ciphertext" in value) this.tokens = value;
    if (key === "codex.login" && "userCode" in value) this.login = value;
  }

  async delete(key: string): Promise<boolean> {
    if (key === "codex.tokens") this.tokens = undefined;
    if (key === "codex.login") this.login = undefined;
    return true;
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarms.push(scheduledTime);
  }
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

const encryptionKey = btoa("0123456789abcdef0123456789abcdef");
const authEnv = {
  CODEX_TOKEN_ENCRYPTION_KEY: encryptionKey,
  CODEX_USAGE_RELAY_TOKEN: "",
  CODEX_USAGE_RELAY_URL: "",
  WECOM_WEBHOOK_URL: "",
};

function probeRequest(body: unknown): Request {
  return new Request("https://codex-auth.internal/probe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Codex auth durable object", () => {
  it.each(["", "?force=false", "?force=True", "?force=1"])(
    "keeps the stored-token login fast path for %s",
    async (query) => {
      const sealed = await sealJson(
        {
          accessToken: "old-access",
          refreshToken: "old-refresh",
          accountId: "account-1",
          expiresAt: Date.now() + 3600_000,
        },
        encryptionKey,
      );
      const storage = new TestCodexStorage(sealed);
      const auth = new CodexAuthState({ storage }, authEnv);
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);

      const response = await auth.fetch(
        new Request(`https://codex-auth.internal/login${query}`, { method: "POST" }),
      );

      await expect(response.json()).resolves.toEqual({
        state: "authenticated",
        accountId: "account-1",
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await storage.get("codex.tokens")).toEqual(sealed);
    },
  );

  it("preserves forced device login through old-token refresh until successful replacement", async () => {
    const sealed = await sealJson(
      {
        accessToken: "revoked-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() + 60_000,
      },
      encryptionKey,
    );
    const storage = new TestCodexStorage(sealed);
    const auth = new CodexAuthState({ storage }, authEnv);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: "1" }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: "refreshed-old-access",
          refresh_token: "refreshed-old-refresh",
          expires_in: 3600,
        }),
      )
      .mockResolvedValueOnce(Response.json({ rate_limit: {} }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(
        Response.json({ authorization_code: "new-code", code_verifier: "verifier" }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const pending = {
      state: "pending",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
    };

    for (const _attempt of [1, 2]) {
      const response = await auth.fetch(
        new Request("https://codex-auth.internal/login?force=true", { method: "POST" }),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(pending);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storage.alarms).toHaveLength(1);
    const status = await auth.fetch(new Request("https://codex-auth.internal/status"));
    await expect(status.json()).resolves.toMatchObject(pending);
    expect(await storage.get("codex.tokens")).toEqual(sealed);

    const usage = await auth.fetch(new Request("https://codex-auth.internal/usage"));
    expect(usage.status).toBe(200);
    const afterRefresh = await auth.fetch(new Request("https://codex-auth.internal/status"));
    await expect(afterRefresh.json()).resolves.toMatchObject(pending);
    const refreshed = await storage.get("codex.tokens");
    if (!refreshed) throw new Error("Missing refreshed tokens");
    await expect(openJson(refreshed, encryptionKey)).resolves.toMatchObject({
      accessToken: "refreshed-old-access",
      refreshToken: "refreshed-old-refresh",
    });

    await auth.alarm();
    expect(await storage.get("codex.tokens")).toEqual(refreshed);
    await auth.alarm();

    const replaced = await storage.get("codex.tokens");
    expect(replaced).toBeDefined();
    if (!replaced) throw new Error("Missing replacement tokens");
    await expect(openJson(replaced, encryptionKey)).resolves.toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
    expect(await storage.get("codex.login")).toBeUndefined();
    const completed = await auth.fetch(new Request("https://codex-auth.internal/status"));
    await expect(completed.json()).resolves.toMatchObject({ state: "authenticated" });
  });

  it("refreshes once for three parallel probes and returns only their generated text", async () => {
    const storage = new TestCodexStorage(
      await sealJson(
        {
          accessToken: "old-private-access",
          refreshToken: "old-private-refresh",
          accountId: "account-1",
          expiresAt: Date.now() - 60_000,
        },
        encryptionKey,
      ),
    );
    const auth = new CodexAuthState(
      { storage },
      {
        ...authEnv,
        CODEX_USAGE_RELAY_URL: "https://relay.example/wham/usage",
        CODEX_USAGE_RELAY_TOKEN: "private-relay",
      },
    );
    let refreshes = 0;
    const inferenceUrls: string[] = [];
    const inferenceHeaders: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        if (requestUrl(input) === "https://auth.openai.com/oauth/token") {
          refreshes += 1;
          return Response.json({
            access_token: "new-private-access",
            refresh_token: "rotated-private-refresh",
            expires_in: 3600,
          });
        }
        inferenceUrls.push(requestUrl(input));
        inferenceHeaders.push(new Headers(init?.headers));
        return new Response(
          'data: {"type":"response.output_text.delta","delta":"12,34,56"}\n\n' +
            'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        );
      }),
    );

    const responses = await Promise.all(
      [0, 1, 2].map(() => auth.fetch(probeRequest({ model: "gpt-5", prompt: "numbers" }))),
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual([
      { text: "12,34,56" },
      { text: "12,34,56" },
      { text: "12,34,56" },
    ]);
    expect(refreshes).toBe(1);
    expect(inferenceUrls).toEqual(Array(3).fill("https://relay.example/codex/responses"));
    expect(
      inferenceHeaders.map((headers) => [
        headers.get("authorization"),
        headers.get("chatgpt-account-id"),
        headers.get("x-relay-token"),
      ]),
    ).toEqual([
      ["Bearer new-private-access", "account-1", "private-relay"],
      ["Bearer new-private-access", "account-1", "private-relay"],
      ["Bearer new-private-access", "account-1", "private-relay"],
    ]);
  });

  it("aborts a stalled shared refresh and allows later probes to refresh again", async () => {
    const storage = new TestCodexStorage(
      await sealJson(
        { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 0 },
        encryptionKey,
      ),
    );
    const auth = new CodexAuthState({ storage }, authEnv);
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), delay);
      return controller.signal;
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let refreshes = 0;
    let inferences = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        if (requestUrl(input) === "https://auth.openai.com/oauth/token") {
          refreshes++;
          if (refreshes === 1) {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
                once: true,
              });
              markStarted?.();
            });
          }
          return Response.json({ access_token: "new-access", expires_in: 3600 });
        }
        inferences++;
        return new Response(
          'data: {"type":"response.output_text.delta","delta":"12,34,56"}\n\n' +
            'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        );
      }),
    );
    const probes = Promise.all(
      [0, 1, 2].map(() => auth.fetch(probeRequest({ model: "gpt-5", prompt: "numbers" }))),
    );
    await started;
    await vi.advanceTimersByTimeAsync(15_000);
    const outcome = await Promise.race([probes, Promise.resolve("refresh still pending")]);
    expect(outcome).toBeInstanceOf(Array);
    if (typeof outcome === "string") throw new Error(outcome);
    expect(outcome.map((response) => response.status)).toEqual([502, 502, 502]);
    expect(refreshes).toBe(1);
    expect(inferences).toBe(0);

    const recovered = await auth.fetch(probeRequest({ model: "gpt-5", prompt: "numbers" }));
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toEqual({ text: "12,34,56" });
    expect(refreshes).toBe(2);
    expect(inferences).toBe(1);
  });

  it.each([
    { model: "", prompt: "numbers" },
    { model: "gpt-5", prompt: "" },
    { model: "x".repeat(201), prompt: "numbers" },
    { model: "gpt-5", prompt: "x".repeat(16_385) },
    { model: 12, prompt: "numbers" },
    { model: "gpt-5", prompt: "numbers", accessToken: "injected" },
  ])("rejects invalid probe input %# before making upstream requests", async (body) => {
    const auth = new CodexAuthState({ storage: new TestCodexStorage(undefined) }, authEnv);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await auth.fetch(probeRequest(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_probe" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed probe JSON", async () => {
    const auth = new CodexAuthState({ storage: new TestCodexStorage(undefined) }, authEnv);

    const response = await auth.fetch(
      new Request("https://codex-auth.internal/probe", { method: "POST", body: "{" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_probe" });
  });

  it("rejects anonymous probes without starting login or inference", async () => {
    const auth = new CodexAuthState({ storage: new TestCodexStorage(undefined) }, authEnv);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await auth.fetch(probeRequest({ model: "gpt-5", prompt: "numbers" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "codex_not_authenticated" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["refresh", "inference"])(
    "sanitizes %s failures at the internal probe boundary",
    async (failure) => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const storage = new TestCodexStorage(
        await sealJson(
          {
            accessToken: "private-access",
            refreshToken: "private-refresh",
            expiresAt: failure === "refresh" ? 0 : Date.now() + 3600_000,
          },
          encryptionKey,
        ),
      );
      const auth = new CodexAuthState({ storage }, authEnv);
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("private-access private-refresh upstream body", { status: 401 }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const response = await auth.fetch(probeRequest({ model: "gpt-5", prompt: "numbers" }));

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({
        error: failure === "refresh" ? "codex_probe_error" : "Codex probe http (HTTP 401)",
      });
      expect(warning).toHaveBeenCalledOnce();
      expect(JSON.stringify(warning.mock.calls)).not.toMatch(/private-access|private-refresh/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("starts a new device login when the stored refresh token is expired", async () => {
    // Given
    const encryptionKey = btoa("0123456789abcdef0123456789abcdef");
    const storage = new TestCodexStorage(
      await sealJson(
        {
          accessToken: "expired-access-token",
          refreshToken: "expired-refresh-token",
          expiresAt: Date.now() - 60_000,
        },
        encryptionKey,
      ),
    );
    const state = {
      storage,
    };
    const auth = new CodexAuthState(state, {
      CODEX_TOKEN_ENCRYPTION_KEY: encryptionKey,
      CODEX_USAGE_RELAY_TOKEN: "",
      CODEX_USAGE_RELAY_URL: "",
      WECOM_WEBHOOK_URL: "",
    });
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      calls.push(url);
      if (url === "https://auth.openai.com/oauth/token") {
        return Response.json(
          {
            error: {
              message: "Your session has expired. Please log in again.",
              code: "refresh_token_expired",
            },
          },
          { status: 401 },
        );
      }
      if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
        return Response.json({ device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: "1" });
      }
      return Response.json({ error: "unexpected request" }, { status: 500 });
    };

    try {
      // When
      const response = await auth.fetch(
        new Request("https://codex-auth.internal/login", { method: "POST" }),
      );

      // Then
      await expect(response.json()).resolves.toEqual({
        state: "pending",
        userCode: "ABCD-EFGH",
        verificationUrl: "https://auth.openai.com/codex/device",
      });
      expect(calls).toEqual([
        "https://auth.openai.com/oauth/token",
        "https://auth.openai.com/api/accounts/deviceauth/usercode",
      ]);
      expect(storage.alarms).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
