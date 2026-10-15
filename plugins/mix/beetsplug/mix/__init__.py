"""Thin read-only proposal and explicitly invoked ID-based append commands."""

from contextlib import contextmanager, redirect_stderr, redirect_stdout
from copy import deepcopy
import io
import json
import logging
import math
from time import perf_counter

import beets
from beets import ui
from beets.plugins import BeetsPlugin

from beets_mix import defaults as d
from beets_mix.api import apply, extend
from beets_mix.plex import PlexClient, PlexError
from beets_mix.seeds import from_plex, from_query
from .snapshot import link_snapshot, snapshot
from .worker import encode_steer


def _positive(value, name):
    if type(value) is not int or value < 1:
        raise ui.UserError(f"{name} must be a positive integer")
    return value


def _finite(value, name, low=0, high=None, *, positive=False):
    try:
        valid = (type(value) in (int, float) and math.isfinite(value)
                 and (value > low if positive else value >= low)
                 and (high is None or value <= high))
    except OverflowError:
        valid = False
    if not valid:
        raise ui.UserError(f"Invalid {name}")
    return value


def _text(value, name):
    if type(value) is not str or not value.strip() or "\x00" in value:
        raise ui.UserError(f"Invalid {name}")
    return value


def _validate(opts, args):
    plex = opts.plex_playlist is not None
    if plex:
        _text(opts.plex_playlist, "playlist title")
    if bool(args) == plex:
        raise ui.UserError("Choose exactly one seed source: --plex-playlist or a beets query")
    if any(type(part) is not str or not part.strip() for part in args):
        raise ui.UserError("Invalid beets query")
    _finite(opts.cluster_threshold, "cluster threshold", high=2)
    _finite(opts.steer_weight, "steer weight", high=1)
    for name in ("n", "k", "max_per_artist"):
        _positive(getattr(opts, name), name)
    if type(opts.fresh) is not bool or type(opts.json) is not bool:
        raise ui.UserError("Invalid boolean option")
    if opts.steer is not None:
        _text(opts.steer, "steering text")
        if len(opts.steer.strip()) > 240:
            raise ui.UserError("Steering text must contain at most 240 characters")
    if opts.store is not None:
        _text(opts.store, "store path")
    return plex


def _validate_apply(opts, args):
    _text(opts.plex_playlist, "playlist title")
    if type(opts.json) is not bool or not args:
        raise ui.UserError("Apply requires explicit positive item IDs")
    ids = []
    for token in args:
        if type(token) is not str or not token or not token.isascii() or not token.isdecimal():
            raise ui.UserError("Apply requires positive ASCII decimal item IDs")
        try:
            value = int(token)
        except (ValueError, OverflowError):
            raise ui.UserError("Invalid apply item ID") from None
        ids.append(_positive(value, "item ID"))
    return ids


@contextmanager
def _quiet_boundaries():
    """Suppress supported stdlib/beets emission paths, not just one manager.

    BeetsLogger inherits Logger.handle, including extra_debug -> _log. Guarding
    that shared emission point also covers handlers bound before redirection.
    This command-scoped global guard is not a concurrent logging sandbox.
    """
    previous_handle = logging.Logger.handle

    def discard_record(self, record):
        pass

    with _Discard() as sink, redirect_stdout(sink), redirect_stderr(sink):
        logging.Logger.handle = discard_record
        try:
            yield
        finally:
            logging.Logger.handle = previous_handle


class _Discard(io.TextIOBase):
    """Discard upstream text without retaining secret-bearing buffers."""

    def write(self, text):
        return len(text)


def _human(payload):
    lines = ["Mix proposal (read-only)"]
    for cluster in payload["clusters"]:
        picks = [row for row in payload["proposal"] if row["cluster"] == cluster["id"]]
        if not picks:
            continue
        styles = ", ".join(cluster["top_styles"]) or "styles unavailable"
        lines.append(f"Cluster {cluster['id']} ({cluster['size']} seeds): {styles}")
        for row in picks:
            lines.append(f"{row['n']:>2}. {row['artist']} — {row['title']} | support {row['support']:.4f}"
                         f" | nearest seed: {row['nearest_seed']['title']}")
    lines.append(f"{len(payload['proposal'])} proposed; {payload['elapsed_ms']:.1f} ms")
    return "\n".join(lines)


