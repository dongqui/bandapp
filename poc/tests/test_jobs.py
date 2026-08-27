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
