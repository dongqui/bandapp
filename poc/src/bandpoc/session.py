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
from .fetch import ffmpeg_available

_YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}
# Real YouTube video ids are exactly this character class. The `v=` query
# parameter and the youtu.be path segment are otherwise attacker-controlled
# strings with no validation from yt-dlp or the URL parser: an id becomes a
# session id, which becomes a filename (`explore.py`'s render_session writes
# `out_dir / f"{session_id}.html"`) and an unescaped `href`. Rejecting
# anything outside [A-Za-z0-9_-] here is what keeps "../../evil" and
# "x</script>y" from ever being treated as a session id (case is kept per a
# prior ruling: real ids are case-sensitive).
_VALID_YOUTUBE_ID = re.compile(r"^[A-Za-z0-9_-]+$")


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
        segments = [segment for segment in parsed.path.split("/") if segment]
        candidate = segments[0] if segments else None
    else:
        candidate = (parse_qs(parsed.query).get("v") or [None])[0]
    # An id we cannot trust is not an id: fall through to the filename-stem
    # path (or its "pass --id explicitly" error) rather than returning
    # attacker-controlled text as a session id. See _VALID_YOUTUBE_ID above.
    if candidate is None or not _VALID_YOUTUBE_ID.match(candidate):
        return None
    return candidate


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


def _stream_subprocess(cmd: list[str]) -> int:
    """Run ``cmd``, printing its combined stdout/stderr through this
    process's own ``print()`` as each line arrives.

    jobs.capture_into works by swapping ``sys.stdout`` at the Python level
    only -- a *child* process's stdout/stderr write straight to the real
    fd 1/2, bypassing that swap entirely and confirmed to leave job.log
    empty for the whole duration of a download. Piping the child's output
    through this process's own stdout instead is what lets it land wherever
    sys.stdout currently points, capture_into included. Read and printed one
    line at a time (not collected and dumped at the end): a user watching a
    multi-minute download needs to see it progressing, not a wall of text
    once it's already done -- indistinguishable from a hang until then.

    Every line is re-encoded through cp949 with errors="replace" before
    printing: yt-dlp's own output can carry text this console's codepage
    cannot represent (a video title in a script outside cp949, say), and an
    un-sanitised print() of that would raise UnicodeEncodeError partway
    through a download.
    """
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    assert process.stdout is not None
    for line in process.stdout:
        print(line.rstrip("\n").encode("cp949", errors="replace").decode("cp949"))
    return process.wait()


def _download(source: str, session_id: str, raw_dir: Path) -> Path:
    # `-x --audio-format wav` needs ffmpeg to do the actual extraction; a
    # missing ffmpeg otherwise surfaces only after yt-dlp runs, as a
    # confusing "yt-dlp produced no audio" instead of the same clean install
    # hint `cmd_fetch` already gives (Minor 5). A local-file import never
    # reaches this function, so it never pays this check.
    if not ffmpeg_available():
        raise RuntimeError(
            "ffmpeg not found on PATH. Install it: winget install Gyan.FFmpeg"
        )
    raw_dir.mkdir(parents=True, exist_ok=True)
    # Not subprocess.run(check=False): that inherits fd 1/2 directly, so the
    # child's own output never passes through Python's sys.stdout at all --
    # see _stream_subprocess. check=False's spirit (never raise on a bad
    # exit code -- the "produced no audio" check below is what actually
    # decides success) carries over: the return code is intentionally
    # ignored here too.
    _stream_subprocess(
        [
            # See fetch.py: the console script is not on PATH unless the venv
            # is activated, and bandpoc.exe does not activate it.
            sys.executable, "-m", "yt_dlp",
            "-x", "--audio-format", "wav", "--no-playlist",
            "-o", str(raw_dir / f"{session_id}.%(ext)s"), source,
        ]
    )
    downloaded = raw_dir / f"{session_id}.wav"
    if not downloaded.exists():
        raise RuntimeError(f"yt-dlp produced no audio for {source!r}")
    return downloaded


def add_session(
    source: str, scenes_dir: str | Path, session_id: str | None = None
) -> Path:
    """Put one whole recording under ``scenes_dir`` as ``<id>.wav``."""
    if session_id:
        slug = slugify(session_id)
        if not slug:
            raise ValueError(
                f"--id {session_id!r} has no safe characters; pass a different --id"
            )
        session_id = slug
    else:
        session_id = derive_id(source)
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
