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
