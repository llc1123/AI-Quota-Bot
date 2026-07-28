import { describe, expect, it } from "vitest";
import { CodexAuthState } from "../src/codex-auth";
import { type SealedBox, sealJson } from "../src/crypto";

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

describe("Codex auth durable object", () => {
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
