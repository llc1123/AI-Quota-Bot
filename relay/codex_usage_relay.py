from __future__ import annotations

import json
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Final
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

OPENAI_USAGE_URL: Final = "https://chatgpt.com/backend-api/wham/usage"
UPSTREAM_TIMEOUT_SECONDS: Final = 30


def _send(handler: BaseHTTPRequestHandler, status: HTTPStatus | int, body: bytes, content_type: str) -> None:
    handler.send_response(int(status))
    handler.send_header("content-type", content_type)
    handler.send_header("content-length", str(len(body)))
    handler.send_header("cache-control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def _json(handler: BaseHTTPRequestHandler, status: HTTPStatus, payload: dict[str, str]) -> None:
    _send(handler, status, json.dumps(payload, separators=(",", ":")).encode(), "application/json")


class CodexUsageRelay(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        if self.path == "/health":
            _json(self, HTTPStatus.OK, {"ready": "true"})
            return
        if self.path != "/wham/usage":
            _json(self, HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return

        relay_token = os.environ.get("RELAY_TOKEN", "")
        if relay_token == "" or self.headers.get("x-relay-token") != relay_token:
            _json(self, HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return

        authorization = self.headers.get("authorization", "")
        if not authorization.startswith("Bearer "):
            _json(self, HTTPStatus.UNAUTHORIZED, {"error": "missing_openai_token"})
            return

        request = Request(
            os.environ.get("OPENAI_USAGE_URL", OPENAI_USAGE_URL),
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
            _json(self, HTTPStatus.BAD_GATEWAY, {"error": "openai_unreachable"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    ThreadingHTTPServer(("0.0.0.0", port), CodexUsageRelay).serve_forever()
