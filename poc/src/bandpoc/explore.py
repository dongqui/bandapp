"""Explore model output on a recording with no ground truth (spec § 3.3).

Nothing here scores anything. It assembles what a human needs to judge:
the score curve, a starting cutoff, and the segments that cutoff produces.
The actual comparison happens in a browser, against the audio.

`ModelView.segments` are computed from the ROUNDED score curve (see
`_SCORE_DECIMALS`), not the full-precision one -- deliberately. The page's
JS reimplementation of the post-processing (`toSegments`) only ever sees the
rounded `scores` it is sent, so segments derived from a different, more
precise input would legitimately disagree with what the browser computes
near the cutoff, even with no bug on either side, and would trip the page's
drift banner (spec § 5 R1) on a false alarm. Consequence: the segments shown
can differ from what the full-precision curve would produce, for frames
within `10 ** -_SCORE_DECIMALS / 2` of the cutoff. That is acceptable -- this
is an eyeball tool with a live slider, and a frame-level difference at the
cutoff is far below what a human is judging by ear. Do not "fix" this by
computing segments from the full-precision curve again.
"""

from __future__ import annotations

import html as html_mod
import json
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import soundfile as sf

from . import cache, registry
from .audio import load_audio
from .autothresh import auto_threshold
from .labels import HOP
from .postproc import PostParams, resample_scores, scores_to_segments

DEFAULTS = PostParams(threshold=0.5, min_duration=20.0, merge_gap=10.0)
"""min_duration and merge_gap follow the post-processing spec; threshold is
per-model and comes from autothresh."""

_SCORE_DECIMALS = 2
"""0.01 resolution on a 0-1 curve is finer than a screen pixel and roughly
halves the page size against full float repr."""


@dataclass(frozen=True)
class ModelView:
    key: str
    scores: list[float]
    threshold: float
    reason: str
    separated: bool
    segments: list[tuple[float, float]]
    binary: bool = False
    meta: dict = field(default_factory=dict)


@dataclass(frozen=True)
class SessionView:
    session_id: str
    duration: float
    models: list[ModelView]
    # key -> human reason, for a requested detector that could not be
    # resolved to any cache file at all (Important 2). Kept separate from
    # `models` rather than folded into a log line printed here: this module
    # never prints (only cli.py does), so the caller decides how -- or
    # whether -- to surface it.
    skipped: dict = field(default_factory=dict)


def _resolve_version(key: str) -> tuple[str | None, str | None]:
    """Look up a detector's real cache version.

    Returns ``(version, None)`` on success, or ``(None, reason)`` when the
    key is unknown or a *registered* backend's factory blows up importing a
    heavy dependency (registry.py defers those imports to instantiation
    time, so a key can pass `explore`'s own --detectors validation and still
    fail here). Never fabricates a version on failure -- explore only ever
    reads `.npz` files, it does not touch a model, so inventing a version
    number would silently point the cache lookup at the wrong filename (see
    `_cached_path_for_unresolved_version` below and the Important 2 writeup
    in the task report for the full story: this used to return "1", which
    happened to be right for every detector except one, by coincidence).
    """
    try:
        return registry.get(key).version, None
    except (KeyError, ImportError) as exc:
        return None, str(exc)


def _detector_version(key: str) -> str | None:
    return _resolve_version(key)[0]


def _cached_path_for_unresolved_version(
    cache_dir: Path, session_id: str, key: str
) -> Path | None:
    """Find a cached score file for `key` when its version can't be looked
    up. Cache filenames are ``<session>__<key>__v<version>.npz``; build the
    glob through `cache._sanitize` -- the same sanitiser `cache.cache_path`
    uses to write them -- rather than reimplementing the escaping rules, so
    a session id or key containing characters the sanitiser rewrites still
    matches its own file.

    Returns a match only when it is unambiguous. If the cache holds curves
    for this key at two different versions (a stale one from before a
    version bump, plus a fresh one, both orphaned because the version can no
    longer be looked up), guessing which is "the" cache would risk silently
    showing stale scores as current ones.
    """
    pattern = f"{cache._sanitize(session_id)}__{cache._sanitize(key)}__v*.npz"
    matches = sorted(Path(cache_dir).glob(pattern))
    return matches[0] if len(matches) == 1 else None


