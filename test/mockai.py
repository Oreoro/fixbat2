"""A stand-in OpenAI-compatible server.

Lets test/diagnosers.py exercise the real code path — request shape, JSON
extraction, schema fallback, pricing — without a paid key. Behaviour is chosen
by the requested model id, and each case reproduces something a real provider
actually returned.
"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 8899

BRIEF = {
    "summary": "Order confirmation throws on every promoted cart.",
    "suspected_cause": "applyPromotion reads .total before the summary is built.",
    "what_changed": "45091cc reordered promotion handling ahead of tax.",
    "open_questions": ["Does buildOrderSummary set total first?",
                       "Do carts without a promotion pass?"],
    "cited_file": "src/checkout/pricing.ts",
    "cited_line": 142,
    # deadbee is deliberately not among the commits supplied as evidence.
    "cited_commits": ["45091cc", "deadbee"],
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _completion(self, content, prompt=2400, completion=600, finish="stop"):
        self._send(200, {
            "choices": [{"finish_reason": finish, "message": {"content": content}}],
            "usage": {"prompt_tokens": prompt, "completion_tokens": completion},
        })

    def do_GET(self):
        if self.path.endswith("/models"):
            return self._send(200, {"data": [{"id": "mock-good"}, {"id": "mock-fenced"}]})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        req = json.loads(self.rfile.read(length) or b"{}")
        model = req.get("model", "")
        strict = (req.get("response_format") or {}).get("type") == "json_schema"

        if not self.headers.get("authorization", "").startswith("Bearer "):
            return self._send(401, {"error": {"message": "missing key"}})

        # An endpoint that does not implement json_schema, as many do not.
        if model == "mock-no-schema" and strict:
            return self._send(400, {"error": {"message": "response_format json_schema unsupported"}})

        if model == "mock-truncated":
            return self._completion("{", completion=4000, finish="length")

        if model == "mock-prose-citation":
            # What glm-5.3-flash returned: a sentence where a path belongs.
            brief = dict(BRIEF)
            brief["cited_file"] = ("app/src/payments/idempotency.ts:33 (cacheIdempotencyKey), "
                                  "called from src/routes/charges.ts:52")
            brief["cited_line"] = None
            return self._completion(json.dumps(brief))

        if model == "mock-basename-citation":
            # Also real: the basename alone, with no directory.
            brief = dict(BRIEF)
            brief["cited_file"] = "pricing.ts"
            return self._completion(json.dumps(brief))

        content = json.dumps(BRIEF)
        if model == "mock-fenced":
            content = "Here you go:\n```json\n" + content + "\n```"
        self._completion(content)


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
