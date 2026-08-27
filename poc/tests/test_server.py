import json
import os
import socket
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

import bandpoc.server as server_module
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


# --- raw-socket helpers -----------------------------------------------------
#
# urllib normalises away exactly the things these tests need to see (CR/LF
# in a status line, a connection dying mid-write), so they talk to the
# socket directly instead of going through urlopen.


def _host_port(base):
    host, port = base[len("http://"):].split(":")
    return host, int(port)


def _raw_request(base, headers_text, body=b"", timeout=5):
    """Send exactly the given header block (already CRLF-terminated,
    including the trailing blank line) plus body, and return the full raw
    response bytes received before the connection closes."""
    host, port = _host_port(base)
    sock = socket.create_connection((host, port), timeout=timeout)
    sock.settimeout(timeout)
    raw = b""
    try:
        sock.sendall(headers_text.encode() + body)
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            raw += chunk
    except OSError:
        pass
    finally:
        sock.close()
    return raw


def test_a_crlf_in_the_detectors_field_cannot_inject_a_header(server):
    """FINDING 1: send_error() used to splice this straight into the status
    line unescaped. Assert on the raw bytes off the wire -- urllib's parser
    would silently normalise an injected header away and hide the bug."""
    base, _, _, _ = server
    payload = json.dumps({
        "url": "https://youtu.be/abc",
        "detectors": ["evil\r\nX-Injected: pwned\r\n\r\n<script>alert(1)</script>"],
    }).encode()
    headers = (
        "POST /api/sessions HTTP/1.1\r\n"
        f"Host: {_host_port(base)[0]}\r\n"
        "Content-Type: application/json\r\n"
        f"Content-Length: {len(payload)}\r\n"
        "Connection: close\r\n"
        "\r\n"
    )
    raw = _raw_request(base, headers, payload)

    assert raw, "expected a response"
    header_block, _, rest = raw.partition(b"\r\n\r\n")
    status_line = header_block.split(b"\r\n", 1)[0]

    # The whole point: no attacker-controlled bytes reach the header block.
    assert b"\r\n" not in status_line.rstrip(b"\r\n")
    assert b"X-Injected" not in header_block
    assert b"<script>" not in header_block
    assert status_line.endswith(b"400 Bad Request")
    # The attacker text is allowed to show up only inside the JSON body,
    # safely quoted -- never as raw bytes that could be mistaken for headers.
    assert b"X-Injected" in rest or b"Injected" in rest


def test_a_negative_content_length_is_rejected_immediately(server):
    """FINDING 2: int("-1") is a legal int, and a negative length was still
    truthy, so self.rfile.read(-1) turned into a read-until-EOF that never
    arrives on a live socket. This must come back fast, not hang."""
    base, _, _, _ = server
    headers = (
        "POST /api/sessions HTTP/1.1\r\n"
        f"Host: {_host_port(base)[0]}\r\n"
        "Content-Type: application/octet-stream\r\n"
        "X-Filename: a.wav\r\n"
        f"X-Detectors: {KEYS[0]}\r\n"
        "Content-Length: -1\r\n"
        "Connection: close\r\n"
        "\r\n"
    )
    raw = _raw_request(base, headers, b"", timeout=5)
    assert raw, "server did not respond -- it may have hung reading the body"
    status_line = raw.split(b"\r\n", 1)[0]
    assert b"400" in status_line


def test_a_real_oversized_upload_does_not_hang_and_is_not_accepted(server, monkeypatch):
    """FINDING 3: with the cap lowered, a client that genuinely streams a
    body larger than it should get a connection error (not a 413 body, and
    not a hang), and no job must be created."""
    base, queue, _, _ = server
    monkeypatch.setattr(server_module, "MAX_UPLOAD_BYTES", 1024)
    host, port = _host_port(base)
    before = len(queue.recent(limit=200))

    body_size = 20 * 1024 * 1024  # far over the lowered 1 KiB cap
    header = (
        "POST /api/sessions HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        "Content-Type: application/octet-stream\r\n"
        "X-Filename: big.wav\r\n"
        f"X-Detectors: {KEYS[0]}\r\n"
        f"Content-Length: {body_size}\r\n"
        "\r\n"
    ).encode()

    sock = socket.create_connection((host, port), timeout=5)
    sock.settimeout(5)
    write_error = None
    recv_error = None
    leftover = b""
    try:
        sock.sendall(header)
        chunk = b"x" * 65536
        sent = 0
        while sent < body_size:
            sock.sendall(chunk)
            sent += len(chunk)
    except socket.timeout:
        pytest.fail("write hung instead of failing once the server closed the connection")
    except OSError as exc:
        write_error = exc
    try:
        sock.settimeout(1)
        leftover = sock.recv(4096)
    except OSError as exc:
        recv_error = exc
    finally:
        sock.close()

    # Either the write dies mid-stream (the common case, per review) or --
    # if the OS happened to buffer the whole body before the server got to
    # closing the socket -- the follow-up read observes the reset instead.
    # Either way nothing hangs and no 413 body sneaks through.
    assert write_error is not None or recv_error is not None, (
        "expected either the write or the read to fail once the server "
        "refused the oversized upload and closed the connection"
    )
    assert leftover == b"", "expected zero bytes of a 413 -- the connection dies first"
    assert len(queue.recent(limit=200)) == before


def test_a_nameless_upload_with_no_derivable_session_id_is_rejected(server):
    """FINDING 4: derive_id() on the temp file's own random name always
    succeeds, so passing session_id=None here used to silently name the
    session after a throwaway temp file instead of failing loudly."""
    base, queue, _, _ = server
    before = len(queue.recent(limit=200))
    request = Request(
        f"{base}/api/sessions", data=b"x",
        headers={"Content-Type": "application/octet-stream",
                 "X-Filename": "???.wav", "X-Detectors": KEYS[0]},
        method="POST",
    )
    with pytest.raises(HTTPError) as excinfo:
        urlopen(request)
    assert excinfo.value.code == 400
    assert len(queue.recent(limit=200)) == before


def test_a_write_failure_during_upload_does_not_leak_the_temp_file(server, monkeypatch):
    """FINDING 5: mkstemp's fd was closed correctly, but a failure between
    creating the temp file and submitting the job (no Job exists yet, so the
    runner's per-job cleanup never fires) used to orphan the file forever."""
    base, queue, _, _ = server

    created_paths = []
    real_mkstemp = tempfile.mkstemp

    def spying_mkstemp(*args, **kwargs):
        result = real_mkstemp(*args, **kwargs)
        created_paths.append(result[1])
        return result

    monkeypatch.setattr(server_module.tempfile, "mkstemp", spying_mkstemp)

    class FailingFile:
        """Stands in for open(handle, 'wb'): write() fails, but still closes
        the real fd exactly once so this test doesn't leak one of its own."""

        def __init__(self, fd):
            self._fd = fd

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            os.close(self._fd)
            return False

        def write(self, data):
            raise OSError("simulated disk full")

    monkeypatch.setattr(
        server_module, "open", lambda fd, mode: FailingFile(fd), raising=False,
    )

    request = Request(
        f"{base}/api/sessions", data=b"x" * 10,
        headers={"Content-Type": "application/octet-stream",
                 "X-Filename": "leaky.wav", "X-Detectors": KEYS[0]},
        method="POST",
    )
    with pytest.raises(HTTPError) as excinfo:
        urlopen(request)
    assert excinfo.value.code == 500

    assert len(created_paths) == 1
    assert not Path(created_paths[0]).exists()
    assert len(queue.recent(limit=200)) == 0
