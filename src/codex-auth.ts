import { codexUsageRequest } from "./codex-http";
import { chatgptAccountId, jwtExpiryMs, openJson, type SealedBox, sealJson } from "./crypto";
import {
  CODEX_API_BASE,
  CODEX_ISSUER,
  CODEX_OAUTH_CLIENT_ID,
  codexUsageRelay,
  requiredEnv,
} from "./env";
import { asString, fetchJson, isRecord, joinUrl, json } from "./http";
import { sendWecomMarkdown } from "./wecom";

const TOKENS_KEY = "codex.tokens";
const LOGIN_KEY = "codex.login";
const LOGIN_TTL_MS = 15 * 60 * 1000;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

interface StoredTokens {
  idToken?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
}

interface LoginAttempt {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  expiresAt: number;
  verificationUrl: string;
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

type CodexAuthStorage = {
  readonly get: {
    (key: typeof TOKENS_KEY): Promise<SealedBox | undefined>;
    (key: typeof LOGIN_KEY): Promise<LoginAttempt | undefined>;
  };
  readonly put: {
    (key: typeof TOKENS_KEY, value: SealedBox): Promise<void>;
    (key: typeof LOGIN_KEY, value: LoginAttempt): Promise<void>;
  };
  readonly delete: (key: string) => Promise<unknown>;
  readonly setAlarm: (scheduledTime: number | Date) => Promise<void>;
};

type CodexAuthObjectState = {
  readonly storage: CodexAuthStorage;
};

type CodexAuthEnv = Pick<
  Env,
  | "CODEX_TOKEN_ENCRYPTION_KEY"
  | "CODEX_USAGE_RELAY_TOKEN"
  | "CODEX_USAGE_RELAY_URL"
  | "WECOM_WEBHOOK_URL"
>;

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function tokenSnapshot(previous: StoredTokens | undefined, next: TokenResponse): StoredTokens {
  const accessToken = next.access_token ?? previous?.accessToken;
  const refreshToken = next.refresh_token ?? previous?.refreshToken;
  if (!accessToken || !refreshToken) throw new Error("Codex token response missing tokens");
  const idToken = next.id_token ?? previous?.idToken;
  const expiresAt = next.expires_in
    ? Date.now() + next.expires_in * 1000
    : (jwtExpiryMs(accessToken) ?? Date.now() + 3600_000);
  const fromToken = idToken ? chatgptAccountId(idToken) : chatgptAccountId(accessToken);
  const accountId = fromToken ?? previous?.accountId;
  return {
    ...(idToken ? { idToken } : {}),
    accessToken,
    refreshToken,
    expiresAt,
    ...(accountId ? { accountId } : {}),
  };
}

function isExpiredRefreshToken(error: unknown): boolean {
  return error instanceof Error && error.message.includes("refresh_token_expired");
}

export class CodexAuthState {
  constructor(
    private readonly state: CodexAuthObjectState,
    private readonly env: CodexAuthEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/status") return json(await this.status());
      if (request.method === "POST" && url.pathname === "/login") return json(await this.login());
      if (request.method === "GET" && url.pathname === "/usage") return json(await this.usage());
      return json({ error: "not_found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "codex_error" }, 502);
    }
  }

  async alarm(): Promise<void> {
    await this.pollLogin();
  }

  private async loadTokens(): Promise<StoredTokens | undefined> {
    const box = await this.state.storage.get(TOKENS_KEY);
    return box
      ? openJson<StoredTokens>(box, requiredEnv(this.env, "CODEX_TOKEN_ENCRYPTION_KEY"))
      : undefined;
  }

  private async saveTokens(tokens: StoredTokens): Promise<void> {
    await this.state.storage.put(
      TOKENS_KEY,
      await sealJson(tokens, requiredEnv(this.env, "CODEX_TOKEN_ENCRYPTION_KEY")),
    );
    await this.state.storage.delete(LOGIN_KEY);
  }

  private async status(): Promise<Record<string, unknown>> {
    const tokens = await this.loadTokens();
    if (tokens)
      return {
        state: "authenticated",
        accountId: tokens.accountId,
        expiresAt: new Date(tokens.expiresAt).toISOString(),
      };
    const login = await this.state.storage.get(LOGIN_KEY);
    if (login && login.expiresAt > Date.now()) {
      return {
        state: "pending",
        userCode: login.userCode,
        verificationUrl: login.verificationUrl,
        expiresAt: new Date(login.expiresAt).toISOString(),
      };
    }
    return { state: "anonymous" };
  }

  private async login(): Promise<Record<string, unknown>> {
    const tokens = await this.loadTokens();
    if (tokens) {
      try {
        const refreshed = await this.refreshTokens(tokens);
        return { state: "authenticated", accountId: refreshed.accountId };
      } catch (error) {
        if (!isExpiredRefreshToken(error)) throw error;
        await this.state.storage.delete(TOKENS_KEY);
      }
    }

    const existing = await this.state.storage.get(LOGIN_KEY);
    if (existing && existing.expiresAt > Date.now())
      return {
        state: "pending",
        userCode: existing.userCode,
        verificationUrl: existing.verificationUrl,
      };

    const response = await fetchJson(joinUrl(CODEX_ISSUER, "/api/accounts/deviceauth/usercode"), {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "codex-cli" },
      body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
    });
    if (!isRecord(response)) throw new Error("Codex device login returned invalid JSON");
    const deviceAuthId = asString(response["device_auth_id"]);
    const userCode = asString(response["user_code"]) ?? asString(response["usercode"]);
    if (!deviceAuthId || !userCode) throw new Error("Codex device login response missing code");
    const intervalSeconds = Number.parseInt(asString(response["interval"]) ?? "5", 10);
    const login: LoginAttempt = {
      deviceAuthId,
      userCode,
      intervalMs: Math.max(intervalSeconds, 1) * 1000,
      expiresAt: Date.now() + LOGIN_TTL_MS,
      verificationUrl: joinUrl(CODEX_ISSUER, "/codex/device"),
    };
    await this.state.storage.put(LOGIN_KEY, login);
    await this.state.storage.setAlarm(Date.now() + login.intervalMs);
    await this.notify(
      `**Codex 需要登录**\n> 打开：${login.verificationUrl}\n> 输入代码：<font color="warning">${login.userCode}</font>\n> 15 分钟内有效。`,
    );
    return { state: "pending", userCode: login.userCode, verificationUrl: login.verificationUrl };
  }

