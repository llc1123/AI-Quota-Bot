# Architecture

## Overview

One Cloudflare Worker collects ZenMux and Krill AI quotas into normalized `ProviderSnapshot` values, formats them for WeCom markdown and Telegram text, and sends scheduled or on-demand reports. Provider requests go directly to their configured upstream APIs. The only persistent application state is the last report baseline in Workers KV.

The project uses ESM TypeScript with strict compiler options, Vite with `@cloudflare/vite-plugin`, Vitest, and Biome.

## Modules

| Module                | Responsibility                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`        | Worker `fetch` and `scheduled` handlers, routes, admin authentication, readiness, report orchestration         |
| `src/providers.ts`    | Provider collection, failure isolation, ZenMux parsing, request pacing, shared snapshot and quota-window types |
| `src/krill.ts`        | Krill subscription windows and wallet/gift balance parsing                                                     |
| `src/report.ts`       | WeCom markdown and Telegram text formatting                                                                    |
| `src/report-state.ts` | KV baseline serialization and report change thresholds                                                         |
| `src/telegram.ts`     | Webhook secret validation, update parsing, group allowlist and `/quota` command dispatch                       |
| `src/telegram-api.ts` | Telegram `sendMessage` request and response handling                                                           |
| `src/wecom.ts`        | WeCom markdown delivery                                                                                        |
| `src/env.ts`          | Required secrets and upstream base URL configuration                                                           |
| `src/http.ts`         | HTTP/JSON helpers, bearer authentication and value predicates                                                  |

## Data flow

### Scheduled report

1. Cloudflare invokes `scheduled` every ten minutes.
2. `collectSnapshots(env)` collects ZenMux subscription, ZenMux PAYG and Krill subscription data concurrently. Each provider returns a normalized value or an error snapshot.
3. ZenMux requests use a per-isolate serial gate, with at least five seconds between PAYG balance request starts. Separate Worker isolates are not coordinated.
4. `shouldSendScheduledReport` compares current values with KV `last-report-baseline`.
5. When thresholds are crossed, `sendWecomMarkdown` sends the formatted report and `saveReportBaseline` stores the new values.

### Manual report

`POST /run` authenticates `ADMIN_TOKEN`, collects snapshots, sends WeCom markdown unconditionally, then saves the baseline. `GET /preview` authenticates the same token and returns the report without sending it.

### Telegram query

1. `POST /telegram/webhook` checks `x-telegram-bot-api-secret-token` against `TELEGRAM_WEBHOOK_SECRET` and parses the update with Zod.
2. Only allowlisted group/supergroup messages containing `/quota` or `/quota@bot_username` are accepted.
3. The handler registers collection and `sendTelegramMessage` with `ctx.waitUntil` and acknowledges the webhook.
4. Provider requests have bounded timeouts: ZenMux uses 3 seconds and Krill uses 20 seconds, leaving time to send the response within the webhook background execution budget.

## Data model

- `ProviderSnapshot` is a discriminated union of `windowed`, `balance` and `error` values.
- `QuotaWindow` holds usage percentage, elapsed-window percentage, remaining time and optional stable ID, label or idle timing.
- `ReportBaseline` stores numeric window and balance values. Malformed persisted entries are discarded during parsing.
- Krill's `credit_balance_usd` includes gift credits; wallet balance is total credit minus `welfare_balance_usd`.

## HTTP routes

| Route                    | Access                                           |
| ------------------------ | ------------------------------------------------ |
| `GET /health`            | Public health response                           |
| `GET /ready`             | Public required-configuration readiness response |
| `GET /preview`           | Admin bearer token                               |
| `POST /run`              | Admin bearer token                               |
| `POST /telegram/webhook` | Telegram secret header, then chat allowlist      |

Other routes return 404. JSON responses use `cache-control: no-store`.

## Storage and deployment

KV binding `REPORT_STATE` holds `last-report-baseline`. There are no active Durable Object bindings, token stores, separate relay containers or model inference jobs. Historical entries in `wrangler.jsonc` are retained with a final deletion migration so existing deployments destroy retired namespaces and their stored data.

Production releases run through GitHub Actions. Runtime credentials are Worker secret bindings; local development uses an untracked `.dev.vars`. The Worker has no OAuth login lifecycle.
