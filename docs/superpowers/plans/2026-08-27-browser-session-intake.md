# 브라우저 세션 투입 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 유튜브 URL이나 오디오 파일을 브라우저에서 넘기면 파이썬 백엔드가 `add-session → run → explore`를 대신 돌리는 로컬 서버를 만든다.

**Architecture:** 새 모듈 둘이 서로를 모른다 — `jobs.py`는 직렬 작업 큐와 상태만 알고 HTTP를 모르며, `server.py`는 라우팅만 알고 파이프라인을 모른다. 파이프라인은 재구현하지 않고 기존 `cmd_run`/`cmd_explore`를 `argparse.Namespace`로 그대로 호출하며, 진행 상황은 그 함수들이 이미 찍는 `print` 출력을 가로채 얻는다.

**Tech Stack:** Python 3.11 표준 라이브러리만 (`http.server`, `threading`, `queue`, `contextlib`), 바닐라 JS (프레임워크·번들러 없음), pytest

**Spec:** `docs/superpowers/specs/2026-08-27-browser-session-intake-design.md`

## Global Constraints

- 모든 작업은 `poc/` 하위. Python 3.11, `numpy<2`. **새 의존성 금지** — 서버는 표준 라이브러리만 쓴다.
- **`127.0.0.1`에만 바인딩한다. `--host` 옵션을 만들지 않는다.** 이건 임의 URL을 다운로드하고 임의 경로에 파일을 쓰는 서버다.
- **기본 포트 8765.** 포트가 이미 쓰이면 안내 후 종료한다 — 조용히 다른 포트로 옮기지 않는다.
- **업로드 상한 1GB.** `Content-Length`를 먼저 보고 거절하므로 상한을 넘는 몸통을 읽지 않는다. 초과 시 413.
- **`/reports/` 서빙은 경로 traversal을 반드시 막는다.** 이 프로젝트는 `?v=../../evil`로 traversal 구멍을 이미 한 번 냈다.
- **폴링 간격 2초**, `done`/`failed`에 닿으면 멈춘다.
- **CLI가 출력하는 모든 문자열은 cp949로 인코딩 가능해야 한다.** 한국어 Windows 콘솔 기본 코드페이지다. em dash(`—`)는 cp949에 없으므로 `--`를 쓴다. `tests/test_cli.py`가 `cli.py`·`session.py`·`explore.py`를 이미 검사하며, 이 계획은 `server.py`와 `jobs.py`를 그 목록에 추가한다.
- **파이프라인을 재구현하지 않는다.** `session.add_session`, `cli.cmd_run`, `cli.cmd_explore`를 그대로 부른다.
- 기존 CLI 여섯 명령(`fetch`/`build-scenes`/`run`/`report`/`add-session`/`explore`)은 전부 그대로 동작해야 한다.
- 네트워크를 타는 테스트를 만들지 않는다. 유튜브 다운로드는 `subprocess.run`을 가로채 검증한다.
- 커밋 메시지는 영어, Conventional Commits.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `poc/src/bandpoc/jobs.py` | `Job`, `JobQueue`(직렬 워커), stdout 캡처, 파이프라인 러너 |
| `poc/src/bandpoc/server.py` | 라우팅, 요청 파싱, JSON 응답, 정적 서빙, 폼 페이지 |
| `poc/src/bandpoc/cli.py` | `serve` 서브커맨드 추가 |
| `poc/tests/test_jobs.py` | 큐 직렬성, 상태 전이, 로그 캡처, 러너 |
| `poc/tests/test_server.py` | 라우트, 몸통 파싱, traversal 차단, 폼 페이지 |
| `poc/tests/test_cli.py` | `serve` 배선, cp949 가드 확대 |
| `poc/README.md` | 브라우저 사용법, 로컬 전용 경고 |

---

### Task 1: 작업 큐와 로그 캡처

**Files:**
- Create: `poc/src/bandpoc/jobs.py`
- Test: `poc/tests/test_jobs.py`

**Interfaces:**
- Consumes: 없음 (표준 라이브러리만)
- Produces:
  - `bandpoc.jobs.Job` — `dataclass(job_id, source, detectors: tuple[str,...], session_id: str|None, cleanup_source: bool, state: str, log: list[str], report_url: str|None, error: str|None)`, 메서드 `snapshot() -> dict`
  - `bandpoc.jobs.JobQueue(runner: Callable[[Job], None])` — `submit(source, detectors, session_id=None, cleanup_source=False) -> Job`, `get(job_id) -> Job|None`, `recent(limit=20) -> list[Job]`, `wait_idle(timeout=None) -> bool`
  - `bandpoc.jobs.capture_into(job)` — 컨텍스트 매니저

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_jobs.py`:

```python
import threading
import time

import pytest

from bandpoc.jobs import Job, JobQueue, capture_into


def test_submit_returns_a_queued_job_with_an_id():
    q = JobQueue(runner=lambda job: None)
    job = q.submit("https://example.com/x", ["dsp_baseline:default"])
    assert job.job_id
    assert job.detectors == ("dsp_baseline:default",)
    assert q.wait_idle(timeout=5)
    assert q.get(job.job_id).state == "done"


def test_get_returns_none_for_an_unknown_id():
    q = JobQueue(runner=lambda job: None)
    assert q.get("nope") is None


def test_a_runner_exception_marks_the_job_failed_without_killing_the_worker():
    def boom(job):
        raise ValueError("kaboom")

    q = JobQueue(runner=boom)
    first = q.submit("a", ["k"])
    assert q.wait_idle(timeout=5)
    assert q.get(first.job_id).state == "failed"
    assert "kaboom" in q.get(first.job_id).error

    # The worker must survive to take the next job.
    q2_runner_ran = []
    q._runner = lambda job: q2_runner_ran.append(job.job_id)
    second = q.submit("b", ["k"])
    assert q.wait_idle(timeout=5)
    assert q2_runner_ran == [second.job_id]
    assert q.get(second.job_id).state == "done"


