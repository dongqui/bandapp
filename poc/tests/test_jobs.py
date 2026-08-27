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


def test_a_baseexception_from_the_runner_still_leaves_the_job_in_a_terminal_state():
    """FINDING 11: _run_one's except clause is `except Exception`, not
    BaseException, deliberately -- it exists so a bad *job* cannot take
    down the worker thread, not to swallow everything, and a BaseException
    (SystemExit, ...) should still propagate. But without a `finally`, that
    propagation left job.state stuck at "running" forever: indistinguishable
    from a job genuinely still in progress. Calls _run_one directly (not
    through the worker thread) so the test can catch the SystemExit itself
    rather than needing to detect a background thread's death."""
    def raises_system_exit(job):
        raise SystemExit("simulated crash")

    q = JobQueue(runner=lambda job: None)
    job = Job(job_id="x", source="s", detectors=())
    q._runner = raises_system_exit

    with pytest.raises(SystemExit):
        q._run_one(job)

    assert job.state == "failed"


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


def test_recent_with_zero_limit_returns_empty_list():
    """Regression: self._order[-0:] is the whole list, not nothing."""
    q = JobQueue(runner=lambda job: None)
    q.submit("a", ["k"])
    assert q.wait_idle(timeout=5)
    assert q.recent(limit=0) == []


def test_recency_cap_never_drops_a_job_that_has_not_finished():
    """Regression: the recency cap used to evict the oldest *submitted* job
    regardless of its state. Submitting well past the cap with a slow runner
    used to leave some jobs evicted -- and therefore never run -- before the
    worker ever got to them: get(job_id) returned None forever, with no
    error and no state transition, for an id submit() itself had handed
    back.
    """
    from bandpoc.jobs import _RECENT_CAP

    ran = []
    lock = threading.Lock()

    def slow(job):
        time.sleep(0.002)
        with lock:
            ran.append(job.job_id)

    q = JobQueue(runner=slow)
    n = _RECENT_CAP + 100  # well past the cap while jobs are still in flight
    ids = [q.submit(str(i), ["k"]).job_id for i in range(n)]
    assert q.wait_idle(timeout=60)

    with lock:
        ran_ids = set(ran)
    missing = set(ids) - ran_ids
    assert not missing, f"{len(missing)} submitted jobs never ran: {sorted(missing)[:5]}"

    # A job may age out of the recent-window cache once it has *finished*
    # (that's the intended bounded cache); it must never come back missing
    # with no explanation.
    for jid in ids:
        job = q.get(jid)
        if job is not None:
            assert job.state == "done"


def test_wait_idle_never_lies_while_work_is_outstanding():
    """Regression: _idle used to be derived from a snapshot of a different
    structure (_pending.empty()) taken at a different moment than the
    increment/clear in submit(). A submit's clear() landing between the
    worker's task_done() and its empty()-check let the worker's set()
    clobber it, so wait_idle() could return True with a job still
    outstanding. Track outstanding work with a counter mutated under the
    same lock as the idle flip instead, and prove here that whenever
    wait_idle() returns True, every job submitted so far has actually
    started and finished.
    """
    lock = threading.Lock()
    started = 0
    finished = 0

    def flaky(job):
        nonlocal started, finished
        with lock:
            started += 1
        try:
            if int(job.source) % 7 == 0:
                raise ValueError("flaky failure")
        finally:
            with lock:
                finished += 1

    q = JobQueue(runner=flaky)
    submitted = 0
    for round_ in range(25):
        batch = [q.submit(str(submitted + i), ["k"]).job_id for i in range(20)]
        submitted += len(batch)
        assert q.wait_idle(timeout=10), f"round {round_}: wait_idle timed out"
        with lock:
            snapshot_started, snapshot_finished = started, finished
        assert snapshot_started == submitted, (
            f"round {round_}: wait_idle() returned True but only "
            f"{snapshot_started}/{submitted} jobs had started"
        )
        assert snapshot_finished == submitted, (
            f"round {round_}: wait_idle() returned True but only "
            f"{snapshot_finished}/{submitted} jobs had finished"
        )
    assert submitted == 500


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
