# Codebase Structure

## Directory layout

```text
src/
  index.ts            Worker routes and scheduled reports
  providers.ts        Snapshot collection, ZenMux parsing and pacing
  krill.ts            Krill subscription and balance parsing
  report.ts           WeCom markdown and Telegram text
  report-state.ts     KV baseline and change detection
  telegram.ts         Webhook validation and /quota dispatch
  telegram-api.ts     Telegram sendMessage integration
  wecom.ts            WeCom markdown delivery
  env.ts              Secrets and upstream configuration
  http.ts             HTTP/JSON helpers
test/                 Vitest suites mirroring source modules
.github/workflows/
  ci.yml              Checks on every push and pull request
  deploy-worker.yml   Production Worker release from main
wrangler.jsonc        Worker identity, cron, KV and migration history
worker-configuration.d.ts  Generated Worker/runtime types
package.json          npm scripts and dependencies
package-lock.json     Dependency lockfile
tsconfig.json         Strict TypeScript configuration
vite.config.ts        Cloudflare Worker Vite integration
vitest.config.ts      Test include pattern
biome.jsonc           Formatting and lint rules
.dev.vars.example     Local configuration template
```

`.dev.vars`, `.wrangler/`, `dist/` and `node_modules/` are untracked local state or generated output.

## Entry points and contracts

- `src/index.ts` exports the Worker's `fetch` and `scheduled` handlers.
- `src/providers.ts` defines `ProviderSnapshot`, `QuotaWindow`, `WindowKind` and `collectSnapshots`.
- `src/report.ts` formats normalized snapshots; `src/report-state.ts` decides whether scheduled reports should be sent.
- `src/telegram.ts` owns command acceptance; `src/telegram-api.ts` owns Telegram delivery.

## Conventions

Files use kebab-case, exported types use PascalCase, and module constants use UPPER_SNAKE_CASE. Tests live in `test/<module>.test.ts`. Keep provider parsing separate from delivery formatting and wrap provider reads with failure isolation.

Add routes in `src/index.ts` and apply `adminGuard` when required. Shared HTTP helpers belong in `src/http.ts`; environment configuration belongs in `src/env.ts`. Retain existing migration tags and append resource lifecycle changes in `wrangler.jsonc`.

## Checks

`npm run check` runs lint, typecheck, tests and build. `npm run types` regenerates `worker-configuration.d.ts` after configuration changes. Deploy production with the `Deploy Worker` GitHub Actions workflow.