def collect_session(
    data_dir: str | Path, session_id: str, keys: list[str]
) -> SessionView:
    """Gather every cached curve for one session, ready for rendering."""
    data_dir = Path(data_dir)
    # Read the duration from the header, not the samples: `load_audio` pulls
    # the whole file into RAM as float32, and this function only ever needed
    # one number out of it. Measured on a real 45-minute session: peak RSS
    # 1132 MB against a 95 MB baseline, scaling linearly with recording
    # length -- on a tool whose whole premise is "the recording is imported
    # whole, length unlimited" (a 2-hour rehearsal would be ~3 GB). Do not
    # "simplify" this back to `wav, sr = load_audio(path); len(wav) / sr`.
    info = sf.info(str(data_dir / "scenes" / f"{session_id}.wav"))
    duration = info.frames / info.samplerate
    n_frames = int(np.floor(round(duration / HOP, 6)))

    models: list[ModelView] = []
    skipped: dict = {}
    cache_dir = data_dir / "cache"
    for key in keys:
        version, reason = _resolve_version(key)
        if version is not None:
            path = cache.cache_path(cache_dir, session_id, key, version)
        else:
            path = _cached_path_for_unresolved_version(cache_dir, session_id, key)
            if path is None:
                # The version lookup failed AND nothing is cached under any
                # version for this key either -- there is genuinely nothing
                # to show, but say why instead of leaving the caller to
                # conclude (wrongly) that the cache is simply empty. Before
                # this fix that wrong conclusion sent people to re-run
                # `bandpoc run`, which hits the exact same failed import.
                skipped[key] = reason
                continue
        if not path.exists():
            continue
        cached = cache.load(path)
        curve = resample_scores(cached.scores, cached.hop, n_frames, HOP)
        # auto_threshold reads the full-precision curve: it only picks a
        # cutoff and never needs to agree with anything frame-by-frame.
        chosen = auto_threshold(curve)
        # Round BEFORE segmenting, not after. The page's JS only ever sees
        # this rounded curve, so `scores` and `segments` must both be
        # derived from it -- see the module docstring for why.
        shown = np.round(curve, _SCORE_DECIMALS).astype(np.float32)
        params = PostParams(
            threshold=chosen.value,
            min_duration=DEFAULTS.min_duration,
            merge_gap=DEFAULTS.merge_gap,
        )
        # `shown` is float32; `chosen.value` (params.threshold) is a plain
        # Python float. For about half of the 101 possible 2-decimal
        # thresholds, float32(v) < v in float64 (e.g. float32(0.32) ==
        # 0.3199999928...), so the two languages agreeing that a
        # frame == threshold is "on" is NOT a given. It works here because
        # scores_to_segments does `np.asarray(shown) >= params.threshold`:
        # with numpy<2's scalar promotion rules, comparing a float32 array
        # against a Python float scalar demotes the scalar to float32
        # first, so this comparison runs float32-vs-float32 -- while the
        # page's JS runs float64-vs-float64 on the same 2-decimal numbers.
        # Both preserve equality on the 0.01 grid, but only because of this
        # implicit, version-dependent promotion. A future numpy upgrade (or
        # passing a plain Python list here instead of the float32 array)
        # could silently switch this to a float64 comparison and reintroduce
        # the false-positive drift-banner risk this function exists to
        # avoid -- if that ever needs to change, re-verify this note first.
        segments = [
            (s.start, s.end) for s in scores_to_segments(shown, HOP, params)
        ]
        # Hard-label detectors (ina_segmenter, silero_vad) emit essentially
        # two distinct values, which makes the cutoff slider meaningless
        # across almost its whole range -- but `separated` doesn't catch
        # this: Otsu's between-class variance on a clean 0/1 split is ~0.25,
        # comfortably above the floor, so `separated` reports True
        # (autothresh.py's docstring calls this out as a known limitation of
        # `separated` being a spread proxy, not a bimodality test). Today
        # this caveat only lives in README.md, and only about the scored
        # report -- surface it on the explore page too (Minor 9).
        binary = bool(np.unique(shown).size == 2)
        models.append(
            ModelView(
                key=key,
                scores=[round(float(v), _SCORE_DECIMALS) for v in shown],
                threshold=chosen.value,
                reason=chosen.reason,
                separated=chosen.separated,
                segments=segments,
                binary=binary,
                meta=cached.meta,
            )
        )

    # Ascending take count: whichever model over-detects sinks to the bottom
    # where it is obvious. Fixed at load time - see the renderer.
    models.sort(key=lambda m: (len(m.segments), m.key))
    return SessionView(
        session_id=session_id, duration=duration, models=models, skipped=skipped
    )


