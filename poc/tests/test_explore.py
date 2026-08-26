import numpy as np
import pytest
import soundfile as sf

import bandpoc.detectors  # noqa: F401 - populate the registry regardless of import order
from bandpoc import cache, registry
from bandpoc.audio import WORK_SR
from bandpoc.explore import (
    DEFAULTS,
    _detector_version,
    collect_session,
    encode_mp3,
)


def write_session_wav(data_dir, session_id="s", seconds=120.0):
    scenes = data_dir / "scenes"
    scenes.mkdir(parents=True, exist_ok=True)
    path = scenes / f"{session_id}.wav"
    t = np.arange(int(WORK_SR * seconds)) / WORK_SR
    sf.write(str(path), (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), WORK_SR)
    return path


def cache_curve(data_dir, session_id, key, curve, hop=0.1, version=None):
    """Version comes from the registry, as collect_session's lookup does.
    Hardcoding "1" made these tests pass alone and fail in the full suite:
    importing bandpoc.detectors registers dsp_baseline:default at version "2",
    and the cache path stopped matching.
    """
    if version is None:
        version = _detector_version(key)
    cache.save(
        cache.cache_path(data_dir / "cache", session_id, key, version),
        np.asarray(curve, dtype=np.float32),
        hop,
        {"rtf": 0.01, "detector_version": version},
    )


