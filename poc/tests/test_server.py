import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from html.parser import HTMLParser
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

import bandpoc.server as server_module
from bandpoc.jobs import JobQueue
from bandpoc.server import MAX_UPLOAD_BYTES, make_handler

KEYS = ["dsp_baseline:default", "yamnet:music_group"]


class _ScriptExtractor(HTMLParser):
    """Extracts <script> element text content the way a real browser's HTML
    tokenizer would -- as opposed to a raw substring search over the page,
    which cannot tell "this JS runs inside one script element" from "an
    early close-tag sequence inside a comment ended that element, and the
    rest of the file is now ordinary page text -- or, if some later text
    happens to spell out an open-tag sequence too, a *second*, unrelated
    script element that starts mid-sentence".

    element_count is exposed for exactly that second case: naively
    concatenating the text of every <script> element the parser saw would
    silently repair a "closed early, reopened by accident" split back into
    something that might still look like intact JS. Counting elements is
    what actually catches that -- the real page must contain exactly one."""

    def __init__(self):
        super().__init__(convert_charrefs=False)
        self._in_script = False
        self.script_text = ""
        self.element_count = 0

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            self._in_script = True
            self.element_count += 1

    def handle_endtag(self, tag):
        if tag == "script":
            self._in_script = False

    def handle_data(self, data):
        if self._in_script:
            self.script_text += data


def _extract_script(html_text: str) -> _ScriptExtractor:
    extractor = _ScriptExtractor()
    extractor.feed(html_text)
    return extractor


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


def read_range(url, range_header):
    """GET with a Range header. Returns (status, body, headers) on success;
    on an error status urllib raises HTTPError, which the caller catches to
    get at the status/body/headers the same way."""
    request = Request(url, headers={"Range": range_header})
    with urlopen(request) as response:
        return response.status, response.read(), response.headers


_RANGE_BODY = bytes(range(256)) * 40  # 10240 bytes, byte i%256 makes slices self-checking


@pytest.fixture
def ranged_report(server):
    base, _, reports, _ = server
    (reports / "j1").mkdir(parents=True)
    (reports / "j1" / "audio.wav").write_bytes(_RANGE_BODY)
    return f"{base}/reports/j1/audio.wav"


def test_a_full_report_response_advertises_range_support(ranged_report):
    """Accept-Ranges must be present on the plain 200 too -- that is what
    tells a browser's <audio> element seeking is possible at all."""
    with urlopen(ranged_report) as response:
        assert response.status == 200
        assert response.headers["Accept-Ranges"] == "bytes"
        assert response.read() == _RANGE_BODY


def test_a_bounded_range_returns_206_with_the_exact_slice(ranged_report):
    status, body, headers = read_range(ranged_report, "bytes=10-19")
    assert status == 206
    assert body == _RANGE_BODY[10:20]
    assert headers["Content-Range"] == f"bytes 10-19/{len(_RANGE_BODY)}"
    assert headers["Content-Length"] == "10"
    assert headers["Accept-Ranges"] == "bytes"


def test_an_open_ended_range_returns_everything_from_start_to_eof(ranged_report):
    status, body, headers = read_range(ranged_report, "bytes=10000-")
    assert status == 206
    assert body == _RANGE_BODY[10000:]
    assert headers["Content-Range"] == f"bytes 10000-{len(_RANGE_BODY) - 1}/{len(_RANGE_BODY)}"


def test_a_suffix_range_returns_the_last_n_bytes(ranged_report):
    status, body, headers = read_range(ranged_report, "bytes=-100")
    assert status == 206
    assert body == _RANGE_BODY[-100:]
    size = len(_RANGE_BODY)
    assert headers["Content-Range"] == f"bytes {size - 100}-{size - 1}/{size}"


def test_a_range_past_eof_is_416_with_the_asterisk_content_range(ranged_report):
    with pytest.raises(HTTPError) as excinfo:
        read_range(ranged_report, f"bytes={len(_RANGE_BODY) + 100}-")
    assert excinfo.value.code == 416
    assert excinfo.value.headers["Content-Range"] == f"bytes */{len(_RANGE_BODY)}"


def test_a_zero_length_suffix_range_is_416(ranged_report):
    with pytest.raises(HTTPError) as excinfo:
        read_range(ranged_report, "bytes=-0")
    assert excinfo.value.code == 416


@pytest.mark.parametrize("bad_range", [
    "bytes=abc-def",       # not integers
    "bytes=",              # empty spec
    "words=0-10",           # wrong unit
    "bytes=50-10",          # end before start
    "bytes=-",              # neither a start nor a suffix length
])
def test_a_malformed_range_header_is_ignored_and_serves_200(ranged_report, bad_range):
    status, body, headers = read_range(ranged_report, bad_range)
    assert status == 200
    assert body == _RANGE_BODY
    assert "Content-Range" not in headers


def test_a_multi_range_request_is_not_supported_and_serves_200(ranged_report):
    """Multi-range is explicitly out of scope: respond 200 to the whole file
    rather than attempting a multipart/byteranges body."""
    status, body, headers = read_range(ranged_report, "bytes=0-9,20-29")
    assert status == 200
    assert body == _RANGE_BODY
    assert "Content-Range" not in headers


