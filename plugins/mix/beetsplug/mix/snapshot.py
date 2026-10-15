"""Materialize read-only beets metadata before crossing external boundaries."""

import json
import math
import os
import re
from decimal import Decimal, InvalidOperation

from beets.dbcore import query as dbquery
from beets.dbcore.sort import FixedFieldSort
from beets.library import Item, parse_query_parts


DEFAULTS = {
    "artist": "", "albumartist": "", "title": "", "album": "", "mb_trackid": "",
    "year": None, "length": 0, "plex_ratingkey": None,
    "plex_userrating": 0, "plex_skipcount": 0, "plex_viewcount": 0,
}
NUMERIC_FIELDS = ("plex_userrating", "plex_skipcount", "plex_viewcount")
NUMBER = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")


def _numeric_fields(attributes):
    values = dict.fromkeys(NUMERIC_FIELDS, 0)
    seen = set()
    for attribute in attributes:
        field, raw = attribute["key"].lower(), attribute["value"]
        try:
            # Validate persisted text, not Item's potentially permissive typed
            # getter: optional plugin types may normalize malformed text to 0.
            if field in seen or type(raw) is not str or not NUMBER.fullmatch(raw):
                raise ValueError
            exact = Decimal(raw)
            if exact < 0 or field == "plex_userrating" and exact > 10:
                raise ValueError
            value = json.loads(raw)
            if not math.isfinite(value) or value == 0 and exact != 0:
                raise ValueError
        except (ValueError, OverflowError, InvalidOperation):
            raise ValueError(f"Invalid persisted {field}") from None
        seen.add(field)
        values[field] = value
    return values


def snapshot(lib, query=()):
    """Return owned, ID-sorted rows; caller owns lib._close() before external IO.

    Beets accessors provide native fixed/other flexible types. Persisted Plex
    numeric text is decoded strictly, independently of optional plugin types.
    """
    parsed, _ = parse_query_parts(list(query), Item)
    clause, _ = parsed.clause()
    with lib.transaction() as transaction:
        maximum = transaction.query("SELECT MAX(id) AS maximum FROM items")[0]["maximum"] or 0
    rows = []
    for first in range(0, maximum + 1, 512):
        bounded = dbquery.NumericQuery("items.id", f"{first}..{first + 511}")
        page_query = dbquery.AndQuery([bounded, parsed]) if clause is not None else bounded
        # Let beets handle relation joins and typed flex values. Its SQL fetch
        # finishes transactions before Results materializes these bounded Items.
        page = list(lib.items(page_query, sort=FixedFieldSort("id")))
        with lib.transaction() as transaction:
            attributes = transaction.query(
                "SELECT entity_id,key,value FROM item_attributes "
                "WHERE entity_id>=? AND entity_id<? AND lower(key) IN (?,?,?)",
                (first, first + 512, *NUMERIC_FIELDS))
        numeric = {}
        for attribute in attributes:
            numeric.setdefault(attribute["entity_id"], []).append(attribute)
        for item in page:
            if clause is None and not parsed.match(item):
                continue
            path = os.path.normpath(os.path.join(os.fsdecode(lib.directory), os.fsdecode(item["path"])))
            rows.append({"id": item["id"], "path": path, "album_id": item.get("album_id", None),
                         **{field: item.get(field, default) for field, default in DEFAULTS.items() if field not in NUMERIC_FIELDS},
                         **_numeric_fields(numeric.get(item["id"], []))})
    return sorted(rows, key=lambda row: row["id"])
