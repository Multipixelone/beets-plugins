"""Serve packaged graph assets and one explicitly selected JSON file on localhost."""

import argparse
import hashlib
import json
import os
import re
import signal
import stat
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from text_query import QueryError, TextQuery

COVER_PATH = re.compile(r"/covers/cover-[0-9a-f]{64}\.jpg\Z")

ASSETS = {"/", "/index.html", "/app.js", "/worker.js", "/style.css", "/THIRD_PARTY_LICENSES.txt"}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, data=None, covers=None, **kwargs):
        self.data = data
        self.covers = covers
        super().__init__(*args, **kwargs)

    def json_response(self, status, result):
        body = json.dumps(result, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if status == 429:
            self.send_header('Retry-After', '1')
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        # Close rejected requests too: unread bodies must never become another request.
        self.close_connection = True
        try:
            if self.path != '/api/embed-text':
                raise QueryError(404, 'Unknown endpoint.')
            host = self.headers.get('Host', '')
            # An SSH tunnel may use a different local port from the backend.
            loopback = re.fullmatch(r'(?:127\.0\.0\.1|localhost)(?::([0-9]{1,5}))?', host)
            if not loopback or (loopback[1] is not None and not 1 <= int(loopback[1]) <= 65535):
                raise QueryError(403, 'Text queries require a localhost Host header.')
            origin = self.headers.get('Origin')
            if origin is not None and origin != 'http://' + host:
                raise QueryError(403, 'Cross-origin text queries are not allowed.')
            if self.headers.get('Sec-Fetch-Site') == 'cross-site':
                raise QueryError(403, 'Cross-origin text queries are not allowed.')
            if self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
                raise QueryError(415, 'Expected application/json.')
            length = self.headers.get('Content-Length', '')
            if self.headers.get('Transfer-Encoding') or not length.isdecimal():
                raise QueryError(400, 'A valid Content-Length is required.')
            if int(length) > 4096:
                raise QueryError(413, 'Text query body exceeds 4 KiB.')
            deadline = time.monotonic() + 10
            body = bytearray()
            while len(body) < int(length):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError
                self.connection.settimeout(remaining)
                part = self.rfile.read1(int(length) - len(body))
                if not part:
                    break
                body.extend(part)
            if len(body) != int(length):
                raise QueryError(400, 'Incomplete text query.')
            request = json.loads(body)
            text = request.get('q') if isinstance(request, dict) else None
            if not isinstance(text, str) or not text.strip() or len(text.strip()) > 240:
                raise QueryError(400, 'Enter a phrase of 1–240 characters.')
            if self.server.text_query is None:
                raise QueryError(503, 'Text search is unavailable on this server.')
            self.json_response(200, self.server.text_query.query(text.strip()))
        except QueryError as exc:
            self.json_response(exc.status, {'error': str(exc)})
        except (ValueError, UnicodeError, TimeoutError):
            self.json_response(400, {'error': 'Invalid JSON text query or request read timeout.'})

    def revalidated_file(self, target, content_type):
        """Hash and serve the same inode, even while exports are atomically replaced."""
        file = None
        try:
            file = target.open('rb')
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode):
                file.close()
                raise OSError('Not a regular file')
            identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
            # One entry per permitted path; no unbounded request-key cache.
            with self.server.etag_lock:
                cached = self.server.etags.get(str(target))
                if cached and cached[0] == identity:
                    etag = cached[1]
                else:
                    etag = '"' + hashlib.file_digest(file, 'sha256').hexdigest() + '"'
                    self.server.etags[str(target)] = (identity, etag)
            file.seek(0)
        except OSError:
            if file is not None:
                file.close()
            self.send_error(404, 'File is unavailable')
            return None
        requested = self.headers.get('If-None-Match', '')
        matches = any(tag.strip().removeprefix('W/') in (etag, '*') for tag in requested.split(','))
        self.send_response(304 if matches else 200)
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('ETag', etag)
        self.send_header('X-Content-Type-Options', 'nosniff')
        if not matches:
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(info.st_size))
        self.end_headers()
        if matches:
            file.close()
            return None
        return file

    def send_head(self):
        path = urlsplit(self.path).path
        if path == "/data.json" and self.data is not None:
            return self.revalidated_file(self.data, 'application/json')
        if self.covers is not None and COVER_PATH.fullmatch(path):
            try:
                # O_NOFOLLOW also protects against symlink swaps between checking and opening.
                fd = os.open(self.covers / path.rsplit("/", 1)[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                file = os.fdopen(fd, "rb")
                info = os.fstat(file.fileno())
                if not stat.S_ISREG(info.st_mode):
                    file.close()
                    raise OSError("Not a regular thumbnail")
            except OSError:
                self.send_error(404, "Cover is unavailable")
                return None
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(info.st_size))
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            return file
        if path not in ASSETS:
            self.send_error(404)
            return None
        target = Path(self.directory) / ('index.html' if path == '/' else path[1:])
        return self.revalidated_file(target, self.guess_type(str(target)))


class Server(ThreadingHTTPServer):
    def __init__(self, *args, text_query=None, **kwargs):
        self.text_query = text_query
        self.etags = {}
        self.etag_lock = threading.Lock()
        super().__init__(*args, **kwargs)

    def server_close(self):
        if self.text_query is not None:
            self.text_query.close()
        super().server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, help="export JSON to load automatically")
    parser.add_argument("--covers", type=Path, help="exporter thumbnail cache directory")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--assets", type=Path, default=Path(__file__).with_name("dist"))
    parser.add_argument("--cache-dir", type=Path, help="offline text encoder cache directory")
    parser.add_argument("--text-worker", type=Path, help="packaged CPU embedding worker")
    parser.add_argument("--text-idle-seconds", type=int, default=600, help="idle unload delay; 0 keeps encoder loaded")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    if args.text_idle_seconds < 0:
        parser.error("text-idle-seconds must be nonnegative")
    if args.data is not None:
        args.data = args.data.expanduser().resolve()
        if not args.data.is_file():
            parser.error("data must be an existing JSON file")
    if args.covers is not None:
        args.covers = args.covers.expanduser().resolve()
        if not args.covers.is_dir():
            parser.error("covers must be an existing thumbnail directory")
    if not (args.assets / "index.html").is_file():
        parser.error("viewer assets are missing; run npm ci and npm run build first")
    handler = partial(Handler, directory=str(args.assets.resolve()), data=args.data, covers=args.covers)
    cache = (args.cache_dir or (args.data.parent if args.data else Path.cwd()) / '.album-graph-cache').expanduser().resolve()
    query = TextQuery(args.text_worker, cache, args.text_idle_seconds)
    def stop(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    with Server(("127.0.0.1", args.port), handler, text_query=query) as server:
        suffix = "/?data=data.json" if args.data else "/"
        print(f"Album graph: http://127.0.0.1:{args.port}{suffix}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
