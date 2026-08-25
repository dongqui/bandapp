"""Which AudioSet classes count as music (spec § 3.2).

Names, not indices: YAMNet has 521 classes and PANNs/AST have 527, so a
hardcoded index would silently mean a different class in a different model.
Names absent from a given ontology are skipped rather than erroring, which is
what lets one variant definition serve all three AudioSet detectors.
"""

from __future__ import annotations

from typing import Sequence

import numpy as np

MUSIC_ONLY: tuple[str, ...] = ("Music",)

MUSIC_GROUP: tuple[str, ...] = (
    "Music",
    "Musical instrument",
    "Plucked string instrument",
    "Guitar",
    "Electric guitar",
    "Acoustic guitar",
    "Bass guitar",
    "Drum kit",
    "Drum",
    "Snare drum",
    "Bass drum",
    "Cymbal",
    "Hi-hat",
    "Percussion",
    "Keyboard (musical)",
    "Piano",
    "Electric piano",
    "Organ",
    "Synthesizer",
    "Singing",
    "Rock music",
    "Pop music",
)

VARIANTS: dict[str, tuple[str, ...]] = {
    "music_only": MUSIC_ONLY,
    "music_group": MUSIC_GROUP,
}


def indices_for(labels: Sequence[str], names: Sequence[str]) -> list[int]:
    lookup = {name: i for i, name in enumerate(labels)}
    idx = [lookup[n] for n in names if n in lookup]
    if not idx:
        raise ValueError(f"no matching AudioSet classes for {tuple(names)!r}")
    return idx


def score_from_logits(probs: np.ndarray, idx: list[int]) -> np.ndarray:
    """Max probability over the selected classes, per frame."""
    return np.asarray(probs, dtype=np.float32)[:, idx].max(axis=1).astype(np.float32)