def encode_mp3(wav_path: str | Path, mp3_path: str | Path) -> Path:
    """Encode once and keep it: a report folder is timestamped, so caching the
    mp3 beside the report would re-encode a 47-minute file every run."""
    wav_path, mp3_path = Path(wav_path), Path(mp3_path)
    if mp3_path.exists() and mp3_path.stat().st_mtime_ns >= wav_path.stat().st_mtime_ns:
        return mp3_path
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found on PATH. Install it: winget install Gyan.FFmpeg")
    mp3_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path),
         "-ac", "1", "-b:a", "128k", str(mp3_path)],
        check=True,
    )
    return mp3_path


_CSS = """
:root{color-scheme:light}
body{font-family:system-ui,'Segoe UI','Malgun Gothic',sans-serif;margin:0;
     padding:1.5rem;background:#fafafa;color:#1a1a1a}
h1{font-size:1.3rem;margin:0 0 1rem}
a{color:#1565c0}
audio{width:100%;margin-bottom:1rem}
.controls{background:#fff;border:1px solid #e0e0e0;padding:.6rem .9rem;
          margin-bottom:1rem;display:flex;gap:1.5rem;align-items:center;
          flex-wrap:wrap;font-size:.85rem}
.controls input[type=number]{width:5rem}
.model{background:#fff;border:1px solid #e0e0e0;margin-bottom:.9rem;padding:.6rem .9rem}
.model header{display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
.key{font-weight:600;font-size:.9rem;min-width:16rem}
.count{font-size:.85rem;color:#555}
.flag,.binary-flag{color:#c62828;font-size:.78rem}
canvas{width:100%;height:64px;display:block;margin-top:.4rem;cursor:pointer}
.segs{font-size:.75rem;color:#555;margin-top:.3rem;
      font-family:ui-monospace,Consolas,monospace;word-break:break-all}
.banner{background:#c62828;color:#fff;padding:.7rem 1rem;margin-bottom:1rem;
        font-weight:600;display:none}
"""

