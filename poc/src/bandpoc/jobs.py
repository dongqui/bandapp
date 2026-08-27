"""Serial job queue for browser-submitted sessions (spec section 3.1).

Knows nothing about HTTP. The server hands it a source and gets back a Job
whose state it can poll; everything about requests and responses stays on the
other side of that line.
"""

from __future__ import annotations

import contextlib
import io
import queue
import threading
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Callable, Sequence

_RECENT_CAP = 200
_TERMINAL_STATES = ("done", "failed")


@dataclass
class Job:
    job_id: str
    source: str
    detectors: tuple[str, ...]
    session_id: str | None = None
    cleanup_source: bool = False
    state: str = "queued"
    log: list[str] = field(default_factory=list)
    report_url: str | None = None
    error: str | None = None

    def snapshot(self) -> dict:
        """A plain dict the server can serialise without touching the Job."""
        return {
            "job_id": self.job_id,
            "session_id": self.session_id,
            "detectors": list(self.detectors),
            "state": self.state,
            "log": list(self.log),
            "report_url": self.report_url,
            "error": self.error,
        }


class _LogWriter(io.TextIOBase):
    """Turn a pipeline's print() stream into whole lines on a job's log."""

    def __init__(self, job: Job) -> None:
        self._job = job
        self._partial = ""

    def write(self, text: str) -> int:
        self._partial += text
        while "\n" in self._partial:
            line, self._partial = self._partial.split("\n", 1)
            self._job.log.append(line)
        return len(text)

    def flush(self) -> None:
        if self._partial:
            self._job.log.append(self._partial)
            self._partial = ""


@contextlib.contextmanager
def capture_into(job: Job):
    """Collect stdout into ``job.log`` for the duration of the block.

    cmd_run and cmd_explore already print exactly the progress a reader wants
    ("[done] s x panns_cnn14:music_group  RTF=0.0421"). Capturing that beats
    inventing a second progress channel that could disagree with the first.
    """
    writer = _LogWriter(job)
    try:
        with contextlib.redirect_stdout(writer):
            yield
    finally:
        writer.flush()


class JobQueue:
    """One worker thread, one job at a time.

    Serial on purpose: two sessions inferring concurrently would hold two
    copies of every model, and the PANNs checkpoint alone is 327 MB.
    """

    def __init__(self, runner: Callable[[Job], None]) -> None:
        self._runner = runner
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._lock = threading.Lock()
        self._pending: queue.Queue[str] = queue.Queue()
        # Count of jobs submitted but not yet finished. Guarded by _lock so
        # that the increment (submit) and decrement (worker) can never
        # interleave with the idle-event flip -- see wait_idle below.
        self._outstanding = 0
        self._idle = threading.Event()
        self._idle.set()
        self._worker = threading.Thread(target=self._loop, daemon=True)
        self._worker.start()

    def submit(
        self,
        source: str,
        detectors: Sequence[str],
        session_id: str | None = None,
        cleanup_source: bool = False,
    ) -> Job:
        job = Job(
            job_id=uuid.uuid4().hex[:12],
            source=source,
            detectors=tuple(detectors),
            session_id=session_id,
            cleanup_source=cleanup_source,
        )
        with self._lock:
            self._jobs[job.job_id] = job
            self._order.append(job.job_id)
            self._outstanding += 1
            self._idle.clear()
            self._evict_finished_over_cap_locked()
        self._pending.put(job.job_id)
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def recent(self, limit: int = 20) -> list[Job]:
        if limit <= 0:
            return []
        with self._lock:
            return [self._jobs[j] for j in reversed(self._order[-limit:])]

    def wait_idle(self, timeout: float | None = None) -> bool:
        """Block until nothing is queued or running. For tests and shutdown."""
        return self._idle.wait(timeout)

    def _evict_finished_over_cap_locked(self) -> None:
        """Drop the oldest *finished* job once the recent-window exceeds the cap.

        Must be called with ``self._lock`` held. A job that is still queued
        or running is never evicted -- a caller may be holding exactly the id
        ``submit()`` handed back and polling it, and silently losing that job
        would leave the poll returning None forever with no error and no
        state transition. A backlog is a temporary condition; losing work is
        not. If nothing has finished yet, the window is simply allowed to
        exceed the cap until something does.
        """
        while len(self._order) > _RECENT_CAP:
            for idx, jid in enumerate(self._order):
                job = self._jobs.get(jid)
                if job is not None and job.state in _TERMINAL_STATES:
                    del self._order[idx]
                    self._jobs.pop(jid, None)
                    break
            else:
                break  # nothing finished yet -- leave the window over cap

    def _loop(self) -> None:
        while True:
            job_id = self._pending.get()
            job = self.get(job_id)
            if job is not None:
                self._run_one(job)
            self._pending.task_done()
            # The decrement and the idle flip happen together, under the
            # same lock submit() uses to increment and clear. Deriving
            # idleness from _pending.empty() instead (a snapshot of a
            # different structure, read at a different moment) is what let
            # a racing submit's clear() get clobbered by this set() -- see
            # the task-1 review. This counter is the only thing wait_idle
            # answers from.
            with self._lock:
                self._outstanding -= 1
                if self._outstanding == 0:
                    self._idle.set()

    def _run_one(self, job: Job) -> None:
        job.state = "running"
        try:
            self._runner(job)
        except Exception as exc:  # a bad job must not take down the worker
            job.error = f"{type(exc).__name__}: {exc}"
            traceback.print_exc()
        job.state = "failed" if job.error else "done"


def make_runner(
    data_dir: "str | Path", reports_dir: "str | Path"
) -> Callable[[Job], None]:
    """Build the runner that walks one job through the existing pipeline.

    Calls cmd_run and cmd_explore rather than reimplementing them, so a
    browser-submitted session takes byte-for-byte the same path as a
    terminal one. Imports are deferred to keep jobs.py importable without
    dragging the whole detector registry in.
    """
    from argparse import Namespace
    from pathlib import Path

    data_dir = Path(data_dir)
    reports_dir = Path(reports_dir)

    def run(job: Job) -> None:
        from .cli import cmd_explore, cmd_run
        from .session import add_session

        detectors = ",".join(job.detectors)
        try:
            with capture_into(job):
                path = add_session(
                    job.source, data_dir / "scenes", session_id=job.session_id
                )
                job.session_id = path.stem
                print(f"[done] session {job.session_id} imported")

                if cmd_run(Namespace(
                    data_dir=str(data_dir), scenes=job.session_id,
                    detectors=detectors, force=False,
                )) != 0:
                    job.error = "inference failed; see the log"
                    return

                # One report directory per job: cmd_explore adds its own
                # timestamp underneath, so the job id alone makes the path
                # predictable without parsing anything out of the log.
                out_dir = reports_dir / job.job_id
                if cmd_explore(Namespace(
                    data_dir=str(data_dir), scenes=job.session_id,
                    detectors=detectors, out_dir=str(out_dir),
                )) != 0:
                    job.error = "explore failed; see the log"
                    return

                pages = sorted(out_dir.glob("*/index.html"))
                if not pages:
                    job.error = "explore produced no page; see the log"
                    return
                job.report_url = (
                    f"/reports/{job.job_id}/{pages[0].parent.name}/index.html"
                )
        except Exception as exc:
            job.error = f"{type(exc).__name__}: {exc}"
        finally:
            if job.cleanup_source:
                Path(job.source).unlink(missing_ok=True)

    return run
