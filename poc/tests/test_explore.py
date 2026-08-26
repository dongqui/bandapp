import shutil

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

_NODE = shutil.which("node")


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


def test_detector_version_does_not_fabricate_a_version_for_an_unknown_key():
    # Important 2: this used to return "1" for any lookup failure, which
    # became part of the cache path collect_session went looking for. That
    # happened to be right for every real detector except one, by
    # coincidence -- see _resolve_version's docstring. It must return None
    # instead, never a guess.
    assert _detector_version("no_such_detector:default") is None


def test_collect_session_reads_duration_from_the_header_not_the_samples(
    tmp_path, monkeypatch
):
    """Important 1: collect_session must never call load_audio to get the
    duration -- doing so pulls the whole session into RAM (measured 1132 MB
    peak RSS on a real 45-minute session against a 95 MB baseline; see the
    comment in collect_session). Monkeypatch load_audio in the explore
    namespace to blow up if collect_session ever calls it, and confirm the
    duration is still correct via soundfile.info.
    """
    import bandpoc.explore as explore_mod

    write_session_wav(tmp_path)  # 120.0 s, see write_session_wav's default
    cache_curve(tmp_path, "s", "dsp_baseline:default", square_curve())

    def boom(*args, **kwargs):
        raise AssertionError("collect_session must not call load_audio for duration")

    monkeypatch.setattr(explore_mod, "load_audio", boom)

    view = collect_session(tmp_path, "s", ["dsp_baseline:default"])

    assert view.duration == pytest.approx(120.0, abs=0.05)


def test_collect_session_finds_the_cache_file_when_version_lookup_fails(
    tmp_path, monkeypatch
):
    """Important 2: a registered backend's factory can raise ImportError when
    instantiated even though the key is known (registry.py defers heavy
    imports to instantiation time) -- e.g. torch/tf/hf missing at runtime.
    Before the fix, that made the version lookup fabricate "1", which
    happened to match dsp_baseline's real version by coincidence; a detector
    actually cached at a different version would be missed entirely. Here a
    real cache file exists at version "7", but the registry lookup blows up
    -- collect_session must still find and use it.
    """
    write_session_wav(tmp_path)
    cache_curve(tmp_path, "s", "dsp_baseline:default", square_curve(), version="7")

    def fake_get(key):
        raise ImportError("simulated: backend not installed")

    monkeypatch.setattr(registry, "get", fake_get)

    view = collect_session(tmp_path, "s", ["dsp_baseline:default"])

    assert [m.key for m in view.models] == ["dsp_baseline:default"]
    assert view.skipped == {}


def test_collect_session_reports_the_real_reason_when_nothing_is_cached_either(
    tmp_path, monkeypatch
):
    """Important 2: when the version lookup fails AND no cache file exists
    under any version, collect_session must say why (the real import error)
    instead of leaving the caller to conclude the cache is simply empty.
    """
    write_session_wav(tmp_path)

    def fake_get(key):
        raise ImportError("simulated: backend not installed")

    monkeypatch.setattr(registry, "get", fake_get)

    view = collect_session(tmp_path, "s", ["dsp_baseline:default"])

    assert view.models == []
    assert view.skipped == {
        "dsp_baseline:default": "simulated: backend not installed"
    }


def test_a_hard_binary_curve_gets_a_note_that_the_cutoff_does_nothing(tmp_path):
    """Minor 9: ina_segmenter and silero_vad emit hard 0/1 labels, so their
    cutoff slider does nothing across almost its whole range -- but
    `separated` doesn't catch this: Otsu's between-class variance on a clean
    0/1 split is ~0.25, comfortably above the floor, so `separated` reports
    True (autothresh.py calls this a known limitation). Detect a curve with
    essentially two distinct values directly and note it on the page.
    """
    write_session_wav(tmp_path)
    binary_curve = np.concatenate(
        [np.zeros(600, dtype=np.float32), np.ones(600, dtype=np.float32)]
    )
    cache_curve(tmp_path, "s", "silero_vad:default", binary_curve)

    view = collect_session(tmp_path, "s", ["silero_vad:default"])
    model = view.models[0]
    assert model.separated is True  # sanity: Otsu's spread check misses this
    assert model.binary is True

    html = render_session(view, "s.mp3", tmp_path / "out").read_text(encoding="utf-8")
    assert "does nothing" in html