def test_a_runner_that_sets_error_marks_the_job_failed():
    def sets_error(job):
        job.error = "inference failed; see the log"

    q = JobQueue(runner=sets_error)
    job = q.submit("a", ["k"])
    assert q.wait_idle(timeout=5)
    assert q.get(job.job_id).state == "failed"


def test_jobs_run_one_at_a_time():
    """Two sessions inferring at once would load every model twice."""
    overlap = []
    running = []
    lock = threading.Lock()

    def slow(job):
        with lock:
            running.append(job.job_id)
            overlap.append(len(running))
        time.sleep(0.05)
        with lock:
            running.remove(job.job_id)

    q = JobQueue(runner=slow)
    for _ in range(4):
        q.submit("a", ["k"])
    assert q.wait_idle(timeout=10)
    assert max(overlap) == 1, f"jobs overlapped: {overlap}"


def test_recent_returns_newest_first():
    q = JobQueue(runner=lambda job: None)
    ids = [q.submit(str(i), ["k"]).job_id for i in range(3)]
    assert q.wait_idle(timeout=5)
    assert [j.job_id for j in q.recent()] == list(reversed(ids))


def test_snapshot_is_json_safe():
    import json

    q = JobQueue(runner=lambda job: None)
    job = q.submit("a", ["k"])
    assert q.wait_idle(timeout=5)
    json.dumps(q.get(job.job_id).snapshot())


def test_capture_into_collects_printed_lines():
    job = Job(job_id="j", source="s", detectors=())
    with capture_into(job):
        print("[done] one")
        print("[skip] two")
    assert job.log == ["[done] one", "[skip] two"]


def test_capture_into_keeps_a_line_with_no_trailing_newline():
    job = Job(job_id="j", source="s", detectors=())
    with capture_into(job):
        print("partial", end="")
    assert job.log == ["partial"]


def test_capture_into_flushes_even_when_the_body_raises():
    job = Job(job_id="j", source="s", detectors=())
    with pytest.raises(RuntimeError):
        with capture_into(job):
            print("before the failure")
            raise RuntimeError("boom")
    assert job.log == ["before the failure"]
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_jobs.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'bandpoc.jobs'`

- [ ] **Step 3: `jobs.py` 구현**

`poc/src/bandpoc/jobs.py`:

```python
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
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_jobs.py -v
```

Expected: 10 passed

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/jobs.py poc/tests/test_jobs.py
git commit -m "feat(poc): add a serial job queue with stdout capture"
```

---

### Task 2: 파이프라인 러너

**Files:**
- Modify: `poc/src/bandpoc/jobs.py` (러너 추가)
- Test: `poc/tests/test_jobs.py` (추가)

**Interfaces:**
- Consumes: Task 1의 `Job`, `capture_into`; `bandpoc.session.add_session`, `bandpoc.cli.cmd_run`, `bandpoc.cli.cmd_explore`
- Produces:
  - `bandpoc.jobs.make_runner(data_dir: str | Path, reports_dir: str | Path) -> Callable[[Job], None]`

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_jobs.py` 끝에 추가:

```python
import numpy as np
import soundfile as sf

from bandpoc.audio import WORK_SR
from bandpoc.jobs import make_runner


def write_wav(path, seconds=40.0):
    path.parent.mkdir(parents=True, exist_ok=True)
    t = np.arange(int(WORK_SR * seconds)) / WORK_SR
    tone = 0.3 * np.sin(2 * np.pi * 220 * t)
    tone[: int(WORK_SR * seconds / 2)] *= 0.01  # quiet half, loud half
    sf.write(str(path), tone.astype(np.float32), WORK_SR)
    return path


def test_runner_walks_add_session_then_run_then_explore(tmp_path):
    src = write_wav(tmp_path / "src" / "take.wav")
    runner = make_runner(tmp_path / "data", tmp_path / "reports")
    job = Job(job_id="j1", source=str(src), detectors=("dsp_baseline:default",))

    runner(job)

    assert job.error is None, job.error
    assert job.session_id == "take"
    assert (tmp_path / "data" / "scenes" / "take.wav").exists()
    assert list((tmp_path / "data" / "cache").glob("*.npz"))
    assert job.report_url and job.report_url.startswith("/reports/j1/")
    served = tmp_path / "reports" / job.report_url[len("/reports/"):]
    assert served.is_file()


def test_runner_puts_pipeline_output_in_the_job_log(tmp_path):
    src = write_wav(tmp_path / "src" / "take.wav")
    runner = make_runner(tmp_path / "data", tmp_path / "reports")
    job = Job(job_id="j2", source=str(src), detectors=("dsp_baseline:default",))

    runner(job)

    assert any("[done]" in line for line in job.log), job.log


def test_runner_honours_an_explicit_session_id(tmp_path):
    src = write_wav(tmp_path / "src" / "take.wav")
    runner = make_runner(tmp_path / "data", tmp_path / "reports")
    job = Job(job_id="j3", source=str(src), detectors=("dsp_baseline:default",),
              session_id="my_session")

    runner(job)

    assert job.session_id == "my_session"
    assert (tmp_path / "data" / "scenes" / "my_session.wav").exists()


def test_runner_reports_a_duplicate_session_as_an_error(tmp_path):
    src = write_wav(tmp_path / "src" / "take.wav")
    runner = make_runner(tmp_path / "data", tmp_path / "reports")
    runner(Job(job_id="j4", source=str(src), detectors=("dsp_baseline:default",)))

    second = Job(job_id="j5", source=str(src), detectors=("dsp_baseline:default",))
    runner(second)

    assert second.error and "already exists" in second.error
    assert second.report_url is None


def test_runner_deletes_an_uploaded_source_when_asked(tmp_path):
    src = write_wav(tmp_path / "src" / "upload.wav")
    runner = make_runner(tmp_path / "data", tmp_path / "reports")
    job = Job(job_id="j6", source=str(src), detectors=("dsp_baseline:default",),
              cleanup_source=True)

    runner(job)

    assert job.error is None, job.error
    assert not src.exists(), "the temporary upload must not be left behind"


