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
- `POST /telegram/webhook`：接收 Telegram webhook；响应 allowlist 群聊中的 `/quota`、`/detect <模型名>`，均可带 `@bot_username`。

## 模型指纹检测

在允许的 Telegram 群聊中发送 `/detect gpt-5.6-luna`。机器人先回复“模型检测中”，完成后编辑同一条消息，显示请求模型、最匹配的模型和是否一致。请求失败或有效回答不足三条时显示检测失败。

匹配到 `gpt-6-astra` 指纹时，输出显示为 `gpt-6-astra/gpt-6.1-sol`；输入这两个模型中的任意一个都判定一致，因为此指纹不能区分两者。

检测复用 `CODEX_AUTH` 内保存的 Codex OAuth 凭证，以 `low` 推理强度并行发送三个独立数字序列探针，不自动重试模型请求。检测由独立的 `DetectionJob` Durable Object alarm 执行，不受 webhook 回复后 30 秒的 `waitUntil` 限制；重复 webhook 按群聊和 update ID 去重。

配置现有 `CODEX_USAGE_RELAY_URL` / `CODEX_USAGE_RELAY_TOKEN` 时，推理请求使用同一 relay 的固定 `/codex/responses` 路由，避开已实测的 Worker 直连 403 HTML 拦截；需部署包含该路由的 relay 版本。未配置时直连 Codex Responses API。

算法和固定版本指纹库来自 MIT 许可的 [lm-detector](https://github.com/Ikaleio/lm-detector)，版本及归属见 `src/detector/`。结果属于参考库内的统计匹配，不是模型身份或路由证明；参考库之外的模型也可能匹配到已有候选。当前 Worker 未压缩包体约 6.5 MiB，符合 Cloudflare 当前 64 MiB 包体限制。

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
- `KRILL_API_BASE`：Krill API base URL（仅 base，路径 `/api/subscription` 写死在代码中）；当前在 `wrangler.jsonc` 中配置为 `https://www.krill-code.com`。必须使用带 `www` 的子域（apex 返回 502），且不可填旧域名 `www.krill-ai.net`（会 301 重定向到新域名，重定向过程会剥离 Authorization header）。未配置时回退到代码内同值默认。

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
  --data-urlencode 'commands=[{"command":"quota","description":"查看当前 AI 额度"},{"command":"detect","description":"检测模型指纹：/detect 模型名"}]' \
  --data-urlencode 'scope={"type":"all_group_chats"}'

curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WORKER_URL}/telegram/webhook" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message"]'
```

Webhook 会校验 Telegram secret header，并静默忽略私聊、频道、非 allowlist 群聊和不支持的指令。

## CI/CD

GitHub Actions：

- `CI`：所有 push 和 pull request 都会检查 Worker、运行测试并构建 relay 镜像。
- `Deploy Worker`：`main` 分支检查并部署 Cloudflare Worker；目标是 `wrangler.jsonc` 中的个人账号 `27f84d8803f0f08e457c5a6cc8ee9d3b`（`i@llc.moe`），运行时 secrets 需预先通过 Wrangler 配置。
- `Publish Relay`：使用仓库自带的 `GITHUB_TOKEN` 推送 relay 镜像到 `ghcr.io/llc1123/ai-quota-bot`，发布 `latest`、`sha-<提交短哈希>` 和分支标签。镜像名从仓库地址转为小写，不需要 GCP 凭据。此工作流只发布镜像；VPS 服务更新单独执行。

Renovate 更新先推送到分支并运行 CI，检查通过后直接合入 `main`；检查或直接合并失败时，允许回退创建 PR。

Cloudflare 账号和 KV namespace ID 由 `wrangler.jsonc` 管理；不再使用 GitHub 的 `CLOUDFLARE_ACCOUNT_ID` 或 `GCP_*` Variables。

GitHub Secrets：

- `CLOUDFLARE_API_TOKEN`：必须具备个人目标账号的 Worker 部署和绑定资源权限。仓库转移会保留旧 secret，需核对或替换其账号授权。

GitHub Packages 首次发布的容器镜像默认为 private，即使仓库是 public 也需在 package 设置中改为 public，才能匿名拉取。此前停用的 relay 工作流需在新发布配置进入主分支后重新启用。

运行时配置不由 workflow 写入：Worker secrets 通过 Wrangler CLI 预置在 Cloudflare；relay 的 `RELAY_TOKEN` 保留在 VPS 环境文件中。Worker 的 `CODEX_USAGE_RELAY_URL` 为 `https://ai-quota-checker.llc.moe/wham/usage`。

跨 Cloudflare 账号迁移时，需在目标账号重新部署 Worker 和两个 SQLite Durable Object，并复制运行时 secrets。Cloudflare 不提供跨账号 DO namespace 转移；Codex 登录状态需要重新完成 `/codex/login`，或另行实现受控的数据导入导出。切换前应等待旧账号中的检测任务完成。

个人账号的生产地址为 `https://ai-quota-bot.llc1123.workers.dev`，Telegram webhook 使用此地址的 `/telegram/webhook`，cron 为 `*/10 * * * *`。后续跨账号迁移时，先将目标 `triggers.crons` 设为空，完成 `/ready`、Codex 登录和真实额度/检测请求验证，再切换 Telegram webhook；确认旧 Worker 的 cron 已停用后恢复目标 cron 并部署，避免重复推送。
