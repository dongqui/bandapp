import numpy as np
import pytest
import soundfile as sf

from bandpoc.audio import WORK_SR
from bandpoc.cli import main, score_scene
from bandpoc.detectors.dsp import DspBaseline


def write_pools(root):
    freqs = {"band_full": 220.0, "conversation": 300.0, "guitar_noodle": 660.0,
             "tuning": 440.0, "room_tone": 80.0, "drums_only": 110.0,
             "guitar_only": 550.0}
    for name, freq in freqs.items():
        d = root / name
        d.mkdir(parents=True)
        t = np.arange(WORK_SR * 30) / WORK_SR
        sf.write(str(d / "a.wav"), (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32),
                 WORK_SR)


def write_recipes(path):
    path.write_text(
        "scenes:\n"
        "  - id: tiny\n"
        "    seed: 1\n"
        "    blocks:\n"
        "      - {label: speech, pool: conversation, dur: 20}\n"
        "      - {label: music, pool: band_full, dur: 40, take: 1}\n"
        "      - {label: speech, pool: conversation, dur: 20}\n"
        "      - {label: music, pool: band_full, dur: 40, take: 2}\n",
        encoding="utf-8",
    )


def test_score_scene_reports_timing_metadata():
    det = DspBaseline()
    det.load()
    wav = np.zeros(WORK_SR * 5, dtype=np.float32)
    scores, hop, meta = score_scene(det, wav, WORK_SR)
    assert hop > 0
    assert len(scores) > 0
    assert meta["wall_s"] >= 0.0
    assert meta["duration_s"] == pytest.approx(5.0, abs=0.1)
    assert meta["rtf"] >= 0.0
    assert "peak_rss_mb" in meta


def test_build_scenes_writes_audio_and_labels(tmp_path):
    write_pools(tmp_path / "clips")
    write_recipes(tmp_path / "scenes.yaml")
    code = main(["build-scenes", "--data-dir", str(tmp_path),
                 "--recipes", str(tmp_path / "scenes.yaml")])
    assert code == 0
    assert (tmp_path / "scenes" / "tiny.wav").exists()
    assert (tmp_path / "scenes" / "tiny.labels.json").exists()


def test_run_caches_scores_and_skips_on_a_second_pass(tmp_path, capsys):
    write_pools(tmp_path / "clips")
    write_recipes(tmp_path / "scenes.yaml")
    main(["build-scenes", "--data-dir", str(tmp_path),
          "--recipes", str(tmp_path / "scenes.yaml")])

    assert main(["run", "--data-dir", str(tmp_path),
                 "--detectors", "dsp_baseline:default"]) == 0
    cached = list((tmp_path / "cache").glob("*.npz"))
    assert len(cached) == 1

    capsys.readouterr()
    assert main(["run", "--data-dir", str(tmp_path),
                 "--detectors", "dsp_baseline:default"]) == 0
    assert "cached" in capsys.readouterr().out


def test_run_force_recomputes(tmp_path, capsys):
    write_pools(tmp_path / "clips")
    write_recipes(tmp_path / "scenes.yaml")
    main(["build-scenes", "--data-dir", str(tmp_path),
          "--recipes", str(tmp_path / "scenes.yaml")])
    main(["run", "--data-dir", str(tmp_path), "--detectors", "dsp_baseline:default"])
    capsys.readouterr()
    main(["run", "--data-dir", str(tmp_path), "--detectors", "dsp_baseline:default",
          "--force"])
    assert "cached" not in capsys.readouterr().out


def test_run_survives_an_unavailable_detector(tmp_path, capsys):
    write_pools(tmp_path / "clips")
    write_recipes(tmp_path / "scenes.yaml")
    main(["build-scenes", "--data-dir", str(tmp_path),
          "--recipes", str(tmp_path / "scenes.yaml")])
    code = main(["run", "--data-dir", str(tmp_path),
                 "--detectors", "dsp_baseline:default,does_not_exist:default"])
    assert code == 0, "one bad detector must not fail the whole run"
    out = capsys.readouterr().out
    assert "does_not_exist:default" in out
    assert len(list((tmp_path / "cache").glob("*.npz"))) == 1


def test_report_produces_html_from_the_cache(tmp_path):
    write_pools(tmp_path / "clips")
    write_recipes(tmp_path / "scenes.yaml")
    main(["build-scenes", "--data-dir", str(tmp_path),
          "--recipes", str(tmp_path / "scenes.yaml")])
    main(["run", "--data-dir", str(tmp_path), "--detectors", "dsp_baseline:default"])
    code = main(["report", "--data-dir", str(tmp_path),
                 "--out-dir", str(tmp_path / "reports")])
    assert code == 0
    pages = list((tmp_path / "reports").rglob("index.html"))
    assert len(pages) == 1
    assert "dsp_baseline:default" in pages[0].read_text(encoding="utf-8")


