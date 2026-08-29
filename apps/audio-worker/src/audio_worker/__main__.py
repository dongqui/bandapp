import os
import time

from audio_worker import __version__
from audio_worker.queue_consumer import poll_once


def main() -> int:
    queue_url = os.environ.get("SQS_PYTHON_ANALYSIS_QUEUE_URL")
    if not queue_url:
        print(f"bandapp audio-worker {__version__} (scaffold; no queue configured)")
        return 0

    import boto3

    sqs = boto3.client(
        "sqs",
        region_name=os.environ.get("AWS_REGION", "ap-northeast-2"),
        endpoint_url=os.environ.get("SQS_ENDPOINT") or None,
    )
    print(f"bandapp audio-worker {__version__} polling {queue_url}", flush=True)
    while True:
        try:
            poll_once(sqs, queue_url)
        except Exception as exc:  # noqa: BLE001 — 어떤 오류든 worker는 살아있어야 한다
            print(f"[audio-worker] poll failed, retrying in 5s: {exc}", flush=True)
            time.sleep(5)


if __name__ == "__main__":
    raise SystemExit(main())
