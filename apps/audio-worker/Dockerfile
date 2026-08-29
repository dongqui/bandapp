FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

# venv를 /opt에 두어 소스 볼륨 마운트에 가려지지 않게 한다.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv

COPY apps/audio-worker/pyproject.toml ./
COPY apps/audio-worker/src ./src
RUN uv sync --no-dev

ENV PATH="/opt/venv/bin:$PATH" PYTHONUNBUFFERED=1
CMD ["python", "-m", "audio_worker"]
