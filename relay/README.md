# Provider usage relay

Minimal Cloud Run service with two fixed upstream routes:

- `GET /wham/usage` → OpenAI Codex usage.
- `GET /krill/subscription` → `https://www.krill-code.com/api/subscription`.

Both routes require `X-Relay-Token`, read the provider token from `Authorization`, and create an upstream request with only:

- `Authorization: Bearer <token>`
- `User-Agent: codex-cli`

Deploy:

```bash
gcloud run deploy codex-usage-relay \
  --source relay \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --set-env-vars RELAY_TOKEN="$CODEX_USAGE_RELAY_TOKEN"
```

Worker config:

```bash
CODEX_USAGE_RELAY_URL="https://<service-url>/wham/usage"
CODEX_USAGE_RELAY_TOKEN="same-random-token"
```

When this pair is configured, Krill collection uses `/krill/subscription` on the
same relay origin directly, with a 20-second Worker timeout. Without the pair,
Krill retains direct collection using `KRILL_API_BASE`. The relay fixes Krill's
upstream to the URL above; it does not accept caller-supplied upstream URLs.
This avoids the observed pre-response timeout from Workers running in AMS by
using the existing Tokyo Cloud Run service. Codex retains its existing fallback behavior.
