"""beets commands: snapshot rows, close beets, then perform external inference."""

import json
import os
import signal
import shlex
import sqlite3
import subprocess
import tempfile
from pathlib import Path

from beets import ui
from beets.dbcore import query as dbquery
from beets.library import Item, parse_query_parts
from beets.plugins import BeetsPlugin

from beets_embed.store import count_pending, model_ids
from beets_embed.devices import DEVICES, select_worker


# Substituted by Nix. The inference environment is never added to beets' PYTHONPATH.
WORKER = "@embed-worker@"
GRAPH_VIEWER = "@album-graph-viewer@"


def snapshot(lib, query=()):
    parsed, _ = parse_query_parts(list(query), Item)
    clause, parameters = parsed.clause()
    with lib.transaction() as transaction:
        maximum = transaction.query("SELECT MAX(id) AS maximum FROM items")[0]["maximum"] or 0
    for first in range(0, maximum + 1, 512):
        if clause is not None:
            # Avoid fetching flex attributes when the query can run in SQL.
            with lib.transaction() as transaction:
                rows = transaction.query(
                    "SELECT id,path,album_id,artist,albumartist,album,title FROM items "
                    f"WHERE ({clause}) AND id>=? AND id<? ORDER BY id",
                    (*parameters, first, first + 512))
            page = []
            for row in rows:
                track = dict(row)
                path = os.fsdecode(track["path"])
                track["path"] = os.path.normpath(os.path.join(os.fsdecode(lib.directory), path))
                page.append(track)
        else:
            # AndQuery drops its entire SQL clause if a child (e.g. userrating)
            # needs Python matching. Passing that AND to lib.items would fetch
            # the WHOLE library for every page. Fetch the ID range alone, release
            # its transaction, and only then apply the original query in Python.
            items = list(lib.items(dbquery.NumericQuery("id", f"{first}..{first + 511}")))
            page = [{"id": item.id, "path": os.fsdecode(item.path),
                     "album_id": item.album_id, "artist": item.artist,
                     "albumartist": item.albumartist, "album": item.album,
                     "title": item.title} for item in items if parsed.match(item)]
        yield from page


def positive(value, label):
    if value < 1:
        raise ui.UserError(f"{label} must be positive")
    return value


def run_worker(command):
    child = subprocess.Popen(command)
    previous = {}
    def forward(signum, _frame):
        if child.poll() is None:
            child.send_signal(signum)
    try:
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous[signum] = signal.signal(signum, forward)
        return child.wait()
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


class EmbedPlugin(BeetsPlugin):
    def __init__(self):
        super().__init__()
        self.config.add({"store": "~/.local/share/beets/embeddings.sqlite3",
                         "device": "auto", "threads": 2, "batch_size": 8})

    def commands(self):
        embed = ui.Subcommand("embed", help="compute offline music embeddings")
        embed.parser.add_option("--count-only", action="store_true", default=False)
        embed.parser.add_option("--limit", type="int", help="process at most N matching tracks")
        search = ui.Subcommand("embed-search", help="search tracks with an audio description")
        search.parser.add_option("--albums", action="store_true", default=False)
        similar = ui.Subcommand("embed-similar", help="nearest albums to a beets seed query")
        for cmd in (embed, search, similar):
            cmd.parser.add_option("--store", help="external vector store path")
            cmd.parser.add_option("--json", action="store_true", default=False)
            if cmd != similar:
                cmd.parser.add_option("--device", type="choice", choices=list(DEVICES))
            if cmd != embed:
                cmd.parser.add_option("--top-k", type="int", default=20)
        embed.func = lambda lib, opts, args: self.run(lib, opts, args, "embed")
        search.func = lambda lib, opts, args: self.run(lib, opts, args, "search")
        similar.func = lambda lib, opts, args: self.run(lib, opts, args, "similar")
        graph = ui.Subcommand("embed-graph-export", help="export whole albums for the similarity graph")
        graph.parser.add_option("-o", "--output", help="output JSON file (required)")
        graph.parser.add_option("--store", help="external vector store path")
        graph.parser.add_option("--model", type="choice", choices=["style", "text"], default="style")
        graph.func = self.export_graph
        return [embed, search, similar, graph]

    def export_graph(self, lib, opts, args):
        from beets_embed.graph_export import export_albums
        if not opts.output:
            raise ui.UserError("An output path is required: -o albums.json")
        store = opts.store or self.config["store"].as_str()
        try:
            selected = {track["album_id"] for track in snapshot(lib, args) if track["album_id"]}
            result = export_albums(lib, selected, store, model_ids()[opts.model], opts.output)
        except (OSError, ValueError, sqlite3.Error) as exc:
            raise ui.UserError(f"Cannot export album graph: {exc}") from exc
        ui.print_(json.dumps(result["summary"], sort_keys=True))
        viewer = "beets-album-graph" if GRAPH_VIEWER.startswith("@") else GRAPH_VIEWER
        ui.print_(f"Open viewer: {shlex.quote(viewer)} --data "
                  f"{shlex.quote(str(Path(opts.output).expanduser().absolute()))}")

    def run(self, lib, opts, args, mode):
        if mode != "embed" and not args:
            raise ui.UserError("A text description or seed query is required")
        if mode != "embed":
            positive(opts.top_k, "top-k")
        if mode == "embed" and opts.limit is not None:
            positive(opts.limit, "limit")
        threads = positive(self.config["threads"].get(int), "threads")
        batch = positive(self.config["batch_size"].get(int), "batch_size")
        if threads > 16 or batch > 128:
            raise ui.UserError("threads must be <=16 and batch_size <=128")
        store_path = os.path.abspath(os.path.expanduser(opts.store or self.config["store"].as_str()))
        with tempfile.TemporaryDirectory(prefix="beets-embed-") as temp:
            manifest = Path(temp) / "tracks.jsonl"
            seeds = set()
            if mode == "similar":
                seeds = {track["id"] for track in snapshot(lib, args)}
            selected = 0
            with manifest.open("w") as out:
                for track in snapshot(lib, args if mode == "embed" else ()):
                    out.write(json.dumps(track, ensure_ascii=True) + "\n")
                    selected += 1
                    if mode == "embed" and opts.limit and selected >= opts.limit:
                        break
            # No connection to beets remains while statting files or running models.
            lib._close()
            if mode == "embed" and opts.count_only:
                with manifest.open() as rows:
                    counts = count_pending((json.loads(row) for row in rows), store_path, model_ids())
                ui.print_(json.dumps(counts, sort_keys=True))
                return
            try:
                worker, device = select_worker(
                    (opts.device if mode != "similar" else None) or self.config["device"].as_str(), WORKER)
            except ValueError as exc:
                raise ui.UserError(str(exc)) from exc
            command = [worker, mode, "--manifest", str(manifest), "--store", store_path,
                       "--threads", str(threads), "--batch-size", str(batch)]
            command.extend(["--device", device])
            if device == "rocm":
                command.append("--probe-passed")
            if mode == "search":
                command.extend(["--text", " ".join(args)])
                if opts.albums:
                    command.append("--albums")
            if mode == "similar":
                command.extend(["--seeds", ",".join(str(i) for i in sorted(seeds))])
            if mode != "embed":
                command.extend(["--top-k", str(opts.top_k)])
            if opts.json:
                command.append("--json")
            try:
                returncode = run_worker(command)
            except OSError as exc:
                raise ui.UserError(f"Cannot start packaged embedding worker: {exc}") from exc
            if returncode:
                raise ui.UserError(f"Embedding worker exited with status {returncode}; completed vectors are retained")
