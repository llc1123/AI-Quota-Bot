from __future__ import annotations

import json
import os
import threading
import unittest
from contextlib import closing, contextmanager
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.request import build_opener

import codex_usage_relay as relay


@contextmanager
def serving(handler):
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
        thread.start()
        try:
            yield server.server_address
        finally:
            server.shutdown()
            thread.join(timeout=5)


class RelayHTTPTests(unittest.TestCase):
    def setUp(self) -> None:
        self.calls = []
        self.status = 200
        self.response_body = b'event: response.completed\r\ndata: {"ok":true}\r\n\r\ndata: [DONE]\n\n'
        self.content_type = "text/event-stream; charset=utf-8"
        self.drop = False
        test = self

        class Upstream(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers.get("content-length", "0")))
                test.calls.append((self.command, self.path, self.headers, body))
                if test.drop:
                    self.close_connection = True
                    return
                self.send_response(test.status)
                self.send_header("content-type", test.content_type)
                self.send_header("content-length", str(len(test.response_body)))
                self.send_header("cf-ray", "local-ray")
                self.send_header("x-request-id", "local-request")
                self.send_header("request-id", "local-request-alternate")
                self.send_header("location", "/credential-sink")
                self.send_header("set-cookie", "must-not-forward=true")
                self.end_headers()
                self.wfile.write(test.response_body)

            do_GET = do_POST

            def log_message(self, format: str, *args) -> None:
                return

        self.upstream = self.enterContext(serving(Upstream))
        self.upstream_url = f"http://{self.upstream[0]}:{self.upstream[1]}"
        self.address = self.enterContext(serving(relay.CodexUsageRelay))
        self.enterContext(patch.dict(os.environ, {"RELAY_TOKEN": "relay-secret"}))
        self.enterContext(patch.object(relay, "CODEX_RESPONSES_URL", self.upstream_url + "/responses"))
        self.body = b'{"model":"test-model","input":[],"instructions":"","stream":true,"store":false,"reasoning":{"effort":"low"}}'
        self.headers = {"X-Relay-Token": "relay-secret", "Authorization": "Bearer provider-secret"}

    def request(self, body: bytes | None = None, *, path="/codex/responses", headers=None, method="POST"):
        body = self.body if body is None else body
        headers = self.headers if headers is None else headers
        with closing(HTTPConnection(*self.address, timeout=5)) as connection:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, response.headers, response.read(), response.will_close

    def test_forwards_exact_body_allowlisted_headers_and_sse(self) -> None:
        self.headers.update({"chatgpt-account-id": "account-123", "Cookie": "secret-cookie",
                             "User-Agent": "untrusted", "originator": "untrusted",
                             "Accept": "text/html", "Content-Type": "text/plain"})
        status, headers, body, closes = self.request()
        self.assertEqual((status, body, closes), (200, self.response_body, True))
        self.assertEqual(headers["content-type"], self.content_type)
        self.assertEqual(headers["cf-ray"], "local-ray")
        self.assertEqual(headers["x-request-id"], "local-request")
        self.assertEqual(headers["request-id"], "local-request-alternate")
        self.assertIsNone(headers.get("set-cookie"))
        self.assertEqual(len(self.calls), 1)
        method, path, sent, payload = self.calls[0]
        self.assertEqual((method, path, payload), ("POST", "/responses", self.body))
        self.assertEqual(sent["Authorization"], "Bearer provider-secret")
        self.assertEqual(sent["User-Agent"], "codex-cli")
        self.assertEqual(sent["Content-Type"], "application/json")
        self.assertEqual(sent["Accept"], "text/event-stream")
        self.assertEqual(sent["originator"], "codex_cli_rs")
        self.assertEqual(sent["chatgpt-account-id"], "account-123")
        self.assertIsNone(sent.get("X-Relay-Token"))
        self.assertIsNone(sent.get("Cookie"))

    def test_complete_fingerprint_stream_larger_than_256_kib_is_preserved(self) -> None:
        text = ", ".join(str(index) for index in range(332))
        self.response_body = b"".join(
            ("data: " + json.dumps({"type": "response.output_text.delta",
             "item_id": "msg_" + "a" * 64, "output_index": 0, "content_index": 0,
             "sequence_number": index, "delta": char}) + "\n\n").encode()
            for index, char in enumerate(text)
        ) + b'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'
        self.assertGreater(len(self.response_body), 262144)
        status, _, received, _ = self.request()
        self.assertEqual((status, received), (200, self.response_body))

    def test_rejects_missing_or_wrong_credentials(self) -> None:
        for headers in ({}, {"X-Relay-Token": "wrong"},
                        {"X-Relay-Token": "relay-secret"},
                        {**self.headers, "Authorization": "Basic secret"},
                        {**self.headers, "Authorization": "Bearer "}):
            with self.subTest(headers=headers):
                self.assertEqual(self.request(headers=headers)[0], 401)
        with patch.dict(os.environ, {"RELAY_TOKEN": ""}):
            self.assertEqual(self.request(headers={**self.headers, "X-Relay-Token": ""})[0], 401)
        self.assertEqual(self.calls, [])

    def test_rejects_other_paths_and_query(self) -> None:
        for path in ("/codex/responses?url=http://evil", "/codex/responses/", "/other"):
            with self.subTest(path=path):
                self.assertEqual(self.request(path=path)[0], 404)
        self.assertEqual(self.calls, [])

    def test_rejects_invalid_framing_and_closes_without_consuming_body(self) -> None:
        cases = [([], 400), ([("Content-Length", "bad")], 400),
                 ([("Content-Length", "-1")], 400), ([("Content-Length", "+2")], 400),
                 ([("Content-Length", "1.0")], 400),
                 ([("Content-Length", "2"), ("Content-Length", "2")], 400),
                 ([("Content-Length", "32769")], 413),
                 ([("Content-Length", "9" * 5000)], 413),
                 ([("Transfer-Encoding", "chunked")], 400),
                 ([("Transfer-Encoding", "identity"), ("Content-Length", "2")], 400)]
        for framing, expected in cases:
            with self.subTest(framing=framing), closing(HTTPConnection(*self.address, timeout=5)) as connection:
                connection.putrequest("POST", "/codex/responses")
                for name, value in [*self.headers.items(), *framing]:
                    connection.putheader(name, value)
                connection.endheaders()
                response = connection.getresponse()
                self.assertEqual(response.status, expected)
                response.read()
                self.assertTrue(response.will_close)
        self.assertEqual(self.calls, [])

    def test_rejects_invalid_json_or_shape(self) -> None:
        for body in (b"", b"{", b"\xff", b"[]", b"null", b'{}',
                     b'{"model":3,"input":[]}', b'{"model":"m","input":{}}'):
            with self.subTest(body=body):
                self.assertEqual(self.request(body)[0], 400)
        self.assertEqual(self.calls, [])

    def test_request_exact_limit_and_response_exact_limit_are_preserved(self) -> None:
        body = self.body + b" " * (32768 - len(self.body))
        self.response_body = b"x" * 2097152
        status, _, received, _ = self.request(body)
        self.assertEqual((status, received), (200, self.response_body))
        self.assertEqual(self.calls[0][3], body)
        self.assertIsNone(self.calls[0][2].get("chatgpt-account-id"))

    def test_oversized_upstream_success_and_error_are_bounded(self) -> None:
        self.response_body = b"x" * 2097153
        for self.status in (200, 403):
            with self.subTest(status=self.status):
                status, _, body, _ = self.request()
                self.assertEqual((status, json.loads(body)), (502, {"error": "response_too_large"}))
        self.assertEqual(len(self.calls), 2)

    def test_upstream_error_preserves_body_status_and_diagnostics(self) -> None:
        self.status, self.response_body, self.content_type = 403, b"<html>blocked</html>", "text/html"
        status, headers, body, _ = self.request()
        self.assertEqual((status, body, headers["content-type"]), (403, self.response_body, "text/html"))
        self.assertEqual(headers["cf-ray"], "local-ray")
        self.assertEqual(len(self.calls), 1)

    def test_redirects_are_returned_without_following_or_resending(self) -> None:
        for self.status in (301, 302, 303, 307, 308):
            with self.subTest(status=self.status):
                status, headers, body, _ = self.request()
                self.assertEqual((status, body), (self.status, self.response_body))
                self.assertIsNone(headers.get("location"))
        self.assertEqual([call[1] for call in self.calls], ["/responses"] * 5)

    def test_disconnected_upstream_returns_safe_error_without_retry(self) -> None:
        self.drop = True
        status, _, body, _ = self.request()
        self.assertEqual((status, json.loads(body)), (502, {"error": "openai_unreachable"}))
        self.assertEqual(len(self.calls), 1)

    def test_url_error_and_timeout_return_safe_errors(self) -> None:
        from urllib.error import URLError

        for error, expected in ((URLError("provider-secret"), 502), (TimeoutError("provider-secret"), 504)):
            with self.subTest(error=type(error).__name__):
                opener = build_opener(relay.NoRedirect())
                with patch.object(opener, "open", side_effect=error) as opened, patch.object(relay, "build_opener", return_value=opener):
                    status, _, body, _ = self.request()
                self.assertEqual(status, expected)
                self.assertNotIn(b"provider-secret", body)
                self.assertEqual(opened.call_args.kwargs["timeout"], 240)
                self.assertEqual(opened.call_count, 1)

    def test_existing_get_routes_and_auth(self) -> None:
        self.response_body, self.content_type = b'{"quota":42}', "application/json"
        with patch.dict(os.environ, {"OPENAI_USAGE_URL": self.upstream_url + "/usage"}), patch.object(relay, "KRILL_SUBSCRIPTION_URL", self.upstream_url + "/subscription"):
            for path, upstream_path in (("/wham/usage", "/usage"), ("/krill/subscription", "/subscription")):
                with self.subTest(path=path):
                    self.assertEqual(self.request(path=path, method="GET", body=b"", headers={})[0], 401)
                    self.assertEqual(self.request(path=path, method="GET", body=b"", headers={"X-Relay-Token": "relay-secret"})[0], 401)
                    status, headers, body, _ = self.request(path=path, method="GET", body=b"")
                    self.assertEqual((status, headers["content-type"], body), (200, "application/json", self.response_body))
                    self.assertEqual(self.calls[-1][:2], ("GET", upstream_path))
                    self.assertEqual(self.calls[-1][2]["Authorization"], "Bearer provider-secret")
                    self.assertIsNone(self.calls[-1][2].get("X-Relay-Token"))
        self.assertEqual(json.loads(self.request(path="/health", method="GET", body=b"", headers={})[2]), {"ready": "true"})
        self.assertEqual(self.request(path="/unknown", method="GET", body=b"")[0], 404)


if __name__ == "__main__":
    unittest.main()