def test_report_without_any_cache_fails_with_a_clear_message(tmp_path, capsys):
    write_pools(tmp_path / "clips")
    write_recipes(tmp_path / "scenes.yaml")
    main(["build-scenes", "--data-dir", str(tmp_path),
          "--recipes", str(tmp_path / "scenes.yaml")])
    assert main(["report", "--data-dir", str(tmp_path),
                 "--out-dir", str(tmp_path / "reports")]) == 1
    assert "bandpoc run" in capsys.readouterr().out


def test_cli_messages_encode_on_a_cp949_console():
    """Korean Windows consoles default to cp949, which has no em dash.

    `bandpoc fetch` completed its whole download and then died printing the
    closing advice, so keep every CLI string inside that codec.
    """
    import ast
    from pathlib import Path

    from bandpoc import cli

    tree = ast.parse(Path(cli.__file__).read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            try:
                node.value.encode("cp949")
            except UnicodeEncodeError as exc:
                raise AssertionError(
                    f"cli.py line {node.lineno} has a character cp949 cannot encode: {exc}"
                ) from exc


def write_session(root, session_id="session_01", seconds=4.0):
    """A wav with no labels.json beside it."""
    scenes = root / "scenes"
    scenes.mkdir(parents=True, exist_ok=True)
    t = np.arange(int(WORK_SR * seconds)) / WORK_SR
    sf.write(str(scenes / f"{session_id}.wav"),
             (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), WORK_SR)


def test_scene_ids_finds_a_wav_without_labels(tmp_path):
    from bandpoc.cli import _scene_ids

    write_session(tmp_path)
    assert _scene_ids(tmp_path, "all") == ["session_01"]


def test_scene_ids_lists_labelled_and_unlabelled_together(tmp_path):
    from bandpoc.cli import _scene_ids

    write_pools(tmp_path / "clips")
    write_recipes(tmp_path / "scenes.yaml")
    main(["build-scenes", "--data-dir", str(tmp_path),
          "--recipes", str(tmp_path / "scenes.yaml")])
    write_session(tmp_path)

    assert _scene_ids(tmp_path, "all") == ["session_01", "tiny"]


def test_labelled_scene_ids_keeps_only_scenes_with_a_labels_file(tmp_path):
    from bandpoc.cli import _labelled_scene_ids

    write_pools(tmp_path / "clips")
    write_recipes(tmp_path / "scenes.yaml")
    main(["build-scenes", "--data-dir", str(tmp_path),
          "--recipes", str(tmp_path / "scenes.yaml")])
    write_session(tmp_path)

    assert _labelled_scene_ids(tmp_path, "all") == ["tiny"]


def test_labelled_scene_ids_works_when_the_wav_was_deleted(tmp_path):
    """Minor 4: report only ever reads labels.json and the cache, never the
    wav -- a scene whose (large) wav was deleted after scoring must still be
    found.
    """
    from bandpoc.cli import _labelled_scene_ids

    write_pools(tmp_path / "clips")
    write_recipes(tmp_path / "scenes.yaml")
    main(["build-scenes", "--data-dir", str(tmp_path),
          "--recipes", str(tmp_path / "scenes.yaml")])

    (tmp_path / "scenes" / "tiny.wav").unlink()

    assert _labelled_scene_ids(tmp_path, "all") == ["tiny"]


def test_scene_ids_reports_an_unknown_id_by_name(tmp_path, capsys):
    """Minor 3: an unknown --scenes id must be named, not silently dropped."""
    from bandpoc.cli import _scene_ids

    write_session(tmp_path, "session_01")

    result = _scene_ids(tmp_path, "session_01,typoo")

    assert result == ["session_01"]
    assert "typoo" in capsys.readouterr().out


def test_report_builds_from_labels_and_cache_after_the_wav_is_deleted(tmp_path):
    """Minor 4: each session wav is large (~259 MB for 45 minutes); deleting
    it after scoring is normal housekeeping, and report must not need it.
    """
    write_pools(tmp_path / "clips")
    write_recipes(tmp_path / "scenes.yaml")
    main(["build-scenes", "--data-dir", str(tmp_path),
          "--recipes", str(tmp_path / "scenes.yaml")])
    main(["run", "--data-dir", str(tmp_path), "--detectors", "dsp_baseline:default"])

    (tmp_path / "scenes" / "tiny.wav").unlink()

    code = main(["report", "--data-dir", str(tmp_path),
                 "--out-dir", str(tmp_path / "reports")])

    assert code == 0
    pages = list((tmp_path / "reports").rglob("index.html"))
    assert len(pages) == 1
    assert "dsp_baseline:default" in pages[0].read_text(encoding="utf-8")


def test_explore_says_something_accurate_when_every_scene_id_is_a_typo(
    tmp_path, capsys
):
    """Minor 3: `explore --scenes typoo` on a populated directory must not
    blame a missing `add-session` -- "s" exists, it was just misspelled.
    """
    src = tmp_path / "take.wav"
    t = np.arange(WORK_SR * 30) / WORK_SR
    sf.write(str(src), (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), WORK_SR)
    main(["add-session", str(src), "--data-dir", str(tmp_path), "--id", "s"])
    main(["run", "--data-dir", str(tmp_path), "--detectors", "dsp_baseline:default"])
    capsys.readouterr()

    code = main(["explore", "--data-dir", str(tmp_path),
                 "--out-dir", str(tmp_path / "reports"),
                 "--scenes", "typoo"])

    out = capsys.readouterr().out
    assert code == 1
    assert "typoo" in out
    assert "add-session" not in out


def test_explore_reports_the_real_reason_when_a_detectors_version_lookup_fails(
    tmp_path, monkeypatch, capsys
):
    """Regression for Important 2: an installed-but-unimportable backend must
    not make explore fabricate a cache version and blame an empty cache.
    """
    src = tmp_path / "take.wav"
    t = np.arange(WORK_SR * 30) / WORK_SR
    sf.write(str(src), (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), WORK_SR)
    main(["add-session", str(src), "--data-dir", str(tmp_path), "--id", "s"])
    capsys.readouterr()

    from bandpoc import registry

    def fake_get(key):
        raise ImportError("simulated: backend not installed")

    monkeypatch.setattr(registry, "get", fake_get)

    code = main(["explore", "--data-dir", str(tmp_path),
                 "--out-dir", str(tmp_path / "reports"),
                 "--detectors", "dsp_baseline:default"])

    out = capsys.readouterr().out
    assert code == 1
    assert "simulated: backend not installed" in out


def test_run_scores_a_session_that_has_no_labels(tmp_path):
    write_session(tmp_path)

    assert main(["run", "--data-dir", str(tmp_path),
                 "--detectors", "dsp_baseline:default"]) == 0
    assert len(list((tmp_path / "cache").glob("*.npz"))) == 1


def test_report_skips_unlabelled_sessions_instead_of_failing(tmp_path, capsys):
    write_pools(tmp_path / "clips")
    write_recipes(tmp_path / "scenes.yaml")
    main(["build-scenes", "--data-dir", str(tmp_path),
          "--recipes", str(tmp_path / "scenes.yaml")])
    write_session(tmp_path)
    main(["run", "--data-dir", str(tmp_path), "--detectors", "dsp_baseline:default"])

    assert main(["report", "--data-dir", str(tmp_path),
                 "--out-dir", str(tmp_path / "reports")]) == 0
    pages = list((tmp_path / "reports").rglob("index.html"))
    assert "session_01" not in pages[0].read_text(encoding="utf-8")


def test_report_says_so_when_every_scene_is_unlabelled(tmp_path, capsys):
    write_session(tmp_path)
    main(["run", "--data-dir", str(tmp_path), "--detectors", "dsp_baseline:default"])

    assert main(["report", "--data-dir", str(tmp_path),
                 "--out-dir", str(tmp_path / "reports")]) == 1
    assert "bandpoc explore" in capsys.readouterr().out


def test_add_session_command_imports_a_local_file(tmp_path):
    src = tmp_path / "take.wav"
    t = np.arange(WORK_SR * 2) / WORK_SR
    sf.write(str(src), (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), WORK_SR)

    code = main(["add-session", str(src), "--data-dir", str(tmp_path),
                 "--id", "session_01"])

    assert code == 0
    assert (tmp_path / "scenes" / "session_01.wav").exists()


def test_add_session_reports_a_duplicate_without_a_traceback(tmp_path, capsys):
    src = tmp_path / "take.wav"
    sf.write(str(src), np.zeros(WORK_SR, dtype=np.float32), WORK_SR)
    main(["add-session", str(src), "--data-dir", str(tmp_path), "--id", "s"])

    assert main(["add-session", str(src), "--data-dir", str(tmp_path),
                 "--id", "s"]) == 1
    assert "already exists" in capsys.readouterr().out


def test_explore_builds_a_page_per_session_plus_an_index(tmp_path):
    src = tmp_path / "take.wav"
    t = np.arange(WORK_SR * 60) / WORK_SR
    sf.write(str(src), (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), WORK_SR)
    main(["add-session", str(src), "--data-dir", str(tmp_path), "--id", "s"])
    main(["run", "--data-dir", str(tmp_path), "--detectors", "dsp_baseline:default"])

    code = main(["explore", "--data-dir", str(tmp_path),
                 "--out-dir", str(tmp_path / "reports")])

    assert code == 0
    pages = sorted(p.name for p in (tmp_path / "reports").rglob("*.html"))
    assert pages == ["index.html", "s.html"]
    assert list((tmp_path / "reports").rglob("s.mp3"))


def test_explore_without_any_cached_scores_fails_clearly(tmp_path, capsys):
    src = tmp_path / "take.wav"
    sf.write(str(src), np.zeros(WORK_SR * 2, dtype=np.float32), WORK_SR)
    main(["add-session", str(src), "--data-dir", str(tmp_path), "--id", "s"])

    assert main(["explore", "--data-dir", str(tmp_path),
                 "--out-dir", str(tmp_path / "reports")]) == 1
    assert "bandpoc run" in capsys.readouterr().out


def test_explore_flags_an_unknown_detector_key_but_still_renders_the_good_one(
    tmp_path, capsys
):
    src = tmp_path / "take.wav"
    t = np.arange(WORK_SR * 60) / WORK_SR
    sf.write(str(src), (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), WORK_SR)
    main(["add-session", str(src), "--data-dir", str(tmp_path), "--id", "s"])
    main(["run", "--data-dir", str(tmp_path), "--detectors", "dsp_baseline:default"])

    code = main(["explore", "--data-dir", str(tmp_path),
                 "--out-dir", str(tmp_path / "reports"),
                 "--detectors", "dsp_baseline:default,bogus:xyz"])

    out = capsys.readouterr().out
    assert code == 0
    assert "bogus:xyz" in out
    assert "unknown detector" in out
    pages = sorted(p.name for p in (tmp_path / "reports").rglob("*.html"))
    assert pages == ["index.html", "s.html"]


def test_explore_says_so_plainly_when_every_detector_key_is_unknown(tmp_path, capsys):
    src = tmp_path / "take.wav"
    sf.write(str(src), np.zeros(WORK_SR, dtype=np.float32), WORK_SR)
    main(["add-session", str(src), "--data-dir", str(tmp_path), "--id", "s"])
    capsys.readouterr()  # discard add-session's own output

    code = main(["explore", "--data-dir", str(tmp_path),
                 "--out-dir", str(tmp_path / "reports"),
                 "--detectors", "bogus:xyz"])

    out = capsys.readouterr().out
    assert code == 1
    assert "unknown detector" in out
    # An all-unknown --detectors must not be blamed on a missing `bandpoc run`.
    assert "bandpoc run" not in out


def test_explore_keeps_an_already_encoded_session_when_ffmpeg_is_unavailable(
    tmp_path, monkeypatch, capsys
):
    """Regression test for the ffmpeg-missing guard in cmd_explore.

    One session ("cached") already has an mp3 newer than its wav -- the real
    encode_mp3 would short-circuit and return it without touching ffmpeg at
    all. The other ("fresh") has no mp3 and needs a real encode, which fails
    without ffmpeg. explore must still render the cached session into the
    index and cleanly skip the other one, with exit code 0.
    """
    import os
    from pathlib import Path

    for sid in ("cached", "fresh"):
        src = tmp_path / f"{sid}.wav"
        t = np.arange(WORK_SR * 30) / WORK_SR
        sf.write(str(src), (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), WORK_SR)
        main(["add-session", str(src), "--data-dir", str(tmp_path), "--id", sid])
    main(["run", "--data-dir", str(tmp_path), "--detectors", "dsp_baseline:default"])

    cached_wav = tmp_path / "scenes" / "cached.wav"
    cached_mp3 = tmp_path / "scenes" / "cached.mp3"
    cached_mp3.write_bytes(b"fake mp3 bytes")
    future = cached_wav.stat().st_mtime + 60
    os.utime(cached_mp3, (future, future))

    import bandpoc.cli as cli_module

    def fake_encode_mp3(wav_path, mp3_path):
        wav_path, mp3_path = Path(wav_path), Path(mp3_path)
        if mp3_path.exists() and mp3_path.stat().st_mtime_ns >= wav_path.stat().st_mtime_ns:
            return mp3_path
        raise RuntimeError("ffmpeg not found on PATH. Install it: winget install Gyan.FFmpeg")

    monkeypatch.setattr(cli_module, "encode_mp3", fake_encode_mp3)

    code = main(["explore", "--data-dir", str(tmp_path), "--out-dir", str(tmp_path / "reports")])

    assert code == 0
    out = capsys.readouterr().out
    assert "[skip] fresh" in out
    pages = sorted(p.name for p in (tmp_path / "reports").rglob("*.html"))
    assert pages == ["cached.html", "index.html"]
    index_html = next((tmp_path / "reports").rglob("index.html")).read_text(encoding="utf-8")
    assert "cached" in index_html
    assert "fresh" not in index_html
