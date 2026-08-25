import numpy as np
import pytest

from bandpoc.labels import LabelBlock, SceneLabels
from bandpoc.report import DetectorResult, build_report, fig_to_data_uri
from bandpoc.sweep import SceneInput, best_point, run_sweep


@pytest.fixture
def scene():
    return SceneLabels(
        scene_id="s",
        duration=180.0,
        blocks=(
            LabelBlock(0.0, 60.0, "music", 1),
            LabelBlock(60.0, 120.0, "speech", None),
            LabelBlock(120.0, 180.0, "music", 2),
        ),
    )


def result_for(scene, key="dsp_baseline:default", available=True):
    masks = scene.frame_masks()
    curve = np.where(masks.is_music, 0.95, 0.05).astype(np.float32)
    if not available:
        return DetectorResult(key, False, "missing package: tensorflow", None, None, [], {}, {})
    points = run_sweep([SceneInput("s", curve, scene)])
    best, top = best_point(points)
    return DetectorResult(key, True, "", best, top, points, {"s": curve},
                          {"rtf": 0.02, "device": "cpu"})


def test_report_file_is_created(scene, tmp_path):
    out = build_report([result_for(scene)], {"s": scene}, tmp_path)
    assert out.exists()
    assert out.name == "index.html"


def test_report_is_self_contained(scene, tmp_path):
    out = build_report([result_for(scene)], {"s": scene}, tmp_path)
    html = out.read_text(encoding="utf-8")
    assert "http://" not in html
    assert "https://" not in html
    assert "data:image/png;base64," in html


def test_report_names_every_detector(scene, tmp_path):
    results = [result_for(scene, "dsp_baseline:default"),
               result_for(scene, "yamnet:music_group", available=False)]
    html = build_report(results, {"s": scene}, tmp_path).read_text(encoding="utf-8")
    assert "dsp_baseline:default" in html
    assert "yamnet:music_group" in html


def test_unavailable_detector_is_marked_with_its_reason(scene, tmp_path):
    results = [result_for(scene, "yamnet:music_group", available=False)]
    html = build_report(results, {"s": scene}, tmp_path).read_text(encoding="utf-8")
    assert "unavailable" in html.lower()
    assert "missing package: tensorflow" in html


def test_report_states_when_the_recall_floor_was_not_reached(scene, tmp_path):
    masks = scene.frame_masks()
    points = run_sweep([SceneInput("s", np.zeros(len(masks.is_music), np.float32), scene)])
    best, top = best_point(points)
    assert best is None
    res = DetectorResult("dsp_baseline:default", True, "", None, top, points,
                         {"s": np.zeros(len(masks.is_music), np.float32)}, {})
    html = build_report([res], {"s": scene}, tmp_path).read_text(encoding="utf-8")
    assert "90% recall not reached" in html


def test_report_carries_the_synthetic_data_caveat(scene, tmp_path):
    html = build_report([result_for(scene)], {"s": scene}, tmp_path).read_text(encoding="utf-8")
    assert "합성" in html


def test_fig_to_data_uri_returns_an_inline_png():
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots()
    ax.plot([0, 1], [0, 1])
    uri = fig_to_data_uri(fig)
    assert uri.startswith("data:image/png;base64,")
    assert len(uri) > 100
