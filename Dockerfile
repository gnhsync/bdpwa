FROM debian:bookworm-slim AS builder

WORKDIR /app

# ── System deps ───────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip libcairo2 libpangocairo-1.0-0 \
  && rm -rf /var/lib/apt/lists/*

# ── Python build deps ─────────────────────────────────────────────────────────
COPY build/requirements.txt build/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r build/requirements.txt

# ── Vendor assets — committed to git, verified against upstream on every build ─
# Committed files are the fallback if a CDN goes down.
# Any upstream change causes a diff mismatch and fails the build immediately.
COPY vendor/ vendor/
COPY build/vendor.sh build/vendor.sh
RUN bash build/vendor.sh /tmp/v && diff -r vendor/ /tmp/v && rm -rf /tmp/v

# ── Content pipeline ──────────────────────────────────────────────────────────
COPY build/ build/
COPY data/content.zip data/content.zip

RUN --mount=type=secret,id=openai_key \
    python3 build/pipeline.py \
      --zip-file data/content.zip \
      --openai-key-file /run/secrets/openai_key

# ── Frontend source ───────────────────────────────────────────────────────────
COPY index.html manifest.json sw.js 404.html ./
COPY css/ css/
COPY js/ js/
COPY icons/ icons/
RUN cd icons && python3 generate_icons.py

# ── App bundle ────────────────────────────────────────────────────────────────
# Single source of truth for what belongs in the deployable app.
# Build-internal files (embeddings.bin, query_affinity.json, search_menu.json,
# export_version.json) stay in the builder and never reach clients.
FROM scratch AS app
COPY --from=builder /app/index.html    ./
COPY --from=builder /app/manifest.json ./
COPY --from=builder /app/sw.js         ./
COPY --from=builder /app/404.html      ./
COPY --from=builder /app/css/          css/
COPY --from=builder /app/js/           js/
COPY --from=builder /app/icons/        icons/
COPY --from=builder /app/data/version.json    data/
COPY --from=builder /app/data/bundle.tar.gz  data/

# ── Artifact export target ────────────────────────────────────────────────────
# docker build --target artifact --output type=local,dest=./_site .
FROM app AS artifact

# ── Serve target (default) ────────────────────────────────────────────────────
# docker build -t bugsanddrugs . && docker run -p 8081:8081 bugsanddrugs
FROM alpine:latest AS serve
RUN apk add --no-cache python3
COPY --from=app / /app/
COPY serve.py /app/
WORKDIR /app
EXPOSE 8081
CMD ["python3", "serve.py", "8081"]
