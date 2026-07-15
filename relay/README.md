# Codex usage relay

Minimal Cloud Run service for one endpoint only: `GET /wham/usage`.

It requires `X-Relay-Token`, reads the OpenAI access token from `Authorization`, then creates a clean upstream request to ChatGPT with only:

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
