"""Lazy detector registry. Factories defer heavy imports until instantiation."""

from __future__ import annotations

from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:  # importing Detector for real would make this circular:
    from .detectors.base import Detector  # registry → detectors/__init__ → registry

_FACTORIES: dict[str, "Callable[[], Detector]"] = {}


def register(key: str, factory: "Callable[[], Detector]") -> None:
    _FACTORIES[key] = factory


def get(key: str) -> "Detector":
    if key not in _FACTORIES:
        raise KeyError(f"unknown detector {key!r}; known: {sorted(_FACTORIES)}")
    return _FACTORIES[key]()


def all_keys() -> list[str]:
    return sorted(_FACTORIES)
