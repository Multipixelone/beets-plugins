"""Read-only command composition with real temporary beets/Store fixtures."""

import contextlib
import copy
import importlib.util
import io
import json
import logging
from pathlib import Path
import signal
import sqlite3
import sys
from types import SimpleNamespace
import tempfile
import traceback
import unittest
from unittest.mock import patch

import beets
from beets import ui
from beets import logging as beets_logging
from beets.dbcore.db import Transaction
from beets.library import Item, Library
import confuse
import numpy as np
from beets_embed.store import Store, fingerprint, model_ids

from beets_mix import api
from beets_mix.plex import PlexClient, PlexError
import beetsplug.mix as plugin
from beetsplug.mix.worker import encode_steer


SECRET = "sentinel-config-token-host-query-stderr"


class Commands(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        config = confuse.Configuration("beets", "beets", read=False)
        config.read(user=False)
        config.set({"plex": {"host": "server.invalid", "token": SECRET},
                    "mix": {"store": str(self.root / "vectors.sqlite3")}})
        self.enterContext(patch.object(beets, "config", config))
        self.lib = Library(str(self.root / "library.db"), directory=str(self.root), set_music_dir=False)
        self.addCleanup(self.lib._close)
        self.store = self.root / "vectors.sqlite3"
        with Store(self.store) as store:
            for i, artist in ((1, "Seed"), (2, "Candidate"), (3, "Other")):
                path = self.root / f"{i}.wav"
                path.write_bytes(b"synthetic")
                self.lib.add(Item(path=bytes(path), artist=artist, title=f"Song{i}", length=180))
                for family, size in (("style", 1280), ("text", 512)):
                    vector = np.zeros(size, dtype="f4")
                    vector[0] = 1
                    store.put(i, fingerprint(path), model_ids()[family], vector, np.zeros(size))
        self.connect = self.enterContext(patch.object(PlexClient, "connect", side_effect=AssertionError("unexpected Plex")))
        self.worker = self.enterContext(patch.object(plugin, "encode_steer", side_effect=AssertionError("unexpected worker")))
        self.plugin = plugin.MixPlugin()
        self.command = self.plugin.commands()[0]
        self.stdout, self.stderr = io.StringIO(), io.StringIO()

    def run_command(self, argv, changes=None):
        opts, args = self.command.parser.parse_args(argv)
        for name, value in (changes or {}).items():
            setattr(opts, name, value)
        self.stdout, self.stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(self.stdout), contextlib.redirect_stderr(self.stderr):
            self.command.func(self.lib, opts, args)
        return self.stdout.getvalue()

    def assert_closed(self):
        self.assertFalse(self.lib._connections)
        self.assertTrue(all(not stack for stack in self.lib._tx_stacks.values()))

    def assert_safe(self, error):
        self.assertIsInstance(error, ui.UserError)
        self.assertNotIn(SECRET, "".join(traceback.format_exception(error)))
        self.assertNotIn(SECRET, str(error))
        self.assertTrue(error.__suppress_context__)
        self.assertEqual(self.stdout.getvalue(), "")
        self.assertEqual(self.stderr.getvalue(), "")

    def test_import_constructor_and_registration_are_inert(self):
        spec = importlib.util.spec_from_file_location("beetsplug.mix", plugin.__file__, submodule_search_locations=[])
        module = importlib.util.module_from_spec(spec)
        with patch.object(Library, "__init__", side_effect=AssertionError("unexpected library")), \
             patch.object(Store, "__init__", side_effect=AssertionError("unexpected Store")), \
             patch("subprocess.Popen", side_effect=AssertionError("unexpected subprocess")), \
             patch.object(beets.plugins.BeetsPlugin, "register_listener") as listener:
            spec.loader.exec_module(module)
            instance = module.MixPlugin()
            commands = instance.commands()
        self.assertEqual([c.name for c in commands], ["mix-extend", "mix-apply"])
        listener.assert_not_called()
        self.connect.assert_not_called()
        self.worker.assert_not_called()

    def test_real_query_end_to_end_store_after_close_no_writes(self):
        owner = self
        class CheckedStore(Store):
            def __init__(self, path, readonly=False):
                owner.assert_closed()
                owner.assertTrue(readonly)
                super().__init__(path, readonly=readonly)
        before = self.store.read_bytes()
        with sqlite3.connect(self.root / "library.db") as database:
            library_before = list(database.iterdump())
        database.close()
        with patch.object(api, "Store", CheckedStore), \
             patch.object(Item, "store", side_effect=AssertionError("must not store")), \
             patch.object(Transaction, "mutate", side_effect=AssertionError("must not mutate")), \
             patch.object(Transaction, "mutate_many", side_effect=AssertionError("must not mutate")), \
             patch.object(plugin, "perf_counter", side_effect=[10., 10.123]):
            payload = json.loads(self.run_command(["--cluster-threshold", ".1", "--json", "artist:Seed"]))
        self.assert_closed()
        self.assertEqual(payload["schema"], "beets-mix.proposal.v1")
        self.assertEqual([r["item_id"] for r in payload["proposal"]], [2, 3])
        self.assertEqual(payload["seed"]["source"], "query")
        self.assertEqual(payload["target"], {})
        self.assertEqual(payload["resolution"]["resolved_unique"], 1)
        self.assertEqual(payload["params"]["k"], 100)
        self.assertEqual(payload["params"]["n"], 15)
        self.assertEqual(payload["elapsed_ms"], 123.)
        self.assertEqual(before, self.store.read_bytes())
        with sqlite3.connect(self.root / "library.db") as database:
            self.assertEqual(library_before, list(database.iterdump()))
        database.close()
        self.assertEqual(self.stderr.getvalue(), "")
        self.connect.assert_not_called()
        self.worker.assert_not_called()

    def test_query_tokens_preserved_and_plex_config_never_read(self):
        original = type(beets.config).__getitem__
        def get(config, key):
            if key == "plex":
                raise AssertionError(SECRET)
            return original(config, key)
        with patch.object(type(beets.config), "__getitem__", new=get), \
             patch.object(plugin, "snapshot", wraps=plugin.snapshot) as snapshot:
            payload = json.loads(self.run_command(["--json", "--cluster-threshold", ".2", "artist:Seed", "title:Song1"]))
        self.assertEqual(snapshot.call_count, 2)
        self.assertEqual(snapshot.call_args_list[1].args[1], ["artist:Seed", "title:Song1"])
        self.assertEqual(payload["seed"]["with_vectors"], 1)
        self.connect.assert_not_called()

    def test_mix_only_persisted_history_on_nonseeds_reaches_filters_as_numbers(self):
        fields = ("plex_userrating", "plex_skipcount", "plex_viewcount")
        self.assertTrue(all(field not in Item._types for field in fields))
        second = self.lib.get_item(2)
        for field, value in zip(fields, (6.5, 3, 4)):
            second[field] = value
        second.store()
        original_get = type(beets.config).__getitem__
        def get(config, key):
            if key == "plex":
                raise AssertionError(SECRET)
            return original_get(config, key)
        real_extend = api.extend
        def engine(items, *args, **kwargs):
            self.assert_closed()
            rows = {row["id"]: row for row in items}
            self.assertEqual([rows[2][field] for field in fields], [6.5, 3, 4])
            self.assertIs(type(rows[2]["plex_userrating"]), float)
            self.assertIs(type(rows[2]["plex_skipcount"]), int)
            self.assertTrue(all(rows[1][field] == 0 for field in fields))
            return real_extend(items, *args, **kwargs)
        store_before = self.store.read_bytes()
        for third_history, reason in (((0, 3, 3), "skipped"), ((4, 0, 0), "low_rated")):
            third = self.lib.get_item(3)
            for field, value in zip(fields, third_history):
                third[field] = value
            third.store()  # Synthetic setup only, before command-owned reads.
            with self.lib.transaction() as transaction:
                raw = transaction.query("SELECT value FROM item_attributes WHERE entity_id=2 AND key IN (?,?,?)", fields)
            self.assertTrue(all(type(row["value"]) is str for row in raw))
            with contextlib.closing(sqlite3.connect(self.root / "library.db")) as database:
                before = list(database.iterdump())
            with patch.object(type(beets.config), "__getitem__", new=get), \
                 patch.object(plugin, "extend", side_effect=engine), \
                 patch.object(Transaction, "mutate", side_effect=AssertionError("no command writes")), \
                 patch.object(Transaction, "mutate_many", side_effect=AssertionError("no command writes")):
                payload = json.loads(self.run_command(["--json", "--cluster-threshold", ".1", "artist:Seed"]))
            self.assertEqual([row["item_id"] for row in payload["proposal"]], [2])
            self.assertEqual(payload["excluded_counts"][reason], 1)
            with contextlib.closing(sqlite3.connect(self.root / "library.db")) as database:
                self.assertEqual(before, list(database.iterdump()))
        self.assertEqual(self.store.read_bytes(), store_before)
        self.connect.assert_not_called()
        self.worker.assert_not_called()

    def prepared_loggers(self):
        """Pre-bound handlers on both supported, distinct logger managers."""
        beets.config["verbose"].set(3)
        std = logging.getLogger("mix-remediation-standard")
        native = beets_logging.getLogger("beets")  # Native query parser's logger.
        self.assertIsNot(std.manager, native.manager)
        streams = (io.StringIO(), io.StringIO())
        for logger, stream in zip((std, native), streams):
            handlers, level, propagate, disabled = logger.handlers[:], logger.level, logger.propagate, logger.disabled
            manager_disable = logger.manager.disable
            handler = logging.StreamHandler(stream)
            def restore(logger=logger, handlers=handlers, level=level, propagate=propagate,
                        disabled=disabled, manager_disable=manager_disable, handler=handler):
                logger.handlers[:] = handlers
                logger.setLevel(level)
                logger.propagate, logger.disabled = propagate, disabled
                logger.manager.disable = manager_disable
                handler.close()
            self.addCleanup(restore)
            logger.handlers[:] = [handler]
            logger.setLevel(logging.DEBUG)
            logger.disabled, logger.propagate = False, False
            logger.manager.disable = 0
            logger._cache.clear()
        return std, native, streams

    def logging_state(self, std, native):
        return (logging.Logger.handle, beets_logging.BeetsLogger.handle,
                std.manager.disable, native.manager.disable, std.level, native.level,
                tuple(std.handlers), tuple(native.handlers), std.propagate, native.propagate,
                std.disabled, native.disabled, sys.stdout, sys.stderr)

    def emit_logs(self, std, native, message=SECRET):
        std.debug(message)
        std.warning(message)
        std.error(message)
        native.debug(message)
        native.warning(message)
        native.error(message)
        native.extra_debug(message)  # Bypasses the manager's isEnabledFor gate.
        native._log(logging.ERROR, message, ())

    def test_prebound_standard_and_native_logs_suppressed_on_command_success_and_failure(self):
        std, native, streams = self.prepared_loggers()
        real_snapshot, real_extend = plugin.snapshot, plugin.extend
        state = self.logging_state(std, native)
        query = "artist::Seed|" + SECRET  # Real native parsing logs this regex.
        for boundary, fails in (("snapshot", False), ("snapshot", True), ("extend", False), ("extend", True)):
            real = real_snapshot if boundary == "snapshot" else real_extend
            def noisy(*args, **kwargs):
                self.emit_logs(std, native)
                print(SECRET)
                print(SECRET, file=sys.stderr)
                if fails:
                    raise RuntimeError(SECRET)
                return real(*args, **kwargs)
            with self.subTest(boundary=boundary, fails=fails), patch.object(plugin, boundary, side_effect=noisy):
                if fails:
                    with self.assertRaises(ui.UserError) as raised:
                        self.run_command(["--json", "--cluster-threshold", ".1", query])
                    self.assert_safe(raised.exception)
                else:
                    payload = json.loads(self.run_command(["--json", "--cluster-threshold", ".1", query]))
                    self.assertEqual(payload["seed"]["resolved"], 1)
                    self.assertNotIn(SECRET, self.stdout.getvalue())
                    self.assertEqual(self.stderr.getvalue(), "")
            self.assertEqual([s.getvalue() for s in streams], ["", ""])
            self.assertEqual(self.logging_state(std, native), state)
            self.emit_logs(std, native, "emission-restored")
            self.assertTrue(all("emission-restored" in s.getvalue() for s in streams))
            for stream in streams:
                stream.seek(0)
                stream.truncate(0)

    def test_guard_restores_methods_managers_and_streams_on_baseexceptions(self):
        std, native, streams = self.prepared_loggers()
        state = self.logging_state(std, native)
        for error in (KeyboardInterrupt(), SystemExit(143)):
            with self.subTest(error=type(error)), self.assertRaises(type(error)):
                with plugin._quiet_boundaries():
                    self.assertIsNot(logging.Logger.handle, state[0])
                    self.assertIs(beets_logging.BeetsLogger.handle, logging.Logger.handle)
                    self.assertNotIsInstance(sys.stdout, io.StringIO)
                    self.assertFalse(sys.stdout.seekable())
                    self.assertEqual(sys.stdout.write(SECRET * 1000), len(SECRET) * 1000)
                    self.emit_logs(std, native)
                    raise error
            self.assertEqual(self.logging_state(std, native), state)
            self.assertEqual([s.getvalue() for s in streams], ["", ""])
            self.emit_logs(std, native, "interrupt-emission-restored")
            self.assertTrue(all("interrupt-emission-restored" in s.getvalue() for s in streams))
            for stream in streams:
                stream.seek(0)
                stream.truncate(0)

    def test_python_query_and_zero_query_resolution_are_safe(self):
        first = self.lib.get_item(1)
        first["favorite"] = "yes"
        first.store()  # Synthetic fixture setup, before the command boundary.
        payload = json.loads(self.run_command(["--json", "--cluster-threshold", ".1", "favorite:yes"]))
        self.assertEqual(payload["seed"]["resolved"], 1)
        self.assertEqual([row["item_id"] for row in payload["proposal"]], [2, 3])
        with self.assertRaises(ui.UserError) as raised:
            self.run_command(["--json", "--cluster-threshold", ".1", "favorite:no"])
        self.assert_safe(raised.exception)
        self.assert_closed()
        self.connect.assert_not_called()
        self.worker.assert_not_called()

    def test_invalid_options_rejected_before_any_io(self):
        cases = [([], {}), (["artist:Seed"], {}), (["--cluster-threshold", ".1"], {}),
                 (["--cluster-threshold", ".1", "--plex-playlist", "p", "artist:Seed"], {}),
                 (["--cluster-threshold", ".1", "--plex-playlist", " "], {})]
        base = ["--cluster-threshold", ".1", "artist:Seed"]
        for name in ("n", "k", "max_per_artist"):
            for value in (0, -1, True, 1.5):
                cases.append((base, {name: value}))
        for name in ("cluster_threshold", "steer_weight"):
            for value in (True, float("nan"), float("inf"), -1):
                cases.append((base, {name: value}))
        cases.extend((base, change) for change in ({"cluster_threshold": 2.01}, {"steer_weight": 1.01},
                     {"steer": ""}, {"steer": " "}, {"steer": True}, {"steer": "x" * 241},
                     {"store": ""}, {"fresh": 1}, {"json": 1}))
        with patch.object(plugin, "snapshot") as snapshot, patch.object(self.lib, "_close") as close, \
             patch.object(self.plugin, "_settings") as settings, patch.object(plugin, "extend") as engine:
            for argv, changes in cases:
                with self.subTest(argv=argv, changes=changes), self.assertRaises(ui.UserError):
                    self.run_command(argv, changes)
                self.assertEqual(self.stdout.getvalue(), "")
            snapshot.assert_not_called()
            settings.assert_not_called()
            close.assert_not_called()
            engine.assert_not_called()
        self.connect.assert_not_called()
        self.worker.assert_not_called()

    def test_knobs_and_steering_forwarded_only_after_library_close(self):
        self.plugin.config["worker"].set("trusted-matching-worker")
        self.plugin.config["worker_timeout"].set(9)
        vector = np.eye(1, 512, dtype="f4")[0]
        def worker(text, executable, timeout):
            self.assert_closed()
            self.assertEqual((text, executable, timeout), ("sleepier", "trusted-matching-worker", 9))
            return vector, model_ids()["text"]
        real_extend = api.extend
        def engine(*args, **kwargs):
            self.assert_closed()
            self.assertIs(kwargs["steer_vector"], vector)
            self.assertEqual(kwargs["text_model_id"], model_ids()["text"])
            return real_extend(*args, **kwargs)
        with patch.object(plugin, "encode_steer", side_effect=worker), patch.object(plugin, "extend", side_effect=engine):
            payload = json.loads(self.run_command(["--json", "--cluster-threshold", ".3", "--k", "1", "-n", "1",
                "--max-per-artist", "1", "--steer", "sleepier", "--steer-weight", "0", "--fresh",
                "--store", str(self.store), "artist:Seed"]))
        self.assertEqual(payload["models"]["text"], model_ids()["text"])
        self.assertEqual(payload["params"]["k"], 1)
        self.assertEqual(payload["params"]["n"], 1)
        self.assertEqual(payload["params"]["max_per_artist"], 1)
        self.assertTrue(payload["params"]["fresh"])
        self.assertEqual(payload["params"]["steer_weight"], 0)

    def test_missing_worker_and_bad_typed_config_fail_before_capture(self):
        cases = [("mix", "worker", "@embed-worker@"), ("mix", "worker_timeout", True),
                 ("mix", "worker_timeout", float("nan")), ("mix", "plex_timeout", 0),
                 ("plex", "port", True), ("plex", "port", 3.5), ("plex", "port", 65536),
                 ("plex", "host", 3), ("plex", "token", None)]
        for section, key, value in cases:
            self.plugin.config["worker"].set("trusted-worker")
            self.plugin.config["worker_timeout"].set(120)
            self.plugin.config["plex_timeout"].set(15)
            beets.config["plex"].set({"host": "server.invalid", "token": SECRET, "port": 32400})
            beets.config[section][key].set(value)
            with self.subTest(section=section, key=key), patch.object(plugin, "snapshot") as snapshot, \
                 self.assertRaises(ui.UserError) as raised:
                self.run_command(["--json", "--cluster-threshold", ".1", "--steer", "sleepier", "--plex-playlist", "p"])
            self.assert_safe(raised.exception)
            snapshot.assert_not_called()
        self.connect.assert_not_called()
        self.worker.assert_not_called()

    def plex_fixture(self):
        rows = plugin.snapshot(self.lib)
        rows[0]["plex_ratingkey"], rows[1]["plex_ratingkey"], rows[2]["plex_ratingkey"] = "10", "20", "77"
        extra = copy.deepcopy(rows[2])
        extra["id"], extra["plex_ratingkey"] = 4, "077"  # Collision not in selected playlist.
        other = copy.deepcopy(rows[2])
        other["id"], other["plex_ratingkey"] = 5, "88"
        ambiguous = copy.deepcopy(other)
        ambiguous["id"], ambiguous["plex_ratingkey"] = 6, "088"
        rows += [extra, other, ambiguous]
        server = SimpleNamespace()
        entries = [SimpleNamespace(type="track", listType="audio", _server=server, title="entry", ratingKey=key)
                   for key in ("10", "010", "999", "88", None)]
        playlist = SimpleNamespace(title="Exact", playlistType="audio", smart=False, ratingKey="500", _server=server)
        playlist.items = lambda: entries
        lookups = []
        def playlists(**kwargs):
            self.assert_closed()
            lookups.append(kwargs)
            return [SimpleNamespace(title="Exact fuzzy"), playlist]
        server.playlists = playlists
        client = PlexClient(server)
        session = SimpleNamespace(close=lambda: self.assert_closed())
        client._session = session
        return rows, client, lookups

    def test_plex_exact_resolution_occurrences_and_global_quarantine(self):
        rows, client, lookups = self.plex_fixture()
        original = copy.deepcopy(rows)
        def connect(host, token, *, port, timeout):
            self.assert_closed()
            self.assertEqual((host, token, port, timeout), ("server.invalid", SECRET, 32400, 15))
            return client
        with patch.object(plugin, "snapshot", return_value=rows), patch.object(PlexClient, "connect", side_effect=connect), \
             patch.object(client, "close", wraps=client.close) as close:
            payload = json.loads(self.run_command(["--json", "--cluster-threshold", ".1", "--plex-playlist", "Exact"]))
        self.assertEqual(rows, original)
        self.assertEqual(lookups, [{"playlistType": "audio", "title": "Exact"}])
        close.assert_called_once()
        self.assertEqual(payload["seed"]["tracks"], 5)
        self.assertEqual(payload["seed"]["resolved"], 1)
        self.assertEqual(payload["seed"]["with_vectors"], 1)
        self.assertEqual(payload["resolution"]["resolved_occurrences"], 2)
        self.assertEqual(payload["resolution"]["duplicate_resolved_occurrences"], 1)
        self.assertEqual(payload["resolution"]["unresolved_count"], 3)
        self.assertEqual(payload["resolution"]["ambiguous_count"], 1)
        self.assertEqual(payload["resolution"]["quarantined_item_ids"], [3, 4, 5, 6])
        self.assertEqual([r["item_id"] for r in payload["proposal"]], [2])
        self.assertTrue(payload["target"]["plex"])
        self.assertNotIn(SECRET, self.stdout.getvalue())

    def test_safe_categories_empty_stdout_and_restored_logging_on_boundary_errors(self):
        def fail(*args, **kwargs):
            print(SECRET)
            print(SECRET, file=__import__("sys").stderr)
            logging.getLogger("mix-sentinel").error(SECRET)
            raise RuntimeError(SECRET)
        argv = ["--json", "--cluster-threshold", ".1", "artist:Seed"]
        for boundary in ("snapshot", "from_query", "extend"):
            previous = logging.root.manager.disable
            with self.subTest(boundary=boundary), patch.object(plugin, boundary, side_effect=fail), \
                 self.assertRaises(ui.UserError) as raised:
                self.run_command(argv)
            self.assert_safe(raised.exception)
            self.assert_closed()
            self.assertEqual(logging.root.manager.disable, previous)
        self.plugin.config["worker"].set("trusted-worker")
        for boundary in ("worker", "subprocess"):
            with self.subTest(boundary=boundary):
                with patch.object(plugin, "encode_steer", side_effect=fail) if boundary == "worker" else \
                     patch.object(plugin, "encode_steer", new=encode_steer):
                    with patch("beetsplug.mix.worker.subprocess.Popen", side_effect=OSError(SECRET)), self.assertRaises(ui.UserError) as raised:
                        self.run_command(argv + ["--steer", "sleepier"])
                self.assert_safe(raised.exception)
        with patch.object(plugin, "snapshot", side_effect=[[], RuntimeError(SECRET)]), self.assertRaises(ui.UserError) as raised:
            self.run_command(argv)
        self.assert_safe(raised.exception)
        self.assert_closed()
        for signal_number in (signal.SIGINT, signal.SIGTERM):
            self.assertNotEqual(signal.getsignal(signal_number).__name__ if callable(signal.getsignal(signal_number)) else None, "interrupted")

    def test_safe_plex_connect_read_and_cleanup_errors(self):
        for boundary in ("connect", "playlist", "close"):
            rows, client, _ = self.plex_fixture()
            connect = patch.object(PlexClient, "connect", side_effect=RuntimeError(SECRET)) if boundary == "connect" else \
                      patch.object(PlexClient, "connect", return_value=client)
            with self.subTest(boundary=boundary), patch.object(plugin, "snapshot", return_value=rows), connect, \
                 patch.object(client, boundary if boundary != "connect" else "playlist", side_effect=RuntimeError(SECRET)):
                with self.assertRaises(ui.UserError) as raised:
                    self.run_command(["--json", "--cluster-threshold", ".1", "--plex-playlist", "Exact"])
            self.assert_safe(raised.exception)
            self.assert_closed()
        error = PlexError("playlist_ambiguous")
        error.args = (SECRET,)
        with patch.object(PlexClient, "connect", side_effect=error), self.assertRaises(ui.UserError) as raised:
            self.run_command(["--json", "--cluster-threshold", ".1", "--plex-playlist", "Exact"])
        self.assert_safe(raised.exception)
        self.assertIn("playlist_ambiguous", str(raised.exception))

    def test_native_query_library_close_and_store_errors_are_safe(self):
        with self.assertRaises(ui.UserError) as raised:
            self.run_command(["--json", "--cluster-threshold", ".1", f"year:{SECRET}"])
        self.assert_safe(raised.exception)
        self.assert_closed()
        with patch.object(self.lib, "_close", side_effect=RuntimeError(SECRET)), self.assertRaises(ui.UserError) as raised:
            self.run_command(["--json", "--cluster-threshold", ".1", "artist:Seed"])
        self.assert_safe(raised.exception)
        self.lib._close()
        with self.assertRaises(ui.UserError) as raised:
            self.run_command(["--json", "--cluster-threshold", ".1", "--store", str(self.root / SECRET), "artist:Seed"])
        self.assert_safe(raised.exception)

    def test_human_output_and_strict_json_surrogates_and_nonfinite(self):
        output = self.run_command(["--cluster-threshold", ".1", "artist:Seed"])
        self.assertIn("Mix proposal (read-only)", output)
        self.assertIn("Cluster 0", output)
        self.assertIn("1. Candidate", output)
        self.assertIn("support", output)
        self.assertIn("nearest seed: Song1", output)
        real_extend = api.extend
        def surrogate(*args, **kwargs):
            proposal = real_extend(*args, **kwargs)
            proposal.data["proposal"][0]["title"] = "odd-\udcff"
            return proposal
        with patch.object(plugin, "extend", side_effect=surrogate):
            payload = json.loads(self.run_command(["--json", "--cluster-threshold", ".1", "artist:Seed"]))
        self.assertEqual(payload["proposal"][0]["title"], "odd-\udcff")
        def nonfinite(*args, **kwargs):
            proposal = real_extend(*args, **kwargs)
            proposal.data["proposal"][0]["support"] = float("nan")
            return proposal
        with patch.object(plugin, "extend", side_effect=nonfinite), self.assertRaises(ui.UserError) as raised:
            self.run_command(["--json", "--cluster-threshold", ".1", "artist:Seed"])
        self.assert_safe(raised.exception)


if __name__ == "__main__":
    unittest.main()
