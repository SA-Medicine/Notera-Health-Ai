# Notera-Health-Ai — NER sidecar image (Cloud Run, private)
# NER models are memory-hungry — deploy with --memory=2Gi (doc 07 §4).
FROM python:3.11-slim

WORKDIR /app

# System deps some scispaCy/medspaCy wheels need
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Medical NER model wheels (free/open). Kept as a separate layer for caching.
RUN pip install --no-cache-dir \
      "https://s3-us-west-2.amazonaws.com/ai2-s2-scispacy/releases/v0.5.4/en_ner_bc5cdr_md-0.5.4.tar.gz" \
      "https://huggingface.co/kormilitzin/en_core_med7_lg/resolve/main/en_core_med7_lg-any-py3-none-any.whl" \
    || echo "WARN: model wheels not fetched at build time; service will degrade gracefully"

COPY main.py .

ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
