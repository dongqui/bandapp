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
