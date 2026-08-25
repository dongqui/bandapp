import numpy as np
import pytest

from bandpoc.detectors.audioset_classes import (
    MUSIC_GROUP,
    MUSIC_ONLY,
    VARIANTS,
    indices_for,
    score_from_logits,
)


def test_music_only_is_the_single_music_class():
    assert MUSIC_ONLY == ("Music",)


def test_music_group_contains_music_and_instrument_classes():
    assert "Music" in MUSIC_GROUP
    assert "Drum kit" in MUSIC_GROUP
    assert "Singing" in MUSIC_GROUP
    assert len(MUSIC_GROUP) > len(MUSIC_ONLY)


def test_variants_expose_both_definitions():
    assert set(VARIANTS) == {"music_only", "music_group"}


def test_indices_for_maps_names_to_positions():
    labels = ["Speech", "Music", "Guitar"]
    assert indices_for(labels, ("Music", "Guitar")) == [1, 2]


def test_indices_for_skips_names_absent_from_this_models_ontology():
    labels = ["Speech", "Music"]
    assert indices_for(labels, ("Music", "Theremin")) == [1]


def test_indices_for_raises_when_nothing_matches():
    with pytest.raises(ValueError, match="no matching"):
        indices_for(["Speech"], ("Music",))


def test_score_takes_the_max_over_selected_classes():
    probs = np.array([[0.1, 0.7, 0.3], [0.9, 0.2, 0.4]], dtype=np.float32)
    np.testing.assert_allclose(score_from_logits(probs, [1, 2]), [0.7, 0.4])


def test_score_handles_a_single_frame():
    probs = np.array([[0.1, 0.8]], dtype=np.float32)
    np.testing.assert_allclose(score_from_logits(probs, [1]), [0.8])
