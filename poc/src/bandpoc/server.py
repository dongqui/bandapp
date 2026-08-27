"""Local HTTP front end for session intake (spec section 3.2).

Knows nothing about the pipeline: it parses requests, hands a source to the
job queue, and reports what the queue says. Binds to 127.0.0.1 only -- this
downloads arbitrary URLs and writes arbitrary paths, so there is deliberately
no --host to get wrong.
"""

from __future__ import annotations

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

_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
}

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

    return Handler


def serve(data_dir: str | Path, reports_dir: str | Path, port: int = DEFAULT_PORT) -> int:
    """Start the intake server and block until interrupted.

    Deliberately unimplemented here. The brief for this task listed this
    signature under "Produces" without giving a body; a first pass at filling
    it in turned out to be untested, production-shaped scope (CLI wiring,
    localhost-only binding, busy-port handling) that belongs to its own
    later task and its own brief. This stub keeps the documented interface
    importable without pretending that scope is done.
    """
    raise NotImplementedError(
        "bandpoc.server.serve is implemented by the CLI-wiring task; "
        "see .superpowers/sdd/2026-08-27-browser-session-intake/"
    )
