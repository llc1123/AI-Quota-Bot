# Codebase Structure

## Directory Layout

```
[project-root]/
├── src/                    # TypeScript Worker source (Cloudflare Worker + Durable Object)
│   ├── index.ts            # Entry point: fetch + scheduled handlers, route dispatch
│   ├── codex-auth.ts       # CodexAuthState Durable Object (device login, token storage)
│   ├── codex-http.ts       # Codex usage fetch + relay fallback
│   ├── crypto.ts           # AES-GCM seal/open, JWT claim parsing
│   ├── env.ts              # Provider constants, requiredEnv, stub helpers
│   ├── http.ts             # JSON/fetch/bearer/URL shared helpers
│   ├── krill.ts            # Krill subscription parsing
│   ├── providers.ts        # collectSnapshots + ProviderSnapshot/QuotaWindow types
│   ├── report-state.ts     # KV baseline + change detection
│   ├── report.ts           # buildMarkdown / buildTelegramMessage
│   ├── telegram.ts         # Telegram webhook handling + sendTelegramMessage
│   └── wecom.ts            # WeCom markdown send
├── test/                   # Vitest tests (co-located 1:1 with src modules)
├── relay/                  # Python Cloud Run relay (separate deploy)
│   ├── codex_usage_relay.py
│   ├── Dockerfile
│   ├── README.md
│   └── .gitignore
├── .github/workflows/      # CI, Deploy Worker, Deploy Relay
├── .wrangler/              # Wrangler local dev state (gitignored)
├── dist/                   # Build output (gitignored)
├── node_modules/           # Dependencies (gitignored)
├── package.json            # Scripts + deps (vite, vitest, wrangler, zod)
├── package-lock.json
├── wrangler.jsonc          # Worker bindings, cron, KV, Durable Object, migration
├── worker-configuration.d.ts # Generated runtime/Env types (`wrangler types`)
├── tsconfig.json           # Strict TypeScript config
├── vite.config.ts          # @cloudflare/vite-plugin
├── vitest.config.ts        # Test include glob
├── biome.jsonc             # Format/lint config
├── .dev.vars.example       # Local secret template (copy to .dev.vars)
├── .gitignore
└── README.md               # Project overview, HTTP surface, config, CI/CD
```

## Directory Purposes

**`src/`:**

- Purpose: All Worker code — routing, provider collection, auth, reporting, notifications.
- Contains: 12 TypeScript modules, one per concern (see `ARCHITECTURE.md` Layers).
- Key files: `index.ts`, `providers.ts`, `codex-auth.ts`, `report.ts`.

**`test/`:**

- Purpose: Vitest unit tests, one file per source module.
- Contains: `codex-auth.test.ts`, `codex-http.test.ts`, `krill.test.ts`, `providers.test.ts`, `report-state.test.ts`, `report.test.ts`, `telegram.test.ts`.
- Key files: `telegram.test.ts` (largest — webhook/validation coverage), `report-state.test.ts` (baseline/change gating).

**`relay/`:**

- Purpose: Standalone Python service proxying both OpenAI usage and Krill subscription requests past Worker-originated fetch failures (OpenAI's bot block, Krill's region-specific pre-response timeout).
- Contains: `codex_usage_relay.py` (single-file stdlib HTTP server), `Dockerfile` (python:3.15-slim).
- Key files: `codex_usage_relay.py`.

**`.github/workflows/`:**

- Purpose: CI and deployment automation.
- Contains: `ci.yml`, `deploy-worker.yml`, `deploy-relay.yml`.
- Key files: `deploy-relay.yml` (OIDC identity federation to Cloud Run).

## Key File Locations

**Entry Points:** `src/index.ts`: Worker `fetch` + `scheduled`; `src/codex-auth.ts`: Durable Object `fetch`/`alarm`; `relay/codex_usage_relay.py`: relay `do_GET`.

**Configuration:** `wrangler.jsonc`: bindings, cron (`*/10 * * * *`), KV `REPORT_STATE`, DO `CODEX_AUTH`, migration `v1`; `tsconfig.json`: compiler flags; `biome.jsonc`: format/lint; `.dev.vars.example`: local secrets (copy to `.dev.vars`, never commit).

**Core Logic:** `src/providers.ts`: snapshot collection; `src/krill.ts`: Krill parsing; `src/report.ts`: formatting; `src/report-state.ts`: change detection; `src/codex-auth.ts`: Codex login state.

**Shared Utilities:** `src/http.ts`: JSON/fetch/bearer helpers; `src/env.ts`: constants and `requiredEnv`; `src/crypto.ts`: seal/open/JWT.

**Tests:** `test/*.test.ts`: Vitest suites, run via `npm test` (`vitest run`).

**Generated:** `worker-configuration.d.ts`: runtime types; regenerate with `npm run types` (`wrangler types`).

## Naming Conventions

**Files:** kebab-case, one module per concern: `provider-name.ts`, `*-auth.ts`, `*-state.ts`, `*-http.ts`.
**Types:** PascalCase exported types/interfaces (`ProviderSnapshot`, `QuotaWindow`, `SealedBox`, `ReportBaseline`); internal helpers/constants are module-private lowercase or UPPER_SNAKE.
**Tests:** co-located in `test/` as `<module>.test.ts`, mirroring the `src/` filename.
**Constants:** internal magic numbers/keys are module-level `UPPER_SNAKE_CASE` (e.g. `MAX_SUBSCRIPTIONS`, `LOGIN_TTL_MS`, `LAST_REPORT_BASELINE_KEY`).

## Where to Add New Code

**New provider:** add a reader in `src/providers.ts` (or a sibling `src/<provider>.ts` with a parser), wrap it in `provider()` for failure isolation, and extend `ProviderSnapshot`/`report.ts` ordering if needed.

**New HTTP route:** add a branch in `handleRequest` in `src/index.ts`; mark it `protectedRoute` if it needs `adminGuard`.

**New notification channel:** add `src/<channel>.ts` exporting a `send*` function mirroring `src/wecom.ts`; wire it into `src/index.ts` trigger points.

**New report metric / baseline field:** extend `ReportBaseline` and `reportBaseline()` in `src/report-state.ts`, keeping thresholds in the same module.

**New Durable Object class:** add the class, export it from `src/index.ts`, and add the binding + migration in `wrangler.jsonc`; regenerate `worker-configuration.d.ts`.

**Shared helpers:** put them in `src/http.ts` (HTTP/JSON/predicates) or `src/crypto.ts` (crypto/JWT); env constants go in `src/env.ts`.

**Tests:** add `test/<module>.test.ts` beside the source it covers; keep the runner config in `vitest.config.ts` (`test/**/*.test.ts`).
