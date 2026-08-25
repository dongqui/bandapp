"""The cache boundary between slow inference and fast post-processing.

Keying on the detector version means bumping ``Detector.version`` after a logic
change invalidates exactly the affected curves and nothing else.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass(frozen=True)
class CachedScores:
    scores: np.ndarray
    hop: float
    meta: dict


def _sanitize(text: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in text)


def cache_path(root: str | Path, scene_id: str, detector_key: str, version: str) -> Path:
    return Path(root) / f"{_sanitize(scene_id)}__{_sanitize(detector_key)}__v{_sanitize(version)}.npz"


def save(path: str | Path, scores: np.ndarray, hop: float, meta: dict) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        p,
        scores=np.asarray(scores, dtype=np.float32),
        hop=np.float64(hop),
        meta=np.str_(json.dumps(meta, ensure_ascii=False)),
    )


def load(path: str | Path) -> CachedScores:
    with np.load(Path(path), allow_pickle=False) as data:
        return CachedScores(
            scores=np.asarray(data["scores"], dtype=np.float32),
            hop=float(data["hop"]),
            meta=json.loads(str(data["meta"])),
        )


def exists(root: str | Path, scene_id: str, detector_key: str, version: str) -> bool:
    return cache_path(root, scene_id, detector_key, version).exists()
