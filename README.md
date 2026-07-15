# AI Quota WeCom Bot

Cloudflare Worker 定时汇总 OpenAI Codex、ZenMux Subscription、Krill AI 额度，并推送到企业微信群机器人。

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

## 配置

Cloudflare secrets：

- `WECOM_WEBHOOK_URL`
- `ADMIN_TOKEN`
- `CODEX_TOKEN_ENCRYPTION_KEY`：32 字节随机值的 base64 编码。
- `ZENMUX_MANAGEMENT_KEY`
- `KRILL_JWT`

可选变量见 `.dev.vars.example`。

## CI/CD

GitHub Actions：

- `CI`：检查 Worker、测试、构建 relay 镜像。
- `Deploy Worker`：`main` 分支部署 Cloudflare Worker，并同步 Worker secrets。
- `Deploy Relay`：使用 GitHub OIDC Direct Workload Identity Federation 推送 relay 镜像到 Artifact Registry，再部署到 Cloud Run；部署后把 Cloud Run URL 写入 Worker secret `CODEX_USAGE_RELAY_URL`。

GitHub Variables：

- `GCP_PROJECT_ID=llc-personal`
- `GCP_REGION=asia-northeast1`
- `GCP_ARTIFACT_REPOSITORY=ai-quota-bot`
- `GCP_RELAY_SERVICE=codex-usage-relay`
- `GCP_RELAY_RUNTIME_SERVICE_ACCOUNT=codex-relay-runtime@llc-personal.iam.gserviceaccount.com`
- `GCP_WORKLOAD_IDENTITY_PROVIDER=projects/833268932862/locations/global/workloadIdentityPools/github/providers/github`
- `CLOUDFLARE_ACCOUNT_ID=fc1f4ce1cc619f0f7dde83674c85b62c`

GitHub Secrets：

- `CLOUDFLARE_API_TOKEN`

运行时配置不由 workflow 写入：Worker secrets 通过 Wrangler CLI 预置在 Cloudflare；Cloud Run env/secrets、service account、公开访问和资源限制通过 gcloud CLI 预置在服务上。Actions 只推 Worker 代码、relay 镜像和 Cloud Run revision 镜像。
