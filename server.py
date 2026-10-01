#!/usr/bin/env python3
"""Roblox Alt Checker - standalone web server (local, Render, Docker, any VPS).

Serves the static site in docs/ and the /api/* routes from checker.py.
Set PORT to change the port (default 8080). See checker.py for the other
environment variables.

Accounts, plans and ads belong to the hosted version (Supabase + Stripe). Run
this way, with docs/assets/config.js left blank, every feature is unlocked.
"""
import json
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import checker  # noqa: E402

PORT = int(os.environ.get("PORT", "8080"))
PUBLIC_DIR = Path(__file__).resolve().parent / "docs"
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "RobloxAltChecker/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.client_ip(), fmt % args))

    def client_ip(self):
        fwd = self.headers.get("X-Forwarded-For")
        return fwd.split(",")[0].strip() if fwd else self.client_address[0]

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, ctype):
        try:
            body = path.read_bytes()
        except OSError:
            return self.send_json(404, {"error": "not found"})
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/"):
            status, payload = checker.handle_api(parsed.path, parsed.query, self.client_ip())
            return self.send_json(status, payload)
        # Everything else is a file under docs/; "/" is index.html.
        rel = urllib.parse.unquote(parsed.path).lstrip("/") or "index.html"
        target = (PUBLIC_DIR / rel).resolve()
        ctype = CONTENT_TYPES.get(target.suffix)
        if ctype and target.is_relative_to(PUBLIC_DIR) and target.is_file():
            return self.send_file(target, ctype)
        return self.send_json(404, {"error": "not found"})


def main():
    if not (PUBLIC_DIR / "index.html").exists():
        sys.exit(f"docs/index.html not found next to {__file__}")
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Roblox Alt Checker listening on http://0.0.0.0:{PORT}  "
          f"(badge check: {'on' if checker.ROBLOX_COOKIE else 'off - set ROBLOX_COOKIE to enable'})",
          flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
