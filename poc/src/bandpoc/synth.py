"""Assemble labelled test scenes from tagged clip pools (spec § 4).

Ground truth is exact by construction: the recipe declares both the label and
the Take grouping, so nothing is ever hand-labelled.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import yaml

from .audio import WORK_SR, load_audio, normalize_loudness, save_audio
from .labels import LabelBlock, SceneLabels, validate

_AUDIO_SUFFIXES = {".wav", ".flac", ".ogg", ".m4a", ".mp3"}
_ROOM_TONE_POOL = "room_tone"
_ROOM_TONE_GAIN = 0.02
_CROSSFADE_RANGE = (0.3, 1.0)


@dataclass(frozen=True)
class ClipPool:
    clips: dict[str, tuple[Path, ...]]

    @classmethod
    def from_dir(cls, root: str | Path) -> "ClipPool":
        root = Path(root)
        clips: dict[str, tuple[Path, ...]] = {}
        if not root.is_dir():
            return cls(clips=clips)
        for sub in sorted(p for p in root.iterdir() if p.is_dir()):
            files = tuple(
                sorted(f for f in sub.iterdir() if f.suffix.lower() in _AUDIO_SUFFIXES)
            )
            if files:
                clips[sub.name] = files
        return cls(clips=clips)

    def has(self, name: str) -> bool:
        return name in self.clips

    def take(self, name: str, rng: np.random.Generator) -> Path:
        if name not in self.clips:
            raise KeyError(f"clip pool {name!r} is empty or missing under the clips dir")
        files = self.clips[name]
        return files[int(rng.integers(len(files)))]


def load_recipes(path: str | Path) -> list[dict]:
    payload = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    return list(payload["scenes"])


def _draw(pool: ClipPool, name: str, n_samples: int, sr: int, rng) -> np.ndarray:
    """Pull ``n_samples`` from a random clip in ``name``, looping if too short."""
    wav, _ = load_audio(pool.take(name, rng), target_sr=sr)
    if wav.size == 0:
        return np.zeros(n_samples, dtype=np.float32)
    if wav.size < n_samples:
        wav = np.tile(wav, int(np.ceil(n_samples / wav.size)))
    start = int(rng.integers(max(1, wav.size - n_samples)))
    return np.array(wav[start : start + n_samples], dtype=np.float32)


def _mix_at_snr(base: np.ndarray, overlay: np.ndarray, snr_db: float) -> np.ndarray:
    base_rms = float(np.sqrt(np.mean(base**2))) + 1e-9
    over_rms = float(np.sqrt(np.mean(overlay**2))) + 1e-9
    target = base_rms / (10.0 ** (snr_db / 20.0))
    return (base + overlay * (target / over_rms)).astype(np.float32)


def _crossfade(prev: np.ndarray, nxt: np.ndarray, n: int) -> None:
    """Fade the tail of ``prev`` into the head of ``nxt``, in place."""
    n = min(n, len(prev), len(nxt))
    if n <= 1:
        return
    ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
    prev[-n:] *= 1.0 - ramp
    nxt[:n] *= ramp


def build_scene(
    recipe: dict, pool: ClipPool, out_dir: str | Path, sr: int = WORK_SR
) -> SceneLabels:
    rng = np.random.default_rng(int(recipe.get("seed", 0)))
    scene_id = str(recipe["id"])
    parts: list[np.ndarray] = []
    blocks: list[LabelBlock] = []
    t = 0.0

    for spec in recipe["blocks"]:
        dur = float(spec["dur"])
        n = int(round(dur * sr))
        label = str(spec["label"])
        if label == "silence":
            audio = np.zeros(n, dtype=np.float32)
        else:
            audio = normalize_loudness(_draw(pool, str(spec["pool"]), n, sr, rng), sr)
        overlay = spec.get("overlay")
        if overlay:
            over = normalize_loudness(_draw(pool, str(overlay["pool"]), n, sr, rng), sr)
            audio = _mix_at_snr(audio, over, float(overlay["snr_db"]))
        if parts:
            fade = int(rng.uniform(*_CROSSFADE_RANGE) * sr)
            _crossfade(parts[-1], audio, fade)
        parts.append(audio)
        blocks.append(
            LabelBlock(
                start=round(t, 6),
                end=round(t + dur, 6),
                label=label,
                take=None if spec.get("take") is None else int(spec["take"]),
            )
        )
        t += dur

    scene = SceneLabels(scene_id=scene_id, duration=round(t, 6), blocks=tuple(blocks))
    validate(scene)

    wav = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
    if pool.has(_ROOM_TONE_POOL) and wav.size:
        tone = normalize_loudness(_draw(pool, _ROOM_TONE_POOL, wav.size, sr, rng), sr)
        wav = (wav + tone * _ROOM_TONE_GAIN).astype(np.float32)
    peak = float(np.max(np.abs(wav))) if wav.size else 0.0
    if peak > 0.99:
        wav = (wav * (0.99 / peak)).astype(np.float32)

    out_dir = Path(out_dir)
    save_audio(out_dir / f"{scene_id}.wav", wav, sr)
    scene.to_json(out_dir / f"{scene_id}.labels.json")
    return scene