def test_runner_deletes_an_uploaded_source_even_on_failure(tmp_path):
    src = write_wav(tmp_path / "src" / "upload.wav")
    runner = make_runner(tmp_path / "data", tmp_path / "reports")
    runner(Job(job_id="j7", source=str(src), detectors=("dsp_baseline:default",),
               session_id="taken"))
    again = write_wav(tmp_path / "src" / "upload.wav")

    job = Job(job_id="j8", source=str(again), detectors=("dsp_baseline:default",),
              session_id="taken", cleanup_source=True)
    runner(job)

    assert job.error
    assert not again.exists()
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_jobs.py -v -k runner
```

Expected: FAIL — `ImportError: cannot import name 'make_runner' from 'bandpoc.jobs'`

- [ ] **Step 3: 러너 구현**

`poc/src/bandpoc/jobs.py` 끝에 추가:

```python
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
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_jobs.py -v
```

Expected: 16 passed. `ffmpeg`이 PATH에 없어 실패하면 `C:\Users\kimwi\AppData\Local\Microsoft\WinGet\Links`를 PATH 앞에 붙이고 재시도한다.

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/jobs.py poc/tests/test_jobs.py
git commit -m "feat(poc): run the existing pipeline from a job"
```

---

### Task 3: API 라우트

**Files:**
- Create: `poc/src/bandpoc/server.py`
- Test: `poc/tests/test_server.py`

**Interfaces:**
- Consumes: Task 1-2의 `JobQueue`, `Job`; `bandpoc.registry.all_keys`
- Produces:
  - `bandpoc.server.MAX_UPLOAD_BYTES: int` — `1024 ** 3`
  - `bandpoc.server.make_handler(job_queue, reports_dir, detector_keys) -> type[BaseHTTPRequestHandler]`
  - `bandpoc.server.serve(data_dir, reports_dir, port=8765) -> int`

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_server.py`:

```python
import json
import threading
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from bandpoc.jobs import JobQueue
from bandpoc.server import MAX_UPLOAD_BYTES, make_handler

KEYS = ["dsp_baseline:default", "yamnet:music_group"]


@pytest.fixture
def server(tmp_path):
    """A live server on an ephemeral port, with a runner that does nothing."""
    ran = []
    queue = JobQueue(runner=lambda job: ran.append(job.job_id))
    reports = tmp_path / "reports"
    reports.mkdir()
    handler = make_handler(queue, reports, KEYS)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    yield base, queue, reports, ran
    httpd.shutdown()
    httpd.server_close()


def get_json(url):
    with urlopen(url) as response:
        return response.status, json.loads(response.read())


def post_json(url, payload):
    request = Request(url, data=json.dumps(payload).encode(),
                      headers={"Content-Type": "application/json"}, method="POST")
    with urlopen(request) as response:
        return response.status, json.loads(response.read())


def test_detectors_endpoint_lists_the_registered_keys(server):
    base, _, _, _ = server
    status, body = get_json(f"{base}/api/detectors")
    assert status == 200
    assert body["detectors"] == KEYS


def test_posting_a_url_creates_a_job(server):
    base, queue, _, _ = server
    status, body = post_json(f"{base}/api/sessions",
                             {"url": "https://youtu.be/abc", "detectors": KEYS[:1]})
    assert status == 202
    job = queue.get(body["job_id"])
    assert job is not None
    assert job.source == "https://youtu.be/abc"
    assert job.detectors == (KEYS[0],)


def test_posting_a_url_with_an_explicit_id(server):
    base, queue, _, _ = server
    _, body = post_json(f"{base}/api/sessions",
                        {"url": "https://youtu.be/abc", "detectors": KEYS[:1],
                         "id": "my_session"})
    assert queue.get(body["job_id"]).session_id == "my_session"


def test_posting_a_file_body_writes_it_and_creates_a_job(server, tmp_path):
    base, queue, _, _ = server
    request = Request(
        f"{base}/api/sessions", data=b"RIFFfake-wav-bytes",
        headers={"Content-Type": "application/octet-stream",
                 "X-Filename": "Practice Take 2.wav",
                 "X-Detectors": KEYS[0]},
        method="POST",
    )
    with urlopen(request) as response:
        body = json.loads(response.read())

    job = queue.get(body["job_id"])
    assert job.cleanup_source is True
    from pathlib import Path
    assert Path(job.source).read_bytes() == b"RIFFfake-wav-bytes"
    assert Path(job.source).suffix == ".wav"


def test_an_upload_with_no_id_derives_one_from_the_filename(server):
    base, queue, _, _ = server
    request = Request(
        f"{base}/api/sessions", data=b"x",
        headers={"Content-Type": "application/octet-stream",
                 "X-Filename": "Practice Take 2.wav", "X-Detectors": KEYS[0]},
        method="POST",
    )
    with urlopen(request) as response:
        body = json.loads(response.read())
    assert queue.get(body["job_id"]).session_id == "practice_take_2"


def test_a_request_over_the_upload_cap_is_refused(server):
    base, _, _, _ = server
    request = Request(
        f"{base}/api/sessions", data=b"x",
        headers={"Content-Type": "application/octet-stream",
                 "X-Filename": "a.wav", "X-Detectors": KEYS[0],
                 "Content-Length": str(MAX_UPLOAD_BYTES + 1)},
        method="POST",
    )
    with pytest.raises(HTTPError) as excinfo:
        urlopen(request)
    assert excinfo.value.code == 413


def test_a_request_with_no_source_is_rejected(server):
    base, _, _, _ = server
    with pytest.raises(HTTPError) as excinfo:
        post_json(f"{base}/api/sessions", {"detectors": KEYS[:1]})
    assert excinfo.value.code == 400


def test_malformed_json_is_rejected(server):
    base, _, _, _ = server
    request = Request(f"{base}/api/sessions", data=b"{not json",
                      headers={"Content-Type": "application/json"}, method="POST")
    with pytest.raises(HTTPError) as excinfo:
        urlopen(request)
    assert excinfo.value.code == 400


def test_an_unknown_detector_key_is_rejected(server):
    base, _, _, _ = server
    with pytest.raises(HTTPError) as excinfo:
        post_json(f"{base}/api/sessions",
                  {"url": "https://youtu.be/abc", "detectors": ["bogus:xyz"]})
    assert excinfo.value.code == 400


