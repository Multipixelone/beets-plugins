"""Exercise the patched plugin against a real library and importer file hook."""

from collections import defaultdict
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import beets
from beets import plugins, util
from beets.importer.tasks import Action, ImportTask, SingletonImportTask
from beets.library import Item, Library
from beetsplug.xtractor import XtractorPlugin
from beetsplug.xtractor.command import XtractorCommand
import pytest


@pytest.fixture
def environment(tmp_path, monkeypatch):
    beets.config.clear()
    beets.config.read(user=False)
    monkeypatch.setattr(plugins.BeetsPlugin, "listeners", defaultdict(list))
    monkeypatch.setattr(plugins.BeetsPlugin, "_raw_listeners", defaultdict(list))
    monkeypatch.setattr(plugins, "_instances", [])
    output = tmp_path / "output"
    output.mkdir()
    calls = tmp_path / "calls"
    extractor = tmp_path / "extractor"
    data = {
        "rhythm": {"bpm": 123.4, "danceability": 0.5, "beats_count": 42},
        "lowlevel": {"average_loudness": 0.4},
        "highlevel": {
            "danceability": {"all": {"danceable": 0.7}},
            "gender": {"value": "female", "all": {"male": 0.2, "female": 0.8}},
            "genre_rosamerica": {"value": "pop"},
            "voice_instrumental": {
                "value": "voice", "all": {"voice": 1.0, "instrumental": 0.0}
            },
            "moods_mirex": {
                "value": "Cluster1", "all": {f"Cluster{i}": 0.2 for i in range(1, 6)}
            },
        },
    }
    for mood in ("acoustic", "aggressive", "electronic", "happy", "sad", "party", "relaxed"):
        data["highlevel"][f"mood_{mood}"] = {"all": {mood: 0.0}}
    extractor.write_text(
        f"#!{sys.executable}\n"
        "import json, sys\nfrom pathlib import Path\n"
        f"with open({str(calls)!r}, 'a') as calls:\n    calls.write(sys.argv[1] + '\\n')\n"
        "assert Path(sys.argv[3]).is_file()\n"
        "if Path(sys.argv[1]).name == 'bad.flac':\n"
        "    Path(sys.argv[2]).write_text('partial output')\n"
        "    sys.stderr.write('invalid audio')\n    sys.exit(2)\n"
        f"Path(sys.argv[2]).write_text(json.dumps({data!r}))\n"
    )
    extractor.chmod(0o755)
    cfg = beets.config["xtractor"]
    cfg.set({"auto": True, "write": False, "quiet": True, "threads": 2,
             "output_path": str(output), "essentia_extractor": str(extractor)})
    lib = Library(str(tmp_path / "library.db"), str(tmp_path))

    def make_item(name="track.flac"):
        path = tmp_path / name
        path.write_bytes(b"unchanged audio")
        item = Item(path=str(path), title=name, artist="Test", album="Test")
        lib.add(item)
        return item

    def load_plugin():
        plugin = XtractorPlugin()
        plugins._instances.append(plugin)
        return plugin

    yield SimpleNamespace(lib=lib, cfg=cfg, output=output, calls=calls,
                          make_item=make_item, load_plugin=load_plugin)
    lib._close()
    beets.config.clear()


def import_files(env, items, singleton=False, move=False):
    task = SingletonImportTask(None, items[0]) if singleton else ImportTask(None, [], items)
    task.set_choice(Action.ASIS)
    task.manipulate_files(SimpleNamespace(lib=env.lib), write=False,
                          operation=util.MoveOperation.MOVE if move else None)


@pytest.mark.parametrize("singleton", [False, True])
def test_import_scores_persist_without_writing(environment, singleton, monkeypatch):
    env = environment
    env.load_plugin()
    item = env.make_item()
    old_item = env.make_item("unrelated.flac")
    monkeypatch.setattr(Item, "try_write", lambda *args, **kwargs: pytest.fail("tag write"))
    import_files(env, [item], singleton)
    stored = env.lib.get_item(item.id)
    assert stored.bpm == 123
    assert stored.get("mood_happy") == 0.0
    assert stored.get("is_instrumental") == 0.0
    assert stored.get("voice_instrumental") == "voice"
    assert env.lib.get_item(old_item.id).get("mood_happy") is None
    assert Path(item.filepath).read_bytes() == b"unchanged audio"
    assert env.calls.read_text().splitlines() == [str(item.filepath)]
    assert not list(env.output.iterdir())


