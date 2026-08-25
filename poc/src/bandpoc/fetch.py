"""Collect raw material for scene synthesis from YouTube (spec § 4.1).

Pools are defined by search queries rather than fixed URLs so the harness works
without anyone hand-curating a link list. Search results are unvetted, which is
why the CLI tells you to audition the clips and delete the bad ones before
building scenes — see ``bandpoc fetch --help``.
"""

from __future__ import annotations

import shutil
import subprocess
import zlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import yaml

from .audio import WORK_SR, load_audio, normalize_loudness, save_audio

_EDGE_TRIM = 0.10  # skip the first and last 10% of a video
_DEFAULTS = dict(max_results=3, clips_per_video=4, clip_seconds=30.0)


@dataclass(frozen=True)
class PoolSpec:
    name: str
    queries: tuple[str, ...]
    urls: tuple[str, ...]
    max_results: int
    clips_per_video: int
    clip_seconds: float


def load_sources(path: str | Path) -> list[PoolSpec]:
    payload = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    pools: list[PoolSpec] = []
    for name, cfg in (payload.get("pools") or {}).items():
        cfg = cfg or {}
        queries = tuple(cfg.get("queries") or ())
        urls = tuple(cfg.get("urls") or ())
        if not queries and not urls:
            raise ValueError(f"pool {name!r} has neither queries nor urls")
        pools.append(
            PoolSpec(
                name=str(name),
                queries=queries,
                urls=urls,
                max_results=int(cfg.get("max_results", _DEFAULTS["max_results"])),
                clips_per_video=int(
                    cfg.get("clips_per_video", _DEFAULTS["clips_per_video"])
                ),
                clip_seconds=float(cfg.get("clip_seconds", _DEFAULTS["clip_seconds"])),
            )
        )
    return pools


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def slice_clips(
    wav: np.ndarray, sr: int, spec: PoolSpec, rng: np.random.Generator
) -> list[np.ndarray]:
    """Cut non-overlapping clips from the middle 80% of a source recording."""
    n = int(round(spec.clip_seconds * sr))
    lo = int(len(wav) * _EDGE_TRIM)
    hi = len(wav) - lo
    if hi - lo < n:
        return []
    candidates = np.arange(lo, hi - n + 1, n)
    if candidates.size == 0:
        return []
    order = rng.permutation(candidates.size)[: spec.clips_per_video]
    return [
        np.array(wav[s : s + n], dtype=np.float32) for s in sorted(candidates[order])
    ]


def _targets(spec: PoolSpec) -> list[str]:
    out = list(spec.urls)
    out += [f"ytsearch{spec.max_results}:{q}" for q in spec.queries]
    return out


def fetch_pool(
    spec: PoolSpec, raw_dir: str | Path, clips_dir: str | Path, sr: int = WORK_SR
) -> int:
    """Download this pool's sources and write normalised clips. Returns clip count."""
    if not ffmpeg_available():
        raise RuntimeError("ffmpeg not found on PATH. Install it: winget install Gyan.FFmpeg")
    raw_pool = Path(raw_dir) / spec.name
    raw_pool.mkdir(parents=True, exist_ok=True)
    for target in _targets(spec):
        subprocess.run(
            [
                "yt-dlp", "-x", "--audio-format", "wav", "--no-playlist",
                "--match-filter", "duration>120 & duration<3600",
                "-o", str(raw_pool / "%(id)s.%(ext)s"), target,
            ],
            check=False,
        )
    out_dir = Path(clips_dir) / spec.name
    out_dir.mkdir(parents=True, exist_ok=True)
    # crc32, not hash(): Python string hashing is salted per process, so hash()
    # would pick different clips on every run.
    rng = np.random.default_rng(zlib.crc32(spec.name.encode("utf-8")))
    count = 0
    for src in sorted(raw_pool.glob("*.wav")):
        wav, _ = load_audio(src, target_sr=sr)
        for i, clip in enumerate(slice_clips(wav, sr, spec, rng)):
            save_audio(out_dir / f"{src.stem}_{i:02d}.wav", normalize_loudness(clip, sr), sr)
            count += 1
    return count
