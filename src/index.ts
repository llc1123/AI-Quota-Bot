import { CodexAuthState } from "./codex-auth";
import { codexStub, requiredEnv, type SecretName } from "./env";
import { bearerAuth, json } from "./http";
import { collectSnapshots } from "./providers";
import { buildMarkdown } from "./report";
import { sendWecomMarkdown } from "./wecom";

export { CodexAuthState };

async function adminGuard(request: Request, env: Env): Promise<Response | undefined> {
  const token = requiredEnv(env, "ADMIN_TOKEN");
  return bearerAuth(request) === token ? undefined : json({ error: "unauthorized" }, 401);
}

async function report(env: Env): Promise<{
  readonly markdown: string;
  readonly snapshots: Awaited<ReturnType<typeof collectSnapshots>>;
}> {
  const snapshots = await collectSnapshots(env);
  return {
    snapshots,
    markdown: buildMarkdown(snapshots),
  };
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
  if (request.method === "GET" && url.pathname === "/ready") {
    const requiredNames = [
      "WECOM_WEBHOOK_URL",
      "ADMIN_TOKEN",
      "CODEX_TOKEN_ENCRYPTION_KEY",
      "ZENMUX_MANAGEMENT_KEY",
      "KRILL_JWT",
    ] satisfies readonly SecretName[];
    const missing = requiredNames.filter(
      (key) => typeof env[key] !== "string" || env[key].trim() === "",
    );
    return json({ ready: missing.length === 0, missing }, missing.length === 0 ? 200 : 503);
  }
  const protectedRoute =
    (request.method === "GET" && ["/preview", "/codex/status"].includes(url.pathname)) ||
    (request.method === "POST" && ["/run", "/codex/login"].includes(url.pathname));
  if (protectedRoute) {
    const rejected = await adminGuard(request, env);
    if (rejected) return rejected;
  }
  if (request.method === "GET" && url.pathname === "/preview") return json(await report(env));
  if (request.method === "POST" && url.pathname === "/run") {
    const current = await report(env);
    await sendWecomMarkdown(requiredEnv(env, "WECOM_WEBHOOK_URL"), current.markdown);
    return json({ ok: true, snapshots: current.snapshots });
  }
  if (request.method === "GET" && url.pathname === "/codex/status")
    return codexStub(env).fetch("https://codex-auth.internal/status");
  if (request.method === "POST" && url.pathname === "/codex/login")
    return codexStub(env).fetch("https://codex-auth.internal/login", { method: "POST" });
  return json({ error: "not_found" }, 404);
}

export default {
  fetch: handleRequest,
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const current = await report(env);
    await sendWecomMarkdown(requiredEnv(env, "WECOM_WEBHOOK_URL"), current.markdown);
  },
} satisfies ExportedHandler<Env>;
