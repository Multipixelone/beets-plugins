"""Real temporary beets libraries; no host configuration or external IO."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import beets
from beets.dbcore import query as dbquery, types
from beets.dbcore.db import Transaction
from beets.library import Item, Library
import confuse

from beets_mix.api import FIELDS, snapshots
from beetsplug.mix.snapshot import NUMERIC_FIELDS, _numeric_fields, snapshot


class Snapshot(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        config = confuse.Configuration("beets", "beets", read=False)
        config.read(user=False)
        self.enterContext(patch.object(beets, "config", config))
        self.lib = Library(str(self.root / "library.db"), directory=str(self.root / "music"), set_music_dir=False)
        self.addCleanup(self.lib._close)

    def assert_idle(self):
        self.assertTrue(all(not stack for stack in self.lib._tx_stacks.values()))
        self.assertTrue(all(not connection.in_transaction for connection in self.lib._connections.values()))

    def test_complete_persisted_numeric_flex_sql_and_relative_paths(self):
        self.assertTrue(all(field not in Item._types for field in NUMERIC_FIELDS))
        album = self.lib.add_album([Item(path=b"relative/../seed.wav", title="Seed", artist="A", year=2001,
                              length=30.5, plex_userrating=6.5, plex_skipcount=3, plex_viewcount=4,
                              plex_ratingkey="00123", mb_trackid="mb-seed")])
        self.lib.add(Item(path=b"/absolute/other.wav", title="Other", artist="B"))
        with self.lib.transaction() as transaction:
            raw = transaction.query("SELECT key,value,typeof(value) AS storage FROM item_attributes WHERE key LIKE 'plex_%'")
        self.assertEqual({r["key"]: r["value"] for r in raw},
                         {"plex_userrating": "6.5", "plex_skipcount": "3", "plex_viewcount": "4", "plex_ratingkey": "00123"})
        self.assertTrue(all(r["storage"] == "text" for r in raw))
        with patch.object(self.lib, "items", wraps=self.lib.items) as reads:
            result = snapshot(self.lib, ["artist:A", "title-"])
        self.assertEqual(len(result), 1)
        row = result[0]
        self.assertEqual(set(row), set(FIELDS) | {"album_id"})
        self.assertEqual(row["path"], str(self.root / "music" / "seed.wav"))
        self.assertEqual(row["year"], 2001)
        self.assertEqual(row["album_id"], album.id)
        self.assertEqual(row["length"], 30.5)
        self.assertIs(type(row["plex_userrating"]), float)
        self.assertEqual(row["plex_userrating"], 6.5)
        self.assertIs(type(row["plex_skipcount"]), int)
        self.assertEqual(row["plex_skipcount"], 3)
        self.assertEqual(row["plex_viewcount"], 4)
        self.assertEqual(row["plex_ratingkey"], "00123")
        self.assertTrue(all(call.args[0].clause()[0] is not None for call in reads.call_args_list))
        all_rows = snapshot(self.lib)
        self.assertEqual(all_rows[1]["path"], "/absolute/other.wav")
        self.assertTrue(all(all_rows[1][field] == 0 for field in NUMERIC_FIELDS))
        self.assertIsNone(all_rows[1]["plex_ratingkey"])
        self.assertEqual(all_rows[1]["year"], 0)  # Native present beets value, not absence.
        snapshots(all_rows)
        self.assert_idle()

    def test_bounded_pages_native_python_query_and_closed_transactions(self):
        with self.lib.transaction():
            for i in range(1030):
                self.lib.add(Item(path=f"/synthetic/{i}.wav".encode(), title=f"Song{i}", artist="A" if i % 3 else "B"))
        test = self

        class EvenQuery(dbquery.FieldQuery):
            def clause(self):
                return None, ()

            def match(self, item):
                test.assert_idle()
                return item.id % 2 == 0

        original_items = self.lib.items
        pages = []
        slow = True

        def bounded_items(query, **kwargs):
            test.assertIsInstance(query, dbquery.NumericQuery if slow else dbquery.AndQuery)
            test.assertIsNotNone(query.clause()[0])
            results = original_items(query, **kwargs)
            test.assertLessEqual(len(results), 512)
            pages.append(len(results))
            return results

        with patch.object(Item, "_queries", {**Item._queries, "even": EvenQuery}), \
             patch.object(self.lib, "items", side_effect=bounded_items):
            rows = snapshot(self.lib, ["artist:A", "even:yes"])
        self.assertEqual(len(pages), 3)
        self.assertEqual(sum(pages), 1030)
        self.assertEqual([r["id"] for r in rows], [i for i in range(1, 1031) if i % 2 == 0 and (i - 1) % 3 != 0])
        pages.clear()
        slow = False
        with patch.object(self.lib, "items", side_effect=bounded_items):
            rows = snapshot(self.lib, ["artist:A"])
        self.assertEqual(len(pages), 3)
        self.assertEqual(sum(pages), len(rows))
        self.assertEqual([r["id"] for r in rows], [i for i in range(1, 1031) if (i - 1) % 3 != 0])
        self.assert_idle()

    def test_read_only_repeatable_materialized_and_caller_owns_close(self):
        self.lib.add(Item(path=b"/one.wav", title="One", artist="A", plex_skipcount="3"))
        self.lib.add(Item(path=b"/two.wav", title="Two", artist="B"))
        connections = list(self.lib._connections.values())
        before = [c.total_changes for c in connections]
        original_transaction = self.lib.transaction
        active = 0

        @contextmanager
        def transaction():
            nonlocal active
            with original_transaction() as tx:
                active += 1
                try:
                    yield tx
                finally:
                    active -= 1

        with patch.object(self.lib, "transaction", side_effect=transaction), \
             patch.object(self.lib, "_close", wraps=self.lib._close) as close, \
             patch.object(Item, "store", side_effect=AssertionError("snapshot must not store")), \
             patch.object(Item, "__setitem__", side_effect=AssertionError("snapshot must not change attributes")), \
             patch.object(Transaction, "mutate", side_effect=AssertionError("snapshot must not mutate")), \
             patch.object(Transaction, "mutate_many", side_effect=AssertionError("snapshot must not mutate")):
            first = snapshot(self.lib)
            second = snapshot(self.lib)
            close.assert_not_called()
        self.assertIsInstance(first, list)
        self.assertEqual(first, second)
        self.assertIsNot(first[0], second[0])
        self.assertEqual(first[0]["plex_skipcount"], 3)
        snapshots(first)
        self.assertEqual(active, 0)
        self.assertEqual([c.total_changes for c in connections], before)
        self.assert_idle()
        self.lib._close()
        self.assertFalse(self.lib._connections)
        json.dumps(first, allow_nan=False)
        self.assertEqual(first[0]["title"], "One")

    def test_only_absence_gets_defaults_and_invalid_present_values_survive(self):
        # A tiny fake page exposes genuine absence (fixed beets fields normally
        # exist even when their native null value is zero or an empty string).
        item = {"id": 1, "path": b"relative.wav", "artist": None}
        with patch.object(self.lib, "items", return_value=[item]):
            row = snapshot(self.lib)[0]
        self.assertIsNone(row["year"])
        self.assertIsNone(row["album_id"])
        self.assertEqual(row["length"], 0)
        self.assertEqual(row["album"], "")
        self.assertIsNone(row["plex_ratingkey"])
        self.assertTrue(all(row[field] == 0 for field in NUMERIC_FIELDS))
        self.assertIsNone(row["artist"])

    def put_raw(self, field, value):
        with self.lib.transaction() as transaction:
            transaction.mutate("DELETE FROM item_attributes WHERE entity_id=1 AND key=?", (field,))
            transaction.mutate("INSERT INTO item_attributes(entity_id,key,value) VALUES(1,?,?)", (field, value))

    def test_invalid_persisted_numeric_never_defaults_to_zero(self):
        self.lib.add(Item(path=b"/one.wav", title="One"))
        for field in NUMERIC_FIELDS:
            for raw in (None, "", " ", "bad", "True", "False", "true", "false", "NaN", "Infinity", "-Infinity",
                        "1e999", "1e-999", "-1", "-.5", "01", "+1", " 3", "3 ", "1_0", ".5", "1.", "\u0663"):
                self.put_raw(field, raw)
                with self.subTest(field=field, raw=raw), self.assertRaisesRegex(ValueError, field):
                    snapshot(self.lib)
                self.assert_idle()
            for raw in ("0", "0.0", "3", "3.0", "6.5", "3e0"):
                self.put_raw(field, raw)
                self.assertEqual(snapshot(self.lib)[0][field], json.loads(raw))
            self.put_raw(field, "0")
        for raw in ("10.1", "11", "10.0000000000000000001"):
            self.put_raw("plex_userrating", raw)
            with self.assertRaisesRegex(ValueError, "plex_userrating"):
                snapshot(self.lib)
        for raw in (True, False):
            with self.assertRaises(ValueError):
                _numeric_fields([{"key": "plex_userrating", "value": raw}])

    def test_raw_validation_cannot_be_masked_by_optional_plugin_types(self):
        self.lib.add(Item(path=b"/one.wav", title="One"))
        self.put_raw("plex_skipcount", "malformed")
        with patch.object(Item, "_types", {**Item._types, "plex_skipcount": types.INTEGER}):
            self.assertEqual(self.lib.get_item(1).get("plex_skipcount"), 0)
            with self.assertRaisesRegex(ValueError, "plex_skipcount"):
                snapshot(self.lib)
        self.assert_idle()

    def test_numeric_raw_reads_restricted_to_page_and_keys(self):
        self.lib.add(Item(path=b"/one.wav", title="One", plex_userrating="6.5"))
        second = self.lib.add(Item(path=b"/last.wav", title="Last", plex_viewcount="4"))
        # Beets allocates its own ID on add; make a sparse synthetic page gap.
        with self.lib.transaction() as transaction:
            transaction.mutate("UPDATE items SET id=1025 WHERE id=?", (second,))
            transaction.mutate("UPDATE item_attributes SET entity_id=1025 WHERE entity_id=?", (second,))
        original = Transaction.query
        ranges = []
        def query(transaction, sql, parameters=()):
            if sql.startswith("SELECT entity_id,key,value FROM item_attributes"):
                self.assertIn("entity_id>=? AND entity_id<?", sql)
                self.assertIn("lower(key) IN (?,?,?)", sql)
                self.assertEqual(parameters[1] - parameters[0], 512)
                self.assertEqual(parameters[2:], NUMERIC_FIELDS)
                ranges.append(parameters[:2])
            return original(transaction, sql, parameters)
        with patch.object(Transaction, "query", new=query):
            rows = snapshot(self.lib)
        self.assertEqual(ranges, [(0, 512), (512, 1024), (1024, 1536)])
        self.assertEqual([row["id"] for row in rows], [1, 1025])
        self.assertEqual(rows[1]["plex_viewcount"], 4)
        self.assert_idle()

    def test_surrogate_byte_path_roundtrip_without_file_access(self):
        raw = b"odd-\xff.wav"
        self.lib.add(Item(path=raw, title="Surrogate"))
        row = snapshot(self.lib)[0]
        expected = os.path.join(os.fsencode(self.lib.directory), raw)
        self.assertEqual(os.fsencode(row["path"]), expected)
        self.assertEqual(json.loads(json.dumps(row))["path"], row["path"])
        snapshots([row])
        self.assert_idle()

    def test_empty_and_invalid_native_queries_release_transactions(self):
        self.assertEqual(snapshot(self.lib), [])
        with self.assertRaises(dbquery.InvalidQueryArgumentValueError):
            snapshot(self.lib, ["year:not-a-number"])
        self.assert_idle()


if __name__ == "__main__":
    unittest.main()