def test_no_detectors_selected_is_rejected(server):
    base, _, _, _ = server
    with pytest.raises(HTTPError) as excinfo:
        post_json(f"{base}/api/sessions",
                  {"url": "https://youtu.be/abc", "detectors": []})
    assert excinfo.value.code == 400


def test_polling_a_job_returns_its_snapshot(server):
    base, queue, _, _ = server
    _, body = post_json(f"{base}/api/sessions",
                        {"url": "https://youtu.be/abc", "detectors": KEYS[:1]})
    assert queue.wait_idle(timeout=5)
    status, snapshot = get_json(f"{base}/api/jobs/{body['job_id']}")
    assert status == 200
    assert snapshot["state"] == "done"
    assert snapshot["job_id"] == body["job_id"]


def test_polling_an_unknown_job_is_a_404(server):
    base, _, _, _ = server
    with pytest.raises(HTTPError) as excinfo:
        get_json(f"{base}/api/jobs/nosuchjob")
    assert excinfo.value.code == 404


def test_the_job_list_returns_newest_first(server):
    base, queue, _, _ = server
    ids = [post_json(f"{base}/api/sessions",
                     {"url": f"https://youtu.be/{i}", "detectors": KEYS[:1]})[1]["job_id"]
           for i in range(3)]
    assert queue.wait_idle(timeout=5)
    _, body = get_json(f"{base}/api/jobs")
    assert [j["job_id"] for j in body["jobs"]] == list(reversed(ids))


def test_an_unknown_path_is_a_404(server):
    base, _, _, _ = server
    with pytest.raises(HTTPError) as excinfo:
        get_json(f"{base}/api/nope")
    assert excinfo.value.code == 404
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_server.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'bandpoc.server'`

- [ ] **Step 3: `server.py` 구현 (API 부분)**

`poc/src/bandpoc/server.py`:

```python
"""Local HTTP front end for session intake (spec section 3.2).

Knows nothing about the pipeline: it parses requests, hands a source to the
job queue, and reports what the queue says. Binds to 127.0.0.1 only -- this
downloads arbitrary URLs and writes arbitrary paths, so there is deliberately
no --host to get wrong.
"""

from __future__ import annotations

import json
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

MAX_UPLOAD_BYTES = 1024 ** 3
"""1 GB. A 45-minute 48 kHz mono wav is 259 MB, so a 3-hour session fits,
while a runaway request cannot fill the disk."""

_HOST = "127.0.0.1"
DEFAULT_PORT = 8765


def make_handler(job_queue, reports_dir: str | Path, detector_keys: list[str]):
    """Build a handler class bound to one queue, report root and key list."""
    reports_root = Path(reports_dir).resolve()
    known_keys = list(detector_keys)

    class Handler(BaseHTTPRequestHandler):
        server_version = "bandpoc"

        def log_message(self, fmt, *args):  # keep the console for job output
            pass

        # --- helpers ------------------------------------------------------

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, obj, status: int = 200) -> None:
            self._send(status, json.dumps(obj).encode("utf-8"),
                       "application/json; charset=utf-8")

        def _fail(self, status: int, message: str) -> None:
            self.send_error(status, message)

        # --- GET ----------------------------------------------------------

        def do_GET(self) -> None:
            path = unquote(urlparse(self.path).path)
            if path == "/":
                self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")
            elif path == "/api/detectors":
                self._json({"detectors": known_keys})
            elif path == "/api/jobs":
                self._json({"jobs": [j.snapshot() for j in job_queue.recent()]})
            elif path.startswith("/api/jobs/"):
                job = job_queue.get(path[len("/api/jobs/"):])
                if job is None:
                    self._fail(404, "no such job")
                else:
                    self._json(job.snapshot())
            elif path.startswith("/reports/"):
                self._serve_report(path[len("/reports/"):])
            else:
                self._fail(404, "not found")

        # --- POST ---------------------------------------------------------

        def do_POST(self) -> None:
            if unquote(urlparse(self.path).path) != "/api/sessions":
                self._fail(404, "not found")
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                self._fail(400, "bad Content-Length")
                return
            # Refuse before reading: an oversized body must not be pulled off
            # the socket just to be discarded.
            if length > MAX_UPLOAD_BYTES:
                self._fail(413, "upload too large")
                return

            body = self.rfile.read(length) if length else b""
            content_type = self.headers.get("Content-Type", "")
            if content_type.startswith("application/json"):
                ok = self._submit_url(body)
            else:
                ok = self._submit_upload(body)
            if ok is not None:
                self._json({"job_id": ok}, status=202)

        def _detectors_or_fail(self, requested) -> list[str] | None:
            if not requested:
                self._fail(400, "select at least one detector")
                return None
            unknown = [k for k in requested if k not in known_keys]
            if unknown:
                self._fail(400, f"unknown detector(s): {', '.join(unknown)}")
                return None
            return list(requested)

        def _submit_url(self, body: bytes) -> str | None:
            try:
                payload = json.loads(body or b"{}")
            except ValueError:
                self._fail(400, "body is not valid JSON")
                return None
            url = (payload.get("url") or "").strip()
            if not url:
                self._fail(400, "no url given")
                return None
            detectors = self._detectors_or_fail(payload.get("detectors") or [])
            if detectors is None:
                return None
            session_id = (payload.get("id") or "").strip() or None
            return job_queue.submit(url, detectors, session_id=session_id).job_id

        def _submit_upload(self, body: bytes) -> str | None:
            if not body:
                self._fail(400, "empty upload")
                return None
            raw = (self.headers.get("X-Detectors") or "").split(",")
            detectors = self._detectors_or_fail([k.strip() for k in raw if k.strip()])
            if detectors is None:
                return None

            from .session import slugify

            filename = self.headers.get("X-Filename") or "upload.wav"
            # The filename is used for its extension and to suggest an id.
            # It never becomes part of a path: slugify decides that.
            suffix = Path(filename).suffix.lower() or ".wav"
            session_id = (self.headers.get("X-Session-Id") or "").strip()
            session_id = slugify(session_id) if session_id else slugify(Path(filename).stem)
            handle, temp_path = tempfile.mkstemp(suffix=suffix, prefix="bandpoc-")
            with open(handle, "wb") as out:
                out.write(body)
            return job_queue.submit(
                temp_path, detectors, session_id=session_id or None,
                cleanup_source=True,
            ).job_id

    return Handler
