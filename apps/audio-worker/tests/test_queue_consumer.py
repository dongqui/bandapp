from audio_worker.queue_consumer import poll_once


class FakeSqs:
    def __init__(self, messages):
        self._messages = messages
        self.deleted = []

    def receive_message(self, **kwargs):
        assert kwargs["QueueUrl"] == "http://localstack:4566/q"
        return {"Messages": self._messages} if self._messages else {}

    def delete_message(self, **kwargs):
        self.deleted.append(kwargs["ReceiptHandle"])


def test_poll_once_logs_and_deletes_messages(capsys):
    sqs = FakeSqs([{"Body": '{"recordingId": "rec_1"}', "ReceiptHandle": "rh-1"}])

    count = poll_once(sqs, "http://localstack:4566/q")

    assert count == 1
    assert sqs.deleted == ["rh-1"]
    assert "rec_1" in capsys.readouterr().out


def test_poll_once_returns_zero_when_queue_is_empty():
    sqs = FakeSqs([])

    assert poll_once(sqs, "http://localstack:4566/q") == 0
    assert sqs.deleted == []