def test_a_non_binary_curve_gets_no_binary_note(tmp_path):
    # square_curve() only has two distinct values itself (0.05 / 0.95) and
    # would trip the binary detector too -- use a curve with more than two
    # distinct values, the actual case this test wants to distinguish.
    write_session_wav(tmp_path)
    cache_curve(
        tmp_path, "s", "dsp_baseline:default",
        np.linspace(0.0, 1.0, 1200, dtype=np.float32),
    )

    view = collect_session(tmp_path, "s", ["dsp_baseline:default"])
    assert view.models[0].binary is False

    html = render_session(view, "s.mp3", tmp_path / "out").read_text(encoding="utf-8")
    assert "does nothing" not in html


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
    model = view.models[0]
    assert model.separated is False  # sanity: this is the case under test

    html = render_session(view, "flat.mp3", tmp_path / "out").read_text(encoding="utf-8")

    # The flag renders inside a single model's own row (one <section
    # class='model'> per model), so its wording must read as describing
    # THIS model, not as a page-level heading about "models" in general --
    # and it must actually carry this model's own reason text, not just a
    # fixed word that happens to survive any wording change.
    match = re.search(r'<span class="flag">(.*?)</span>', html)
    assert match, "no flag span rendered for a model that did not separate"
    flag_text = match.group(1)
    assert "does not separate" in flag_text
    assert "models" not in flag_text
    assert model.reason in flag_text


def test_the_page_has_no_external_requests(tmp_path):
    html = render_session(built_view(tmp_path), "s.mp3", tmp_path / "out").read_text(
        encoding="utf-8"
    )
    assert "http://" not in html
    assert "https://" not in html
    # A protocol-relative URL ("//cdn.example.com/x.js" in a src/href
    # attribute) reaches the network exactly like an https:// one but is not
    # caught by the checks above.
    assert '="//' not in html
    # No script-driven network calls, and no CSS-level external resource
    # loading (@import can pull in a stylesheet, and by extension whatever
    # that stylesheet references).
    assert "fetch(" not in html
    assert "XMLHttpRequest" not in html
    assert "@import" not in html


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


def _extract_to_segments_js():
    """Pull the `toSegments` function verbatim out of `bandpoc.explore._JS`.

    This is a differential test against the ACTUAL page script, not a copy
    of it -- copying the algorithm into the test would only prove the copy
    agrees with Python, which tells us nothing about whether the shipped
    page does. The end-of-function marker is a closing brace at column 0:
    every brace *inside* the function body is indented, so this cannot
    truncate early on the function's own for-loops and if-statements.
    """
    import re as re_mod

    import bandpoc.explore as explore_mod

    match = re_mod.search(r"function toSegments\(.*?\n\}\n", explore_mod._JS, re_mod.S)
    assert match, "toSegments not found in bandpoc.explore._JS"
    return match.group(0)


def _run_js_to_segments(cases):
    """Run `toSegments` under node for a batch of cases in one process.

    One node startup for the whole batch, not one per case: this test's
    whole point is to run on every push, so it has to stay fast.
    """
    import json as json_mod
    import subprocess
    import tempfile
    from pathlib import Path as PathMod

    script = _extract_to_segments_js() + """
let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  const cases = JSON.parse(data);
  const results = cases.map(c =>
    toSegments(c.scores, c.hop, c.threshold, c.mergeGap, c.minDuration));
  process.stdout.write(JSON.stringify(results));
});
"""
    with tempfile.NamedTemporaryFile(
        "w", suffix=".js", delete=False, encoding="utf-8"
    ) as f:
        f.write(script)
        script_path = f.name
    try:
        result = subprocess.run(
            ["node", script_path],
            input=json_mod.dumps(cases),
            capture_output=True,
            text=True,
            check=True,
        )
    finally:
        PathMod(script_path).unlink()
    return json_mod.loads(result.stdout)


