# Architecture

## Pattern Overview

**Overall:** Provider-snapshot pipeline over a Cloudflare Worker

The Worker aggregates usage quotas from three AI providers (OpenAI Codex, ZenMux, Krill AI) into a single normalized `ProviderSnapshot` list, formats that list for two delivery channels (WeCom markdown, Telegram text), and pushes it on a cron schedule or on demand. A companion Durable Object (`CodexAuthState`) owns the Codex OAuth device-login lifecycle, and a separate Python relay (`relay/`) fronts both OpenAI's usage endpoint and Krill's subscription endpoint to bypass Worker-originated fetch failures (OpenAI's bot interception and a Krill region-specific pre-response timeout).

**Key Characteristics:**
- **Single Worker, two handlers** — one `fetch` handler (`src/index.ts`) routes every HTTP request, and one `scheduled` handler drives the cron report.
- **Failure isolation per provider** — every provider read is wrapped in a catch that degrades to an `error` snapshot, so one dead provider never aborts the rest of the report.
- **Change-gated sending** — scheduled reports compare against a KV-stored baseline and are silently skipped when nothing crossed the threshold.
- **Sealed token storage** — Codex tokens are AES-GCM-encrypted at rest inside the Durable Object, keyed by `CODEX_TOKEN_ENCRYPTION_KEY`.
- **Dual surface** — WeCom receives full markdown; Telegram serves on-demand `/quota` replies in plain text with a separate, stricter config path.
- **ESM TypeScript**, bundled by Vite via `@cloudflare/vite-plugin`; strict compiler flags (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).

## Layers

**Routing / handler layer:**
- Purpose: Dispatch incoming HTTP requests to admin, webhook, and health routes; run the cron report.
- Location: `src/index.ts`
- Contains: `default.fetch` (`handleRequest`), `default.scheduled`, `adminGuard`, the internal `report()` helper.
- Depends on: `src/providers.ts`, `src/report.ts`, `src/report-state.ts`, `src/telegram.ts`, `src/wecom.ts`, `src/env.ts`, `src/http.ts`, `src/codex-auth.ts`.
- Used by: the Cloudflare runtime (entry point declared in `wrangler.jsonc` `main`).

**Provider collection layer:**
- Purpose: Read each provider's raw API and normalize it to `ProviderSnapshot`s.
- Location: `src/providers.ts`
- Contains: `collectSnapshots`, `parseCodexUsage`, `codexUsageJson`, `parseZenmuxSubscription`, `parseZenmuxPaygBalance`, the `provider()` failure-isolation wrapper, re-exports of Krill parsers, the bounded read timeouts (`PROVIDER_FETCH_TIMEOUT_MS`, `KRILL_FETCH_TIMEOUT_MS`), and the shared `QuotaWindow`/`ProviderSnapshot`/`WindowKind` types.
- Depends on: `src/krill.ts`, `src/codex-http.ts` (via `src/codex-auth.ts` DO), `src/env.ts`, `src/http.ts`.
- Used by: `src/index.ts` (`report()` and the Telegram path).

**Provider-specific parsing:**
- Purpose: Turn Krill's subscription payload into cycle windows and a dollar balance.
- Location: `src/krill.ts`
- Contains: `parseKrillCycleWindows`, `parseKrillBalance`, internal label-sanitizing/percent/progress helpers, and Krill-specific limits (`MAX_SUBSCRIPTIONS`, `MAX_SUBSCRIPTION_ID_LENGTH`, `MAX_LABEL_LENGTH`).
- Depends on: `src/http.ts` (`isRecord`), `src/providers.ts` types.
- Used by: `src/providers.ts` (and re-exported from it).

**Codex auth / identity layer:**
- Purpose: Own the Codex OAuth device-code flow and token persistence in a Durable Object.
- Location: `src/codex-auth.ts`
- Contains: `CodexAuthState` (DO class), `StoredTokens`, `LoginAttempt`, `CodexAuthStorage`, the device-login/alarm-poll/refresh state machine.
- Depends on: `src/codex-http.ts`, `src/crypto.ts`, `src/env.ts`, `src/http.ts`, `src/wecom.ts`.
- Used by: `src/index.ts` (via stubs from `src/env.ts` `codexStub`) and `src/providers.ts` (usage fetch through the DO).

**Codex HTTP / relay-fallback layer:**
- Purpose: Fetch Codex usage directly, then fall back to the relay when OpenAI's bot-block triggers.
- Location: `src/codex-http.ts`
- Contains: `codexUsageRequest`, `relayUsageRequest`, `jsonResponse`, `CodexUsageRelay` type.
- Depends on: nothing internal (uses platform `fetch`).
- Used by: `src/codex-auth.ts`.

**Cryptography layer:**
- Purpose: AES-GCM seal/open of JSON and JWT claim extraction.
- Location: `src/crypto.ts`
- Contains: `sealJson`, `openJson`, `SealedBox`, `jwtClaims`, `jwtExpiryMs`, `chatgptAccountId`, base64url helpers.
- Depends on: `src/http.ts` (`isRecord`, `asString`).
- Used by: `src/codex-auth.ts`.

**Reporting layer:**
- Purpose: Format `ProviderSnapshot`s into WeCom markdown and Telegram text.
- Location: `src/report.ts`
- Contains: `buildMarkdown`, `buildTelegramMessage`, bar/color/window-label helpers.
- Depends on: `src/providers.ts` types only.
- Used by: `src/index.ts` and `src/telegram.ts` (through `index.ts`).

**Report state / dedup layer:**
- Purpose: Persist and compare a numeric baseline to decide whether a report is worth sending.
- Location: `src/report-state.ts`
- Contains: `ReportBaseline`, `ReportStateStore`, `reportBaseline`, `shouldSendScheduledReport`, `shouldSendForReportChange`, `saveReportBaseline`.
- Depends on: `src/http.ts` (`isRecord`), `src/providers.ts` types.
- Used by: `src/index.ts`.

**Notification / integration layer:**
- Purpose: Send messages to WeCom and Telegram.
- Location: `src/wecom.ts`, `src/telegram.ts`
- Contains: `sendWecomMarkdown`; Telegram `handleTelegramWebhook`, `sendTelegramMessage`, `parseTelegramWebhookConfig`, zod schemas, `TelegramConfigurationError`, `TelegramApiError`.
- Depends on: `src/http.ts`, `zod`.
- Used by: `src/index.ts` and `src/codex-auth.ts` (WeCom notify).

**Shared utilities / env layer:**
- Purpose: Small HTTP/env helpers and compile-time constants.
- Location: `src/http.ts`, `src/env.ts`
- Contains: `json`, `fetchJson` (applies `AbortSignal.timeout(timeoutMs)` when a timeout is passed), `bearerAuth`, `joinUrl`, `isRecord`, `asString`, `asNumber`; env constants (`CODEX_ISSUER`, `CODEX_API_BASE`, `CODEX_OAUTH_CLIENT_ID`, `ZENMUX_API_BASE`, `KRILL_API_BASE`), `textEnv`, `requiredEnv`, `codexStub`, `krillApiBase`, `codexUsageRelay`, `SecretName`.
- Used by: nearly every other module.

**Relay layer (separate deploy):**
- Purpose: Proxy two fixed upstream routes (`GET /wham/usage` → OpenAI, `GET /krill/subscription` → Krill) with a clean `Authorization`/`User-Agent` header, so requests look like a real Codex CLI and avoid OpenAI's bot interception and Krill's region-specific pre-response timeout.
- Location: `relay/codex_usage_relay.py` (Cloud Run, `relay/Dockerfile`).
- Depends on: Python stdlib only.
- Used by: `src/codex-http.ts` via `relayUsageRequest` (Codex fallback) and `src/providers.ts` (Krill subscription) when `CODEX_USAGE_RELAY_URL`/`CODEX_USAGE_RELAY_TOKEN` are configured.

## Data Flow

**Scheduled report (cron `*/10 * * * *`):**

1. Cloudflare invokes `default.scheduled` — `src/index.ts`
2. `report()` calls `collectSnapshots(env)`, which fans out Codex / ZenMux subscription / ZenMux PAYG / Krill reads in `Promise.all`; the Krill read uses the relay's `/krill/subscription` when the relay pair is configured (falling back to `KRILL_API_BASE`) with a 20s timeout — `src/providers.ts`
3. `shouldSendScheduledReport` loads the KV baseline and diffs usage/balance deltas against thresholds — `src/report-state.ts`
4. If changed, `sendWecomMarkdown` posts `buildMarkdown(snapshots)` to the WeCom webhook — `src/wecom.ts`/`src/report.ts`
5. `saveReportBaseline` writes the fresh baseline back to KV `REPORT_STATE` — `src/report-state.ts`

**Manual report (`POST /run`):**

1. `handleRequest` matches `POST /run`, passes `adminGuard` (Bearer `ADMIN_TOKEN`) — `src/index.ts`
2. `report()` → `collectSnapshots` → `buildMarkdown` — `src/providers.ts`/`src/report.ts`
3. Sends unconditionally, then saves the baseline (no change gating) — `src/index.ts`

**Telegram on-demand query (`POST /telegram/webhook`):**

1. Telegram POSTs an update; `handleTelegramWebhook` verifies `x-telegram-bot-api-secret-token` against `TELEGRAM_WEBHOOK_SECRET` — `src/telegram.ts`
2. The update is schema-validated and filtered to allowlisted group/supergroup chats with a `/quota` (optionally `@bot_username`) command; everything else returns `{ok:true}` silently — `src/telegram.ts`
3. On match, `ctx.waitUntil` schedules `collectSnapshots` → `buildTelegramMessage` → `sendTelegramMessage` — `src/index.ts` → `src/telegram.ts`

**Codex device login (`POST /codex/login`):**

1. `handleRequest` proxies to the DO via `codexStub(env).fetch("https://codex-auth.internal/login")` — `src/index.ts`/`src/env.ts`
2. DO `login()` requests a device code from `CODEX_ISSUER`, stores a `LoginAttempt`, sets an alarm, and notifies WeCom with the code — `src/codex-auth.ts`
3. On alarm, `pollLogin()` exchanges the code, then `saveTokens` seals the tokens with AES-GCM — `src/codex-auth.ts`/`src/crypto.ts`

**Codex usage collection (inside the report):**

1. `collectSnapshots` calls the DO's internal `/usage` route — `src/providers.ts`
2. DO `usage()` refreshes tokens if near expiry, then calls `codexUsageRequest` — `src/codex-auth.ts`
3. `codexUsageRequest` tries OpenAI directly; on the blocker string it calls `relayUsageRequest` against the relay — `src/codex-http.ts`

## Key Abstractions

**`ProviderSnapshot`:**
- Purpose: The normalized unit every provider produces, downcast to `windowed` (ranked windows), `balance` (dollar string), or `error` (message).
- Location: `src/providers.ts`
- Pattern: Discriminated union on `kind`.

**`QuotaWindow`:**
- Purpose: A single quota window with `usagePercent` (quota used) and `timePercent`/`remainingMs` (time elapsed in the window), plus optional `id`/`label`/`timing: "idle"`.
- Location: `src/providers.ts`
- Pattern: Readonly plain object; `kind` is `"1d" | "5h" | "7d" | "cycle"`.

**`CodexAuthState`:**
- Purpose: The Durable Object (SQLite-backed) that owns Codex tokens and the login/alarm poll loop; exposes `/status`, `/login`, `/usage` internally.
- Location: `src/codex-auth.ts`
- Pattern: Durable Object class; exported from `src/index.ts` and bound as `CODEX_AUTH` in `wrangler.jsonc`.

**`SealedBox`:**
- Purpose: Versioned AES-GCM ciphertext envelope (`{version, iv, ciphertext}` base64url).
- Location: `src/crypto.ts`
- Pattern: Versioned container; `sealJson`/`openJson` are the only writers/readers.

**`ReportBaseline` / `ReportStateStore`:**
- Purpose: The KV-backed numeric snapshot (`windows: Record<string,number>`, `balances: Record<string,number>`) used for change detection.
- Location: `src/report-state.ts`
- Pattern: JSON-persisted record; parsed leniently (`parseBaseline` drops malformed entries).

## Entry Points

**Worker fetch handler:**
- Location: `src/index.ts` (`export default { fetch, scheduled }`)
- Triggers: Every HTTP request to the Worker.
- Responsibilities: Route `/health`, `/ready`, `/preview`, `/run`, `/codex/status`, `/codex/login`, `/telegram/webhook`; apply `adminGuard` to protected routes; return 404 otherwise.

**Worker scheduled handler:**
- Location: `src/index.ts` (`default.scheduled`)
- Triggers: Cloudflare cron `*/10 * * * *` (declared in `wrangler.jsonc`).
- Responsibilities: Collect snapshots, gate on baseline change, send WeCom markdown, save baseline.

**Durable Object `fetch` / `alarm`:**
- Location: `src/codex-auth.ts` (`CodexAuthState.fetch`, `CodexAuthState.alarm`)
- Triggers: Internal DO subrequests from `codexStub`; the DO alarm for device-code polling.
- Responsibilities: Serve `/status`/`/login`/`/usage`; run the poll-on-alarm step; notify WeCom on transitions.

**Relay HTTP handler:**
- Location: `relay/codex_usage_relay.py` (`do_GET`)
- Triggers: `GET /wham/usage` (from `relayUsageRequest`), `GET /krill/subscription` (from the Krill branch of `collectSnapshots`), and `GET /health`.
- Responsibilities: Validate `X-Relay-Token`, require a `Bearer` provider token, forward `Authorization`/`User-Agent` to the route's fixed upstream (OpenAI overridable via `OPENAI_USAGE_URL`, Krill fixed), and stream the response back.

## Error Handling

**Strategy:** Degrade per-provider rather than fail the report.

- `provider()` in `src/providers.ts` wraps each read and returns `{kind:"error", provider, message}` on any throw, so `collectSnapshots` always resolves and the report renders the error inline.
- The Krill branch uses the same pattern directly (returns an error snapshot array on catch), and every provider read is bounded by a timeout so a hung upstream degrades instead of stalling the report.
- The Codex Durable Object catches all request errors and returns `{error}` JSON with HTTP 502 (`src/codex-auth.ts`).
- `codexUsageRequest` recognizes OpenAI's `"Unable to load site"` blocker string and retries via the relay before surfacing the error (`src/codex-http.ts`).
- `requiredEnv` throws a Chinese-language message naming the missing secret, and `/ready` surfaces all missing/invalid names with HTTP 503 (`src/env.ts`/`src/index.ts`).
- Telegram validation is fail-closed: bad secret → 401, malformed update → 400, then silent `{ok:true}` for anything outside the allowlist/command filter; config errors raise `TelegramConfigurationError`, API failures raise `TelegramApiError` (`src/telegram.ts`).

## Cross-Cutting Concerns

**Logging:** No dedicated logger; failures surface through the report text, `/ready` diagnostics, and WeCom notifications on login transitions.

**Caching:** All JSON responses set `cache-control: no-store` (`src/http.ts` `json`); the relay also sends `cache-control: no-store`.

**Storage:**
- KV namespace `REPORT_STATE` (`wrangler.jsonc` binding) holds the last report baseline under `last-report-baseline`.
- Durable Object `CODEX_AUTH` (SQLite migration `v1`) stores sealed Codex tokens (`codex.tokens`) and the in-flight login attempt (`codex.login`), plus the alarm for polling.

**Scheduling:**
- Cloudflare cron `*/10 * * * *` drives the Worker `scheduled` handler.
- The Durable Object alarm drives Codex device-code polling at the provider-specified interval.

**Security:**
- Admin routes (`/preview`, `/run`, `/codex/login`, `/codex/status`) require `Authorization: Bearer $ADMIN_TOKEN`.
- Codex tokens are AES-GCM-encrypted at rest; the 32-byte key is `CODEX_TOKEN_ENCRYPTION_KEY`.
- Telegram webhook verifies `x-telegram-bot-api-secret-token` and restricts chats to `TELEGRAM_ALLOWED_CHAT_IDS` (negative IDs only).
- The relay requires an `X-Relay-Token` before forwarding bearer credentials upstream.