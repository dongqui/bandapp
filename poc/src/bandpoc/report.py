"""Self-contained HTML report (spec § 7).

Everything is inlined as data URIs so the file can be opened from disk, copied
around, or attached to a message with no server and no broken images.
"""

from __future__ import annotations

import base64
import html
import io
from dataclasses import dataclass, field
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

from .labels import HOP, LABELS, SceneLabels  # noqa: E402
from .sweep import SweepPoint  # noqa: E402

def _use_a_font_with_hangul() -> None:
    """Chart titles are Korean; DejaVu Sans has no Hangul and renders tofu.

    Picks the first installed candidate rather than bundling a font. If none is
    present the titles degrade to boxes, which is ugly but never fatal -- the
    numbers in the HTML table are the report's substance.
    """
    import matplotlib.font_manager as fm

    installed = {f.name for f in fm.fontManager.ttflist}
    for candidate in ("Malgun Gothic", "Noto Sans KR", "NanumGothic", "Gulim", "Dotum"):
        if candidate in installed:
            plt.rcParams["font.family"] = candidate
            # The chosen fonts render a hyphen-minus but not U+2212.
            plt.rcParams["axes.unicode_minus"] = False
            return


_use_a_font_with_hangul()

_RECALL_FLOOR = 0.90
_CAVEAT = (
    "이 리포트의 수치는 유튜브 클립을 조립한 <b>합성 씬</b>에서 나온 것이다. "
    "블록 경계가 실제 합주보다 깔끔하므로 <b>모델 간 상대 비교</b>로만 읽어야 하며, "
    "절대 정확도는 실제 합주 녹음을 확보한 뒤 재검증해야 한다."
)
_LABEL_COLORS = {
    "music": "#2e7d32",
    "speech": "#c62828",
    "silence": "#bdbdbd",
    "tuning": "#ef6c00",
    "ambient": "#8d8d8d",
    "speech_with_noodling": "#6a1b9a",
}


@dataclass
class DetectorResult:
    key: str
    available: bool
    reason: str
    best: SweepPoint | None
    top_recall: SweepPoint | None
    points: list[SweepPoint]
    curves: dict[str, np.ndarray]
    meta: dict = field(default_factory=dict)


def fig_to_data_uri(fig) -> str:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=110, bbox_inches="tight")
    plt.close(fig)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _fmt(value: float, digits: int = 3) -> str:
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return "—"
    return f"{value:.{digits}f}"


def _summary_rows(results: list[DetectorResult]) -> str:
    rows = []
    for r in results:
        if not r.available:
            rows.append(
                f"<tr class='na'><td>{html.escape(r.key)}</td>"
                f"<td colspan='8'>unavailable — {html.escape(r.reason)}</td></tr>"
            )
            continue
        point = r.best or r.top_recall
        if point is None:
            rows.append(
                f"<tr class='na'><td>{html.escape(r.key)}</td>"
                f"<td colspan='8'>no sweep points</td></tr>"
            )
            continue
        note = "" if r.best else " <span class='warn'>90% recall not reached</span>"
        cls = "ok" if r.best else "warn-row"
        p = point.params
        rows.append(
            f"<tr class='{cls}'><td>{html.escape(r.key)}{note}</td>"
            f"<td>{p.threshold:.2f} / {p.min_duration:.0f}s / {p.merge_gap:.0f}s</td>"
            f"<td>{_fmt(point.recall)}</td>"
            f"<td>{point.false_seconds:.0f}s</td>"
            f"<td>{_fmt(point.false_ratio)}</td>"
            f"<td>{_fmt(point.boundary.start_p50, 1)} / {_fmt(point.boundary.start_p90, 1)}</td>"
            f"<td>{_fmt(point.boundary.end_p50, 1)} / {_fmt(point.boundary.end_p90, 1)}</td>"
            f"<td>{point.take_count_error:+d}</td>"
            f"<td>{_fmt(r.meta.get('rtf'), 4)}</td></tr>"
        )
    return "\n".join(rows)


