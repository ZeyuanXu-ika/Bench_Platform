"""Serve only the public web app on localhost; no upload endpoint."""
import argparse
import socket
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = {"/", "/index.html", "/styles.css", "/graph-ui.css", "/evidence-editor.css", "/app.mjs", "/core.mjs", "/graph.mjs", "/graph-view.mjs", "/subject-lineage.mjs", "/evidence-fact.mjs", "/evidence-editor.mjs", "/graph-ui.mjs", "/annotation-timeline.mjs", "/material-scope.mjs", "/material-results.mjs", "/gt-import.mjs", "/gt-export.mjs", "/storage.mjs", "/sw.js", "/favicon.svg", "/README.md", "/samples/demo-task.zip", "/samples/demo-graph.json"}


class PreviewServer(ThreadingHTTPServer):
    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.allow_reuse_address = False
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def existing_preview(port):
    """Return whether the listener can serve the current application's modules."""
    base = f"http://127.0.0.1:{port}"
    try:
        with urlopen(Request(base + "/", method="HEAD"), timeout=2) as response:
            if response.headers.get("X-Bench-Platform") != "local-preview":
                return False, []
    except OSError:
        return False, []
    unavailable = []
    for path in sorted(PUBLIC):
        if not path.endswith(".mjs"):
            continue
        try:
            with urlopen(Request(base + path, method="HEAD"), timeout=2) as response:
                if (response.headers.get("X-Bench-Platform") != "local-preview"
                        or response.headers.get_content_type() not in {"text/javascript", "application/javascript"}):
                    unavailable.append(path)
        except OSError:
            unavailable.append(path)
    return True, unavailable


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
        server = PreviewServer(("127.0.0.1", args.port), partial(Handler, directory=str(ROOT)))
    except OSError:
        if args.open:
            is_preview, unavailable = existing_preview(args.port)
            if is_preview:
                if unavailable:
                    missing = ", ".join(unavailable)
                    parser.exit(1, f"端口 {args.port} 的标注预览缺少当前模块（{missing}）。请关闭旧预览窗口，再运行启动脚本。\n")
                webbrowser.open(f"http://127.0.0.1:{args.port}/")
                raise SystemExit(0)
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
