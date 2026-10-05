"""Versioned vectors, deliberately independent of the beets database."""

import hashlib
import json
import os
import sqlite3
from pathlib import Path


def fingerprint(path):
    stat = os.stat(path)
    payload = [os.fsdecode(os.path.abspath(path)), stat.st_size, stat.st_mtime_ns]
    return hashlib.sha256(json.dumps(payload, ensure_ascii=True).encode()).hexdigest()


def model_specs():
    manifest = json.loads(Path(__file__).with_name("models.json").read_text())
    result = {}
    for family, prefixes in manifest["families"].items():
        assets = {name: data for name, data in manifest["assets"].items()
                  if any(name.startswith(prefix) for prefix in prefixes)}
        identity = {"preprocessing": manifest["preprocessing"], "assets": assets,
                    "implementation": "effnet-onnx-amclap-strict-v1",
                    "family": family,
                    "name": "Discogs-EffNet v1" if family == "style" else "AMCLAP AllMusicCaps TE-trained SigReg",
                    "code_revisions": ({"allmusiccaps": "602ad59bfe7c11374ea0e9a57aa349d6a8ed3de0",
                                        "omar-rq": "985d6513bfeb308f1e0e66de9a7420648a0ff072"}
                                       if family == "text" else {})}
        digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        result[family] = (f"{family}:{digest}", identity)
    return result


def model_ids():
    return {family: spec[0] for family, spec in model_specs().items()}


class Store:
    def __init__(self, path, readonly=False):
        self.path = Path(path).expanduser().absolute()
        if readonly:
            self.db = sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True, timeout=5)
        else:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.db = sqlite3.connect(self.path, timeout=5)
            version = self.db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                self.db.close()
                raise ValueError("Unsupported embedding store schema")
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS vectors (
                    item_id INTEGER NOT NULL, fingerprint TEXT NOT NULL,
                    model TEXT NOT NULL, dimension INTEGER NOT NULL,
                    mean BLOB NOT NULL, std BLOB NOT NULL,
                    heads BLOB NOT NULL, windows INTEGER NOT NULL,
                    PRIMARY KEY (item_id, fingerprint, model));
                CREATE TABLE IF NOT EXISTS models (
                    model TEXT PRIMARY KEY, heads TEXT NOT NULL, metadata TEXT NOT NULL);
                PRAGMA user_version=1;
            """)
        if self.db.execute("PRAGMA user_version").fetchone()[0] != 1:
            self.db.close()
            raise ValueError("Unsupported embedding store schema")

    def close(self):
        self.db.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def has(self, item_id, content, model):
        return self.db.execute(
            "SELECT 1 FROM vectors WHERE item_id=? AND fingerprint=? AND model=?",
            (item_id, content, model)).fetchone() is not None

    def put(self, item_id, content, model, mean, std, heads=None, windows=1):
        import numpy as np
        mean, std = np.asarray(mean, dtype="<f2"), np.asarray(std, dtype="<f2")
        if mean.ndim != 1 or std.shape != mean.shape or not mean.size:
            raise ValueError("Expected equally sized, nonempty mean and std vectors")
        if not np.isfinite(mean).all() or not np.isfinite(std).all():
            raise ValueError("Non-finite embedding")
        heads = heads or {}
        layout = {name: value["labels"] for name, value in heads.items()}
        scores = []
        for name, labels in layout.items():
            values = np.asarray(heads[name]["scores"], dtype="<f4")
            if len(labels) != len(values) or not np.isfinite(values).all():
                raise ValueError("Invalid classifier output")
            scores.extend(values)
        head_bytes = np.asarray(scores, dtype="<f4").tobytes()
        layout_json = json.dumps(layout, separators=(",", ":"))
        # Each family is independently durable; interrupted tracks resume safely.
        with self.db:
            existing = self.db.execute("SELECT heads FROM models WHERE model=?", (model,)).fetchone()
            if existing is not None and existing[0] != layout_json:
                raise ValueError("Classifier layout changed without changing model identity")
            metadata = next((spec for identity, spec in model_specs().values() if identity == model),
                            {"name": model})
            self.db.execute("INSERT OR IGNORE INTO models VALUES (?,?,?)",
                            (model, layout_json, json.dumps(metadata, sort_keys=True)))
            self.db.execute("INSERT OR REPLACE INTO vectors VALUES (?,?,?,?,?,?,?,?)",
                            (item_id, content, model, mean.size, mean.tobytes(),
                             std.tobytes(), head_bytes, windows))

    def get(self, item_id, content, model):
        import numpy as np
        row = self.db.execute(
            "SELECT mean,std,heads,windows FROM vectors "
            "WHERE item_id=? AND fingerprint=? AND model=?",
            (item_id, content, model)).fetchone()
        if row is None:
            return None
        layout = json.loads(self.db.execute("SELECT heads FROM models WHERE model=?", (model,)).fetchone()[0])
        scores = np.frombuffer(row[2], dtype="<f4")
        heads, offset = {}, 0
        for name, labels in layout.items():
            heads[name] = {"labels": labels, "scores": scores[offset:offset + len(labels)].tolist()}
            offset += len(labels)
        return {"mean": np.frombuffer(row[0], dtype="<f2").astype("f4"),
                "std": np.frombuffer(row[1], dtype="<f2").astype("f4"),
                "heads": heads, "windows": row[3]}

    def vector(self, item_id, content, model):
        """Search only needs a mean; avoid decoding 498 heads per track."""
        import numpy as np
        row = self.db.execute(
            "SELECT mean FROM vectors WHERE item_id=? AND fingerprint=? AND model=?",
            (item_id, content, model)).fetchone()
        return None if row is None else np.frombuffer(row[0], dtype="<f2").astype("f4")


def count_pending(tracks, path, models):
    counts = {"selected": 0, "complete": 0, "pending": 0, "unreadable": 0}
    store = Store(path, readonly=True) if Path(path).expanduser().exists() else None
    try:
        for track in tracks:
            counts["selected"] += 1
            try:
                content = fingerprint(track["path"])
            except OSError:
                counts["unreadable"] += 1
                continue
            complete = store is not None and all(
                store.has(track["id"], content, model) for model in models.values())
            counts["complete" if complete else "pending"] += 1
        return counts
    finally:
        if store is not None:
            store.close()