def test_auto_defaults_off(environment):
    env = environment
    beets.config.clear()
    beets.config.read(user=False)
    env.cfg.set({"write": False, "output_path": str(env.output)})
    plugin = env.load_plugin()
    assert plugin.config["auto"].get(bool) is False
    import_files(env, [env.make_item()])
    assert not env.calls.exists()


def test_completed_items_skip_in_auto_and_manual_runs(environment):
    env = environment
    plugin = env.load_plugin()
    item = env.make_item()
    import_files(env, [item])
    # Reload: the importer task can otherwise contain stale field values.
    import_files(env, [env.lib.get_item(item.id)])
    command = XtractorCommand(plugin.config)
    command.func(env.lib, command.parser.get_default_values(), [])
    assert len(env.calls.read_text().splitlines()) == 1
    assert not list(env.output.iterdir())
    env.cfg["force"] = True
    import_files(env, [env.lib.get_item(item.id)])
    assert len(env.calls.read_text().splitlines()) == 2


def test_write_uses_resolved_path_after_persistence(environment, monkeypatch):
    env = environment
    env.cfg["write"] = True
    env.load_plugin()
    item = env.make_item()
    writes = []

    def write(item, path=None):
        assert env.lib.get_item(item.id).bpm == 123
        writes.append(path)

    monkeypatch.setattr(Item, "try_write", write)
    import_files(env, [item])
    assert writes == [str(item.filepath)]


def test_dry_run_does_not_store_or_write(environment, monkeypatch):
    env = environment
    env.cfg["dry-run"] = True
    env.cfg["write"] = True
    env.load_plugin()
    item = env.make_item()
    monkeypatch.setattr(Item, "try_write", lambda *args, **kwargs: pytest.fail("tag write"))
    import_files(env, [item])
    assert env.lib.get_item(item.id).get("mood_happy") is None
    assert env.calls.exists()


def test_failed_track_warns_and_other_tracks_continue(environment, caplog):
    env = environment
    env.load_plugin()
    bad = env.make_item("bad.flac")
    good = env.make_item("good.flac")
    import_files(env, [bad, good])
    assert env.lib.get_item(bad.id).get("mood_happy") is None
    assert env.lib.get_item(good.id).get("mood_happy") == 0.0
    assert "Extractor exited with code 2" in caplog.text
    assert not (env.output / "profile.yml").exists()
    assert not list(env.output.iterdir())
    import_files(env, [env.lib.get_item(bad.id)])
    assert len(env.calls.read_text().splitlines()) == 3


@pytest.mark.parametrize("singleton", [False, True])
def test_analysis_uses_final_path_after_move(environment, singleton):
    env = environment
    env.load_plugin()
    item = env.make_item("moved.flac")
    original = item.filepath
    import_files(env, [item], singleton, move=True)
    stored = env.lib.get_item(item.id)
    assert stored.filepath != original
    assert stored.get("mood_happy") == 0.0
    assert env.calls.read_text().splitlines() == [str(stored.filepath)]


def test_missing_output_directory_warns_without_aborting(environment, caplog):
    env = environment
    env.cfg["output_path"] = str(env.output / "missing")
    env.load_plugin()
    item = env.make_item()
    import_files(env, [item])
    assert env.lib.get_item(item.id).get("mood_happy") is None
    assert "Automatic analysis failed" in caplog.text
    assert not env.calls.exists()


def test_zero_threads_normalizes_for_import(environment, monkeypatch):
    env = environment
    env.cfg["threads"] = 0
    monkeypatch.setattr("beetsplug.xtractor.command.multiprocessing.cpu_count", lambda: 2)
    env.load_plugin()
    import_files(env, [env.make_item("one.flac"), env.make_item("two.flac")])
    assert len(env.calls.read_text().splitlines()) == 2


def test_empty_import_does_not_analyze_library(environment):
    env = environment
    env.load_plugin()
    env.make_item()
    import_files(env, [])
    assert not env.calls.exists()
    assert not list(env.output.iterdir())
