"""Local HTTP front end for session intake (spec section 3.2).

Knows nothing about the pipeline: it parses requests, hands a source to the
job queue, and reports what the queue says. Binds to 127.0.0.1 only -- this
downloads arbitrary URLs and writes arbitrary paths, so there is deliberately
no --host to get wrong.
"""

from __future__ import annotations

import http.server
import json
import tempfile
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import unquote, urlparse

MAX_UPLOAD_BYTES = 1024 ** 3
"""1 GB. A 45-minute 48 kHz mono wav is 259 MB, so a 3-hour session fits,
while a runaway request cannot fill the disk."""

_HOST = "127.0.0.1"
DEFAULT_PORT = 8765


class ThreadingHTTPServer(http.server.ThreadingHTTPServer):
    """Stock ThreadingHTTPServer with SO_REUSEADDR disabled.

    http.server.HTTPServer sets allow_reuse_address = 1 (SO_REUSEADDR) so a
    server restarting quickly can rebind a socket still in TIME_WAIT. On
    POSIX that flag does not let two live sockets share a port -- a
    genuinely busy port still fails bind(). On Windows it does: confirmed
    during review that binding 127.0.0.1 to the same port twice in a row
    succeeds both times with the stock class, no OSError from either call.
    Left alone, the busy-port guard in serve() below would never fire on
    that platform -- a second `bandpoc serve` would silently share the port
    with the first instead of failing loudly, which is exactly the
    "quietly moving" behaviour the fixed port exists to avoid.

    A subclass, not a mutation of http.server.ThreadingHTTPServer itself:
    the first version of this fix set the attribute directly on the stdlib
    class, which changed it process-globally for every import of
    http.server.ThreadingHTTPServer, including in code that has nothing to
    do with this server (every `bandpoc` subcommand imports this module by
    way of cli.py, whether or not it ever calls serve()). Shadowing the
    module-level name with a subclass instead keeps the real stdlib class
    untouched -- confirmed after this change that
    `http.server.ThreadingHTTPServer.allow_reuse_address` is still 1 -- and
    serve() below still finds this class by the same bare name, so the
    brief's tests, which monkeypatch server_mod.ThreadingHTTPServer by
    name, patch whichever object that name points to either way.

    Trade-off worth naming: disabling reuse also removes the TIME_WAIT
    rebind that allow_reuse_address exists for. On POSIX, restarting this
    server immediately after Ctrl+C can now hit "address already in use"
    for the remainder of the socket's TIME_WAIT window (typically under a
    minute) even though nothing is actually still listening. Accepted here:
    this is a manually-run local dev tool restarted by a person who can
    just wait a few seconds or pass --port, not a service that needs
    fast automatic restarts, and it is a small price for a busy-port check
    that actually means "busy" on every platform.
    """

    allow_reuse_address = False


_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
}

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

