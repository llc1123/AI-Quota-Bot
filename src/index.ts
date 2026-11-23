import { requiredEnv, type SecretName } from "./env";
import { bearerAuth, json } from "./http";
import { collectSnapshots } from "./providers";
import { buildMarkdown, buildTelegramMessage } from "./report";
import { saveReportBaseline, shouldSendScheduledReport } from "./report-state";
import {
  handleTelegramWebhook,
  parseTelegramWebhookConfig,
  sendTelegramMessage,
  TelegramConfigurationError,
} from "./telegram";
import { sendWecomMarkdown } from "./wecom";

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

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
  if (request.method === "GET" && url.pathname === "/ready") {
    const requiredNames = [
      "WECOM_WEBHOOK_URL",
      "ADMIN_TOKEN",
      "ZENMUX_MANAGEMENT_KEY",
      "KRILL_JWT",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_WEBHOOK_SECRET",
      "TELEGRAM_ALLOWED_CHAT_IDS",
    ] satisfies readonly SecretName[];
    const missing = requiredNames.filter(
      (key) => typeof env[key] !== "string" || env[key].trim() === "",
    );
    const invalid: string[] = [];
    if (missing.length === 0) {
      try {
        parseTelegramWebhookConfig({
          webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
          allowedChatIds: env.TELEGRAM_ALLOWED_CHAT_IDS,
          botUsername: env.TELEGRAM_BOT_USERNAME,
        });
      } catch (error) {
        if (error instanceof TelegramConfigurationError) invalid.push(error.field);
        else throw error;
      }
    }
    const ready = missing.length === 0 && invalid.length === 0;
    return json({ ready, missing, invalid }, ready ? 200 : 503);
  }
  if (request.method === "POST" && url.pathname === "/telegram/webhook") {
    const token = requiredEnv(env, "TELEGRAM_BOT_TOKEN");
    return handleTelegramWebhook(
      request,
      parseTelegramWebhookConfig({
        webhookSecret: requiredEnv(env, "TELEGRAM_WEBHOOK_SECRET"),
        allowedChatIds: requiredEnv(env, "TELEGRAM_ALLOWED_CHAT_IDS"),
        botUsername: env.TELEGRAM_BOT_USERNAME,
      }),
      {
        getQuotaMessage: async () => buildTelegramMessage(await collectSnapshots(env)),
        sendMessage: (reply) => sendTelegramMessage(token, reply),
        waitUntil: (task) => ctx.waitUntil(task),
      },
    );
  }
  const protectedRoute =
    (request.method === "GET" && url.pathname === "/preview") ||
    (request.method === "POST" && url.pathname === "/run");
  if (protectedRoute) {
    const rejected = await adminGuard(request, env);
    if (rejected) return rejected;
  }
  if (request.method === "GET" && url.pathname === "/preview") return json(await report(env));
  if (request.method === "POST" && url.pathname === "/run") {
    const current = await report(env);
    await sendWecomMarkdown(requiredEnv(env, "WECOM_WEBHOOK_URL"), current.markdown);
    await saveReportBaseline(env.REPORT_STATE, current.snapshots);
    return json({ ok: true, snapshots: current.snapshots });
  }
  return json({ error: "not_found" }, 404);
}

export default {
  fetch: handleRequest,
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const current = await report(env);
    const shouldSend = await shouldSendScheduledReport(env.REPORT_STATE, current.snapshots);
    if (!shouldSend) return;
    await sendWecomMarkdown(requiredEnv(env, "WECOM_WEBHOOK_URL"), current.markdown);
    await saveReportBaseline(env.REPORT_STATE, current.snapshots);
  },
} satisfies ExportedHandler<Env>;
