"""Command line: fetch → build-scenes → run → report."""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import numpy as np

from . import cache, registry
from .audio import WORK_SR, load_audio
from .detectors.base import Detector
from .fetch import fetch_pool, ffmpeg_available, load_sources
from .labels import HOP, SceneLabels
from .postproc import resample_scores
from .report import DetectorResult, build_report
from .synth import ClipPool, build_scene, load_recipes
from .sweep import SceneInput, best_point, run_sweep

import bandpoc.detectors  # noqa: F401 — registers every adapter

_DEFAULT_DATA = Path("data")


def _peak_rss_mb() -> float:
    import psutil

    return psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)


def _peak_vram_mb() -> float | None:
    try:
        import torch

        if torch.cuda.is_available():
            return torch.cuda.max_memory_allocated() / (1024 * 1024)
    except Exception:
        pass
    return None


def score_scene(detector: Detector, wav: np.ndarray, sr: int) -> tuple[np.ndarray, float, dict]:
    """Run one detector over one scene, measuring wall time and memory."""
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
    except Exception:
        pass
    started = time.perf_counter()
    scores, hop = detector.music_score(wav, sr)
    wall = time.perf_counter() - started
    duration = len(wav) / sr
    return (
        scores,
        hop,
        {
            "wall_s": round(wall, 3),
            "duration_s": round(duration, 3),
            "rtf": round(wall / duration, 5) if duration > 0 else 0.0,
            "peak_rss_mb": round(_peak_rss_mb(), 1),
            "peak_vram_mb": _peak_vram_mb(),
            "detector_version": detector.version,
        },
    )


def _scene_ids(data_dir: Path, requested: str) -> list[str]:
    available = sorted(p.stem.replace(".labels", "")
                       for p in (data_dir / "scenes").glob("*.labels.json"))
    if requested == "all":
        return available
    return [s for s in requested.split(",") if s in available]


def cmd_fetch(args) -> int:
    if not ffmpeg_available():
        print("ffmpeg not found on PATH. Install it: winget install Gyan.FFmpeg")
        return 1
    data_dir = Path(args.data_dir)
    total = 0
    for spec in load_sources(args.sources):
        n = fetch_pool(spec, data_dir / "raw", data_dir / "clips")
        print(f"{spec.name}: {n} clips")
        total += n
    print(f"\n{total} clips written to {data_dir / 'clips'}")
    print(
        "Search results are UNVETTED. Listen through each pool and delete anything "
        "that does not match its intent before running build-scenes -- bad material "
        "silently corrupts every metric downstream."
    )
    return 0


def cmd_build_scenes(args) -> int:
    data_dir = Path(args.data_dir)
    pool = ClipPool.from_dir(data_dir / "clips")
    if not pool.clips:
        print(f"no clips under {data_dir / 'clips'}; run `bandpoc fetch` first")
        return 1
    for recipe in load_recipes(args.recipes):
        scene = build_scene(recipe, pool, data_dir / "scenes")
        takes = len(scene.ground_truth_takes())
        print(f"{scene.scene_id}: {scene.duration / 60:.1f} min, {takes} takes")
    return 0


def cmd_run(args) -> int:
    data_dir = Path(args.data_dir)
    cache_dir = data_dir / "cache"
    scene_ids = _scene_ids(data_dir, args.scenes)
    if not scene_ids:
        print(f"no scenes under {data_dir / 'scenes'}; run `bandpoc build-scenes` first")
        return 1
    keys = registry.all_keys() if args.detectors == "all" else args.detectors.split(",")

    for scene_id in scene_ids:
        wav, sr = load_audio(data_dir / "scenes" / f"{scene_id}.wav", target_sr=WORK_SR)
        for key in keys:
            try:
                detector = registry.get(key)
            except (KeyError, ImportError) as exc:
                print(f"[skip] {key}: {exc}")
                continue
            ok, reason = detector.is_available()
            if not ok:
                print(f"[skip] {key}: {reason}")
                continue
            if not args.force and cache.exists(cache_dir, scene_id, key, detector.version):
                print(f"[cached] {scene_id} x {key}")
                continue
            try:
                detector.load()
                scores, hop, meta = score_scene(detector, wav, sr)
            except Exception as exc:  # a broken backend must not end the run
                print(f"[fail] {scene_id} x {key}: {type(exc).__name__}: {exc}")
                continue
            cache.save(
                cache.cache_path(cache_dir, scene_id, key, detector.version), scores, hop, meta
            )
            print(f"[done] {scene_id} x {key}  RTF={meta['rtf']:.4f}  "
                  f"RSS={meta['peak_rss_mb']:.0f}MB")
    return 0