function escapeHtml(value) {
  // Everything rendered here through innerHTML must go through this first.
  // session_id, error and log lines are not guaranteed safe: session_id can
  // be the raw, unslugified id a caller supplied in the JSON body (it is
  // only replaced with the slugified one once the pipeline's add_session
  // step finishes -- until then, or if it fails before that point, the raw
  // string is what a poll returns), and error/log carry exception text,
  // yt-dlp output and filenames verbatim. This project has already shipped
  // one <\\/script> breakout; treat all three as hostile.
  //
  // That escaped slash above is not decorative: this whole file is embedded
  // verbatim inside a real script element (see PAGE below), and an HTML
  // tokenizer ends that element the moment it sees the byte sequence made
  // of "<", then "/", then "script" -- including inside a JS comment, and
  // regardless of case. Spelling that sequence out unescaped anywhere in
  // this file, even just to describe it, is exactly the mistake to avoid:
  // a first draft of this very comment did that and it truncated the whole
  // element mid-function in a real browser. See explore.py's
  // render_session for the same rule applied to embedded JSON.
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function friendlyError(text) {
  // The API reports failures as {"error": "..."} JSON (see server.py's
  // _fail) so that error text never lands in a raw response status line.
  // Showing that raw JSON blob to a person isn't friendly, so unwrap it;
  // fall back to the raw text if it isn't JSON after all.
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === 'string' && parsed.error) {
      return parsed.error;
    }
  } catch (err) {
    // not JSON -- fall through
  }
  return text || 'request failed';
}

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
  const name = escapeHtml(snapshot.session_id || snapshot.job_id);
  const link = snapshot.report_url
    ? ` <a href="${escapeHtml(snapshot.report_url)}">open the explorer</a>` : '';
  const error = snapshot.error
    ? `<div class="err">${escapeHtml(snapshot.error)}</div>` : '';
  const log = snapshot.log.length
    ? `<pre>${snapshot.log.map(escapeHtml).join('\\n')}</pre>` : '';
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
  let res;
  try {
    res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url, detectors, id: document.getElementById('sid').value.trim(),
      }),
    });
  } catch (err) {
    say('network error -- is the server still running?');
    return;
  }
  if (!res.ok) { say(friendlyError(await res.text())); return; }
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
  let res;
  try {
    res = await fetch('/api/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename': file.name,
        'X-Detectors': detectors.join(','),
        'X-Session-Id': document.getElementById('sid').value.trim(),
      },
      body: file,
    });
  } catch (err) {
    // The server refuses an oversized body from Content-Length before ever
    // reading it and closes the connection without writing a 413 -- the
    // browser sees that as a failed fetch (a network error), not an HTTP
    // response, indistinguishable here from the connection just dropping.
    // Say so rather than reporting an unexplained failure.
    say('upload failed -- the file may be larger than the server allows, ' +
        'or the connection dropped. Try a smaller file.');
    return;
  }
  if (!res.ok) { say(friendlyError(await res.text())); return; }
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
  <input type='text' id='url' placeholder='www.youtube.com/watch?v=...'>
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


def _parse_range(
    range_header: str, size: int
) -> tuple[int, int] | str | None:
    """Parse a single-range ``Range: bytes=...`` header against a file of
    ``size`` bytes.

    Returns an inclusive ``(start, end)`` pair, the literal string
    ``"unsatisfiable"``, or ``None``. ``None`` covers every shape the caller
    should treat exactly like no Range header at all -- a malformed value, a
    unit other than ``bytes``, and a multi-range request (``bytes=0-10,20-30``):
    building a real multipart/byteranges response is not required, and
    answering 200 to a request this server does not understand is what
    RFC 7233 prescribes for an unusable Range.
    """
    if not range_header.startswith("bytes="):
        return None
    spec = range_header[len("bytes="):]
    if "," in spec or "-" not in spec:
        return None
    start_text, _, end_text = spec.partition("-")
    if start_text == "":
        # Suffix form: bytes=-N means "the last N bytes".
        if end_text == "":
            return None
        try:
            suffix_length = int(end_text)
        except ValueError:
            return None
        if suffix_length <= 0 or size == 0:
            return "unsatisfiable"
        start = max(0, size - suffix_length)
        return start, size - 1
    try:
        start = int(start_text)
    except ValueError:
        return None
    if start < 0:
        return None
    if end_text == "":
        end = size - 1  # open-ended: bytes=N- means "N to the end"
    else:
        try:
            end = int(end_text)
        except ValueError:
            return None
        if end < start:
            return None
    # A start past EOF is a valid *request* that cannot be satisfied, not a
    # malformed one -- checked after parsing, not folded into the syntax
    # checks above, so e.g. bytes=<size+100>- (a well-formed open-ended
    # range whose start sits past EOF, where end is derived from size and
    # so is always < start) is reported as 416 rather than silently
    # downgraded to a 200 of the whole file.
    if start >= size:
        return "unsatisfiable"
    return start, min(end, size - 1)