```

주의: `PAGE`와 `_serve_report`는 Task 4-5에서 채운다. 이 태스크에서는 다음 두
스텁을 파일 하단에 둔다 — 테스트가 임포트할 수 있어야 하기 때문이다.

```python
PAGE = "<!doctype html><title>bandpoc</title><p>form arrives in a later task"
```

그리고 `Handler` 안에 임시 구현을 둔다:

```python
        def _serve_report(self, rel: str) -> None:
            self._fail(404, "static serving arrives in a later task")
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_server.py -v
```

Expected: 14 passed

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/server.py poc/tests/test_server.py
git commit -m "feat(poc): add the session intake API"
```

---

### Task 4: 리포트 정적 서빙과 traversal 차단

**Files:**
- Modify: `poc/src/bandpoc/server.py` (`_serve_report` 교체)
- Test: `poc/tests/test_server.py` (추가)

**Interfaces:**
- Consumes: Task 3의 `make_handler`
- Produces: 없음 (`_serve_report` 동작만 바뀐다)

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_server.py` 끝에 추가:

```python
from urllib.parse import quote


def read_bytes(url):
    with urlopen(url) as response:
        return response.status, response.read(), response.headers["Content-Type"]


def test_a_report_file_is_served(server):
    base, _, reports, _ = server
    (reports / "j1" / "20260827-120000").mkdir(parents=True)
    page = reports / "j1" / "20260827-120000" / "index.html"
    page.write_text("<h1>hello</h1>", encoding="utf-8")

    status, body, ctype = read_bytes(f"{base}/reports/j1/20260827-120000/index.html")

    assert status == 200
    assert b"hello" in body
    assert "text/html" in ctype


def test_an_mp3_is_served_with_an_audio_content_type(server):
    base, _, reports, _ = server
    (reports / "j1").mkdir(parents=True)
    (reports / "j1" / "s.mp3").write_bytes(b"ID3fake")

    status, body, ctype = read_bytes(f"{base}/reports/j1/s.mp3")

    assert status == 200
    assert body == b"ID3fake"
    assert ctype == "audio/mpeg"


def test_a_missing_report_file_is_a_404(server):
    base, _, _, _ = server
    with pytest.raises(HTTPError) as excinfo:
        read_bytes(f"{base}/reports/j1/nope.html")
    assert excinfo.value.code == 404


@pytest.mark.parametrize("attack", [
    "/reports/../secret.txt",
    "/reports/j1/../../secret.txt",
    "/reports/" + quote("../secret.txt"),
    "/reports/%2e%2e/secret.txt",
])
def test_path_traversal_is_refused(server, tmp_path, attack):
    """This project already shipped one traversal hole (?v=../../evil)."""
    base, _, reports, _ = server
    (reports.parent / "secret.txt").write_text("do not serve me", encoding="utf-8")

    with pytest.raises(HTTPError) as excinfo:
        read_bytes(f"{base}{attack}")

    assert excinfo.value.code in (403, 404)


def test_a_directory_is_not_served(server):
    base, _, reports, _ = server
    (reports / "j1").mkdir(parents=True)
    with pytest.raises(HTTPError) as excinfo:
        read_bytes(f"{base}/reports/j1")
    assert excinfo.value.code == 404
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_server.py -v -k "report or traversal or mp3 or directory"
```

Expected: FAIL — 전부 404 "static serving arrives in a later task"이므로 정상 서빙
테스트가 실패한다 (traversal 테스트는 통과하지만, 그건 아직 아무것도 서빙하지
않기 때문이다)

- [ ] **Step 3: `_serve_report` 구현**

`poc/src/bandpoc/server.py`의 임시 `_serve_report`를 다음으로 교체한다:

```python
        def _serve_report(self, rel: str) -> None:
            target = self._safe_report_path(rel)
            if target is None:
                self._fail(404, "not found")
                return
            content_type = _CONTENT_TYPES.get(
                target.suffix.lower(), "application/octet-stream"
            )
            self._send(200, target.read_bytes(), content_type)

        def _safe_report_path(self, rel: str) -> Path | None:
            """Resolve under the report root, or refuse.

            resolve() collapses `..` and follows symlinks BEFORE the check, so
            neither can walk out. Returning None for every rejection -- rather
            than distinguishing "outside the root" from "does not exist" --
            keeps the response from confirming what lives elsewhere on disk.
            """
            candidate = (reports_root / rel.lstrip("/")).resolve()
            if not candidate.is_relative_to(reports_root):
                return None
            return candidate if candidate.is_file() else None
```

그리고 모듈 상단(`DEFAULT_PORT` 아래)에 추가한다:

```python
_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_server.py -v
```

Expected: 22 passed

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/server.py poc/tests/test_server.py
git commit -m "feat(poc): serve report files with traversal refused"
```

---

### Task 5: 폼 페이지

**Files:**
- Modify: `poc/src/bandpoc/server.py` (`PAGE` 교체)
- Test: `poc/tests/test_server.py` (추가)

**Interfaces:**
- Consumes: Task 3-4의 API 라우트
- Produces: 없음 (`PAGE` 내용만 바뀐다)

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_server.py` 끝에 추가:

```python
def test_the_form_page_is_served_at_the_root(server):
    base, _, _, _ = server
    status, body, ctype = read_bytes(base + "/")
    assert status == 200
    assert "text/html" in ctype
    assert b"<form" in body or b"submit" in body


def test_the_form_page_makes_no_external_requests(server):
    base, _, _, _ = server
    _, body, _ = read_bytes(base + "/")
    html = body.decode("utf-8")
    assert "http://" not in html
    assert "https://" not in html
    assert '="//' not in html
    assert "@import" not in html