def cmd_report(args) -> int:
    data_dir = Path(args.data_dir)
    cache_dir = data_dir / "cache"
    scene_ids = _scene_ids(data_dir, args.scenes)
    scenes = {
        sid: SceneLabels.from_json(data_dir / "scenes" / f"{sid}.labels.json")
        for sid in scene_ids
    }
    if not scenes:
        print(f"no scenes under {data_dir / 'scenes'}; run `bandpoc build-scenes` first")
        return 1

    results: list[DetectorResult] = []
    for key in registry.all_keys():
        try:
            detector = registry.get(key)
            version = detector.version
            ok, reason = detector.is_available()
        except (KeyError, ImportError) as exc:
            results.append(DetectorResult(key, False, str(exc), None, None, [], {}, {}))
            continue

        inputs: list[SceneInput] = []
        curves: dict[str, np.ndarray] = {}
        meta: dict = {}
        for sid, scene in scenes.items():
            path = cache.cache_path(cache_dir, sid, key, version)
            if not path.exists():
                continue
            cached = cache.load(path)
            curve = resample_scores(cached.scores, cached.hop, scene.n_frames(), HOP)
            curves[sid] = curve
            inputs.append(SceneInput(sid, curve, scene))
            meta = cached.meta
        if not inputs:
            results.append(
                DetectorResult(key, False, reason or "no cached scores", None, None, [], {}, {})
            )
            continue
        points = run_sweep(inputs)
        best, top = best_point(points)
        results.append(DetectorResult(key, True, "", best, top, points, curves, meta))

    if not any(r.available for r in results):
        print("no cached scores found -- run `bandpoc run` first")
        return 1

    stamp = time.strftime("%Y%m%d-%H%M%S")
    notes = "\n".join(
        [f"scenes: {', '.join(scenes)}", f"frame hop: {HOP}s", f"generated: {stamp}"]
    )
    path = build_report(results, scenes, Path(args.out_dir) / stamp, notes=notes)
    print(f"report written to {path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bandpoc")
    parser.add_argument("--data-dir", default=str(_DEFAULT_DATA))
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("fetch", help="download YouTube material into data/clips")
    p.add_argument("--sources", default="sources.yaml")
    p.add_argument("--data-dir", default=str(_DEFAULT_DATA))
    p.set_defaults(func=cmd_fetch)

    p = sub.add_parser("build-scenes", help="assemble labelled scenes from clips")
    p.add_argument("--recipes", default="scenes.yaml")
    p.add_argument("--data-dir", default=str(_DEFAULT_DATA))
    p.set_defaults(func=cmd_build_scenes)

    p = sub.add_parser("run", help="run detectors and cache their score curves")
    p.add_argument("--detectors", default="all")
    p.add_argument("--scenes", default="all")
    p.add_argument("--force", action="store_true")
    p.add_argument("--data-dir", default=str(_DEFAULT_DATA))
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("report", help="sweep, evaluate and write the HTML report")
    p.add_argument("--scenes", default="all")
    p.add_argument("--out-dir", default="reports")
    p.add_argument("--data-dir", default=str(_DEFAULT_DATA))
    p.set_defaults(func=cmd_report)

    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
