import sys

import numpy as np
import pytest
import soundfile as sf

from bandpoc.audio import WORK_SR
from bandpoc.session import (
    SessionExists,
    add_session,
    derive_id,
    slugify,
)


def test_slugify_lowercases_and_keeps_safe_characters():
    assert slugify("Session_01-A") == "session_01-a"


def test_slugify_strips_hangul_spaces_and_brackets_but_keeps_safe_characters():
    # The ASCII "1" of "1차" is in the safe set and survives; Hangul, spaces
    # and brackets do not. A session id becomes a file path and a cache key,
    # so nothing outside [a-z0-9_-] may reach it.
    assert slugify("밴드 합주 (1차)") == "1"


def test_slugify_returns_empty_when_nothing_safe_remains():
    # derive_id turns this into a "pass --id" error rather than a bare path.
    assert slugify("밴드 합주") == ""


def test_slugify_collapses_runs_of_underscores():
    assert slugify("a   b___c") == "a_b_c"


def test_slugify_trims_leading_and_trailing_underscores():
    assert slugify("  hello  ") == "hello"


def test_derive_id_uses_the_youtube_video_id():
    assert derive_id("https://www.youtube.com/watch?v=igMctbh0pT8") == "igMctbh0pT8"


def test_derive_id_handles_short_youtube_links():
    assert derive_id("https://youtu.be/igMctbh0pT8") == "igMctbh0pT8"


def test_derive_id_handles_short_youtube_links_with_a_trailing_slash():
    # A trailing "/" must not leak a path separator into the session id:
    # that id becomes a filename component and a cache key.
    assert derive_id("https://youtu.be/igMctbh0pT8/") == "igMctbh0pT8"


def test_derive_id_uses_the_filename_stem_for_local_paths():
    assert derive_id(r"C:\recordings\Practice Take 2.wav") == "practice_take_2"


def test_derive_id_rejects_a_name_that_slugifies_to_nothing(tmp_path):
    with pytest.raises(ValueError, match="--id"):
        derive_id(str(tmp_path / "밴드.wav"))


def test_derive_id_rejects_a_path_traversal_disguised_as_a_youtube_id():
    # The `v=` query parameter is otherwise unvalidated attacker-controlled
    # text; a session id becomes a filename (explore.py writes
    # out_dir / f"{session_id}.html"), so "../../evil" must never survive as
    # one. It must fall through to the filename-stem path instead of the raw
    # query value, and must not contain a path separator or "..".
    result = derive_id("https://www.youtube.com/watch?v=../../evil")
    assert result == "evil"
    assert "/" not in result and ".." not in result


def test_derive_id_rejects_script_breakout_characters_disguised_as_a_youtube_id():
    # A session id is interpolated into the explorer page's embedded JSON
    # (explore.py). "<" and "/" must never survive as part of an id.
    result = derive_id("https://www.youtube.com/watch?v=x</script>y")
    assert "<" not in result and ">" not in result
    assert "/script" not in result


def test_add_session_converts_a_local_file_to_the_work_sample_rate(tmp_path):
    src = tmp_path / "take.wav"
    t = np.arange(8000 * 3) / 8000
    sf.write(str(src), (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), 8000)

    out = add_session(str(src), tmp_path / "scenes")

    assert out == tmp_path / "scenes" / "take.wav"
    wav, sr = sf.read(str(out), always_2d=True)
    assert sr == WORK_SR
    assert wav.shape[1] == 1
    assert len(wav) / sr == pytest.approx(3.0, abs=0.05)


def test_add_session_honours_an_explicit_id(tmp_path):
    src = tmp_path / "take.wav"
    sf.write(str(src), np.zeros(8000, dtype=np.float32), 8000)

    out = add_session(str(src), tmp_path / "scenes", session_id="session_01")

    assert out.name == "session_01.wav"


def test_add_session_rejects_an_explicit_id_that_slugifies_to_nothing(tmp_path):
    src = tmp_path / "take.wav"
    sf.write(str(src), np.zeros(8000, dtype=np.float32), 8000)

    with pytest.raises(ValueError, match="--id"):
        add_session(str(src), tmp_path / "scenes", session_id="밴드")


def test_add_session_refuses_to_overwrite_an_existing_session(tmp_path):
    src = tmp_path / "take.wav"
    sf.write(str(src), np.zeros(8000, dtype=np.float32), 8000)
    add_session(str(src), tmp_path / "scenes")

    with pytest.raises(SessionExists, match="take"):
        add_session(str(src), tmp_path / "scenes")


def test_add_session_does_not_normalise_loudness(tmp_path):
    """Real level changes are part of the signal the model will face."""
    src = tmp_path / "quiet.wav"
    sf.write(str(src), np.full(WORK_SR, 0.01, dtype=np.float32), WORK_SR)

    out = add_session(str(src), tmp_path / "scenes")

    wav, _ = sf.read(str(out), always_2d=True)
    assert float(np.abs(wav).max()) == pytest.approx(0.01, abs=0.002)


def test_add_session_downloads_a_youtube_url_through_the_running_interpreter(
    tmp_path, monkeypatch
):
    """The yt-dlp console script is only on PATH inside an activated venv."""
    import subprocess

    from bandpoc import session as session_mod

    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        # yt-dlp would have written this; stand in for it.
        target = tmp_path / "raw" / "igMctbh0pT8.wav"
        target.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(target), np.zeros(WORK_SR, dtype=np.float32), WORK_SR)

    monkeypatch.setattr(session_mod, "_raw_dir", lambda scenes_dir: tmp_path / "raw")
    monkeypatch.setattr(subprocess, "run", fake_run)

    out = add_session(
        "https://www.youtube.com/watch?v=igMctbh0pT8", tmp_path / "scenes"
    )

    assert out.name == "igMctbh0pT8.wav"
    assert calls[0][:3] == [sys.executable, "-m", "yt_dlp"]
    assert "yt-dlp" not in calls[0]