_JS = """
const DATA = JSON.parse(document.getElementById('session-data').textContent);
const audio = document.getElementById('player');

// Mirror of bandpoc.postproc.scores_to_segments. Every comparison keeps its
// equality exactly as the Python does: >= threshold, <= merge_gap,
// >= min_duration. The reference cross-check below guards this.
function toSegments(scores, hop, threshold, mergeGap, minDuration) {
  const runs = [];
  let start = -1;
  for (let i = 0; i < scores.length; i++) {
    const on = scores[i] >= threshold;
    if (on && start < 0) start = i;
    if (!on && start >= 0) { runs.push([start * hop, i * hop]); start = -1; }
  }
  if (start >= 0) runs.push([start * hop, scores.length * hop]);

  const merged = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run[0] - last[1] <= mergeGap + 1e-9) last[1] = run[1];
    else merged.push([run[0], run[1]]);
  }
  return merged.filter(s => s[1] - s[0] >= minDuration - 1e-9);
}

function mmss(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function sameSegments(a, b) {
  if (a.length !== b.length) return false;
  return a.every((s, i) =>
    Math.abs(s[0] - b[i][0]) < 1e-6 && Math.abs(s[1] - b[i][1]) < 1e-6);
}

// <input type='number'> is freely clearable, and parseFloat('') is NaN --
// without this, clearing min-duration or merge-gap would silently make
// every "duration >= NaN" comparison false (every timeline goes to "0
// takes") or silently disable merging, with no indication why. Fall back to
// the payload default, and never let a negative value through: a negative
// mergeGap or minDuration does not mean "disabled", it means the field is
// broken, and should behave like it was never touched.
function numberOr(value, fallback) {
  const parsed = parseFloat(value);
  return Math.max(0, Number.isFinite(parsed) ? parsed : fallback);
}

const rows = DATA.models.map((model, index) => {
  const canvas = document.getElementById('canvas-' + index);
  const slider = document.getElementById('thresh-' + index);
  const readout = document.getElementById('value-' + index);
  const count = document.getElementById('count-' + index);
  const list = document.getElementById('segs-' + index);
  return { model, canvas, slider, readout, count, list, segments: [] };
});

function draw(row) {
  const { canvas, model, segments } = row;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const perSecond = width / DATA.duration;

  ctx.fillStyle = 'rgba(46,125,50,0.20)';
  for (const [start, end] of segments) {
    ctx.fillRect(start * perSecond, 0, Math.max(1, (end - start) * perSecond), height);
  }

  ctx.strokeStyle = '#1565c0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = Math.max(1, Math.floor(model.scores.length / width));
  for (let i = 0; i < model.scores.length; i += step) {
    const x = (i * DATA.hop) * perSecond;
    const y = height - model.scores[i] * height;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.strokeStyle = '#999';
  ctx.setLineDash([4, 3]);
  const cut = height - parseFloat(row.slider.value) * height;
  ctx.beginPath(); ctx.moveTo(0, cut); ctx.lineTo(width, cut); ctx.stroke();
  ctx.setLineDash([]);

  const playhead = audio.currentTime * perSecond;
  ctx.strokeStyle = '#c62828';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(playhead, 0); ctx.lineTo(playhead, height); ctx.stroke();
}

function recompute(row) {
  const minDuration = numberOr(document.getElementById('min-duration').value, DATA.minDuration);
  const mergeGap = numberOr(document.getElementById('merge-gap').value, DATA.mergeGap);
  row.segments = toSegments(
    row.model.scores, DATA.hop, parseFloat(row.slider.value), mergeGap, minDuration);
  row.readout.textContent = parseFloat(row.slider.value).toFixed(2);
  row.count.textContent = row.segments.length + ' takes';
  row.list.textContent = row.segments
    .map(s => mmss(s[0]) + '-' + mmss(s[1])).join(' · ');
  draw(row);
}

for (const row of rows) {
  row.slider.addEventListener('input', () => recompute(row));
  row.canvas.addEventListener('click', event => {
    const box = row.canvas.getBoundingClientRect();
    audio.currentTime = ((event.clientX - box.left) / box.width) * DATA.duration;
    audio.play();
  });
}
for (const id of ['min-duration', 'merge-gap']) {
  document.getElementById(id).addEventListener('input',
    () => rows.forEach(recompute));
}
audio.addEventListener('timeupdate', () => rows.forEach(draw));
window.addEventListener('resize', () => rows.forEach(draw));

rows.forEach(recompute);

// Spec § 5 R1: two implementations of the same post-processing will drift.
// Compare against what Python computed at the same parameters and say so
// loudly rather than showing a quietly wrong picture.
const drifted = rows.filter(row => !sameSegments(
  toSegments(row.model.scores, DATA.hop, row.model.threshold,
             DATA.mergeGap, DATA.minDuration),
  row.model.reference));
if (drifted.length) {
  const banner = document.getElementById('drift');
  banner.textContent =
    'WARNING: browser post-processing disagrees with Python for ' +
    drifted.map(r => r.model.key).join(', ') +
    '. The timelines below cannot be trusted.';
  banner.style.display = 'block';
}
"""


