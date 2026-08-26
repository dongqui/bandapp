"""Explore model output on a recording with no ground truth (spec § 3.3).

Nothing here scores anything. It assembles what a human needs to judge:
the score curve, a starting cutoff, and the segments that cutoff produces.
The actual comparison happens in a browser, against the audio.
"""

from __future__ import annotations

import html as html_mod
import json
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

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
    meta: dict = field(default_factory=dict)


@dataclass(frozen=True)
class SessionView:
    session_id: str
    duration: float
    models: list[ModelView]


def _detector_version(key: str) -> str:
    try:
        return registry.get(key).version
    except (KeyError, ImportError):
        return "1"


def collect_session(
    data_dir: str | Path, session_id: str, keys: list[str]
) -> SessionView:
    """Gather every cached curve for one session, ready for rendering."""
    data_dir = Path(data_dir)
    wav, sr = load_audio(data_dir / "scenes" / f"{session_id}.wav")
    duration = len(wav) / sr
    n_frames = int(np.floor(round(duration / HOP, 6)))

    models: list[ModelView] = []
    for key in keys:
        path = cache.cache_path(
            data_dir / "cache", session_id, key, _detector_version(key)
        )
        if not path.exists():
            continue
        cached = cache.load(path)
        curve = resample_scores(cached.scores, cached.hop, n_frames, HOP)
        chosen = auto_threshold(curve)
        params = PostParams(
            threshold=chosen.value,
            min_duration=DEFAULTS.min_duration,
            merge_gap=DEFAULTS.merge_gap,
        )
        models.append(
            ModelView(
                key=key,
                scores=[round(float(v), _SCORE_DECIMALS) for v in curve],
                threshold=chosen.value,
                reason=chosen.reason,
                separated=chosen.separated,
                segments=[
                    (s.start, s.end) for s in scores_to_segments(curve, HOP, params)
                ],
                meta=cached.meta,
            )
        )

    # Ascending take count: whichever model over-detects sinks to the bottom
    # where it is obvious. Fixed at load time - see the renderer.
    models.sort(key=lambda m: (len(m.segments), m.key))
    return SessionView(session_id=session_id, duration=duration, models=models)


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
.flag{color:#c62828;font-size:.78rem}
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
  const minDuration = parseFloat(document.getElementById('min-duration').value);
  const mergeGap = parseFloat(document.getElementById('merge-gap').value);
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
        f"<span class='flag'>models that do not separate cleanly: "
        f"{html_mod.escape(model.reason)}</span>"
        if not model.separated
        else ""
    )
    return f"""<section class='model'>
  <header>
    <span class='key'>{html_mod.escape(model.key)}</span>
    <label>cutoff <input type='range' id='thresh-{index}' min='0' max='1'
      step='0.01' value='{model.threshold}'></label>
    <span id='value-{index}'>{model.threshold:.2f}</span>
    <span class='count' id='count-{index}'></span>
    {flag}
  </header>
  <canvas id='canvas-{index}'></canvas>
  <div class='segs' id='segs-{index}'></div>
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
    page = f"""<!doctype html><html lang='ko'><head><meta charset='utf-8'>
<title>{html_mod.escape(view.session_id)} - 모델 비교</title>
<style>{_CSS}</style></head><body>
<h1>{html_mod.escape(view.session_id)} · {view.duration / 60:.1f} min</h1>
<div class='banner' id='drift'></div>
<audio id='player' controls src="{html_mod.escape(mp3_name)}"></audio>
<div class='controls'>
  <label>min duration <input type='number' id='min-duration'
    value='{DEFAULTS.min_duration}' min='0' step='1'> s</label>
  <label>merge gap <input type='number' id='merge-gap'
    value='{DEFAULTS.merge_gap}' min='0' step='1'> s</label>
  <span>타임라인을 클릭하면 그 시점부터 재생된다.</span>
</div>
{blocks}
<script id="session-data" type="application/json">{json.dumps(payload)}</script>
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
    page = f"""<!doctype html><html lang='ko'><head><meta charset='utf-8'>
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
