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

PAGE = "<!doctype html><title>bandpoc</title><p>form arrives in a later task"


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

        def _serve_report(self, rel: str) -> None:
            self._fail(404, "static serving arrives in a later task")

    return Handler


def serve(data_dir: str | Path, reports_dir: str | Path, port: int = DEFAULT_PORT) -> int:
    """Start the intake server and block until interrupted.

    Wires together the pieces earlier tasks built -- the detector registry,
    the job queue and its pipeline runner -- the way a terminal session would
    have; the only new thing here is exposing that over HTTP.
    """
    from . import registry
    from .jobs import JobQueue, make_runner

    import bandpoc.detectors  # noqa: F401 -- registers every adapter

    data_dir = Path(data_dir)
    reports_dir = Path(reports_dir)
    reports_dir.mkdir(parents=True, exist_ok=True)

    job_queue = JobQueue(runner=make_runner(data_dir, reports_dir))
    handler = make_handler(job_queue, reports_dir, registry.all_keys())
    httpd = ThreadingHTTPServer((_HOST, port), handler)
    print(f"bandpoc listening on http://{_HOST}:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
        httpd.server_close()
    return 0
