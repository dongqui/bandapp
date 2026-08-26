"""Command line: fetch -> build-scenes -> run -> report, plus add-session ->
explore for a whole unlabelled recording."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from . import cache, registry
from .audio import WORK_SR, load_audio
from .detectors.base import Detector
from .explore import collect_session, encode_mp3, render_index, render_session
from .fetch import fetch_pool, ffmpeg_available, load_sources
from .labels import HOP, SceneLabels
from .postproc import resample_scores
from .report import DetectorResult, build_report
from .session import SessionExists, add_session
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


def _filter_requested_ids(
    available: list[str], requested: str, data_dir: Path, kind: str
) -> list[str]:
    """Apply a --scenes filter against `available`, reporting an unknown id
    by name instead of silently dropping it (Minor 3 -- mirrors what
    cmd_explore already does for an unknown --detectors key). Shared by
    `_scene_ids` and `_labelled_scene_ids` so `run`, `report` and `explore`
    all get the diagnostic without three copies of it.
    """
    if requested == "all":
        return available
    names = requested.split(",")
    for name in names:
        if name not in available:
            print(f"[skip] {name}: no {kind} by that id under {data_dir / 'scenes'}")
    return [name for name in names if name in available]


def _scene_ids(data_dir: Path, requested: str) -> list[str]:
    """Every wav under scenes/, labelled or not.

    A session with no labels.json is still something `run` can score; only
    `report` needs the ground truth. `run` needs the real wav to score it,
    which is why this globs *.wav rather than *.labels.json -- see
    `_labelled_scene_ids` for the counterpart `report` uses.
    """
    available = sorted(p.stem for p in (data_dir / "scenes").glob("*.wav"))
    return _filter_requested_ids(available, requested, data_dir, "scene")


def _labelled_scene_ids(data_dir: Path, requested: str) -> list[str]:
    """Every scene with a labels.json under scenes/, wav present or not.

    `report` never reads the wav itself -- only labels.json and the cache --
    so a scene whose (large) wav was deleted after scoring must still be
    reportable (Minor 4: each 45-minute session wav is ~259 MB, and deleting
    it once it's scored is normal housekeeping). This globs *.labels.json
    directly instead of `_scene_ids`'s wav stems filtered down to the
    labelled subset -- that indirection was the actual bug: a deleted wav
    made the scene invisible before its labels were even checked. Be careful
    not to reuse `_scene_ids` here again; the whole point is not to require
    the wav.
    """
    scenes_dir = data_dir / "scenes"
    available = sorted(
        p.name[: -len(".labels.json")] for p in scenes_dir.glob("*.labels.json")
    )
    return _filter_requested_ids(available, requested, data_dir, "labelled scene")


def _no_scenes_message(
    available: list[str], requested: str, data_dir: Path, hint: str, noun: str = "scenes"
) -> str:
    """The right "nothing to work with" message for an empty scene-id result
    (Minor 3), shared by `run`/`report`/`explore`. `--scenes all` (or a
    request that matches nothing at all) genuinely needs `hint` -- go
    produce some scenes. But `--scenes` naming only ids that don't exist
    does not: those ids might just be misspelled, and telling the user to
    redo the step that already produced the real ones is actively wrong.
    That was the original bug: `explore --scenes typoo` on a populated
    directory blamed a missing `add-session`.
    """
    if requested != "all" and available:
        return f"no known {noun} requested; known: {available}"
    return f"no {noun} under {data_dir / 'scenes'}; {hint}"


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
        available = sorted(p.stem for p in (data_dir / "scenes").glob("*.wav"))
        print(_no_scenes_message(
            available, args.scenes, data_dir, "run `bandpoc build-scenes` first"
        ))
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
    # `_labelled_scene_ids` globs labels.json directly (Minor 4): report
    # only ever reads labels + the cache, never the wav, so a scene whose
    # wav was deleted after scoring must still be reportable.
    scene_ids = _labelled_scene_ids(data_dir, args.scenes)
    scenes = {
        sid: SceneLabels.from_json(data_dir / "scenes" / f"{sid}.labels.json")
        for sid in scene_ids
    }
    if not scenes:
        available = sorted(
            p.name[: -len(".labels.json")]
            for p in (data_dir / "scenes").glob("*.labels.json")
        )
        print(_no_scenes_message(
            available, args.scenes, data_dir,
            "run `bandpoc build-scenes`, or use `bandpoc explore` for sessions "
            "that have no ground truth",
            noun="labelled scenes",
        ))
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


def cmd_add_session(args) -> int:
    data_dir = Path(args.data_dir)
    try:
        path = add_session(args.source, data_dir / "scenes", session_id=args.id)
    except (SessionExists, ValueError, RuntimeError) as exc:
        print(f"[fail] {exc}")
        return 1
    # Header read, not load_audio: see collect_session in explore.py for the
    # measured RSS cost (1132 MB on a 45-minute session) of loading a whole
    # recording into RAM just to print a minute count.
    info = sf.info(str(path))
    minutes = info.frames / info.samplerate / 60
    print(f"{path.stem}: {minutes:.1f} min -> {path}")
    print("next: bandpoc run   (then: bandpoc explore)")
    return 0


def cmd_explore(args) -> int:
    data_dir = Path(args.data_dir)
    scene_ids = _scene_ids(data_dir, args.scenes)
    if not scene_ids:
        available = sorted(p.stem for p in (data_dir / "scenes").glob("*.wav"))
        print(_no_scenes_message(
            available, args.scenes, data_dir, "run `bandpoc add-session` first",
            noun="recordings",
        ))
        return 1

    # Validate --detectors up front, the same way cmd_run does, instead of
    # letting collect_session's version lookup swallow an unknown key. Left
    # unvalidated, a typo'd key matches no cache file and every session ends
    # up at "no cached scores found -- run `bandpoc run` first" -- which is
    # actively wrong (the scores may well be cached, just under a key the
    # user did not typo) and sends the user off to redo inference for
    # nothing.
    requested = registry.all_keys() if args.detectors == "all" else args.detectors.split(",")
    known = set(registry.all_keys())
    keys = []
    for key in requested:
        if key in known:
            keys.append(key)
            continue
        # `key` is already known not to be in `known` == set(all_keys()), so
        # registry.get(key) can only ever raise KeyError here -- it checks
        # membership before ever calling a factory (registry.py), and a
        # factory's own ImportError is exactly the case handled below, for
        # keys that ARE known. Do not add ImportError back here (Minor 12);
        # that is a different, live case in explore.py's own version lookup.
        try:
            registry.get(key)
        except KeyError as exc:
            print(f"[skip] {key}: {exc}")
    if not keys:
        print(f"no known detectors requested; known: {sorted(known)}")
        return 1

    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_dir = Path(args.out_dir) / stamp
    views = []
    for scene_id in scene_ids:
        view = collect_session(data_dir, scene_id, keys)
        # A detector whose version could not be resolved (unknown, or a
        # registered backend whose heavy import blew up) AND has nothing
        # cached under any version either -- collect_session couldn't find
        # anything to show for it, but say the real reason instead of
        # leaving it to the generic "no cached scores" line below to imply
        # the cache is simply empty (Important 2).
        for key, reason in view.skipped.items():
            print(f"[skip] {scene_id}: {key}: {reason}")
        if not view.models:
            if not view.skipped:
                print(f"[skip] {scene_id}: no cached scores")
            continue
        # encode_mp3 raises RuntimeError when ffmpeg is missing, and raises
        # subprocess.CalledProcessError when ffmpeg is present but fails on
        # this file (corrupt/unsupported input, disk full, a codec problem).
        # Neither must take down the whole command: earlier sessions in this
        # loop may already have pages written into out_dir, and later ones
        # deserve a chance too. Skip this one with a clear message instead.
        try:
            mp3 = encode_mp3(
                data_dir / "scenes" / f"{scene_id}.wav",
                data_dir / "scenes" / f"{scene_id}.mp3",
            )
        except RuntimeError as exc:
            print(f"[skip] {scene_id}: {exc}")
            continue
        except subprocess.CalledProcessError as exc:
            print(f"[skip] {scene_id}: ffmpeg failed on this file: {exc}")
            continue
        # Load-bearing order: out_dir.mkdir/copyfile/render_session/
        # views.append all happen only past this point, after a successful
        # encode. Moving any of them above the two `continue`s above would
        # let a session with a missing or failed mp3 still get linked from
        # the index, or leave an empty out_dir behind when every session is
        # skipped. Do not reorder.
        out_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(mp3, out_dir / mp3.name)
        render_session(view, mp3.name, out_dir)
        views.append(view)
        print(f"[done] {scene_id}: {len(view.models)} models")

    if not views:
        print("no cached scores found -- run `bandpoc run` first")
        return 1
    print(f"explorer written to {render_index(views, out_dir)}")
    return 0


def main(argv: list[str] | None = None) -> int:
    # No top-level --data-dir (Minor 11): every subparser below redefines its
    # own --data-dir with its own default, and argparse resolves that by
    # simply overwriting whatever the top-level flag set -- so
    # `bandpoc --data-dir X explore` silently used `data/` regardless of X.
    # Each subcommand's own --data-dir already covers the real use case; do
    # not add a top-level one back without also removing the six duplicates.
    parser = argparse.ArgumentParser(prog="bandpoc")
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

    p = sub.add_parser("add-session", help="import one whole recording (URL or file)")
    p.add_argument("source")
    p.add_argument("--id", default=None)
    p.add_argument("--data-dir", default=str(_DEFAULT_DATA))
    p.set_defaults(func=cmd_add_session)

    p = sub.add_parser("explore", help="browse model output against the audio")
    p.add_argument("--detectors", default="all")
    p.add_argument("--scenes", default="all")
    p.add_argument("--out-dir", default="reports/explore")
    p.add_argument("--data-dir", default=str(_DEFAULT_DATA))
    p.set_defaults(func=cmd_explore)

    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