def test_the_delivered_range_bytes_match_the_files_actual_slice(ranged_report, tmp_path):
    """Not just headers -- the bytes read via seek()+read() must be the same
    bytes a plain read of that slice off disk would produce."""
    status, body, _ = read_range(ranged_report, "bytes=4096-8191")
    assert body == _RANGE_BODY[4096:8192]


def test_a_missing_report_file_is_a_404(server):
    base, _, _, _ = server
    with pytest.raises(HTTPError) as excinfo:
        read_bytes(f"{base}/reports/j1/nope.html")
    assert excinfo.value.code == 404


@pytest.mark.parametrize("attack", [
    "/reports/../secret.txt",
    "/reports/j1/../../secret.txt",
    # A distinct encoding from the row below: this one percent-encodes the
    # trailing slash too (%2f), so after a single unquote() it decodes to
    # "../" rather than to a literal "%2e%2e" segment. (A prior version of
    # this parametrization used quote("../secret.txt"), which -- because
    # quote()'s default safe="/" leaves "." and "/" alone -- produced the
    # byte-identical string to the row above and bought no extra coverage.)
    "/reports/%2e%2e%2fsecret.txt",
    "/reports/%2e%2e/secret.txt",
])
def test_path_traversal_is_refused(server, tmp_path, attack):
    """This project already shipped one traversal hole (?v=../../evil)."""
    base, _, reports, _ = server
    (reports.parent / "secret.txt").write_text("do not serve me", encoding="utf-8")

    with pytest.raises(HTTPError) as excinfo:
        read_bytes(f"{base}{attack}")

    assert excinfo.value.code in (403, 404)


def test_a_sibling_directory_sharing_the_root_name_as_a_string_prefix_is_refused(server):
    """Pins is_relative_to() as the containment primitive rather than a
    string check. With root .../reports and sibling .../reports-secret,
    is_relative_to() is not fooled (it compares path *parts*), but the classic
    bug -- str(candidate).startswith(str(root)) -- would be: "reports-secret"
    starts with the string "reports" with no separator in between. Every
    other traversal case in this file targets reports.parent/secret.txt,
    which a startswith check also happens to catch, so none of them would
    catch a regression to the string-prefix form. This one specifically
    would not."""
    base, _, reports, _ = server
    sibling = reports.parent / "reports-secret"
    sibling.mkdir()
    (sibling / "leak.txt").write_text("do not serve me", encoding="utf-8")

    with pytest.raises(HTTPError) as excinfo:
        read_bytes(f"{base}/reports/../reports-secret/leak.txt")

    assert excinfo.value.code in (403, 404)


def test_a_symlink_pointing_outside_the_root_is_refused(server):
    """resolve() follows symlinks before the containment check runs, so a
    symlink planted inside the report root that targets outside it must
    still be refused. Creating a symlink can require elevated privileges on
    Windows; skip rather than fail where this environment doesn't allow it,
    so the suite stays honest about what it actually covers."""
    base, _, reports, _ = server
    outside = reports.parent / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("do not serve me", encoding="utf-8")

    link = reports / "escape.txt"
    try:
        os.symlink(outside / "secret.txt", link)
    except OSError as exc:
        pytest.skip(f"cannot create symlinks in this environment: {exc}")

    with pytest.raises(HTTPError) as excinfo:
        read_bytes(f"{base}/reports/escape.txt")

    assert excinfo.value.code in (403, 404)


@pytest.mark.parametrize("attack", [
    "/reports/%00/secret.txt",
    "/reports/j1/index.html%00.png",
    "/reports/j1%00/index.html",
])
def test_a_null_byte_in_the_path_is_a_clean_404(server, attack):
    """resolve() raises ValueError on an embedded NUL (confirmed: 'stat:
    embedded null character in path'), and a %00 survives unquote() and
    reaches the filesystem layer as a literal null byte. Before the fix this
    closed the connection with zero bytes -- urlopen saw a
    RemoteDisconnected, not an HTTPError -- and dumped a traceback to
    stderr on every request. Must come back as an ordinary 404 instead."""
    base, _, reports, _ = server
    (reports / "j1").mkdir(parents=True)
    (reports / "j1" / "index.html").write_text("hi", encoding="utf-8")

    with pytest.raises(HTTPError) as excinfo:
        read_bytes(f"{base}{attack}")
    assert excinfo.value.code == 404


def test_a_read_failure_after_the_existence_check_is_a_clean_404(server, monkeypatch):
    """The existence check in _safe_report_path (is_file()) and the actual
    read in _serve_report (open()+seek()+read()) are separate filesystem
    calls; anything can happen to the file in between (removed, permissions
    changed, ...) and that open() raising OSError must not vanish as an
    empty response with a stack trace on the server side."""
    base, _, reports, _ = server
    (reports / "j1").mkdir(parents=True)
    (reports / "j1" / "flaky.html").write_text("hi", encoding="utf-8")

    def boom(*args, **kwargs):
        raise OSError("simulated read failure")

    monkeypatch.setattr(server_module, "open", boom, raising=False)

    with pytest.raises(HTTPError) as excinfo:
        read_bytes(f"{base}/reports/j1/flaky.html")
    assert excinfo.value.code == 404


