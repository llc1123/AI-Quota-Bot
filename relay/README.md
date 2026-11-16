# Provider usage relay

Minimal stdlib container service with fixed upstream routes:

- `GET /wham/usage` → OpenAI Codex usage.
- `GET /krill/subscription` → `https://www.krill-code.com/api/subscription`.

Both GET routes require `X-Relay-Token`, read the provider token from `Authorization`, and create an upstream request with only:

- `Authorization: Bearer <token>`
- `User-Agent: codex-cli`

`POST /codex/responses` forwards to the fixed upstream
`https://chatgpt.com/backend-api/codex/responses`. The path must match exactly,
without a query string. It requires a nonempty server `RELAY_TOKEN`, a matching
`X-Relay-Token`, and a nonempty `Authorization: Bearer <provider-token>`.
There is no runtime inference URL configuration, redirect following, or retry.

POST requires one decimal `Content-Length` and at most 32 KiB (32768 bytes).
Malformed or missing lengths, duplicate lengths, transfer encodings (including
chunked), invalid JSON, and payloads without an object containing a string
`model` and list `input` return 400. Oversized requests return 413. The original
JSON bytes, including other Codex fields, are forwarded unchanged. POST
connections close after the response, including rejected requests with unread
bodies.

Upstream application headers are limited to `Authorization`,
`User-Agent: codex-cli`, `Content-Type: application/json`,
`Accept: text/event-stream`, `originator: codex_cli_rs`, and the optional caller
`chatgpt-account-id`. The relay token and caller cookies are never forwarded.
The upstream timeout is 240 seconds. Finite SSE responses are fully buffered,
with a 2 MiB (2097152-byte) maximum, and returned byte for byte with the upstream status,
content type, and available `cf-ray`, `x-request-id`, `request-id`, or
`openai-request-id` headers. Redirect statuses are returned without `Location`.
Oversized responses return 502; transport failures return a generic 502 and
direct timeouts return 504. Upstream error bodies are subject to the same bound
and may be returned to the authenticated Worker for sanitization. Credentials
and raw upstream errors are never added to logs. GET behavior and its 30-second
upstream timeout are unchanged.

Local checks (only loopback HTTP servers are used):

```bash
python3 -m unittest discover -s relay -p 'test_codex_usage_relay.py' -v
python3 -m py_compile relay/codex_usage_relay.py relay/test_codex_usage_relay.py
```

Images are published by `Publish Relay` to GitHub Container Registry:

```bash
docker pull ghcr.io/llc1123/ai-quota-bot:latest
```

The workflow also publishes `sha-<short-commit>` tags for selecting a specific
build. The package must be made public after its first publication for anonymous
pulls. The production relay runs on the VPS behind the shared Nginx at
`ai-quota-checker.llc.moe`; image publication does not update the running
container. Its `RELAY_TOKEN` stays in the VPS environment file. Reload Nginx
after replacing the relay container so its upstream address is refreshed.

Worker config:

```bash
CODEX_USAGE_RELAY_URL="https://ai-quota-checker.llc.moe/wham/usage"
CODEX_USAGE_RELAY_TOKEN="same-random-token"
```

When this pair is configured, Krill collection uses `/krill/subscription` on the
same relay origin directly, with a 20-second Worker timeout. Without the pair,
Krill retains direct collection using `KRILL_API_BASE`. The relay fixes Krill's
upstream to the URL above; it does not accept caller-supplied upstream URLs.
This avoids the observed pre-response timeout from Workers running in AMS by
using the VPS relay. Codex retains its existing fallback behavior.