def test_the_form_page_polls_its_own_api(server):
    base, _, _, _ = server
    _, body, _ = read_bytes(base + "/")
    html = body.decode("utf-8")
    for endpoint in ("/api/detectors", "/api/sessions", "/api/jobs"):
        assert endpoint in html


def test_the_form_page_states_the_poll_interval(server):
    """Spec: poll every 2 s, stop once the job is done or failed."""
    base, _, _, _ = server
    _, body, _ = read_bytes(base + "/")
    html = body.decode("utf-8")
    assert "2000" in html
    assert "failed" in html
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_server.py -v -k form
```

Expected: FAIL — 스텁 `PAGE`에는 폼도 API 경로도 없다

- [ ] **Step 3: `PAGE` 교체**

`poc/src/bandpoc/server.py`의 스텁 `PAGE = ...` 한 줄을 다음으로 교체한다:

```python
_PAGE_CSS = """
body{font-family:system-ui,'Segoe UI','Malgun Gothic',sans-serif;margin:0;
     padding:1.5rem;background:#fafafa;color:#1a1a1a;max-width:60rem}
h1{font-size:1.3rem;margin:0 0 1rem}
h2{font-size:1rem;margin:1.5rem 0 .5rem}
fieldset{border:1px solid #e0e0e0;background:#fff;margin:0 0 1rem;padding:.8rem 1rem}
legend{font-size:.85rem;color:#555;padding:0 .4rem}
input[type=text]{width:100%;padding:.4rem;font-size:.9rem}
label.det{display:inline-block;min-width:16rem;font-size:.85rem;margin:.15rem 0}
.drop{border:2px dashed #bbb;padding:1.2rem;text-align:center;color:#777;
      font-size:.9rem;background:#fff}
.drop.over{border-color:#1565c0;color:#1565c0}
button{padding:.5rem 1.2rem;font-size:.9rem;cursor:pointer}
.job{background:#fff;border:1px solid #e0e0e0;padding:.6rem .9rem;margin-bottom:.6rem}
.state{font-weight:600;font-size:.85rem}
.state.done{color:#2e7d32}.state.failed{color:#c62828}.state.running{color:#1565c0}
.state.queued{color:#888}
pre{background:#f5f5f5;padding:.5rem;font-size:.75rem;max-height:16rem;
    overflow:auto;margin:.4rem 0 0;white-space:pre-wrap}
.err{color:#c62828;font-size:.85rem;margin-top:.3rem}
.hint{font-size:.78rem;color:#666}
"""

_PAGE_JS = """
const FAST = ['dsp_baseline', 'panns_cnn14', 'yamnet'];
const POLL_MS = 2000;
const watching = new Map();

async function loadDetectors() {
  const res = await fetch('/api/detectors');
  const { detectors } = await res.json();
  const box = document.getElementById('detectors');
  box.innerHTML = '';
  for (const key of detectors) {
    const fast = FAST.some(prefix => key.startsWith(prefix));
    const label = document.createElement('label');
    label.className = 'det';
    label.innerHTML =
      `<input type="checkbox" value="${key}"${fast ? ' checked' : ''}> ` +
      `${key}${fast ? '' : ' <span class="hint">(slow)</span>'}`;
    box.appendChild(label);
  }
}

function chosenDetectors() {
  return [...document.querySelectorAll('#detectors input:checked')]
    .map(input => input.value);
}

function renderJob(snapshot) {
  const id = 'job-' + snapshot.job_id;
  let node = document.getElementById(id);
  if (!node) {
    node = document.createElement('div');
    node.className = 'job';
    node.id = id;
    document.getElementById('jobs').prepend(node);
  }
  const name = snapshot.session_id || snapshot.job_id;
  const link = snapshot.report_url
    ? ` <a href="${snapshot.report_url}">open the explorer</a>` : '';
  const error = snapshot.error ? `<div class="err">${snapshot.error}</div>` : '';
  const log = snapshot.log.length
    ? `<pre>${snapshot.log.join('\\n')}</pre>` : '';
  node.innerHTML =
    `<span class="state ${snapshot.state}">${snapshot.state}</span> ` +
    `${name}${link}${error}${log}`;
}

async function poll(jobId) {
  const res = await fetch('/api/jobs/' + jobId);
  if (!res.ok) return;
  const snapshot = await res.json();
  renderJob(snapshot);
  // Stop polling once the job can no longer change.
  if (snapshot.state === 'done' || snapshot.state === 'failed') {
    clearInterval(watching.get(jobId));
    watching.delete(jobId);
  }
}

function watch(jobId) {
  poll(jobId);
  if (!watching.has(jobId)) {
    watching.set(jobId, setInterval(() => poll(jobId), POLL_MS));
  }
}

function say(message) {
  document.getElementById('status').textContent = message;
}

async function submitUrl() {
  const url = document.getElementById('url').value.trim();
  if (!url) { say('paste a URL first'); return; }
  const detectors = chosenDetectors();
  if (!detectors.length) { say('pick at least one model'); return; }
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url, detectors, id: document.getElementById('sid').value.trim(),
    }),
  });
  if (!res.ok) { say(await res.text()); return; }
  const { job_id } = await res.json();
  document.getElementById('url').value = '';
  say('queued');
  watch(job_id);
}

async function submitFile(file) {
  const detectors = chosenDetectors();
  if (!detectors.length) { say('pick at least one model'); return; }
  say('uploading ' + file.name);
  // Raw body plus headers, not multipart: nothing to parse means nothing to
  // parse wrong.
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filename': file.name,
      'X-Detectors': detectors.join(','),
      'X-Session-Id': document.getElementById('sid').value.trim(),
    },
    body: file,
  });
  if (!res.ok) { say(await res.text()); return; }
  const { job_id } = await res.json();
  say('queued');
  watch(job_id);
}

async function loadRecent() {
  const res = await fetch('/api/jobs');
  const { jobs } = await res.json();
  for (const snapshot of jobs.slice().reverse()) {
    renderJob(snapshot);
    if (snapshot.state === 'queued' || snapshot.state === 'running') {
      watch(snapshot.job_id);
    }
  }
}

document.getElementById('go').addEventListener('click', submitUrl);
document.getElementById('file').addEventListener('change', event => {
  if (event.target.files[0]) submitFile(event.target.files[0]);
});
const drop = document.getElementById('drop');
drop.addEventListener('dragover', event => {
  event.preventDefault(); drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', event => {
  event.preventDefault();
  drop.classList.remove('over');
  if (event.dataTransfer.files[0]) submitFile(event.dataTransfer.files[0]);
});

loadDetectors().then(loadRecent);
"""