def make_handler(job_queue, reports_dir: str | Path, detector_keys: list[str]):
    """Build a handler class bound to one queue, report root and key list."""
    reports_root = Path(reports_dir).resolve()
    known_keys = list(detector_keys)

    class Handler(BaseHTTPRequestHandler):
        server_version = "bandpoc"

        def log_message(self, fmt, *args):  # keep the console for job output
            pass

        # --- helpers ------------------------------------------------------

        def _send(
            self,
            status: int,
            body: bytes,
            content_type: str,
            extra_headers: dict[str, str] | None = None,
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            for key, value in (extra_headers or {}).items():
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except ConnectionError:
                # The client went away mid-body. Not exotic: even with Range
                # support, an <audio> element can abort a partial fetch once
                # it has enough buffered. There is no one left to send
                # anything to at this point -- just don't let it become an
                # unhandled-exception traceback on the console that
                # log_message() above was written specifically to keep clear
                # for job output.
                pass

        def _json(self, obj, status: int = 200) -> None:
            self._send(status, json.dumps(obj).encode("utf-8"),
                       "application/json; charset=utf-8")

        def _fail(self, status: int, message: str) -> None:
            # message may carry attacker-controlled text (an echoed detector
            # key, a filename, ...). send_error() interpolates its message
            # straight into the status line with no CR/LF stripping -- that
            # is HTTP response splitting, confirmed with a raw socket during
            # review. Route error text through the JSON body instead, where
            # the status line itself is always the stdlib's fixed reason
            # phrase, and strip CR/LF from the body text too as belt and
            # braces (json.dumps already escapes them, but don't depend on
            # that alone).
            safe = message.replace("\r", "").replace("\n", "")
            self._json({"error": safe}, status=status)

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
            # int() accepts "-1" as a legal integer. A negative length would
            # still be truthy below, so self.rfile.read(length) turns into a
            # read-until-EOF that never arrives on a live socket -- confirmed
            # to hang the request thread forever during review. Reject it
            # here rather than let read() discover the problem.
            if length < 0:
                self._fail(400, "bad Content-Length")
                return
            # Refuse before reading: an oversized body must not be pulled off
            # the socket just to be discarded. Note this only produces a
            # clean 413 when the client's stated Content-Length lies (as the
            # tests below do). A client that genuinely streams a body larger
            # than the cap will instead see its write fail with a connection
            # error once we close the socket without draining -- confirmed
            # with a raw socket during review. That is the accepted
            # trade-off: draining the body to deliver a friendly 413 would
            # defeat the reason the cap exists.
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
            # json.loads accepts any JSON value, not just objects -- a list,
            # null, a bare number or a bare string all parse cleanly. Every
            # field access below assumes a dict, and every .strip()/.join()
            # below assumes str content, so a body that merely parses is not
            # a body that is safe to read: `[]`, `null`, `123`, `"x"`,
            # {"url": 123}, {"url": ["a"]} and {"detectors": [1, 2]} all hit
            # an unhandled AttributeError/TypeError here before this fix --
            # dumping a traceback to the console `log_message` was overridden
            # to keep clean and returning zero bytes to the client. Same
            # defect class this file already closed for %00 in report paths,
            # a TOCTOU read, and the worker loop: validate shape, then a
            # clean 400.
            if not isinstance(payload, dict):
                self._fail(400, "request body must be a JSON object")
                return None
            raw_url = payload.get("url")
            if raw_url is not None and not isinstance(raw_url, str):
                self._fail(400, "url must be a string")
                return None
            url = (raw_url or "").strip()
            if not url:
                self._fail(400, "no url given")
                return None
            raw_detectors = payload.get("detectors")
            if raw_detectors is not None and not (
                isinstance(raw_detectors, list)
                and all(isinstance(d, str) for d in raw_detectors)
            ):
                self._fail(400, "detectors must be a list of strings")
                return None
            detectors = self._detectors_or_fail(raw_detectors or [])
            if detectors is None:
                return None
            raw_id = payload.get("id")
            if raw_id is not None and not isinstance(raw_id, str):
                self._fail(400, "id must be a string")
                return None
            session_id = (raw_id or "").strip() or None
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
            header_id = (self.headers.get("X-Session-Id") or "").strip()
            session_id = slugify(header_id) if header_id else slugify(Path(filename).stem)
            if not session_id:
                # Passing None here would let the pipeline derive an id from
                # job.source instead -- but by then source is the *temp
                # file* path, and mkstemp's random suffix is always
                # alphanumeric, so that derivation always succeeds and
                # quietly names the session after a temp file. Reject
                # instead of accepting a meaningless id.
                self._fail(
                    400,
                    "cannot derive a session id from the upload; "
                    "set X-Session-Id",
                )
                return None

            handle, temp_path = tempfile.mkstemp(suffix=suffix, prefix="bandpoc-")
            try:
                with open(handle, "wb") as out:
                    out.write(body)
            except Exception:
                # No Job exists yet at this point, so the pipeline runner's
                # per-job cleanup (see jobs.make_runner) never gets a chance
                # to run. Without this, a write failure here (disk full,
                # permissions) orphans the temp file permanently.
                Path(temp_path).unlink(missing_ok=True)
                self._fail(500, "failed to store upload")
                return None

            return job_queue.submit(
                temp_path, detectors, session_id=session_id,
                cleanup_source=True,
            ).job_id

        def _serve_report(self, rel: str) -> None:
            target = self._safe_report_path(rel)
            if target is None:
                self._fail(404, "not found")
                return
            content_type = _CONTENT_TYPES.get(
                target.suffix.lower(), "application/octet-stream"
            )
            try:
                size = target.stat().st_size
            except OSError:
                # TOCTOU: is_file() in _safe_report_path and this stat are
                # two separate filesystem calls. The file can vanish or
                # become unreadable in between (removed, permissions) --
                # confirmed to raise straight through as an unhandled
                # OSError, which the client sees as an empty response
                # (RemoteDisconnected), not a 404, and which prints a
                # traceback server-side. Same trade-off as the None branch
                # above: treat "can't be read" the same as "not found"
                # rather than distinguishing them in the response.
                self._fail(404, "not found")
                return

            # Range support (spec: click-to-seek needs it -- without
            # Accept-Ranges and a real 206 answer, Chrome reports a
            # degenerate `seekable` even with the file fully buffered and
            # refuses every seek; confirmed A/B against a Range-capable
            # control server on the same page and file). A missing or
            # malformed Range header, or one this server does not support
            # (multi-range), falls through to an ordinary 200 of the whole
            # file -- RFC 7233 treats an unusable Range the same as none.
            start, end = 0, size - 1  # inclusive, whole file
            status = 200
            range_header = self.headers.get("Range")
            if range_header is not None:
                parsed = _parse_range(range_header, size)
                if parsed == "unsatisfiable":
                    body = json.dumps(
                        {"error": "range not satisfiable"}
                    ).encode("utf-8")
                    self._send(
                        416, body, "application/json; charset=utf-8",
                        extra_headers={"Content-Range": f"bytes */{size}"},
                    )
                    return
                if parsed is not None:
                    start, end = parsed
                    status = 206

            length = end - start + 1
            try:
                # Seek + bounded read, not read_bytes(): a report's audio
                # file can be hundreds of MB, and a client seeking near the
                # end of it must not pull the whole file into memory just to
                # serve a few KB.
                with open(target, "rb") as handle:
                    handle.seek(start)
                    body = handle.read(length)
            except OSError:
                self._fail(404, "not found")
                return

            extra_headers = {"Accept-Ranges": "bytes"}
            if status == 206:
                extra_headers["Content-Range"] = f"bytes {start}-{end}/{size}"
            self._send(status, body, content_type, extra_headers=extra_headers)

        def _safe_report_path(self, rel: str) -> Path | None:
            """Resolve under the report root, or refuse.

            resolve() collapses `..` and follows symlinks BEFORE the check, so
            neither can walk out. Returning None for every rejection -- rather
            than distinguishing "outside the root" from "does not exist" --
            keeps the response from confirming what lives elsewhere on disk.
            """
            try:
                candidate = (reports_root / rel.lstrip("/")).resolve()
            except (OSError, ValueError):
                # resolve() stat()s the path to collapse it, and an embedded
                # NUL byte (a %00 survives unquote() and reaches the
                # filesystem layer as a literal null) makes that stat()
                # raise ValueError rather than return a path -- confirmed
                # with a raw request during review, closing the connection
                # with zero bytes and a traceback on stderr. Any other
                # filesystem-level OSError here gets the same treatment:
                # refuse, don't crash.
                return None
            if not candidate.is_relative_to(reports_root):
                return None
            return candidate if candidate.is_file() else None

    return Handler


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
        # This only stops the HTTP listener. JobQueue's worker is a daemon
        # thread that Ctrl+C never reaches (SIGINT lands on the main thread,
        # blocked in serve_forever() above) and that nothing here joins or
        # drains -- a job in flight is abandoned mid-pipeline, not finished
        # or rolled back, the moment the process actually exits. Confirmed
        # during review: killing a daemon thread mid-write leaves a
        # truncated file with whatever ran after the write (its own cleanup
        # included) never executed. In this pipeline that can mean a
        # truncated scenes/<id>.wav, a corrupt cache .npz, an orphaned
        # bandpoc-* temp upload, or a detached yt-dlp/ffmpeg child process.
        print("\nstopping")
    finally:
        httpd.server_close()
    return 0
