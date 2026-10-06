"""Serve packaged graph assets and one explicitly selected JSON file on localhost."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ASSETS = {"/", "/index.html", "/app.js", "/worker.js", "/style.css", "/THIRD_PARTY_LICENSES.txt"}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, data=None, **kwargs):
        self.data = data
        super().__init__(*args, **kwargs)

    def send_head(self):
        path = urlsplit(self.path).path
        if path == "/data.json" and self.data is not None:
            try:
                file = self.data.open("rb")
            except OSError:
                self.send_error(404, "Export is unavailable")
                return None
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(self.data.stat().st_size))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return file
        if path not in ASSETS:
            self.send_error(404)
            return None
        return super().send_head()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, help="export JSON to load automatically")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--assets", type=Path, default=Path(__file__).with_name("dist"))
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    if args.data is not None:
        args.data = args.data.expanduser().resolve()
        if not args.data.is_file():
            parser.error("data must be an existing JSON file")
    if not (args.assets / "index.html").is_file():
        parser.error("viewer assets are missing; run npm ci and npm run build first")
    handler = partial(Handler, directory=str(args.assets.resolve()), data=args.data)
    with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
        suffix = "/?data=data.json" if args.data else "/"
        print(f"Album graph: http://127.0.0.1:{args.port}{suffix}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
