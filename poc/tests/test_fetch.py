import numpy as np
import pytest

from bandpoc.audio import WORK_SR
from bandpoc.fetch import PoolSpec, load_sources, slice_clips


def spec(**over):
    base = dict(name="band_full", queries=("a",), urls=(), max_results=2,
                clips_per_video=3, clip_seconds=30.0)
    base.update(over)
    return PoolSpec(**base)


def test_slice_clips_returns_the_requested_count_and_length():
    wav = np.random.RandomState(0).randn(WORK_SR * 300).astype(np.float32)
    clips = slice_clips(wav, WORK_SR, spec(), np.random.default_rng(0))
    assert len(clips) == 3
    assert all(len(c) == int(30.0 * WORK_SR) for c in clips)


def test_slice_clips_skips_the_first_and_last_ten_percent():
    # Intros and outros are usually titles or silence, not rehearsal.
    wav = np.zeros(WORK_SR * 300, dtype=np.float32)
    wav[: WORK_SR * 20] = 1.0
    wav[-WORK_SR * 20 :] = 1.0
    clips = slice_clips(wav, WORK_SR, spec(clips_per_video=8), np.random.default_rng(1))
    assert all(float(np.max(np.abs(c))) == 0.0 for c in clips)


def test_slice_clips_returns_nothing_when_the_source_is_too_short():
    wav = np.zeros(WORK_SR * 10, dtype=np.float32)
    assert slice_clips(wav, WORK_SR, spec(), np.random.default_rng(0)) == []


def test_slice_clips_is_deterministic_for_a_given_seed():
    wav = np.random.RandomState(2).randn(WORK_SR * 300).astype(np.float32)
    a = slice_clips(wav, WORK_SR, spec(), np.random.default_rng(5))
    b = slice_clips(wav, WORK_SR, spec(), np.random.default_rng(5))
    for x, y in zip(a, b):
        np.testing.assert_array_equal(x, y)


def test_load_sources_parses_queries_and_urls(tmp_path):
    p = tmp_path / "sources.yaml"
    p.write_text(
        "pools:\n"
        "  band_full:\n"
        "    queries: ['밴드 합주']\n"
        "    urls: ['https://youtu.be/abc']\n"
        "    max_results: 3\n"
        "    clips_per_video: 4\n"
        "    clip_seconds: 25\n",
        encoding="utf-8",
    )
    pools = load_sources(p)
    assert len(pools) == 1
    assert pools[0].name == "band_full"
    assert pools[0].queries == ("밴드 합주",)
    assert pools[0].urls == ("https://youtu.be/abc",)
    assert pools[0].clip_seconds == 25.0


def test_load_sources_applies_defaults_for_omitted_fields(tmp_path):
    p = tmp_path / "sources.yaml"
    p.write_text("pools:\n  tuning:\n    queries: ['guitar tuning']\n", encoding="utf-8")
    pool = load_sources(p)[0]
    assert pool.urls == ()
    assert pool.max_results >= 1
    assert pool.clips_per_video >= 1
    assert pool.clip_seconds > 0


def test_load_sources_rejects_a_pool_with_neither_queries_nor_urls(tmp_path):
    p = tmp_path / "sources.yaml"
    p.write_text("pools:\n  empty: {}\n", encoding="utf-8")
    with pytest.raises(ValueError, match="empty"):
        load_sources(p)
