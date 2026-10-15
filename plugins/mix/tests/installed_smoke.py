"""Built-output-only smoke; not discovered by source unittest tests.

Uses an installed Python environment and the real default-bundle beet wrapper.
Mix import/construction must not open SQLite or launch processes. Native beets
help opens only its configured disposable empty catalog, never a host library.
The worker is never launched/probed and no model weights are loaded.
"""

import argparse
from contextlib import closing
import importlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from unittest.mock import patch


def origin(module, output):
    path = Path(module.__file__).resolve()
    if not path.is_relative_to(output):
        raise AssertionError(f"{module.__name__} did not originate in the built Mix output")
    return str(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mix-out", type=Path, required=True)
    parser.add_argument("--embed-out", type=Path, required=True)
    parser.add_argument("--beet", type=Path, required=True)
    parser.add_argument("--worker", type=Path, required=True)
    args = parser.parse_args()
    output = args.mix_out.resolve()

    with tempfile.TemporaryDirectory(prefix="mix-installed-") as temporary:
        root = Path(temporary)
        for name in ("home", "config", "cache", "data", "state", "run"):
            (root / name).mkdir(mode=0o700)
        os.environ.update(HOME=str(root / "home"), XDG_CONFIG_HOME=str(root / "config"),
                          XDG_CACHE_HOME=str(root / "cache"), XDG_DATA_HOME=str(root / "data"),
                          XDG_STATE_HOME=str(root / "state"), XDG_RUNTIME_DIR=str(root / "run"),
                          BEETSDIR=str(root / "config"), PYTHONNOUSERSITE="1", PYTHONDONTWRITEBYTECODE="1")
        library = root / "help-disposable.db"
        config_path = root / "mix-only.yaml"
        config_path.write_text(
            "plugins: [mix]\nmusicbrainz:\n  enabled: false\n"
            f"library: {json.dumps(str(library))}\ndirectory: {json.dumps(str(root / 'music'))}\n",
            encoding="utf-8")
        with patch("sqlite3.connect", side_effect=AssertionError("Pure import attempted SQLite IO")), \
             patch("subprocess.Popen", side_effect=AssertionError("Pure import attempted a process")):
            package = importlib.import_module("beets_mix")
            origins = {"beets_mix": origin(package, output)}
            origins["beets_embed"] = origin(importlib.import_module("beets_embed"), args.embed_out.resolve())
            exports = ("extend", "apply", "Proposal", "ApplyResult")
            for name in exports:
                if not callable(getattr(package, name, None)):
                    raise AssertionError(f"Missing installed public export: {name}")
            if "beets.ui" in sys.modules or any(name == "plexapi" or name.startswith("plexapi.") for name in sys.modules):
                raise AssertionError("Pure library import eagerly imported beets UI or PlexAPI")
        if library.exists() or (root / "music").exists():
            raise AssertionError("Pure library import created catalog/music state")
        # Explicit isolated configuration, not host beets/Plex configuration.
        import beets
        import confuse

        config = confuse.Configuration("beets", "beets", read=False)
        config.read(user=False)
        config.set_file(str(config_path))
        beets.config = config
        with patch("sqlite3.connect", side_effect=AssertionError("Plugin import/constructor attempted SQLite IO")), \
             patch("subprocess.Popen", side_effect=AssertionError("Plugin import/constructor attempted a process")):
            plugin = importlib.import_module("beetsplug.mix")
            origins["beetsplug.mix"] = origin(plugin, output)
            instance = plugin.MixPlugin()
            commands = [command.name for command in instance.commands()]
            if commands != ["mix-extend", "mix-apply"]:
                raise AssertionError("Installed Mix command registration mismatch")
            configured_worker = instance.config["worker"].get(str)
            embed_plugin = importlib.import_module("beetsplug.embed")
            origins["beetsplug.embed"] = origin(embed_plugin, args.embed_out.resolve())
            if embed_plugin.WORKER != configured_worker:
                raise AssertionError("Mix and embed do not share the same installed worker")
        if configured_worker != str(args.worker) or "@embed-worker@" in configured_worker:
            raise AssertionError("Worker default is not the exact shared packaged worker")
        if not args.worker.is_absolute() or not args.worker.is_file() or not os.access(args.worker, os.X_OK):
            raise AssertionError("Packaged worker is not an absolute executable")
        if library.exists() or (root / "music").exists():
            raise AssertionError("Plugin import/constructor created catalog/music state before CLI")

        # The Python test env must NOT mask a missing default-bundle override:
        # let the built beet wrapper establish its own Python closure from zero.
        child_env = {key: value for key, value in os.environ.items()
                     if not key.startswith(("PYTHON", "NIX_PYTHON"))}
        child_env.update(PYTHONDONTWRITEBYTECODE="1", PYTHONNOUSERSITE="1")
        catalogs = []
        for command, flag in (("mix-extend", "--cluster-threshold"), ("mix-apply", "--plex-playlist")):
            result = subprocess.run([str(args.beet), "-c", str(config_path), "help", command],
                                    env=child_env, capture_output=True, text=True, timeout=30, check=True)
            if command not in result.stdout or flag not in result.stdout:
                raise AssertionError("Built default beet did not expose the requested Mix help")
            if not library.is_file() or (root / "music").exists():
                raise AssertionError(f"{command} help did not leave only the configured disposable catalog (music must be absent)")
            # Pinned native beets initializes this catalog before parsing help.
            # Inspect only that fixture, read-only and outside the import guards.
            with closing(sqlite3.connect(library.as_uri() + "?mode=ro", uri=True)) as database:
                counts = {table: database.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                          for table in ("items", "albums")}
            if any(counts.values()):
                raise AssertionError(f"{command} help populated the disposable catalog: {counts}")
            catalogs.append({"command": command, **counts})
        print(json.dumps({"status": "passed", "origins": origins, "commands": commands,
                          "exports": exports, "beet": str(args.beet),
                          "worker": configured_worker, "worker_executed": False,
                          "default_bundle_help": True, "import_constructor_library_io": False,
                          "native_cli_disposable_library_opened": True, "library_scope": "disposable",
                          "native_cli_catalog_counts": catalogs}, sort_keys=True))


if __name__ == "__main__":
    main()
