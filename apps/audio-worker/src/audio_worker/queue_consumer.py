"""LocalStack/AWS SQS 실험 큐를 polling하는 최소 consumer."""

from typing import Any, Protocol


class SqsClient(Protocol):
    def receive_message(self, **kwargs: Any) -> dict: ...
    def delete_message(self, **kwargs: Any) -> None: ...


def poll_once(sqs: SqsClient, queue_url: str) -> int:
    response = sqs.receive_message(
        QueueUrl=queue_url,
        MaxNumberOfMessages=10,
        WaitTimeSeconds=20,
    )
    messages = response.get("Messages", [])
    for message in messages:
        print(f"[audio-worker] received: {message['Body']}", flush=True)
        sqs.delete_message(QueueUrl=queue_url, ReceiptHandle=message["ReceiptHandle"])
    return len(messages)
