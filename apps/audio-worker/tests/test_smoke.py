from audio_worker import __version__
from audio_worker.__main__ import main


def test_version_is_set():
    assert __version__ == "0.0.1"


def test_main_returns_zero_without_queue_env(monkeypatch, capsys):
    monkeypatch.delenv("SQS_PYTHON_ANALYSIS_QUEUE_URL", raising=False)
    assert main() == 0
    assert "audio-worker" in capsys.readouterr().out
