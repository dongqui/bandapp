"""Explore model output on a recording with no ground truth (spec § 3.3).

Nothing here scores anything. It assembles what a human needs to judge:
the score curve, a starting cutoff, and the segments that cutoff produces.
The actual comparison happens in a browser, against the audio.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import cache, registry
from .audio import load_audio
from .autothresh import auto_threshold
from .labels import HOP
from .postproc import PostParams, resample_scores, scores_to_segments

DEFAULTS = PostParams(threshold=0.5, min_duration=20.0, merge_gap=10.0)
"""min_duration and merge_gap follow the post-processing spec; threshold is
per-model and comes from autothresh."""

_SCORE_DECIMALS = 2
"""0.01 resolution on a 0-1 curve is finer than a screen pixel and roughly
halves the page size against full float repr."""


@dataclass(frozen=True)
class ModelView:
    key: str
    scores: list[float]
    threshold: float
    reason: str
    separated: bool
    segments: list[tuple[float, float]]
    meta: dict = field(default_factory=dict)


@dataclass(frozen=True)
class SessionView:
    session_id: str
    duration: float
    models: list[ModelView]


def _detector_version(key: str) -> str:
    try:
        return registry.get(key).version
    except (KeyError, ImportError):
        return "1"


def collect_session(
    data_dir: str | Path, session_id: str, keys: list[str]
) -> SessionView:
    """Gather every cached curve for one session, ready for rendering."""
    data_dir = Path(data_dir)
    wav, sr = load_audio(data_dir / "scenes" / f"{session_id}.wav")
    duration = len(wav) / sr
    n_frames = int(np.floor(round(duration / HOP, 6)))

    models: list[ModelView] = []
    for key in keys:
        path = cache.cache_path(
            data_dir / "cache", session_id, key, _detector_version(key)
        )
        if not path.exists():
            continue
        cached = cache.load(path)
        curve = resample_scores(cached.scores, cached.hop, n_frames, HOP)
        chosen = auto_threshold(curve)
        params = PostParams(
            threshold=chosen.value,
            min_duration=DEFAULTS.min_duration,
            merge_gap=DEFAULTS.merge_gap,
        )
        models.append(
            ModelView(
                key=key,
                scores=[round(float(v), _SCORE_DECIMALS) for v in curve],
                threshold=chosen.value,
                reason=chosen.reason,
                separated=chosen.separated,
                segments=[
                    (s.start, s.end) for s in scores_to_segments(curve, HOP, params)
                ],
                meta=cached.meta,
            )
        )

    # Ascending take count: whichever model over-detects sinks to the bottom
    # where it is obvious. Fixed at load time - see the renderer.
    models.sort(key=lambda m: (len(m.segments), m.key))
    return SessionView(session_id=session_id, duration=duration, models=models)


def encode_mp3(wav_path: str | Path, mp3_path: str | Path) -> Path:
    """Encode once and keep it: a report folder is timestamped, so caching the
    mp3 beside the report would re-encode a 47-minute file every run."""
    wav_path, mp3_path = Path(wav_path), Path(mp3_path)
    if mp3_path.exists() and mp3_path.stat().st_mtime_ns >= wav_path.stat().st_mtime_ns:
        return mp3_path
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found on PATH. Install it: winget install Gyan.FFmpeg")
    mp3_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path),
         "-ac", "1", "-b:a", "128k", str(mp3_path)],
        check=True,
    )
    return mp3_path
