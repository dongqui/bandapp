import numpy as np
import pytest

from bandpoc.cache import cache_path, exists, load, save


def test_save_load_round_trip(tmp_path):
    scores = np.linspace(0, 1, 50).astype(np.float32)
    path = cache_path(tmp_path, "clean_basic", "panns_cnn14:music_group", "1")
    save(path, scores, 0.1, {"rtf": 0.05, "device": "cuda"})
    out = load(path)
    np.testing.assert_allclose(out.scores, scores)
    assert out.hop == pytest.approx(0.1)
    assert out.meta["rtf"] == pytest.approx(0.05)
    assert out.meta["device"] == "cuda"


def test_version_change_produces_a_different_path(tmp_path):
    a = cache_path(tmp_path, "s", "d:v", "1")
    b = cache_path(tmp_path, "s", "d:v", "2")
    assert a != b


def test_variant_change_produces_a_different_path(tmp_path):
    a = cache_path(tmp_path, "s", "d:music_only", "1")
    b = cache_path(tmp_path, "s", "d:music_group", "1")
    assert a != b


def test_path_has_no_characters_that_break_on_windows(tmp_path):
    p = cache_path(tmp_path, "s", "panns_cnn14:music_group", "1")
    assert ":" not in p.name
    assert p.suffix == ".npz"


def test_exists_is_false_before_save_and_true_after(tmp_path):
    assert not exists(tmp_path, "s", "d:v", "1")
    save(cache_path(tmp_path, "s", "d:v", "1"), np.zeros(3, dtype=np.float32), 0.1, {})
    assert exists(tmp_path, "s", "d:v", "1")


def test_empty_meta_round_trips(tmp_path):
    path = cache_path(tmp_path, "s", "d:v", "1")
    save(path, np.zeros(3, dtype=np.float32), 0.5, {})
    assert load(path).meta == {}