def square_curve(n=1200):
    """Half quiet, half loud - two clear modes 60 s apart at 0.1 s hop."""
    return np.concatenate([np.full(n // 2, 0.05), np.full(n // 2, 0.95)]).astype(
        np.float32
    )


def test_collect_session_returns_one_model_view_per_cached_detector(tmp_path):
    write_session_wav(tmp_path)
    cache_curve(tmp_path, "s", "dsp_baseline:default", square_curve())

    view = collect_session(tmp_path, "s", ["dsp_baseline:default"])

    assert view.session_id == "s"
    assert view.duration == pytest.approx(120.0, abs=0.2)
    assert [m.key for m in view.models] == ["dsp_baseline:default"]


def test_collect_session_skips_detectors_with_no_cached_scores(tmp_path):
    write_session_wav(tmp_path)
    cache_curve(tmp_path, "s", "dsp_baseline:default", square_curve())

    view = collect_session(
        tmp_path, "s", ["dsp_baseline:default", "yamnet:music_group"]
    )

    assert [m.key for m in view.models] == ["dsp_baseline:default"]


def test_scores_are_resampled_onto_the_evaluation_grid(tmp_path):
    write_session_wav(tmp_path, seconds=100.0)
    # 1 s hop: a tenth of the frames the 0.1 s grid needs.
    cache_curve(tmp_path, "s", "dsp_baseline:default",
                np.linspace(0, 1, 100, dtype=np.float32), hop=1.0)

    view = collect_session(tmp_path, "s", ["dsp_baseline:default"])

    assert len(view.models[0].scores) == pytest.approx(1000, abs=2)


def test_a_separating_curve_gets_an_automatic_threshold(tmp_path):
    write_session_wav(tmp_path)
    cache_curve(tmp_path, "s", "dsp_baseline:default", square_curve())

    model = collect_session(tmp_path, "s", ["dsp_baseline:default"]).models[0]

    assert 0.05 < model.threshold < 0.95
    assert model.separated is True


def test_segments_use_the_automatic_threshold(tmp_path):
    write_session_wav(tmp_path)
    cache_curve(tmp_path, "s", "dsp_baseline:default", square_curve())

    model = collect_session(tmp_path, "s", ["dsp_baseline:default"]).models[0]

    assert len(model.segments) == 1
    start, end = model.segments[0]
    assert start == pytest.approx(60.0, abs=0.5)
    assert end == pytest.approx(120.0, abs=0.5)


def test_models_are_sorted_by_take_count_ascending(tmp_path):
    write_session_wav(tmp_path)
    cache_curve(tmp_path, "s", "dsp_baseline:default", square_curve())
    # Three 25 s bursts with 15 s gaps between them. The gaps must exceed
    # DEFAULTS.merge_gap (10 s) or postproc merges the bursts into one segment
    # and this test compares 1 against 1, which is true in either order.
    busy = np.zeros(1200, dtype=np.float32)
    for lo in (0, 400, 800):
        busy[lo : lo + 250] = 0.95
    cache_curve(tmp_path, "s", "silero_vad:default", busy)

    # Deliberately passed in the reverse of the expected output order, so the
    # assertions below catch a missing (or reversed) sort.
    view = collect_session(
        tmp_path, "s", ["silero_vad:default", "dsp_baseline:default"]
    )

    # Assert the ORDER, not just that the counts happen to be sorted:
    # [1, 1] == sorted([1, 1]) is trivially true regardless of which model
    # comes first, which is what let the original fixture (equal counts)
    # pass with the sort reversed, the key tie-break removed, or no sort at
    # all.
    assert [len(m.segments) for m in view.models] == [1, 3]
    assert [m.key for m in view.models] == [
        "dsp_baseline:default",
        "silero_vad:default",
    ]


def test_models_with_equal_take_counts_are_tie_broken_by_key(tmp_path):
    write_session_wav(tmp_path)
    cache_curve(tmp_path, "s", "dsp_baseline:default", square_curve())
    cache_curve(tmp_path, "s", "silero_vad:default", square_curve())

    # Passed in reverse-alphabetical order so the assertion catches a missing
    # (len(segments), key) tie-break, not just a coincidence of input order.
    view = collect_session(
        tmp_path, "s", ["silero_vad:default", "dsp_baseline:default"]
    )

    assert [len(m.segments) for m in view.models] == [1, 1]
    assert [m.key for m in view.models] == [
        "dsp_baseline:default",
        "silero_vad:default",
    ]


def test_scores_are_rounded_to_keep_the_page_small(tmp_path):
    write_session_wav(tmp_path)
    cache_curve(tmp_path, "s", "dsp_baseline:default",
                np.full(1200, 0.123456, dtype=np.float32))

    model = collect_session(tmp_path, "s", ["dsp_baseline:default"]).models[0]

    assert model.scores[0] == pytest.approx(0.12, abs=1e-9)


def test_defaults_match_the_post_processing_spec():
    assert DEFAULTS.min_duration == 20.0
    assert DEFAULTS.merge_gap == 10.0


def test_detector_version_resolves_a_registered_key_to_its_real_version():
    # Compare against the registry's own value, not a hardcoded string, so a
    # future version bump on dsp_baseline doesn't break this test too.
    assert _detector_version("dsp_baseline:default") == registry.get(
        "dsp_baseline:default"
    ).version


def test_detector_version_falls_back_for_an_unknown_key():
    assert _detector_version("no_such_detector:default") == "1"


# No registered detector in this environment raises ImportError (every backend
# imports cleanly here), so the ImportError fallback path of _detector_version
# is exercised by inspection only - see the task report.


def test_encode_mp3_writes_a_file_and_reuses_it(tmp_path):
    wav = write_session_wav(tmp_path, seconds=2.0)
    mp3 = tmp_path / "s.mp3"

    encode_mp3(wav, mp3)
    assert mp3.exists()
    first = mp3.stat().st_mtime_ns

    encode_mp3(wav, mp3)
    assert mp3.stat().st_mtime_ns == first, "an up-to-date mp3 must not be re-encoded"


def test_encode_mp3_re_encodes_when_the_wav_is_newer(tmp_path):
    import os
    import time

    wav = write_session_wav(tmp_path, seconds=2.0)
    mp3 = tmp_path / "s.mp3"
    encode_mp3(wav, mp3)
    first = mp3.stat().st_mtime_ns

    time.sleep(0.01)
    os.utime(wav, None)
    encode_mp3(wav, mp3)

    assert mp3.stat().st_mtime_ns != first


import json
import re

from bandpoc.explore import render_index, render_session


def built_view(tmp_path, session_id="s"):
    write_session_wav(tmp_path, session_id)
    cache_curve(tmp_path, session_id, "dsp_baseline:default", square_curve())
    return collect_session(tmp_path, session_id, ["dsp_baseline:default"])


def embedded_payload(html):
    match = re.search(r'<script id="session-data" type="application/json">(.*?)</script>',
                      html, re.S)
    assert match, "session data must be embedded as JSON"
    return json.loads(match.group(1))


def test_render_session_writes_a_page_named_after_the_session(tmp_path):
    view = built_view(tmp_path)
    out = render_session(view, "s.mp3", tmp_path / "out")
    assert out == tmp_path / "out" / "s.html"
    assert out.exists()


def test_the_page_references_the_mp3_relatively(tmp_path):
    html = render_session(built_view(tmp_path), "s.mp3", tmp_path / "out").read_text(
        encoding="utf-8"
    )
    assert '<audio' in html
    assert 'src="s.mp3"' in html


def test_the_page_names_every_model(tmp_path):
    html = render_session(built_view(tmp_path), "s.mp3", tmp_path / "out").read_text(
        encoding="utf-8"
    )
    assert "dsp_baseline:default" in html


def test_the_page_embeds_scores_and_the_python_reference_segments(tmp_path):
    view = built_view(tmp_path)
    html = render_session(view, "s.mp3", tmp_path / "out").read_text(encoding="utf-8")

    payload = embedded_payload(html)
    model = payload["models"][0]
    assert len(model["scores"]) == len(view.models[0].scores)
    assert model["threshold"] == view.models[0].threshold
    # The cross-check baseline for the JS reimplementation (spec § 5 R1).
    assert model["reference"] == [list(s) for s in view.models[0].segments]


def test_the_page_carries_the_post_processing_defaults(tmp_path):
    payload = embedded_payload(
        render_session(built_view(tmp_path), "s.mp3", tmp_path / "out").read_text(
            encoding="utf-8"
        )
    )
    assert payload["minDuration"] == 20.0
    assert payload["mergeGap"] == 10.0
    assert payload["hop"] == 0.1


def test_a_model_that_could_not_separate_is_flagged_in_the_page(tmp_path):
    write_session_wav(tmp_path, "flat")
    cache_curve(tmp_path, "flat", "dsp_baseline:default",
                np.full(1200, 0.4, dtype=np.float32))
    view = collect_session(tmp_path, "flat", ["dsp_baseline:default"])

    html = render_session(view, "flat.mp3", tmp_path / "out").read_text(encoding="utf-8")

    assert "do not separate" in html


def test_the_page_has_no_external_requests(tmp_path):
    html = render_session(built_view(tmp_path), "s.mp3", tmp_path / "out").read_text(
        encoding="utf-8"
    )
    assert "http://" not in html
    assert "https://" not in html


def test_render_index_lists_every_session(tmp_path):
    views = [built_view(tmp_path, "one"), built_view(tmp_path, "two")]
    out = render_index(views, tmp_path / "out")
    html = out.read_text(encoding="utf-8")

    assert out.name == "index.html"
    assert 'href="one.html"' in html
    assert 'href="two.html"' in html


def test_segments_are_derived_from_the_same_rounded_curve_as_the_scores(
    tmp_path, monkeypatch
):
    """The page's JS only ever sees the 2-decimal `scores` array; it never
    sees the full-precision curve. If `segments` (embedded as `reference`,
    the drift-check baseline for spec Section 5 R1) were computed from the
    full-precision curve while `scores` is rounded, a frame whose true value
    sits within 0.005 of the threshold can cross it only after rounding (or
    only before) -- the browser reimplementation would then legitimately
    disagree with `reference` even though neither post-processing
    implementation has a bug. That would make the drift banner cry wolf.

    This pins the invariant that `scores` and `segments` must come from the
    exact same (rounded) curve, so the only way this comparison can
    disagree is a real algorithm bug -- reusing the boundary shape found
    during investigation: threshold 0.32, frames with true value 0.319
    (which rounds up to 0.32 and so toggles from "off" to "on").
    """
    import bandpoc.explore as explore_mod
    from bandpoc.autothresh import AutoThreshold
    from bandpoc.postproc import PostParams, scores_to_segments

    monkeypatch.setattr(
        explore_mod,
        "auto_threshold",
        lambda curve: AutoThreshold(0.32, "fixed for test", True),
    )

    write_session_wav(tmp_path, "s")
    curve = np.full(1200, 0.05, dtype=np.float32)
    # 250 frames (25 s) at the boundary value -- long enough to survive
    # DEFAULTS.min_duration (20 s) if and only if rounding puts them "on".
    curve[500:750] = np.float32(0.319)
    cache_curve(tmp_path, "s", "dsp_baseline:default", curve)

    view = collect_session(tmp_path, "s", ["dsp_baseline:default"])
    model = view.models[0]

    assert model.threshold == 0.32
    params = PostParams(
        threshold=model.threshold,
        min_duration=DEFAULTS.min_duration,
        merge_gap=DEFAULTS.merge_gap,
    )
    rounded_curve = np.array(model.scores, dtype=np.float32)
    expected = [
        (s.start, s.end) for s in scores_to_segments(rounded_curve, 0.1, params)
    ]
    assert model.segments == expected
