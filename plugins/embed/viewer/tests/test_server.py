import importlib.util
import os
import tempfile
import threading
import unittest
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location('graph_server', Path(__file__).parents[1] / 'server.py')
server_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_module)


class ServerTests(unittest.TestCase):
    def test_only_assets_and_selected_json_are_served(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            assets = root / 'assets'
            assets.mkdir()
            (assets / 'index.html').write_text('viewer')
            (assets / 'secret.txt').write_text('secret')
            for name in server_module.ASSETS - {'/', '/index.html'}:
                (assets / name[1:]).write_text('asset')
            for asset in assets.iterdir():
                os.utime(asset, (0, 0))  # Nix-store timestamp: never rely on heuristic caching.
            covers = root / 'covers'
            covers.mkdir()
            name = 'cover-' + 'a' * 64 + '.jpg'
            (covers / name).write_bytes(b'jpeg fixture')
            alias = 'cover-' + 'b' * 64 + '.jpg'
            (covers / alias).symlink_to(assets / 'secret.txt')
            data = root / 'export.json'
            data.write_text('{"albums":[]}')
            with server_module.Server(('127.0.0.1', 0), partial(server_module.Handler,
                                     directory=str(assets), data=data, covers=covers)) as server:
                thread = threading.Thread(target=server.serve_forever)
                thread.start()
                try:
                    url = f'http://127.0.0.1:{server.server_port}'
                    with urlopen(url + '/') as response:
                        self.assertEqual(response.read(), b'viewer')
                    with urlopen(url + '/data.json?test=1') as response:
                        self.assertEqual(response.read(), data.read_bytes())
                        self.assertEqual(response.headers['Content-Type'], 'application/json')
                    with urlopen(url + '/covers/' + name) as response:
                        self.assertEqual(response.read(), b'jpeg fixture')
                        self.assertEqual(response.headers['Content-Type'], 'image/jpeg')
                        self.assertEqual(response.headers['Cache-Control'], 'public, max-age=31536000, immutable')
                    for path in [*server_module.ASSETS, '/data.json']:
                        with urlopen(url + path) as response:
                            self.assertEqual(response.headers['Cache-Control'], 'no-cache')
                            etag = response.headers['ETag']
                            self.assertRegex(etag, r'^"[0-9a-f]{64}"$')
                        for condition in [etag, '"other", W/' + etag, '*']:
                            with self.assertRaises(HTTPError) as unchanged:
                                urlopen(Request(url + path, headers={'If-None-Match': condition}))
                            with unchanged.exception as response:
                                self.assertEqual(response.code, 304)
                                self.assertEqual(response.read(), b'')
                                self.assertEqual(response.headers['ETag'], etag)
                                self.assertEqual(response.headers['Cache-Control'], 'no-cache')
                        with urlopen(Request(url + path, method='HEAD', headers={'If-None-Match': '"wrong"'})) as response:
                            self.assertEqual(response.status, 200)
                            self.assertEqual(response.read(), b'')
                    old = etag  # /data.json is last.
                    replacement = root / 'new.json'
                    replacement.write_text('{"albums":[1]}')
                    replacement.replace(data)
                    with urlopen(Request(url + '/data.json', headers={'If-None-Match': old,
                                      'If-Modified-Since': 'Thu, 01 Jan 2099 00:00:00 GMT'})) as response:
                        self.assertNotEqual(response.headers['ETag'], old)
                        self.assertEqual(response.read(), data.read_bytes())
                    for path in ['/secret.txt', '/../export.json', '/%2e%2e/export.json',
                                 '/covers/', '/covers/../export.json', '/covers/%2e%2e/export.json',
                                 '/covers/..%2fexport.json', '/covers/%2f' + name, '/covers/' + alias,
                                 '/covers/' + name.replace('a', 'A'), '/covers/' + name + '/extra',
                                 '/covers/' + name.replace('.jpg', '.png'), '/covers/.album-graph-covers.json',
                                 '/covers/%63' + name[1:]]:
                        with self.assertRaises(HTTPError) as error:
                            urlopen(url + path)
                        self.assertEqual(error.exception.code, 404)
                        error.exception.close()
                finally:
                    server.shutdown()
                    thread.join()
