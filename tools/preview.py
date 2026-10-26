"""Serve only the public web app on localhost; no upload endpoint."""
import argparse
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = {"/", "/index.html", "/styles.css", "/app.mjs", "/core.mjs", "/storage.mjs", "/sw.js", "/favicon.svg", "/README.md", "/samples/demo-task.zip"}


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript"}

    def do_GET(self):
        if unquote(urlsplit(self.path).path) not in PUBLIC:
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        if unquote(urlsplit(self.path).path) not in PUBLIC:
            self.send_error(404)
            return
        super().do_HEAD()

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Bench-Platform", "local-preview")
        super().end_headers()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--open", action="store_true", help="Open the local app in the default browser")
    args = parser.parse_args()
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, directory=str(ROOT)))
    except OSError:
        if args.open:
            try:
                with urlopen(f"http://127.0.0.1:{args.port}/", timeout=2) as response:
                    if response.headers.get("X-Bench-Platform") == "local-preview":
                        webbrowser.open(f"http://127.0.0.1:{args.port}/")
                        raise SystemExit(0)
            except OSError:
                pass
        parser.exit(1, f"Port {args.port} is unavailable. Try --port 8788.\n")
    print(f"Bench Platform: http://127.0.0.1:{args.port}", flush=True)
    if args.open:
        webbrowser.open(f"http://127.0.0.1:{args.port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