class MixPlugin(BeetsPlugin):
    def register_listener(self, event, func):
        # Beets 2.13 installs this metadata-source deprecation hook in its base
        # constructor. A command-only plugin has no such source or listeners.
        if event == "pluginload" and func == self._verify_config:
            return
        return super().register_listener(event, func)

    def __init__(self):
        super().__init__()
        self.config.add({"store": "~/.local/share/beets/embeddings.sqlite3",
                         "worker": "@embed-worker@", "worker_timeout": 120, "plex_timeout": 15})

    def commands(self):
        command = ui.Subcommand("mix-extend", help="propose local tracks without writing a playlist")
        command.parser.add_option("--plex-playlist", help="exact manual audio playlist title")
        command.parser.add_option("--cluster-threshold", type="float", help="required explicit cosine-distance threshold")
        command.parser.add_option("--k", type="int", default=d.K)
        command.parser.add_option("-n", type="int", default=d.N)
        command.parser.add_option("--steer")
        command.parser.add_option("--steer-weight", type="float", default=d.STEER_WEIGHT)
        command.parser.add_option("--fresh", action="store_true", default=d.FRESH)
        command.parser.add_option("--max-per-artist", type="int", default=d.MAX_PER_ARTIST)
        command.parser.add_option("--store")
        command.parser.add_option("--json", action="store_true", default=False)
        command.func = self.run
        append = ui.Subcommand("mix-apply", help="append an explicitly approved ordered item-ID subset")
        append.parser.add_option("--plex-playlist", help="exact manual audio playlist title")
        append.parser.add_option("--json", action="store_true", default=False)
        append.func = self.run_apply
        return [command, append]

    def _settings(self, opts, plex):
        settings = {"store": _text(opts.store if opts.store is not None else self.config["store"].get(str), "store path")}
        if opts.steer is not None:
            worker = _text(self.config["worker"].get(str), "worker")
            if worker.startswith("@"):
                raise ValueError("Worker must be configured before packaging")
            settings.update(worker=worker, worker_timeout=_finite(self.config["worker_timeout"].get(), "worker timeout", positive=True))
        if plex:
            port = _positive(beets.config["plex"]["port"].get() if beets.config["plex"]["port"].exists() else 32400, "Plex port")
            if port > 65535:
                raise ValueError("Invalid Plex port")
            settings.update(host=_text(beets.config["plex"]["host"].get(str), "Plex host"),
                            token=_text(beets.config["plex"]["token"].get(str), "Plex token"), port=port,
                            plex_timeout=_finite(self.config["plex_timeout"].get(), "Plex timeout", positive=True))
        return settings

    def run(self, lib, opts, args):
        start = perf_counter()
        plex = _validate(opts, args)  # No config, library or external boundary before validation.
        stage = "configuration"
        try:
            with _quiet_boundaries():
                settings = self._settings(opts, plex)
                stage = "library snapshot"
                try:
                    items = snapshot(lib)
                    seed_ids = [row["id"] for row in snapshot(lib, args)] if not plex else None
                finally:
                    lib._close()
                stage = "seed resolution"
                if plex:
                    stage = "Plex resolution"
                    with PlexClient.connect(settings["host"], settings["token"], port=settings["port"], timeout=settings["plex_timeout"]) as client:
                        resolution = from_plex(items, client.playlist(opts.plex_playlist))
                else:
                    resolution = from_query(items, seed_ids)
                vector, text_model = None, None
                if opts.steer is not None:
                    stage = "steering"
                    vector, text_model = encode_steer(opts.steer, settings["worker"], timeout=settings["worker_timeout"])
                stage = "proposal"
                payload = extend(resolution.items, resolution.seed_item_ids, store=settings["store"],
                    cluster_threshold=opts.cluster_threshold, n=opts.n, k=opts.k,
                    playlist_tracks=resolution.playlist_tracks, seed_metadata=resolution.seed_metadata,
                    target_metadata=resolution.target_metadata, steer_vector=vector, text_model_id=text_model,
                    steer=opts.steer, steer_weight=opts.steer_weight, fresh=opts.fresh,
                    max_per_artist=opts.max_per_artist).to_dict()
                payload["resolution"] = deepcopy(resolution.diagnostics)
                if plex:
                    payload["seed"]["tracks"] = resolution.diagnostics["raw_entries"]
                payload["elapsed_ms"] = round((perf_counter() - start) * 1000, 3)
                stage = "output"
                serialized = json.dumps(payload, ensure_ascii=True, allow_nan=False)
                output = serialized if opts.json else _human(payload)
        except PlexError as error:
            safe = PlexError(error.code if type(error.code) is str else "read_failed")
            raise ui.UserError(f"{safe} [{safe.code}]") from None
        except Exception:
            raise ui.UserError(f"Mix {stage} failed") from None
        try:
            ui.print_(output)
        except Exception:
            raise ui.UserError("Mix output failed") from None

    def _apply_settings(self):
        # Unlike extend, apply reads no Store/worker settings and only obtains
        # connection settings after identity capture has closed the library.
        port = _positive(beets.config["plex"]["port"].get() if beets.config["plex"]["port"].exists() else 32400, "Plex port")
        if port > 65535:
            raise ValueError("Invalid Plex port")
        return {"host": _text(beets.config["plex"]["host"].get(str), "Plex host"),
                "token": _text(beets.config["plex"]["token"].get(str), "Plex token"), "port": port,
                "timeout": _finite(self.config["plex_timeout"].get(), "Plex timeout", positive=True)}

    def run_apply(self, lib, opts, args):
        ids = _validate_apply(opts, args)
        stage = "identity snapshot"
        try:
            with _quiet_boundaries():
                try:
                    items = link_snapshot(lib)
                finally:
                    lib._close()
                stage = "apply configuration"
                settings = self._apply_settings()
                stage = "apply"
                result, uncertain = None, False
                try:
                    with PlexClient.connect(**settings) as client:
                        try:
                            result = apply(items, ids, client=client, plex_playlist=opts.plex_playlist)
                        except PlexError as error:
                            uncertain = error.code == "write_outcome_unknown"
                            raise
                except (Exception, KeyboardInterrupt, SystemExit):
                    # Preserve the unknown-write warning even if context cleanup
                    # masks the original error, or fails after observed success.
                    if uncertain or result is not None and result.data["added"]:
                        raise PlexError("write_outcome_unknown") from None
                    raise
                payload = result.to_dict()
                stage = "apply output"
                serialized = json.dumps(payload, ensure_ascii=True, allow_nan=False)
                output = serialized if opts.json else (
                    f"Mix apply: {len(payload['added'])} added; {len(payload['already_present'])} already present; "
                    f"{len(payload['refused'])} refused; {payload['playlist_tracks_after']} observed playlist tracks")
        except PlexError as error:
            safe = PlexError(error.code if type(error.code) is str else "read_failed")
            raise ui.UserError(f"{safe} [{safe.code}]") from None
        except Exception:
            raise ui.UserError(f"Mix {stage} failed") from None
        try:
            ui.print_(output)
        except Exception:
            raise ui.UserError("Mix apply output failed") from None
