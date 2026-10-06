import json
import sys
import tempfile
import threading
import time
import unittest
from functools import partial
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).parents[1]))
from text_query import QueryError, TextQuery
from test_server import server_module


class TextQueryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.worker = self.root / 'worker'
        self.worker.write_text(f'#!{sys.executable}\n' + '''import json, os, sys, time
assert sys.argv[1:] == ['serve-text', '--device', 'cpu', '--threads', '2']
assert os.environ['HF_HUB_OFFLINE'] == os.environ['TRANSFORMERS_OFFLINE'] == '1'
assert os.environ['HF_HOME'].endswith('/cache/query/hf')
for line in sys.stdin:
 q=json.loads(line)['q']
 if q == 'slow': time.sleep(10)
 if q == 'crash': sys.exit(1)
 if q == 'bad': print('{}', flush=True); continue
 print(json.dumps({'vector': [1.] + [0.] * 511, 'model_id': 'text:test'}), flush=True)
''')
        self.worker.chmod(0o700)

    def manager(self, **kwargs):
        query = TextQuery(self.worker, self.root / 'cache', **kwargs)
        self.addCleanup(query.close)
        return query

    def test_lazy_reuse_rate_and_idle_unload(self):
        query = self.manager(idle_seconds=.15)
        self.assertIsNone(query.child)
        self.assertFalse((self.root / 'cache').exists())
        self.assertEqual(len(query.query('one')['vector']), 512)
        first = query.child
        query.query('two')
        self.assertIs(query.child, first)
        with self.assertRaises(QueryError) as error:
            query.query('three')
        self.assertEqual(error.exception.status, 429)
        deadline = time.monotonic() + 2
        while query.child is not None and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertIsNone(query.child)
        self.assertIsNotNone(first.poll())
        query.requests.clear()
        query.query('reload')
        self.assertNotEqual(query.child.pid, first.pid)

    def test_timeout_concurrency_failure_and_recovery(self):
        query = self.manager(timeout=.15, idle_seconds=0)
        errors = []
        def slow():
            try:
                query.query('slow')
            except QueryError as exc:
                errors.append(exc.status)
        thread = threading.Thread(target=slow)
        thread.start()
        deadline = time.monotonic() + 2
        while query.child is None and time.monotonic() < deadline:
            time.sleep(.005)
        with self.assertRaises(QueryError) as busy:
            query.query('busy')
        self.assertEqual(busy.exception.status, 429)
        thread.join(2)
        self.assertEqual(errors, [504])
        self.assertIsNone(query.child)
        for phrase in ['crash', 'bad']:
            query.requests.clear()
            with self.assertRaises(QueryError) as unavailable:
                query.query(phrase)
            self.assertEqual(unavailable.exception.status, 503)
        query.requests.clear()
        self.assertEqual(query.query('recovered')['model_id'], 'text:test')

    def test_http_validation_and_unavailable(self):
        query = self.manager()
        with server_module.Server(('127.0.0.1', 0), partial(server_module.Handler, directory=str(self.root)),
                                  text_query=query) as server:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                base = f'http://127.0.0.1:{server.server_port}'
                def post(body, code, path='/api/embed-text', headers=None):
                    request = Request(base + path, data=body, headers=headers or {'Content-Type': 'application/json'})
                    try:
                        response = urlopen(request)
                    except HTTPError as exc:
                        response = exc
                    with response:
                        self.assertEqual(response.code, code)
                        self.assertEqual(response.headers['Cache-Control'], 'no-store')
                        return json.loads(response.read())
                result = post(b'{"q":"rainy jazz"}', 200)
                self.assertEqual(result['model_id'], 'text:test')
                post(b'{"q":"tunneled"}', 200, headers={'Content-Type': 'application/json',
                     'Host': 'localhost:12345', 'Origin': 'http://localhost:12345'})
                post(b'{"q":"too fast"}', 429)
                for value in [None, [], '', ' ', 12, 'x' * 241]:
                    post(json.dumps({'q': value}).encode(), 400)
                post(b'not json', 400)
                post(b'x' * 4097, 413)
                post(b'{}', 415, headers={'Content-Type': 'text/plain'})
                post(b'{}', 403, headers={'Content-Type': 'application/json', 'Origin': 'http://evil.test'})
                post(b'{}', 403, headers={'Content-Type': 'application/json', 'Host': 'evil.test', 'Origin': 'http://evil.test'})
                post(b'{}', 404, path='/api/other')
                query.worker = None
                post(b'{"q":"missing"}', 503)
                with self.assertRaises(HTTPError):
                    urlopen(base + '/secret')
            finally:
                server.shutdown()
                thread.join()
