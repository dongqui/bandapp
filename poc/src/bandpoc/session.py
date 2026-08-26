"""Whole recordings, not clips (spec § 3.1).

`bandpoc fetch` is a 30-second clip factory for building synthetic scenes.
A real rehearsal session goes in intact: the point is to see what the models
do with material nobody curated.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .audio import WORK_SR, load_audio, save_audio

_YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}


class SessionExists(ValueError):
    """Raised rather than overwriting: the score cache is keyed by session id,
    so a silent replacement would attach stale curves to new audio."""


def slugify(text: str) -> str:
    """Lowercase, keep [a-z0-9_-], collapse the rest into single underscores.

    Session ids become both file paths and cache keys, so Hangul, spaces and
    brackets must not survive into them.
    """
    lowered = str(text).strip().lower()
    replaced = re.sub(r"[^a-z0-9_-]+", "_", lowered)
    return re.sub(r"_+", "_", replaced).strip("_")


def is_url(source: str) -> bool:
    return urlparse(str(source)).scheme in {"http", "https"}


def _youtube_id(source: str) -> str | None:
    parsed = urlparse(str(source))
    if parsed.netloc not in _YOUTUBE_HOSTS:
        return None
    if parsed.netloc == "youtu.be":
        return parsed.path.lstrip("/") or None
    return (parse_qs(parsed.query).get("v") or [None])[0]


def derive_id(source: str) -> str:
    """Video id for YouTube, slugified filename stem otherwise."""
    video_id = _youtube_id(source)
    if video_id:
        return video_id
    stem = Path(str(source).replace("\\", "/")).stem
    slug = slugify(stem)
    if not slug:
        raise ValueError(
            f"cannot derive a session id from {source!r}; pass --id explicitly"
        )
    return slug


def _raw_dir(scenes_dir: str | Path) -> Path:
    return Path(scenes_dir).parent / "raw_sessions"


def _download(source: str, session_id: str, raw_dir: Path) -> Path:
    raw_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            # See fetch.py: the console script is not on PATH unless the venv
            # is activated, and bandpoc.exe does not activate it.
            sys.executable, "-m", "yt_dlp",
            "-x", "--audio-format", "wav", "--no-playlist",
            "-o", str(raw_dir / f"{session_id}.%(ext)s"), source,
        ],
        check=False,
    )
    downloaded = raw_dir / f"{session_id}.wav"
    if not downloaded.exists():
        raise RuntimeError(f"yt-dlp produced no audio for {source!r}")
    return downloaded


def add_session(
    source: str, scenes_dir: str | Path, session_id: str | None = None
) -> Path:
    """Put one whole recording under ``scenes_dir`` as ``<id>.wav``."""
    session_id = slugify(session_id) if session_id else derive_id(source)
    out = Path(scenes_dir) / f"{session_id}.wav"
    if out.exists():
        raise SessionExists(
            f"session {session_id!r} already exists at {out}; "
            "delete it or pass a different --id"
        )
    src = (
        _download(source, session_id, _raw_dir(scenes_dir))
        if is_url(source)
        else Path(source)
    )
    wav, _ = load_audio(src, target_sr=WORK_SR)
    save_audio(out, wav, WORK_SR)
    return out
