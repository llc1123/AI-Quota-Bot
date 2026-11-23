# AI Quota Bot

Cloudflare Worker 汇总 ZenMux Subscription、ZenMux PAYG 和 Krill AI 额度，定时推送到企业微信群机器人，并通过 Telegram 群聊 `/quota` 指令按需查询。

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

提交前运行 `npm run check`，依次执行 Biome、TypeScript、Vitest 和 Vite 构建。修改绑定或环境变量后运行 `npm run types` 更新生成类型。

## HTTP 表面

- `GET /health`：健康检查。
- `GET /ready`：检查必需环境变量。
- `GET /preview`：生成但不发送播报，需 `Authorization: Bearer $ADMIN_TOKEN`。
- `POST /run`：立即发送播报，需管理员令牌。
- `POST /telegram/webhook`：接收 Telegram webhook；响应 allowlist 群聊中的 `/quota`，也支持 `/quota@bot_username`。

cron 为 `*/10 * * * *`。定时播报仅在额度变化达到阈值时发送；手动 `/run` 总是发送，发送成功后更新 KV 基线。

## 配置

Cloudflare secrets：

- `WECOM_WEBHOOK_URL`
- `ADMIN_TOKEN`
- `ZENMUX_MANAGEMENT_KEY`
- `KRILL_JWT`
- `TELEGRAM_BOT_TOKEN`：BotFather 签发的 bot token。
- `TELEGRAM_WEBHOOK_SECRET`：仅允许字母、数字、下划线和连字符。
- `TELEGRAM_ALLOWED_CHAT_IDS`：逗号分隔的群聊 ID，必须为负数。

Wrangler 变量：

- `TELEGRAM_BOT_USERNAME`：不含 `@` 的 bot username，避免响应发给其他 bot 的命令。
- `ZENMUX_API_BASE`：默认 `https://zenmux.dev`。
- `KRILL_API_BASE`：默认 `https://www.krill-code.com`，查询路径固定为 `/api/subscription`。必须使用带 `www` 的域名；旧域名重定向会丢失 Authorization header。

Krill 从 Worker 直接查询，无独立转发服务。每个供应商有独立超时和错误快照，单个供应商失败不阻塞其他额度。ZenMux 请求在单个 Worker isolate 内串行执行，PAYG balance 请求启动间隔至少 5 秒；此限制不跨 isolate 协调。

本地变量模板见 `.dev.vars.example`，真实凭证不得提交。

## Telegram Bot 初始化

1. 通过 BotFather 创建 bot 并加入目标群聊，取得群聊的负数 ID。
2. 使用 `wrangler secret put` 配置上述 Telegram secrets。
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

Webhook 校验 secret header，并静默忽略私聊、频道、非 allowlist 群聊和不支持的指令。旋转 webhook secret 时，先更新 Worker secret，确认新 secret 请求返回 200 后再调用 Telegram `setWebhook`。

## CI/CD

- `CI`：所有 push 和 pull request 执行 `npm run check`。
- `Deploy Worker`：`main` 分支检查并部署 Worker；生产发布统一通过 GitHub Actions。
- Renovate 分支通过 CI 后直接合入 `main`，失败时允许回退创建 PR。

GitHub secret `CLOUDFLARE_API_TOKEN` 需要目标账号的 Worker 部署与资源权限。运行时 secrets 通过 Wrangler 预置，不由工作流写入。

生产地址为 `https://ai-quota-bot.llc1123.workers.dev`，Telegram webhook 为 `/telegram/webhook`。Cloudflare 账号、KV namespace 和历史资源迁移由 `wrangler.jsonc` 管理；保留历史迁移及删除迁移，以支持已有部署正确退役存储。
