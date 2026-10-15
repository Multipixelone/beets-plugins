"""Identity-only apply CLI over temporary beets and an injected fake client."""

import contextlib
import io
import json
import logging
from pathlib import Path
import sqlite3
import tempfile
import traceback
import unittest
from unittest.mock import patch

import beets
from beets import ui
from beets.dbcore import types
from beets.dbcore.db import Transaction
from beets.library import Item, Library
import confuse

from beets_mix import api
from beets_mix.plex import PlexClient, PlexError
import beetsplug.mix as plugin
from beetsplug.mix.snapshot import link_snapshot
import test_apply as fakes


SECRET = fakes.SECRET


class ContextClient(fakes.FakeClient):
    def __init__(self, present=()):
        super().__init__(present)
        self.closed = False
        self.close_error = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.closed = True
        if self.close_error:
            raise self.close_error


class ApplyCommands(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        config = confuse.Configuration("beets", "beets", read=False)
        config.read(user=False)
        config.set({"plex": {"host": "server.invalid", "token": SECRET},
                    "mix": {"store": SECRET, "worker": SECRET, "worker_timeout": False}})
        self.enterContext(patch.object(beets, "config", config))
        self.lib = Library(str(self.root / "library.db"), directory=str(self.root), set_music_dir=False)
        self.addCleanup(self.lib._close)
        self.keys = ("0010", "20", "0030", "30", "bad", None)
        for i, key in enumerate(self.keys, 1):
            self.lib.add(Item(path=f"/do-not-stat/{i}.wav".encode(), title=f"Song{i}"))
            with self.lib.transaction() as transaction:
                if key is not None:
                    transaction.mutate("INSERT INTO item_attributes(entity_id,key,value) VALUES(?,?,?)", (i, "plex_ratingkey", key))
                transaction.mutate("INSERT INTO item_attributes(entity_id,key,value) VALUES(?,?,?)", (i, "plex_userrating", "malformed history"))
        self.client = ContextClient(["10"])
        def connect(**kwargs):
            self.assert_closed()
            self.assertEqual(kwargs, {"host": "server.invalid", "token": SECRET, "port": 32400, "timeout": 15})
            return self.client
        self.connect = self.enterContext(patch.object(PlexClient, "connect", side_effect=connect))
        self.plugin = plugin.MixPlugin()
        self.command = next(c for c in self.plugin.commands() if c.name == "mix-apply")
        self.stdout, self.stderr = io.StringIO(), io.StringIO()

    def assert_closed(self):
        self.assertFalse(self.lib._connections)
        self.assertTrue(all(not stack for stack in self.lib._tx_stacks.values()))

    def run_command(self, argv, changes=None):
        self.stdout, self.stderr = io.StringIO(), io.StringIO()
        opts, args = self.command.parser.parse_args(argv)
        for name, value in (changes or {}).items():
            setattr(opts, name, value)
        with contextlib.redirect_stdout(self.stdout), contextlib.redirect_stderr(self.stderr):
            self.command.func(self.lib, opts, args)
        return self.stdout.getvalue()

    def assert_safe(self, error):
        self.assertIsInstance(error, ui.UserError)
        self.assertNotIn(SECRET, "".join(traceback.format_exception(error)))
        self.assertTrue(error.__suppress_context__)
        self.assertEqual(self.stdout.getvalue(), "")
        self.assertEqual(self.stderr.getvalue(), "")

    def dump(self):
        with contextlib.closing(sqlite3.connect((self.root / "library.db").as_uri() + "?mode=ro", uri=True)) as connection:
            return list(connection.iterdump())

    def test_real_identity_capture_ignores_history_and_never_uses_store_worker_or_extend(self):
        before = self.dump()
        real = self.plugin.config
        owner = self
        class TimeoutOnly:
            def __getitem__(self, key):
                owner.assert_closed()
                owner.assertEqual(key, "plex_timeout")
                return real[key]
        root_get = type(beets.config).__getitem__
        def get(config, key):
            if config is beets.config and key == "plex":
                self.assert_closed()
            return root_get(config, key)
        with patch.object(self.plugin, "config", TimeoutOnly()), \
             patch.object(type(beets.config), "__getitem__", new=get), \
             patch.object(plugin, "snapshot", side_effect=AssertionError("no history snapshot")), \
             patch.object(plugin, "extend", side_effect=AssertionError("no engine")), \
             patch.object(plugin, "encode_steer", side_effect=AssertionError("no worker")), \
             patch.object(api.Store, "__init__", side_effect=AssertionError("no Store")), \
             patch.object(Transaction, "mutate", side_effect=AssertionError("no library writes")), \
             patch.object(Transaction, "mutate_many", side_effect=AssertionError("no library writes")):
            payload = json.loads(self.run_command(["--plex-playlist", "Target", "--json", "002", "1", "3", "5", "99", "002"]))
        self.assertEqual(payload, {"schema": "beets-mix.apply.v1", "playlist": "Target", "plex_ratingkey": "500",
            "added": [2], "already_present": [1], "refused": [{"item_id": 3, "reason": "ambiguous_plex_link"},
                {"item_id": 5, "reason": "not_plex_linked"}, {"item_id": 99, "reason": "item_not_found"}],
            "playlist_tracks_after": 2})
        self.assertEqual(self.dump(), before)
        self.assertTrue(self.client.closed)
        self.assert_closed()
        self.assertEqual(self.stderr.getvalue(), "")
        self.assertNotIn(SECRET, self.stdout.getvalue())
        self.assertEqual([event for event in self.client.events if event[0] == "append"], [("append", ("20",))])

    def test_invalid_request_options_precede_all_command_io(self):
        cases = [[], ["1"], ["--plex-playlist", "", "1"], ["--plex-playlist", "Target"],
                 ["--plex-playlist", " ", "1"]]
        cases += [["--plex-playlist", "Target", "--", token] for token in ("0", "000", "-1", "+1", "1.0", " 1", "1 ", "\u0661", "True", "/path")]
        with patch.object(plugin, "link_snapshot") as links, patch.object(self.lib, "_close") as close, \
             patch.object(self.plugin, "_apply_settings") as config:
            for argv in cases:
                with self.subTest(argv=argv), self.assertRaises(ui.UserError):
                    self.run_command(argv)
            with self.assertRaises(ui.UserError):
                self.run_command(["--plex-playlist", "Target", "1"], {"json": 1})
            links.assert_not_called()
            close.assert_not_called()
            config.assert_not_called()
        self.connect.assert_not_called()

    def test_raw_link_snapshot_bounded_native_normalizer_independent_and_readonly(self):
        with patch.object(Item, "_types", {**Item._types, "plex_ratingkey": types.INTEGER}):
            self.assertEqual(self.lib.get_item(5).get("plex_ratingkey"), 0)
            with patch.object(self.lib, "items", side_effect=AssertionError("no Item/history access")), \
                 patch.object(Transaction, "mutate", side_effect=AssertionError("no writes")):
                first = link_snapshot(self.lib)
                second = link_snapshot(self.lib)
        self.assertEqual(first, [{"id": i, "plex_ratingkey": key} for i, key in enumerate(self.keys, 1)])
        self.assertEqual(first, second)
        self.assertIsNot(first[0], second[0])
        self.assertTrue(all(not connection.in_transaction for connection in self.lib._connections.values()))
        with self.lib.transaction() as transaction:
            transaction.mutate("UPDATE items SET id=1025 WHERE id=6")
            transaction.mutate("UPDATE item_attributes SET entity_id=1025 WHERE entity_id=6")
        query = Transaction.query
        ranges = []
        def observe(transaction, sql, parameters=()):
            if "LEFT JOIN item_attributes" in sql:
                self.assertIn("items.id>=? AND items.id<?", sql)
                self.assertEqual(parameters[0], "plex_ratingkey")
                self.assertEqual(parameters[2] - parameters[1], 512)
                ranges.append(parameters[1:])
            return query(transaction, sql, parameters)
        with patch.object(Transaction, "query", new=observe):
            rows = link_snapshot(self.lib)
        self.assertEqual(ranges, [(0, 512), (512, 1024), (1024, 1536)])
        self.assertEqual([row["id"] for row in rows], [1, 2, 3, 4, 5, 1025])

    def test_duplicate_raw_key_attributes_fail_closed_and_library_closes(self):
        with self.lib.transaction() as transaction:
            transaction.mutate("INSERT INTO item_attributes(entity_id,key,value) VALUES(?,?,?)", (2, "PLEX_RATINGKEY", "21"))
        with self.assertRaises(ValueError):
            link_snapshot(self.lib)
        with self.assertRaises(ui.UserError) as raised:
            self.run_command(["--plex-playlist", "Target", "--json", "2"])
        self.assert_safe(raised.exception)
        self.assert_closed()
        self.connect.assert_not_called()

    def test_noops_refusals_and_one_line_human_output(self):
        data = json.loads(self.run_command(["--plex-playlist", "Target", "--json", "1", "1"]))
        self.assertEqual(data["already_present"], [1])
        self.assertEqual(data["added"], [])
        self.assertEqual(self.client.events, [("playlist", "Target")])
        output = self.run_command(["--plex-playlist", "Target", "3", "5", "99"])
        self.assertEqual(output.strip(), "Mix apply: 0 added; 0 already present; 3 refused; 1 observed playlist tracks")
        self.assertEqual(len(output.splitlines()), 1)
        self.assertFalse(any(event[0] == "append" for event in self.client.events))

    def test_fetch_refusal_success_repeat_and_actual_observed_count(self):
        self.client.failures["20"] = RuntimeError(SECRET)
        data = json.loads(self.run_command(["--plex-playlist", "Target", "--json", "2"]))
        self.assertEqual(data["refused"], [{"item_id": 2, "reason": "plex_track_unavailable"}])
        self.assertFalse(any(event[0] == "append" for event in self.client.events))
        self.client.failures.clear()
        self.client.concurrent = ["901"]
        data = json.loads(self.run_command(["--plex-playlist", "Target", "--json", "2"]))
        self.assertEqual(data["playlist_tracks_after"], 3)
        data = json.loads(self.run_command(["--plex-playlist", "Target", "--json", "2"]))
        self.assertEqual(data["already_present"], [2])
        self.assertEqual(sum(e[0] == "append" for e in self.client.events), 1)

    def test_write_postread_and_cleanup_failures_never_print_added_or_retry(self):
        for boundary in ("append_error", "post_error", "close_error"):
            for error in (RuntimeError(SECRET), KeyboardInterrupt(), SystemExit(143)):
                self.client = ContextClient(["10"])
                setattr(self.client, boundary, error)
                handle = logging.Logger.handle
                with self.subTest(boundary=boundary, error=type(error)), self.assertRaises(ui.UserError) as raised:
                    self.run_command(["--plex-playlist", "Target", "--json", "2"])
                self.assert_safe(raised.exception)
                self.assertIn("write_outcome_unknown", str(raised.exception))
                self.assertIs(logging.Logger.handle, handle)
                self.assertTrue(self.client.closed)
                self.assertEqual(sum(e[0] == "append" for e in self.client.events), 1)
        # Cleanup must not replace a pending unknown write with a generic read error.
        self.client = ContextClient(["10"])
        self.client.append_error = RuntimeError(SECRET)
        self.client.close_error = PlexError("read_failed")
        with self.assertRaises(ui.UserError) as raised:
            self.run_command(["--plex-playlist", "Target", "--json", "2"])
        self.assertIn("write_outcome_unknown", str(raised.exception))
        self.assert_safe(raised.exception)

    def test_prewrite_snapshot_config_connect_and_target_errors_are_safe(self):
        with patch.object(plugin, "link_snapshot", side_effect=RuntimeError(SECRET)), self.assertRaises(ui.UserError) as raised:
            self.run_command(["--plex-playlist", "Target", "--json", "2"])
        self.assert_safe(raised.exception)
        self.assert_closed()
        self.connect.assert_not_called()
        with patch.object(self.plugin, "_apply_settings", side_effect=RuntimeError(SECRET)), self.assertRaises(ui.UserError) as raised:
            self.run_command(["--plex-playlist", "Target", "--json", "2"])
        self.assert_safe(raised.exception)
        self.assert_closed()
        with patch.object(PlexClient, "connect", side_effect=RuntimeError(SECRET)), self.assertRaises(ui.UserError) as raised:
            self.run_command(["--plex-playlist", "Target", "--json", "2"])
        self.assert_safe(raised.exception)
        self.client.playlist_error = PlexError("playlist_ambiguous")
        with self.assertRaises(ui.UserError) as raised:
            self.run_command(["--plex-playlist", "Target", "--json", "2"])
        self.assert_safe(raised.exception)
        self.assertFalse(any(e[0] == "append" for e in self.client.events))

    def test_native_and_standard_logs_are_suppressed_and_restored_during_apply(self):
        from beets import logging as native_logging
        std, native = logging.getLogger("apply-command-standard"), native_logging.getLogger("beets")
        streams = [io.StringIO(), io.StringIO()]
        beets.config["verbose"].set(3)
        for logger, stream in zip((std, native), streams):
            previous = (logger.handlers[:], logger.level, logger.propagate, logger.disabled)
            def restore(logger=logger, previous=previous):
                logger.handlers[:], level, logger.propagate, logger.disabled = previous
                logger.setLevel(level)
            self.addCleanup(restore)
            logger.handlers[:] = [logging.StreamHandler(stream)]
            logger.setLevel(logging.DEBUG)
            logger.propagate, logger.disabled = False, False
        real_apply = plugin.apply
        def noisy(*args, **kwargs):
            print(SECRET)
            std.error(SECRET)
            native.warning(SECRET)
            native.extra_debug(SECRET)
            return real_apply(*args, **kwargs)
        before = logging.Logger.handle
        with patch.object(plugin, "apply", side_effect=noisy):
            data = json.loads(self.run_command(["--plex-playlist", "Target", "--json", "2"]))
        self.assertEqual(data["added"], [2])
        self.assertTrue(all(stream.getvalue() == "" for stream in streams))
        self.assertIs(logging.Logger.handle, before)
        std.error("restored")
        native.warning("restored")
        self.assertTrue(all("restored" in stream.getvalue() for stream in streams))


if __name__ == "__main__":
    unittest.main()