PAGE = f"""<!doctype html><html lang='ko'><head><meta charset='utf-8'>
<title>bandpoc - 세션 투입</title>
<style>{_PAGE_CSS}</style></head><body>
<h1>세션 투입</h1>
<p class='hint'>유튜브 URL을 넣거나 오디오 파일을 떨어뜨리면 다운로드 - 추론 -
리포트 생성까지 이어서 돈다. 추론은 녹음 길이와 고른 모델 수에 따라 수십 분이
걸릴 수 있고, 작업은 하나씩 순서대로 처리된다.</p>

<fieldset><legend>소스</legend>
  <input type='text' id='url' placeholder='https://www.youtube.com/watch?v=...'>
  <p><button id='go'>추가</button>
     <span id='status' class='hint'></span></p>
  <div class='drop' id='drop'>여기에 오디오 파일을 떨어뜨리거나
    <input type='file' id='file' accept='audio/*,video/*'></div>
</fieldset>

<fieldset><legend>세션 id (선택)</legend>
  <input type='text' id='sid' placeholder='비우면 URL이나 파일명에서 정해진다'>
</fieldset>

<fieldset><legend>모델</legend>
  <div id='detectors'></div>
  <p class='hint'>ast와 clap은 창을 겹쳐 밀어서 훨씬 느리다. 필요할 때만 켠다.</p>
</fieldset>

<h2>작업</h2>
<div id='jobs'></div>
<script>{_PAGE_JS}</script>
</body></html>"""
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_server.py -v
```

Expected: 26 passed

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/server.py poc/tests/test_server.py
git commit -m "feat(poc): add the session intake form page"
```

---

### Task 6: CLI 배선과 엔드투엔드

**Files:**
- Modify: `poc/src/bandpoc/server.py` (`serve` 추가), `poc/src/bandpoc/cli.py`, `poc/tests/test_cli.py`, `poc/README.md`
- Test: `poc/tests/test_cli.py`

**Interfaces:**
- Consumes: Task 1-5 전부
- Produces:
  - `bandpoc.server.serve(data_dir, reports_dir, port=DEFAULT_PORT) -> int`
  - `bandpoc serve [--port N] [--data-dir D] [--out-dir R]`

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_cli.py` 끝에 추가:

```python
def test_serve_binds_localhost_only(monkeypatch, tmp_path):
    """This downloads arbitrary URLs and writes arbitrary paths."""
    from bandpoc import server as server_mod

    seen = {}

    class FakeServer:
        def __init__(self, address, handler):
            seen["address"] = address
            self.server_address = address

        def serve_forever(self):
            raise KeyboardInterrupt

        def server_close(self):
            seen["closed"] = True

    monkeypatch.setattr(server_mod, "ThreadingHTTPServer", FakeServer)
    code = server_mod.serve(tmp_path / "data", tmp_path / "reports", port=0)

    assert code == 0
    assert seen["address"][0] == "127.0.0.1"
    assert seen["closed"] is True


def test_serve_reports_a_busy_port_instead_of_moving(monkeypatch, tmp_path, capsys):
    from bandpoc import server as server_mod

    def refuse(address, handler):
        raise OSError("address already in use")

    monkeypatch.setattr(server_mod, "ThreadingHTTPServer", refuse)
    assert server_mod.serve(tmp_path / "data", tmp_path / "reports", port=8765) == 1
    assert "8765" in capsys.readouterr().out


def test_the_serve_subcommand_is_wired(monkeypatch, tmp_path):
    called = {}

    def fake_serve(data_dir, reports_dir, port):
        called["port"] = port
        called["data_dir"] = str(data_dir)
        return 0

    import bandpoc.cli as cli_mod

    monkeypatch.setattr(cli_mod, "serve", fake_serve)
    assert main(["serve", "--port", "9000", "--data-dir", str(tmp_path)]) == 0
    assert called["port"] == 9000
    assert called["data_dir"] == str(tmp_path)


def test_server_messages_encode_on_a_cp949_console():
    from bandpoc import server

    _assert_every_string_constant_encodes_print_and_raise(server)


def test_jobs_messages_encode_on_a_cp949_console():
    from bandpoc import jobs

    _assert_every_string_constant_encodes_print_and_raise(jobs)
```

`tests/test_cli.py`의 헬퍼 옆에 다음을 추가한다 — `server.py`는 HTML/JS 페이지를
품고 있어 전체 스캔을 하면 정당한 한국어·기호가 걸린다. `explore.py`에 이미 쓰는
것과 같은 범위 한정 방식이다:

```python
def _assert_every_string_constant_encodes_print_and_raise(module, codec="cp949"):
    """Only what can reach a console: print() arguments and raised messages.

    server.py carries an HTML/JS page whose Korean copy never touches a
    Windows console, so a blanket module scan would fail on correct code --
    the same reason explore.py is scoped this way.
    """
    import ast
    from pathlib import Path

    tree = ast.parse(Path(module.__file__).read_text(encoding="utf-8"))
    checked = 0
    for node in ast.walk(tree):
        targets = []
        if isinstance(node, ast.Call) and getattr(node.func, "id", "") == "print":
            targets = node.args
        elif isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call):
            targets = node.exc.args
        for arg in targets:
            for piece in ast.walk(arg):
                if isinstance(piece, ast.Constant) and isinstance(piece.value, str):
                    checked += 1
                    try:
                        piece.value.encode(codec)
                    except UnicodeEncodeError as exc:
                        raise AssertionError(
                            f"{Path(module.__file__).name} line {piece.lineno}: {exc}"
                        ) from exc
    assert checked > 0, "scanned nothing -- the walk is broken, not the code"
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_cli.py -v -k "serve or cp949"
```

Expected: FAIL — `ImportError: cannot import name 'serve' from 'bandpoc.server'`

- [ ] **Step 3: `serve`와 CLI 배선**

`poc/src/bandpoc/server.py` 끝에 추가:

```python
def serve(
    data_dir: str | Path, reports_dir: str | Path, port: int = DEFAULT_PORT
) -> int:
    """Run the intake server until interrupted."""
    from . import registry
    from .jobs import JobQueue, make_runner

    import bandpoc.detectors  # noqa: F401 -- registers every adapter

    data_dir = Path(data_dir)
    reports_dir = Path(reports_dir)
    reports_dir.mkdir(parents=True, exist_ok=True)

    job_queue = JobQueue(runner=make_runner(data_dir, reports_dir))
    handler = make_handler(job_queue, reports_dir, registry.all_keys())
    try:
        httpd = ThreadingHTTPServer((_HOST, port), handler)
    except OSError as exc:
        # Do not quietly pick another port: the whole point of a fixed port
        # is knowing where to point the browser.
        print(f"[fail] cannot bind {_HOST}:{port}: {exc}")
        print("try another port: bandpoc serve --port 8766")
        return 1

    actual = httpd.server_address[1]
    print(f"bandpoc serving on http://{_HOST}:{actual}")
    print("local only -- do not expose this to a network")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        httpd.server_close()
    return 0
