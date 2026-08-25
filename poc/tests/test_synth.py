import numpy as np
import pytest
import soundfile as sf

from bandpoc.audio import WORK_SR
from bandpoc.labels import SceneLabels
from bandpoc.synth import ClipPool, build_scene


@pytest.fixture
def pool(tmp_path):
    """Three pools of short tones so scenes can be built without downloads."""
    root = tmp_path / "clips"
    freqs = {"band_full": 220.0, "conversation": 300.0, "guitar_noodle": 660.0,
             "tuning": 440.0, "room_tone": 80.0}
    for name, freq in freqs.items():
        d = root / name
        d.mkdir(parents=True)
        t = np.arange(WORK_SR * 20) / WORK_SR
        wav = (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
        sf.write(str(d / "a.wav"), wav, WORK_SR)
    return ClipPool.from_dir(root)


def recipe(**over):
    base = {
        "id": "t",
        "seed": 7,
        "blocks": [
            {"label": "speech", "pool": "conversation", "dur": 5.0},
            {"label": "music", "pool": "band_full", "dur": 8.0, "take": 1},
            {"label": "speech", "pool": "conversation", "dur": 2.0, "take": 1},
            {"label": "music", "pool": "band_full", "dur": 8.0, "take": 1},
        ],
    }
    base.update(over)
    return base


def test_audio_length_matches_the_declared_block_total(pool, tmp_path):
    scene = build_scene(recipe(), pool, tmp_path)
    wav, sr = sf.read(str(tmp_path / "t.wav"))
    assert sr == WORK_SR
    assert len(wav) == pytest.approx(23.0 * WORK_SR, abs=WORK_SR * 0.01)
    assert scene.duration == pytest.approx(23.0)


def test_labels_file_round_trips_and_matches_the_recipe(pool, tmp_path):
    scene = build_scene(recipe(), pool, tmp_path)
    loaded = SceneLabels.from_json(tmp_path / "t.labels.json")
    assert loaded == scene
    assert [b.label for b in scene.blocks] == ["speech", "music", "speech", "music"]
    assert [b.take for b in scene.blocks] == [None, 1, 1, 1]


def test_take_group_spans_the_intervening_speech(pool, tmp_path):
    scene = build_scene(recipe(), pool, tmp_path)
    assert scene.ground_truth_takes() == [(5.0, 23.0)]


def test_same_seed_produces_identical_audio(pool, tmp_path):
    a = tmp_path / "a"
    b = tmp_path / "b"
    build_scene(recipe(), pool, a)
    build_scene(recipe(), pool, b)
    wav_a, _ = sf.read(str(a / "t.wav"))
    wav_b, _ = sf.read(str(b / "t.wav"))
    np.testing.assert_allclose(wav_a, wav_b, atol=1e-6)


def test_different_seed_produces_different_audio(pool, tmp_path):
    build_scene(recipe(seed=1), pool, tmp_path / "a")
    build_scene(recipe(seed=2, id="t"), pool, tmp_path / "b")
    wav_a, _ = sf.read(str(tmp_path / "a" / "t.wav"))
    wav_b, _ = sf.read(str(tmp_path / "b" / "t.wav"))
    assert not np.allclose(wav_a, wav_b, atol=1e-6)


def test_overlay_adds_energy_without_changing_the_label(pool, tmp_path):
    plain = recipe(id="plain", blocks=[
        {"label": "speech", "pool": "conversation", "dur": 10.0},
    ])
    mixed = recipe(id="mixed", blocks=[
        {"label": "speech_with_noodling", "pool": "conversation", "dur": 10.0,
         "overlay": {"pool": "guitar_noodle", "snr_db": 6.0}},
    ])
    build_scene(plain, pool, tmp_path)
    scene = build_scene(mixed, pool, tmp_path)
    a, _ = sf.read(str(tmp_path / "plain.wav"))
    b, _ = sf.read(str(tmp_path / "mixed.wav"))
    assert float(np.sqrt(np.mean(b ** 2))) > float(np.sqrt(np.mean(a ** 2)))
    assert scene.blocks[0].label == "speech_with_noodling"
    assert not scene.frame_masks().is_music.any()


def test_music_block_without_take_is_rejected(pool, tmp_path):
    bad = recipe(blocks=[{"label": "music", "pool": "band_full", "dur": 8.0}])
    with pytest.raises(ValueError, match="take"):
        build_scene(bad, pool, tmp_path)


def test_missing_pool_is_reported_by_name(pool, tmp_path):
    bad = recipe(blocks=[{"label": "music", "pool": "nope", "dur": 8.0, "take": 1}])
    with pytest.raises(KeyError, match="nope"):
        build_scene(bad, pool, tmp_path)