def test_a_client_aborting_mid_download_does_not_take_down_the_server(server, capfd):
    """No Range support means an <audio> element's seek re-downloads the
    whole file and then aborts once it has enough buffered -- normal
    behaviour, not exotic. wfile.write() raising ConnectionError partway
    through the body must not print a stack trace per seek (that would
    defeat the log_message() override, whose whole point is to keep the
    console readable for job output) and must not disturb the server's
    ability to serve the next request."""
    base, _, reports, _ = server
    (reports / "j1").mkdir(parents=True)
    # Large enough that closing the socket right after the request line
    # reliably lands the write while the body is still in flight.
    (reports / "j1" / "big.bin").write_bytes(b"x" * (8 * 1024 * 1024))

    host, port = base[len("http://"):].split(":")
    sock = socket.create_connection((host, int(port)), timeout=5)
    sock.settimeout(5)
    request_text = (
        "GET /reports/j1/big.bin HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        "Connection: close\r\n\r\n"
    )
    sock.sendall(request_text.encode())
    sock.recv(1)  # make sure the server has started writing the response
    sock.close()

    # The server thread that was writing big.bin must not have wedged the
    # whole process: a fresh request still gets a normal response.
    status, body, _ = read_bytes(f"{base}/reports/j1/big.bin")
    assert status == 200
    assert len(body) == 8 * 1024 * 1024

    # Give the aborted thread a moment to finish (it races the assertions
    # above), then confirm it never reached socketserver's unhandled-error
    # path -- capfd reads the real stderr file descriptor, so it sees
    # output from that other thread too, not just this one.
    time.sleep(0.3)
    _, err = capfd.readouterr()
    assert "Traceback" not in err
    assert "ConnectionResetError" not in err
    assert "Exception occurred during processing of request" not in err


def test_a_directory_is_not_served(server):
    base, _, reports, _ = server
    (reports / "j1").mkdir(parents=True)
    with pytest.raises(HTTPError) as excinfo:
        read_bytes(f"{base}/reports/j1")
    assert excinfo.value.code == 404


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
    # "failed" alone also appears in the page's CSS (".state.failed{...}"),
    # so that assertion on its own would not fail if the polling stop-logic
    # were deleted entirely -- pin the actual stop call too.
    assert "clearInterval" in html


def test_the_page_js_contains_no_literal_script_tag_sequence():
    """The whole _PAGE_JS string is embedded verbatim inside a real <script>
    element in PAGE (see the f-string in server.py). An HTML tokenizer ends
    a script element the moment it sees "<", "/", "script" in sequence --
    including inside a JS comment -- and, once back in normal parsing, would
    just as readily treat "<", "script" as the start of a brand new element.
    Neither sequence may occur in the JS source itself, in either form or
    case. This is the direct guard; the next two tests prove it actually
    matters by checking what a real parser and a real JS engine see."""
    low = server_module._PAGE_JS.lower()
    assert "</script" not in low
    assert "<script" not in low


def test_the_page_has_exactly_one_script_element_with_the_full_script(server):
    """Parse PAGE the way a browser's HTML tokenizer would and check two
    things a raw substring search over the page (as in
    test_the_form_page_polls_its_own_api and friends) cannot distinguish:

    1. There is exactly one <script> element. An early close-tag sequence
       inside a comment ends the element there; if the following text also
       happens to spell out an open-tag sequence, parsing resumes as a
       *second*, unrelated script element rather than obviously broken
       markup -- and naively concatenating "all text the parser saw between
       any start and end script tag" can silently paper back over that
       split into something that still looks like intact JS. Pinning the
       element count to exactly one is what actually catches that case (a
       mutation test confirmed a first draft of this test did not -- see
       the task report).
    2. That one element's content ends with the JS's real final statement,
       not a prefix truncated by an early close-tag sequence. A raw
       substring search would not catch this either: '/api/detectors',
       '2000', 'failed' and 'clearInterval' are all still present as plain
       body text even when the script is truncated mid-function and none of
       that code ever runs.
    """
    base, _, _, _ = server
    _, body, _ = read_bytes(base + "/")
    extractor = _extract_script(body.decode("utf-8"))
    assert extractor.element_count == 1
    assert extractor.script_text.rstrip().endswith(
        "loadDetectors().then(loadRecent);"
    )


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not on PATH")
def test_the_page_script_is_syntactically_valid_javascript(server, tmp_path):
    """node --check parses the script element's content without executing
    it. A syntax error here (from a truncated <script> element, or any
    other malformed JS) must fail the test suite instead of silently
    shipping a form that is inert in every real browser."""
    base, _, _, _ = server
    _, body, _ = read_bytes(base + "/")
    extractor = _extract_script(body.decode("utf-8"))
    script_path = tmp_path / "page.js"
    script_path.write_text(extractor.script_text, encoding="utf-8")
    result = subprocess.run(
        ["node", "--check", str(script_path)],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
