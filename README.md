# AI Quota Bot

Cloudflare Worker 汇总 OpenAI Codex、ZenMux Subscription、Krill AI 额度，定时推送到企业微信群机器人，并通过 Telegram 群聊指令按需查询。

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

## HTTP 表面

- `GET /health`：健康检查。
- `GET /ready`：检查必需环境变量。
- `GET /preview`：生成但不发送播报，需 `Authorization: Bearer $ADMIN_TOKEN`。
- `POST /run`：立即发送播报，需管理员令牌。
- `POST /codex/login`：触发 Codex 设备码登录并推送企业微信提示，需管理员令牌。
- `GET /codex/status`：查看 Codex 登录状态，需管理员令牌。
- `POST /telegram/webhook`：接收 Telegram webhook；仅响应 allowlist 群聊中的 `/quota` 或 `/quota@bot_username`。

## 配置

Cloudflare secrets：

- `WECOM_WEBHOOK_URL`
- `ADMIN_TOKEN`
- `CODEX_TOKEN_ENCRYPTION_KEY`：32 字节随机值的 base64 编码。
- `ZENMUX_MANAGEMENT_KEY`
- `KRILL_JWT`
- `TELEGRAM_BOT_TOKEN`：BotFather 签发的 bot token。
- `TELEGRAM_WEBHOOK_SECRET`：Telegram `setWebhook.secret_token`，仅允许字母、数字、下划线和连字符。
- `TELEGRAM_ALLOWED_CHAT_IDS`：允许查询额度的群聊 ID，多个 ID 用逗号分隔；群聊 ID 必须为负数。

Wrangler 变量：

- `TELEGRAM_BOT_USERNAME`：不含 `@` 的 bot username，用于避免响应发给其他 bot 的命令；当前在 `wrangler.jsonc` 中配置。

可选变量见 `.dev.vars.example`。

## Telegram Bot 初始化

1. 通过 BotFather 创建 bot 并加入目标群聊，在尚未设置 webhook 时向群内发送 `/quota@bot_username`，然后调用 `getUpdates`，从 `message.chat.id` 取得负数群聊 ID。
2. 将 token、随机 webhook secret 和群聊 ID 写入 Worker secrets：

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put TELEGRAM_ALLOWED_CHAT_IDS
```

3. 注册群聊命令与 webhook：

```bash
export WORKER_URL="https://your-worker.workers.dev"
export TELEGRAM_BOT_TOKEN="..."
export TELEGRAM_WEBHOOK_SECRET="..."

curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands" \
  --data-urlencode 'commands=[{"command":"quota","description":"查看当前 AI 额度"}]' \
  --data-urlencode 'scope={"type":"all_group_chats"}'

curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WORKER_URL}/telegram/webhook" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message"]'
```

Webhook 会校验 Telegram secret header，并静默忽略私聊、频道、非 allowlist 群聊和非 `/quota` 消息。

## CI/CD

GitHub Actions：

- `CI`：检查 Worker、测试、构建 relay 镜像。
- `Deploy Worker`：`main` 分支检查并部署 Cloudflare Worker；运行时 secrets 需预先通过 Wrangler 配置。
- `Deploy Relay`：使用 GitHub OIDC Direct Workload Identity Federation 推送 relay 镜像到 Artifact Registry，再部署到 Cloud Run；部署后把 Cloud Run URL 写入 Worker secret `CODEX_USAGE_RELAY_URL`。

GitHub Variables：

- `GCP_PROJECT_ID=llc-personal`
- `GCP_REGION=asia-northeast1`
- `GCP_ARTIFACT_REPOSITORY=ai-quota-bot`
- `GCP_RELAY_SERVICE=codex-usage-relay`
- `GCP_WORKLOAD_IDENTITY_PROVIDER=projects/833268932862/locations/global/workloadIdentityPools/github/providers/github`
- `CLOUDFLARE_ACCOUNT_ID=fc1f4ce1cc619f0f7dde83674c85b62c`

GitHub Secrets：

- `CLOUDFLARE_API_TOKEN`

运行时配置不由 workflow 写入：Worker secrets 通过 Wrangler CLI 预置在 Cloudflare；Cloud Run env/secrets、service account、公开访问和资源限制通过 gcloud CLI 预置在服务上。Actions 只推 Worker 代码、relay 镜像和 Cloud Run revision 镜像。
