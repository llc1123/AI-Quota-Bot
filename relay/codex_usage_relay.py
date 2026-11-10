from __future__ import annotations

import json
import os
from http import HTTPStatus
from http.client import HTTPException
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Final
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen

OPENAI_USAGE_URL: Final = "https://chatgpt.com/backend-api/wham/usage"
KRILL_SUBSCRIPTION_URL: Final = "https://www.krill-code.com/api/subscription"
UPSTREAM_TIMEOUT_SECONDS: Final = 30
CODEX_RESPONSES_URL: Final = "https://chatgpt.com/backend-api/codex/responses"
CODEX_TIMEOUT_SECONDS: Final = 240
CODEX_REQUEST_LIMIT: Final = 32768
CODEX_RESPONSE_LIMIT: Final = 2097152


class NoRedirect(HTTPRedirectHandler):
    # urllib requires this override signature; credentials must never follow redirects.
    def redirect_request(self, req, fp, code, msg, headers, newurl) -> None:
        return None


def _send(handler: BaseHTTPRequestHandler, status: HTTPStatus | int, body: bytes, content_type: str) -> None:
    handler.send_response(int(status))
    handler.send_header("content-type", content_type)
    handler.send_header("content-length", str(len(body)))
    handler.send_header("cache-control", "no-store")
    if handler.command == "POST":
        handler.send_header("connection", "close")
    handler.end_headers()
    handler.wfile.write(body)


def _json(handler: BaseHTTPRequestHandler, status: HTTPStatus, payload: dict[str, str]) -> None:
    _send(handler, status, json.dumps(payload, separators=(",", ":")).encode(), "application/json")


class CodexUsageRelay(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:
        self.close_connection = True
        if self.path != "/codex/responses":
            _json(self, HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        relay_token = os.environ.get("RELAY_TOKEN", "")
        if not relay_token or self.headers.get("x-relay-token") != relay_token:
            _json(self, HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        authorization = self.headers.get("authorization", "")
        if not authorization.startswith("Bearer ") or not authorization[7:].strip():
            _json(self, HTTPStatus.UNAUTHORIZED, {"error": "missing_openai_token"})
            return
        lengths = self.headers.get_all("content-length", [])
        if self.headers.get_all("transfer-encoding"):
            _json(self, HTTPStatus.BAD_REQUEST, {"error": "unsupported_transfer_encoding"})
            return
        if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
            _json(self, HTTPStatus.BAD_REQUEST, {"error": "invalid_content_length"})
            return
        digits = lengths[0].lstrip("0") or "0"
        if len(digits) > 5 or int(digits) > CODEX_REQUEST_LIMIT:
            _json(self, HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "request_too_large"})
            return
        length = int(digits)
        self.connection.settimeout(CODEX_TIMEOUT_SECONDS)
        try:
            body = self.rfile.read(length)
        except (TimeoutError, OSError):
            _json(self, HTTPStatus.REQUEST_TIMEOUT, {"error": "request_read_failed"})
            return
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeError, RecursionError):
            _json(self, HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
            return
        if (len(body) != length or not isinstance(payload, dict)
                or not isinstance(payload.get("model"), str)
                or not isinstance(payload.get("input"), list)):
            _json(self, HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
            return
        headers = {
            "Authorization": authorization,
            "User-Agent": "codex-cli",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "originator": "codex_cli_rs",
        }
        account_id = self.headers.get("chatgpt-account-id")
        if account_id is not None:
            headers["chatgpt-account-id"] = account_id
        request = Request(CODEX_RESPONSES_URL, data=body, headers=headers, method="POST")
        try:
            try:
                response = build_opener(NoRedirect()).open(request, timeout=CODEX_TIMEOUT_SECONDS)
            except HTTPError as error:
                response = error
            with response:
                response_body = response.read(CODEX_RESPONSE_LIMIT + 1)
                text_chars = reasoning_chars = events = 0
                for line in response_body.splitlines():
                    if not line.startswith(b"data: "):
                        continue
                    try:
                        item = json.loads(line[6:])
                    except (ValueError, UnicodeError, RecursionError):
                        continue
                    if not isinstance(item, dict):
                        continue
                    events += 1
                    delta = item.get("delta")
                    if isinstance(delta, str):
                        if item.get("type") == "response.output_text.delta":
                            text_chars += len(delta)
                        elif item.get("type") in ("response.reasoning_summary_text.delta", "response.reasoning_text.delta"):
                            reasoning_chars += len(delta)
                print(json.dumps({"event": "codex_response", "status": response.code, "bytes": len(response_body),
                                  "events": events, "text_chars": text_chars, "reasoning_chars": reasoning_chars}), flush=True)
                if len(response_body) > CODEX_RESPONSE_LIMIT:
                    _json(self, HTTPStatus.BAD_GATEWAY, {"error": "response_too_large"})
                    return
                self.send_response(response.code)
                self.send_header("content-type", response.headers.get("content-type", "text/plain"))
                self.send_header("content-length", str(len(response_body)))
                self.send_header("cache-control", "no-store")
                self.send_header("connection", "close")
                for name in ("cf-ray", "x-request-id", "request-id", "openai-request-id"):
                    value = response.headers.get(name)
                    if value is not None:
                        self.send_header(name, value)
                self.end_headers()
                self.wfile.write(response_body)
        except TimeoutError:
            _json(self, HTTPStatus.GATEWAY_TIMEOUT, {"error": "openai_timeout"})
        except (URLError, OSError, HTTPException):
            _json(self, HTTPStatus.BAD_GATEWAY, {"error": "openai_unreachable"})

    def do_GET(self) -> None:
        if self.path == "/health":
            _json(self, HTTPStatus.OK, {"ready": "true"})
            return
        if self.path not in ("/wham/usage", "/krill/subscription"):
            _json(self, HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return

        relay_token = os.environ.get("RELAY_TOKEN", "")
        if relay_token == "" or self.headers.get("x-relay-token") != relay_token:
            _json(self, HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return

        provider = "krill" if self.path == "/krill/subscription" else "openai"
        authorization = self.headers.get("authorization", "")
        if not authorization.startswith("Bearer "):
            _json(self, HTTPStatus.UNAUTHORIZED, {"error": f"missing_{provider}_token"})
            return

        request = Request(
            KRILL_SUBSCRIPTION_URL
            if provider == "krill"
            else os.environ.get("OPENAI_USAGE_URL", OPENAI_USAGE_URL),
            headers={"Authorization": authorization, "User-Agent": "codex-cli"},
            method="GET",
        )
        try:
            with urlopen(request, timeout=UPSTREAM_TIMEOUT_SECONDS) as response:
                body = response.read()
                content_type = response.headers.get("content-type", "application/json")
                _send(self, response.status, body, content_type)
        except HTTPError as error:
            _send(self, error.code, error.read(), error.headers.get("content-type", "text/plain"))
        except URLError:
            _json(self, HTTPStatus.BAD_GATEWAY, {"error": f"{provider}_unreachable"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    ThreadingHTTPServer(("0.0.0.0", port), CodexUsageRelay).serve_forever()
