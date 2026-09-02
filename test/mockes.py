"""A stand-in Elasticsearch serving both document shapes.

`logs-*` can hold ECS documents (Beats, Elastic Agent) and OTLP-native ones
(anything arriving at Elastic's OTLP endpoint, which is how the OpenTelemetry
demo ships). A client can have both at once. These are the two shapes as they
actually appear, so the source can be exercised without a cluster.
"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 9299

# ECS — what Elastic Agent and the Elasticsearch exporter write.
ECS_DOC = {
    "@timestamp": "2026-09-02T10:00:00.000Z",
    "service.name": "payment",
    "service.environment": "production",
    "service.version": "2.1.0",
    "log.level": "error",
    "error.type": "PaymentDeclined",
    "error.message": "card issuer declined the charge",
    "error.stack_trace": (
        "PaymentDeclined: card issuer declined the charge\n"
        "    at charge (/app/src/payment/charge.js:88:11)\n"
        "    at handler (/app/src/payment/index.js:34:5)"
    ),
    "trace.id": "ecs0000000000000000000000000001",
}

# OTLP-native — nested resource attributes, OTel semantic conventions,
# severity_text instead of log.level, trace_id instead of trace.id.
OTEL_DOC = {
    "@timestamp": "2026-09-02T10:05:00.000Z",
    "severity_text": "ERROR",
    "severity_number": 17,
    "resource": {
        "attributes": {
            "service": {"name": "cartservice", "version": "1.4.2"},
            "deployment": {"environment": "production"},
        }
    },
    "attributes": {
        "exception": {
            "type": "RedisConnectionException",
            "message": "It was not possible to connect to the redis server(s)",
            # Real .NET format: the file follows " in ", and the line is
            # spelled "line N". The demo's cartservice is C#.
            "stacktrace": (
                "StackExchange.Redis.RedisConnectionException: It was not possible to connect\n"
                "   at cartservice.cartstore.RedisCartStore.GetCartAsync(String userId)"
                " in /app/src/cartstore/RedisCartStore.cs:line 112\n"
                "   at cartservice.services.CartService.GetCart(GetCartRequest request)"
                " in /app/src/services/CartService.cs:line 60"
            ),
        }
    },
    "body": {"text": "failed to get cart"},
    "trace_id": "otel0000000000000000000000000002",
}

# FATAL by severity_number alone — no textual level at all.
OTEL_FATAL = {
    "@timestamp": "2026-09-02T10:06:00.000Z",
    "severity_number": 21,
    "resource": {"attributes": {"service": {"name": "checkout"}}},
    "attributes": {
        "exception": {
            "type": "OutOfMemoryError",
            "message": "Java heap space",
            "stacktrace": "OutOfMemoryError: Java heap space\n\tat checkout.Main.run(Main.java:40)",
        }
    },
    "trace_id": "otel0000000000000000000000000003",
}

DOCS = [ECS_DOC, OTEL_DOC, OTEL_FATAL]


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

    def do_GET(self):
        # What /admin/verify probes.
        if self.path.startswith("/_cluster/health"):
            return self._send(200, {"status": "green", "cluster_name": "mock"})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/logs-"):
            return self._send(404, {"error": "no such index"})
        if not self.headers.get("authorization", "").startswith("ApiKey "):
            return self._send(401, {"error": "missing api key"})

        length = int(self.headers.get("content-length", 0))
        query = json.loads(self.rfile.read(length) or b"{}")

        # Honour the cursor the way a real cluster would, so replay is exercised.
        after = None
        for clause in (query.get("query", {}).get("bool", {}).get("filter") or []):
            rng = clause.get("range", {}).get("@timestamp", {})
            if "gt" in rng:
                after = rng["gt"]
        hits = [d for d in DOCS if after is None or d["@timestamp"] > after]

        self._send(200, {
            "hits": {
                "hits": [
                    {"_id": f"mock-{i}", "_source": d}
                    for i, d in enumerate(sorted(hits, key=lambda x: x["@timestamp"]))
                ]
            }
        })


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