def _heatmap(results: list[DetectorResult]) -> str:
    usable = [r for r in results if r.available and (r.best or r.top_recall)]
    labels = [name for name in LABELS if name != "music"]
    if not usable:
        return ""
    data = np.array(
        [
            [(r.best or r.top_recall).counts.per_label_false_rate.get(n, np.nan) for n in labels]
            for r in usable
        ],
        dtype=float,
    )
    fig, ax = plt.subplots(figsize=(1.4 * len(labels) + 2, 0.5 * len(usable) + 1.6))
    im = ax.imshow(data, cmap="Reds", vmin=0.0, vmax=1.0, aspect="auto")
    ax.set_xticks(range(len(labels)), labels, rotation=30, ha="right", fontsize=8)
    ax.set_yticks(range(len(usable)), [r.key for r in usable], fontsize=8)
    for i in range(data.shape[0]):
        for j in range(data.shape[1]):
            if not np.isnan(data[i, j]):
                ax.text(j, i, f"{data[i, j]:.2f}", ha="center", va="center", fontsize=7,
                        color="white" if data[i, j] > 0.5 else "black")
    ax.set_title("라벨별 오검출률 (낮을수록 좋음)", fontsize=10)
    fig.colorbar(im, ax=ax, shrink=0.8)
    return fig_to_data_uri(fig)


def _timeline(scene: SceneLabels, results: list[DetectorResult]) -> str:
    usable = [r for r in results if r.available and scene.scene_id in r.curves]
    fig, axes = plt.subplots(
        len(usable) + 1, 1, figsize=(13, 1.1 * (len(usable) + 1) + 1),
        sharex=True, gridspec_kw={"hspace": 0.35},
    )
    axes = np.atleast_1d(axes)
    truth_ax = axes[0]
    masks = scene.frame_masks()
    for block in scene.blocks:
        truth_ax.axvspan(block.start, block.end, color=_LABEL_COLORS[block.label], alpha=0.75)
    times = np.arange(len(masks.is_dontcare)) * HOP
    for start, end in _runs(masks.is_dontcare, times):
        truth_ax.axvspan(start, end, facecolor="none", edgecolor="white", hatch="///",
                         linewidth=0.0)
    truth_ax.set_yticks([])
    truth_ax.set_ylabel("truth", fontsize=8, rotation=0, ha="right", va="center")
    truth_ax.set_xlim(0, scene.duration)

    for ax, r in zip(axes[1:], usable):
        curve = r.curves[scene.scene_id]
        ax.plot(np.arange(len(curve)) * HOP, curve, linewidth=0.7, color="#1565c0")
        point = r.best or r.top_recall
        if point is not None:
            ax.axhline(point.params.threshold, color="#999", linewidth=0.6, linestyle="--")
            for seg in point.segments_by_scene.get(scene.scene_id, []):
                ax.axvspan(seg.start, seg.end, color="#2e7d32", alpha=0.20)
        ax.set_ylim(0, 1)
        ax.set_yticks([0, 1])
        ax.set_ylabel(r.key.split(":")[0], fontsize=7, rotation=0, ha="right", va="center")
    axes[-1].set_xlabel("seconds")
    return fig_to_data_uri(fig)


def _runs(mask: np.ndarray, times: np.ndarray) -> list[tuple[float, float]]:
    padded = np.concatenate(([False], mask.astype(bool), [False]))
    edges = np.diff(padded.astype(np.int8))
    starts = np.flatnonzero(edges == 1)
    ends = np.flatnonzero(edges == -1)
    hop = times[1] - times[0] if len(times) > 1 else HOP
    return [(float(s) * hop, float(e) * hop) for s, e in zip(starts, ends)]


def _sweep_curves(results: list[DetectorResult]) -> str:
    fig, ax = plt.subplots(figsize=(7.5, 5))
    plotted = False
    for r in results:
        if not r.available or not r.points:
            continue
        # One line per detector: hold merge/min-duration at the spec defaults so
        # the curve traces threshold alone.
        pts = sorted(
            (p for p in r.points if p.params.min_duration == 20.0 and p.params.merge_gap == 10.0),
            key=lambda p: p.params.threshold,
        )
        if not pts:
            continue
        ax.plot([p.false_seconds for p in pts], [p.recall for p in pts], marker="o",
                markersize=3, linewidth=1.0, label=r.key)
        plotted = True
    if not plotted:
        plt.close(fig)
        return ""
    ax.axhline(_RECALL_FLOOR, color="#c62828", linestyle="--", linewidth=0.8)
    ax.set_xlabel("False Music (seconds)")
    ax.set_ylabel("Music Recall")
    ax.set_title("threshold 스윕 트레이드오프 (min_duration=20s, merge_gap=10s)", fontsize=10)
    ax.set_ylim(0, 1.02)
    ax.legend(fontsize=7)
    ax.grid(alpha=0.25)
    return fig_to_data_uri(fig)


