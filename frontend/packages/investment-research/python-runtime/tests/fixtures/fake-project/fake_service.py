import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import TCPServer


def argument(name: str) -> str:
    index = sys.argv.index(name)
    return sys.argv[index + 1]


MODULE = sys.argv[1]
PORT = int(argument("--port"))
SERVICE = {
    "adapter.app:app": "trading-core",
    "market_watch.app:app": "market-watch",
    "industry_chain.app:app": "industry-chain",
}[MODULE]


class Handler(BaseHTTPRequestHandler):
    def send_json(self, payload: object) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path == "/health":
            if SERVICE == "trading-core":
                self.send_json({
                    "service": SERVICE,
                    "status": "ok",
                    "runners": {"stock": "fake", "holdings": "fake", "brief": "fake"},
                    "env": os.environ.get("FAKE_ENV_MARKER"),
                })
            else:
                self.send_json({"service": SERVICE, "ok": True, "port": PORT, "ts": 0})
            return
        if self.path == "/watchlist":
            if SERVICE == "trading-core":
                self.send_json({"tickers": ["AAPL"]})
            else:
                self.send_json({
                    "items": [{"code": "000001", "name": "平安银行"}],
                    "count": 1,
                })
            return
        self.send_json({"service": SERVICE, "path": self.path})

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length) if length else b"{}"
        try:
            request = json.loads(body)
        except json.JSONDecodeError:
            request = {}
        self.send_json({"service": SERVICE, "path": self.path, "request": request})

    def log_message(self, _format: str, *_args: object) -> None:
        return


class LoopbackHTTPServer(ThreadingHTTPServer):
    def server_bind(self) -> None:
        TCPServer.server_bind(self)
        self.server_name = str(self.server_address[0])
        self.server_port = int(self.server_address[1])


def run() -> None:
    server = LoopbackHTTPServer((argument("--host"), PORT), Handler)
    print(f"fake uvicorn ready service={SERVICE} port={PORT}", flush=True)
    server.serve_forever()