def _model_block(index: int, model: ModelView) -> str:
    flag = (
        f'<span class="flag">this model does not separate cleanly: '
        f'{html_mod.escape(model.reason)}</span>'
        if not model.separated
        else ""
    )
    # Minor 9: a hard-label detector's cutoff slider does nothing across
    # almost its whole range -- see the `binary` comment in collect_session.
    binary_note = (
        '<span class="binary-flag">this model outputs a hard 0/1 curve -- '
        "the cutoff slider does nothing across almost its whole range</span>"
        if model.binary
        else ""
    )
    return f"""<section class="model">
  <header>
    <span class="key">{html_mod.escape(model.key)}</span>
    <label>cutoff <input type="range" id="thresh-{index}" min="0" max="1"
      step="0.01" value="{model.threshold}"></label>
    <span id="value-{index}">{model.threshold:.2f}</span>
    <span class="count" id="count-{index}"></span>
    {flag}
    {binary_note}
  </header>
  <canvas id="canvas-{index}"></canvas>
  <div class="segs" id="segs-{index}"></div>
</section>"""


def render_session(view: SessionView, mp3_name: str, out_dir: str | Path) -> Path:
    payload = {
        "sessionId": view.session_id,
        "duration": view.duration,
        "hop": HOP,
        "minDuration": DEFAULTS.min_duration,
        "mergeGap": DEFAULTS.merge_gap,
        "models": [
            {
                "key": m.key,
                "scores": m.scores,
                "threshold": m.threshold,
                "reason": m.reason,
                "separated": m.separated,
                "reference": [list(s) for s in m.segments],
            }
            for m in view.models
        ],
    }
    blocks = "\n".join(_model_block(i, m) for i, m in enumerate(view.models))
    # Belt-and-braces: the brief this was built from claimed session_id is
    # always [a-z0-9_-] because of Task 1's slugify, but that claim was
    # false -- the YouTube branch in session.py returned the raw `v=` query
    # value with no validation, so a crafted URL could smuggle "</script>"
    # straight into this payload. session.py now validates the id at the
    # source (see _VALID_YOUTUBE_ID there), but escaping "</" here too means
    # this sink is closed even if some other future caller of render_session
    # passes an unvalidated session_id. Do not remove this.
    embedded_json = json.dumps(payload).replace("</", "<\\/")
    page = f"""<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>{html_mod.escape(view.session_id)} - 모델 비교</title>
<style>{_CSS}</style></head><body>
<h1>{html_mod.escape(view.session_id)} · {view.duration / 60:.1f} min</h1>
<div class="banner" id="drift"></div>
<audio id="player" controls src="{html_mod.escape(mp3_name)}"></audio>
<div class="controls">
  <label>min duration <input type="number" id="min-duration"
    value="{DEFAULTS.min_duration}" min="0" step="1"> s</label>
  <label>merge gap <input type="number" id="merge-gap"
    value="{DEFAULTS.merge_gap}" min="0" step="1"> s</label>
  <span>타임라인을 클릭하면 그 시점부터 재생된다.</span>
</div>
{blocks}
<script id="session-data" type="application/json">{embedded_json}</script>
<script>{_JS}</script>
</body></html>"""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{view.session_id}.html"
    path.write_text(page, encoding="utf-8")
    return path


def render_index(views: list[SessionView], out_dir: str | Path) -> Path:
    rows = "\n".join(
        f'<li><a href="{html_mod.escape(v.session_id)}.html">'
        f"{html_mod.escape(v.session_id)}</a> — {v.duration / 60:.1f} min, "
        f"{len(v.models)} models</li>"
        for v in views
    )
    page = f"""<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>세션 탐색</title><style>{_CSS}</style></head><body>
<h1>세션 탐색</h1>
<p>정답 라벨이 없는 실제 녹음이다. 오디오를 들으며 모델별 검출 구간을 직접 비교한다.</p>
<ul>{rows}</ul>
</body></html>"""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "index.html"
    path.write_text(page, encoding="utf-8")
    return path
