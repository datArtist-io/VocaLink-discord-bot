# CPU worker image (any x86_64/arm64 cloud VM).
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    MODELS_DIR=/models DATA_DIR=/data HF_HOME=/models/hf

RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -u 10001 worker

WORKDIR /app
COPY requirements.txt requirements-extras.txt ./
ARG WITH_EXTRAS=0
RUN pip install -r requirements.txt \
 && if [ "$WITH_EXTRAS" = "1" ]; then pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements-extras.txt; fi

COPY translator_worker ./translator_worker
COPY scripts ./scripts
RUN mkdir -p /models /data && chown -R worker /models /data
USER worker

EXPOSE 7700 7701
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD curl -fs http://127.0.0.1:7701/ >/dev/null || exit 1
CMD ["python", "-m", "translator_worker"]
