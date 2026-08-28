from audio_worker import __version__


def main() -> int:
    print(f"bandapp audio-worker {__version__} (scaffold; no job loop yet)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