_CSS = """
body{font-family:system-ui,'Segoe UI',sans-serif;margin:0;padding:2rem;
     background:#fafafa;color:#1a1a1a;line-height:1.6}
h1{font-size:1.6rem}h2{font-size:1.2rem;margin-top:2.5rem;border-bottom:1px solid #ddd;
   padding-bottom:.3rem}
table{border-collapse:collapse;width:100%;font-size:.85rem;background:#fff}
th,td{border:1px solid #e0e0e0;padding:.4rem .6rem;text-align:left}
th{background:#f0f0f0}
tr.ok td:first-child{border-left:3px solid #2e7d32}
tr.warn-row td:first-child{border-left:3px solid #ef6c00}
tr.na{color:#999}
.warn{color:#c62828;font-weight:600;font-size:.8rem}
.caveat{background:#fff8e1;border-left:4px solid #ffb300;padding:.8rem 1rem;margin:1rem 0}
img{max-width:100%;height:auto;display:block;margin:1rem 0;background:#fff}
.meta{font-size:.8rem;color:#666}
"""


def build_report(
    results: list[DetectorResult],
    scenes: dict[str, SceneLabels],
    out_dir: str | Path,
    notes: str = "",
) -> Path:
    parts = [
        "<!doctype html><html lang='ko'><head><meta charset='utf-8'>",
        "<title>Band Feedback — 음악 구간 검출 모델 비교</title>",
        f"<style>{_CSS}</style></head><body>",
        "<h1>Band Feedback — 음악 구간 검출 모델 비교</h1>",
        f"<div class='caveat'>{_CAVEAT}</div>",
        "<h2>요약</h2>",
        "<table><tr><th>Detector</th><th>최적 파라미터 (th / min / gap)</th>"
        "<th>Music Recall</th><th>False Music</th><th>False 비율</th>"
        "<th>Start err p50/p90</th><th>End err p50/p90</th>"
        "<th>Take Count Err</th><th>RTF</th></tr>",
        _summary_rows(results),
        "</table>",
        f"<p class='meta'>Recall 하한 {_RECALL_FLOOR:.0%} 제약 하에 False Music이 "
        "최소인 지점을 골랐다. 제약을 만족하는 조합이 없으면 최대 Recall 지점을 "
        "보여주고 경고를 붙인다.</p>",
    ]

    heatmap = _heatmap(results)
    if heatmap:
        parts += ["<h2>라벨별 오검출 히트맵</h2>", f"<img src='{heatmap}' alt='heatmap'>"]

    sweep_img = _sweep_curves(results)
    if sweep_img:
        parts += ["<h2>threshold 스윕</h2>", f"<img src='{sweep_img}' alt='sweep'>"]

    parts.append("<h2>씬별 타임라인</h2>")
    legend = " · ".join(
        f"<span style='color:{c}'>■</span> {html.escape(n)}" for n, c in _LABEL_COLORS.items()
    )
    parts.append(f"<p class='meta'>{legend} · 빗금 = don't-care (감점 없음)</p>")
    for scene_id, scene in scenes.items():
        parts += [
            f"<h3>{html.escape(scene_id)} ({scene.duration / 60:.1f} min)</h3>",
            f"<img src='{_timeline(scene, results)}' alt='{html.escape(scene_id)}'>",
        ]

    if notes:
        parts += ["<h2>실행 메타</h2>", f"<pre class='meta'>{html.escape(notes)}</pre>"]
    parts.append("</body></html>")

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "index.html"
    path.write_text("\n".join(parts), encoding="utf-8")
    return path