```

`poc/src/bandpoc/cli.py`의 import 블록에 추가한다:

```python
from .server import serve
```

`cmd_explore` 다음에 추가한다:

```python
def cmd_serve(args) -> int:
    return serve(Path(args.data_dir), Path(args.out_dir), port=args.port)
```

`main()`의 `explore` 서브파서 다음에 추가한다:

```python
    p = sub.add_parser("serve", help="browser front end for adding sessions")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--out-dir", default="reports/explore")
    p.add_argument("--data-dir", default=str(_DEFAULT_DATA))
    p.set_defaults(func=cmd_serve)
```

- [ ] **Step 4: 전체 테스트 통과 확인 후 엔드투엔드**

```bash
cd poc && .venv/Scripts/python.exe -m pytest -q
```

Expected: 전부 통과.

이어서 실제로 띄운다:

```bash
cd poc && .venv/Scripts/bandpoc.exe serve
```

브라우저로 `http://127.0.0.1:8765`를 열어 스펙 § 8의 완료 기준을 확인한다 —
로컬 오디오 파일을 떨어뜨리면 작업이 생기고, 로그가 2초마다 갱신되며, 끝나면
탐색 페이지 링크가 뜨고, 눌러서 오디오가 재생된다. 이어서 `/reports/../` 류
경로가 막히는지도 확인한다.

- [ ] **Step 5: README 갱신 후 커밋**

`poc/README.md`의 "정답 라벨 없이 실제 녹음 비교하기" 절 끝에 추가한다:

```markdown
### 브라우저에서 넣기

터미널 대신 브라우저로 세션을 투입할 수 있다.

```bash
bandpoc serve      # http://127.0.0.1:8765
```

유튜브 URL을 넣거나 오디오 파일을 떨어뜨리면 다운로드 - 추론 - 리포트 생성이
이어서 돈다. 진행 상황이 페이지에 흐르고, 끝나면 탐색 페이지 링크가 뜬다.
작업은 하나씩 순서대로 처리된다 - 동시에 두 세션을 추론하면 모델이 두 벌
로드되기 때문이다.

**이 서버를 네트워크에 노출하지 말 것.** 임의 URL을 다운로드하고 임의 경로에
파일을 쓰므로 `127.0.0.1`에만 바인딩하며, 그래서 `--host` 옵션이 없다.
```

```bash
git add poc/src/bandpoc/server.py poc/src/bandpoc/cli.py poc/tests/test_cli.py poc/README.md
git commit -m "feat(poc): wire the serve subcommand"
```

---

## Self-Review

**스펙 커버리지**

| 스펙 항목 | 담당 |
|---|---|
| § 3.1 `Job`, `JobQueue`, 직렬 워커, 로그 캡처, 메모리 상태 | Task 1 |
| § 3.1 파이프라인 재구현 금지 | Task 2 (`Namespace`로 `cmd_run`/`cmd_explore` 호출) |
| § 3.2 포트 8765, 사용 중이면 종료 | Task 6 |
| § 3.2 라우트 6개 | Task 3 (API), Task 4 (`/reports/`), Task 5 (`/`) |
| § 3.2 JSON/raw 두 몸통, multipart 금지 | Task 3 |
| § 3.2 업로드 상한 1GB, 읽기 전 거절 | Task 3 |
| § 3.2 업로드 세션 id 유도 | Task 3 |
| § 3.3 폼 3구역, 2초 폴링, 빠른 모델 기본 선택 | Task 5 |
| § 5 실패가 서버를 죽이지 않음 | Task 1 (`_run_one`), Task 2 (러너 `try`) |
| § 6 localhost 전용, `--host` 없음 | Task 6 |
| § 6 traversal 차단 | Task 4 |
| § 6 업로드 파일명 불신 | Task 3 (`slugify`, 확장자만 사용) |
| § 7 테스트 전 항목 | Task 1~6 |
| § 8 완료 기준 1~11 | Task 6 Step 4 |

**타입 일관성** — `Job.detectors`는 생성 시 `tuple`로 정규화되고
`snapshot()`이 `list`로 직렬화한다. Task 2의 러너는 `",".join(job.detectors)`로
`cmd_run`/`cmd_explore`의 `--detectors` 문자열 계약에 맞춘다. `make_handler`는
Task 3에서 `(job_queue, reports_dir, detector_keys)` 세 인자로 정의되고 Task 6이
같은 순서로 호출한다.

**남은 위험** — `cmd_run`/`cmd_explore`는 `argparse.Namespace`의 특정 속성에
의존한다(`data_dir`, `scenes`, `detectors`, `force` / `out_dir`). 그 함수들이
새 속성을 요구하도록 바뀌면 러너가 `AttributeError`로 깨지는데, Task 2의
테스트가 실제 파이프라인을 끝까지 돌리므로 그 순간 잡힌다.
