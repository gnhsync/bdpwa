#!/usr/bin/env python3
"""
Development server for Bugs & Drugs PWA.

Adds Cache-Control: no-cache so the service worker always fetches a fresh
sw.js and version.json during local testing. Suppresses BrokenPipeError
noise from browsers closing connections early.

Usage:
    python serve.py [port]   (default: 8081)
"""
import sys
import socket
from http.server import HTTPServer, SimpleHTTPRequestHandler

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8081


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Only Cache-Control to prevent stale SW/JS/CSS during development.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if len(args) > 1 and args[1] in ("304", "206"):
            return  # suppress noisy partial-content and not-modified logs
        super().log_message(fmt, *args)

    def handle_error(self, request, client_address):
        # Suppress BrokenPipeError — browsers routinely close connections early
        # (prefetch, speculative loading). Without this the server prints a
        # traceback and looks like it crashed.
        pass

    # Override to swallow BrokenPipeError at the socket level too
    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError):
            pass


print(f"Serving Bugs & Drugs PWA on http://localhost:{PORT}")
print(f"  Root: {__import__('os').getcwd()}")
print(f"  Press Ctrl-C to stop\n")

server = HTTPServer(("", PORT), Handler)
try:
    server.serve_forever()
except KeyboardInterrupt:
    print("\nServer stopped.")
