import { codexUsageRequest } from "./codex-http";
import { chatgptAccountId, jwtExpiryMs, openJson, type SealedBox, sealJson } from "./crypto";
import {
  codexUsageRelay,
  DEFAULT_CODEX_API_BASE,
  DEFAULT_CODEX_CLIENT_ID,
  DEFAULT_CODEX_ISSUER,
  requiredEnv,
  textEnv,
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

export class CodexAuthState {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
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

  private issuer(): string {
    return textEnv(this.env.CODEX_ISSUER, DEFAULT_CODEX_ISSUER).replace(/\/+$/, "");
  }

  private clientId(): string {
    return textEnv(this.env.CODEX_OAUTH_CLIENT_ID, DEFAULT_CODEX_CLIENT_ID);
  }

  private async loadTokens(): Promise<StoredTokens | undefined> {
    const box = await this.state.storage.get<SealedBox>(TOKENS_KEY);
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
    const login = await this.state.storage.get<LoginAttempt>(LOGIN_KEY);
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
    if (tokens) return { state: "authenticated", accountId: tokens.accountId };

    const existing = await this.state.storage.get<LoginAttempt>(LOGIN_KEY);
    if (existing && existing.expiresAt > Date.now())
      return {
        state: "pending",
        userCode: existing.userCode,
        verificationUrl: existing.verificationUrl,
      };

    const issuer = this.issuer();
    const response = await fetchJson(joinUrl(issuer, "/api/accounts/deviceauth/usercode"), {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "codex-cli" },
      body: JSON.stringify({ client_id: this.clientId() }),
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
      verificationUrl: joinUrl(issuer, "/codex/device"),
    };
    await this.state.storage.put(LOGIN_KEY, login);
    await this.state.storage.setAlarm(Date.now() + login.intervalMs);
    await this.notify(
      `**Codex 需要登录**\n> 打开：${login.verificationUrl}\n> 输入代码：<font color="warning">${login.userCode}</font>\n> 15 分钟内有效。`,
    );
    return { state: "pending", userCode: login.userCode, verificationUrl: login.verificationUrl };
  }

  private async pollLogin(): Promise<void> {
    const login = await this.state.storage.get<LoginAttempt>(LOGIN_KEY);
    if (!login) return;
    if (login.expiresAt <= Date.now()) {
      await this.state.storage.delete(LOGIN_KEY);
      await this.notify("**Codex 登录已超时**\n> 请重新触发 `/codex/login`。");
      return;
    }

    const issuer = this.issuer();
    const response = await fetch(joinUrl(issuer, "/api/accounts/deviceauth/token"), {
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
      redirect_uri: joinUrl(this.issuer(), "/deviceauth/callback"),
      client_id: this.clientId(),
      code_verifier: verifier,
    });
  }

  private async refreshTokens(tokens: StoredTokens): Promise<StoredTokens> {
    if (tokens.expiresAt - Date.now() > REFRESH_SKEW_MS) return tokens;
    const refreshed = await fetchJson(joinUrl(this.issuer(), "/oauth/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "codex-cli" },
      body: form({
        client_id: this.clientId(),
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
    const response = await fetchJson(joinUrl(this.issuer(), "/oauth/token"), {
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
    const base = textEnv(this.env.CODEX_API_BASE, DEFAULT_CODEX_API_BASE);
    const path = base.includes("/backend-api") ? "/wham/usage" : "/api/codex/usage";
    const url = joinUrl(base, path);
    return codexUsageRequest(url, tokens.accessToken, codexUsageRelay(this.env));
  }

  private async notify(content: string): Promise<void> {
    const webhook = this.env.WECOM_WEBHOOK_URL?.trim();
    if (webhook) await sendWecomMarkdown(webhook, content);
  }
}