  private async pollLogin(): Promise<void> {
    const login = await this.state.storage.get(LOGIN_KEY);
    if (!login) return;
    if (login.expiresAt <= Date.now()) {
      await this.state.storage.delete(LOGIN_KEY);
      await this.notify("**Codex 登录已超时**\n> 请重新触发 `/codex/login`。");
      return;
    }

    const response = await fetch(joinUrl(CODEX_ISSUER, "/api/accounts/deviceauth/token"), {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "codex-cli" },
      body: JSON.stringify({ device_auth_id: login.deviceAuthId, user_code: login.userCode }),
    });
    if (response.status === 403 || response.status === 404) {
      await this.state.storage.setAlarm(Date.now() + login.intervalMs);
      return;
    }
    if (!response.ok) throw new Error(`Codex device poll failed: ${response.status}`);
    const codeResponse = await response.json<unknown>();
    if (!isRecord(codeResponse)) throw new Error("Codex device poll returned invalid JSON");
    const authorizationCode = asString(codeResponse["authorization_code"]);
    const codeVerifier = asString(codeResponse["code_verifier"]);
    if (!authorizationCode || !codeVerifier)
      throw new Error("Codex device poll missing authorization code");

    const tokens = await this.exchangeCode(authorizationCode, codeVerifier);
    await this.saveTokens(tokenSnapshot(undefined, tokens));
    await this.notify("**Codex 登录成功**\n> 后续额度播报将自动维护登录状态。");
  }

  private async exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
    return this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: joinUrl(CODEX_ISSUER, "/deviceauth/callback"),
      client_id: CODEX_OAUTH_CLIENT_ID,
      code_verifier: verifier,
    });
  }

  private async refreshTokens(tokens: StoredTokens): Promise<StoredTokens> {
    if (tokens.expiresAt - Date.now() > REFRESH_SKEW_MS) return tokens;
    const refreshed = await fetchJson(joinUrl(CODEX_ISSUER, "/oauth/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "codex-cli" },
      body: form({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      }),
    });
    if (!isRecord(refreshed)) throw new Error("Codex refresh returned invalid JSON");
    const next = tokenSnapshot(tokens, refreshed);
    await this.saveTokens(next);
    return next;
  }

  private async tokenRequest(values: Record<string, string>): Promise<TokenResponse> {
    const response = await fetchJson(joinUrl(CODEX_ISSUER, "/oauth/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "codex-cli" },
      body: form(values),
    });
    if (!isRecord(response)) throw new Error("Codex token endpoint returned invalid JSON");
    return response;
  }

  private async usage(): Promise<unknown> {
    const loaded = await this.loadTokens();
    if (!loaded) throw new Error("Codex 未登录");
    const tokens = await this.refreshTokens(loaded);
    const url = joinUrl(CODEX_API_BASE, "/wham/usage");
    return codexUsageRequest(url, tokens.accessToken, codexUsageRelay(this.env));
  }

  private async notify(content: string): Promise<void> {
    const webhook = this.env.WECOM_WEBHOOK_URL?.trim();
    if (webhook) await sendWecomMarkdown(webhook, content);
  }
}
