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
            if len(self._order) > _RECENT_CAP:
                self._jobs.pop(self._order.pop(0), None)
        self._idle.clear()
        self._pending.put(job.job_id)
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def recent(self, limit: int = 20) -> list[Job]:
        with self._lock:
            return [self._jobs[j] for j in reversed(self._order[-limit:])]

    def wait_idle(self, timeout: float | None = None) -> bool:
        """Block until nothing is queued or running. For tests and shutdown."""
        return self._idle.wait(timeout)

    def _loop(self) -> None:
        while True:
            job_id = self._pending.get()
            job = self.get(job_id)
            if job is not None:
                self._run_one(job)
            self._pending.task_done()
            if self._pending.empty():
                self._idle.set()

    def _run_one(self, job: Job) -> None:
        job.state = "running"
        try:
            self._runner(job)
        except Exception as exc:  # a bad job must not take down the worker
            job.error = f"{type(exc).__name__}: {exc}"
            traceback.print_exc()
        job.state = "failed" if job.error else "done"