@pytest.mark.skipif(_NODE is None, reason="node not on PATH")
def test_js_toSegments_agrees_with_python_scores_to_segments():
    """The one guard that matters (spec Section 5 R1): if the page's JS
    reimplementation of the post-processing ever disagrees with
    bandpoc.postproc.scores_to_segments, the whole tool shows a picture
    that does not match what the pipeline computes. Today that is caught
    only by a banner a human has to notice; this pins it in the suite.
    """
    from bandpoc.postproc import PostParams, scores_to_segments

    rng = np.random.default_rng(20260826)
    # Case tuples are (scores, hop, threshold, merge_gap, min_duration, dtype).
    # dtype controls what the PYTHON side is compared against -- "float32"
    # for the one fixture below that needs to match collect_session's
    # actual dtype path (see that fixture's comment); "float64" everywhere
    # else, matching a plain Python list.
    cases = {
        "run reaches the final frame": (
            [0.9] * 5 + [0.1] * 3 + [0.9] * 4, 0.1, 0.5, 0.0, 0.0, "float64"
        ),
        "run starts at frame 0": (
            [0.9] * 4 + [0.1] * 6, 0.1, 0.5, 0.0, 0.0, "float64"
        ),
        "gap exactly equal to merge_gap": (
            [0.9, 0.9, 0.1, 0.1, 0.1, 0.9, 0.9], 0.1, 0.5, 0.3, 0.0, "float64"
        ),
        "segment exactly equal to min_duration": (
            [0.9] * 5 + [0.1] * 3, 0.1, 0.5, 0.0, 0.5, "float64"
        ),
        "all above threshold": ([0.9] * 8, 0.1, 0.5, 0.0, 0.0, "float64"),
        "all below threshold": ([0.1] * 8, 0.1, 0.5, 0.0, 0.0, "float64"),
        "empty curve": ([], 0.1, 0.5, 0.0, 0.0, "float64"),
        "single frame above threshold": ([0.9], 0.1, 0.5, 0.0, 0.0, "float64"),
        "single frame below threshold": ([0.1], 0.1, 0.5, 0.0, 0.0, "float64"),
        # --- Fixtures below: each is engineered so exactly ONE boundary
        # decision determines the whole output. The scenarios above name
        # the right situations but none of them survive into the compared
        # segment lists: an isolated flipped frame is absorbed by
        # min_duration, or a generous merge_gap re-merges a shifted run
        # into its neighbour before comparison. These three cannot be
        # absorbed. Verified by hand-mutating the real toSegments source
        # (>= -> >; dropped the +1e-9 merge tolerance; >= -> > on the
        # duration filter) and rerunning this exact test -- all three
        # mutations made it fail; see the task report for the transcript.
        #
        # (a) Threshold equality must decide a WHOLE segment: every frame
        # exactly equals the threshold. With >= this is one segment
        # (0.0, 1.5); with > (mutation 1) it is zero -- no min_duration or
        # merge_gap can absorb that either way. 0.32 is exactly
        # representable at 2 decimals, and these scores are rounded to 2
        # decimals then cast to float32 -- the same path collect_session's
        # `shown` array takes -- so the "float32" dtype below reproduces
        # the ACTUAL comparison (float32 array vs a plain Python float
        # threshold), not an idealised float64 one.
        "threshold equality decides a whole segment": (
            [round(float(v), 2) for v in np.round(np.full(15, 0.32, dtype=np.float32), 2)],
            0.1, 0.32, 0.0, 1.0, "float32",
        ),
        # (b) Gap equality must decide the segment COUNT: two runs, each
        # comfortably over min_duration, separated by a gap of exactly
        # merge_gap = 1.8 s -- an ordinary value on the 0.1 s grid, not a
        # contrived one (a 10.0 s gap against merge_gap=10.0 is just as
        # ordinary and arises constantly). frame_index * hop is not exact
        # in binary floating point: the raw JS-computed gap here comes out
        # to 1.8000000000000007, a hair above 1.8. With the +1e-9
        # tolerance present, this still merges into one segment; drop the
        # tolerance (mutation 2) and it does not -- two segments instead
        # of one.
        "gap equality decides the segment count": (
            [0.9] * 30 + [0.1] * 18 + [0.9] * 30, 0.1, 0.5, 1.8, 1.0, "float64"
        ),
        # (c) Duration equality must decide survival: a single run whose
        # length is bit-exactly min_duration (1.2 s). With
        # `>= minDuration - 1e-9` it survives; mutating to `> minDuration`
        # (mutation 3) drops it, because exact equality no longer counts
        # as "big enough".
        "duration equality decides survival": (
            [0.1] + [0.9] * 12 + [0.1], 0.1, 0.5, 0.0, 1.2, "float64"
        ),
    }
    for seed in range(5):
        n = int(rng.integers(20, 200))
        scores = np.round(rng.random(n), 2).tolist()
        threshold = round(float(rng.uniform(0.1, 0.9)), 2)
        merge_gap = round(float(rng.uniform(0.0, 2.0)), 2)
        min_duration = round(float(rng.uniform(0.0, 2.0)), 2)
        cases[f"seeded random curve {seed}"] = (
            scores, 0.1, threshold, merge_gap, min_duration, "float64"
        )

    labels = list(cases.keys())
    js_results = _run_js_to_segments(
        [
            {
                "scores": cases[label][0],
                "hop": cases[label][1],
                "threshold": cases[label][2],
                "mergeGap": cases[label][3],
                "minDuration": cases[label][4],
            }
            for label in labels
        ]
    )

    for label, js_segments in zip(labels, js_results):
        scores, hop, threshold, merge_gap, min_duration, dtype = cases[label]
        params = PostParams(
            threshold=threshold, min_duration=min_duration, merge_gap=merge_gap
        )
        py_segments = [
            (s.start, s.end)
            for s in scores_to_segments(np.array(scores, dtype=dtype), hop, params)
        ]
        js_segments = [tuple(seg) for seg in js_segments]

        assert len(py_segments) == len(js_segments), (
            f"{label}: segment count differs -- python={py_segments} js={js_segments}"
        )
        for (py_start, py_end), (js_start, js_end) in zip(py_segments, js_segments):
            # Same 1e-6 tolerance the page's own drift check uses (spec
            # Section 5 R1): both languages compute frame_index * hop, which
            # is not exact in binary floating point, and Python additionally
            # rounds to 1e-10. Neither is a bug; anything above 1e-6 would be.
            assert abs(py_start - js_start) < 1e-6, (
                f"{label}: start differs -- python={py_start} js={js_start}"
            )
            assert abs(py_end - js_end) < 1e-6, (
                f"{label}: end differs -- python={py_end} js={js_end}"
            )
