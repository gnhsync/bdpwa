# Bugs & Drugs PWA

Offline-capable medical reference PWA with hybrid semantic + BM25 search.
Content is sourced from the Bugs & Drugs platform and bundled at build time.

## How it works

- **Search**: BM25 lexical retrieval fused (RRF) with bi-encoder vector search
  over LLM-generated query-affinity descriptions
- **Offline**: all content, models, and data ship as a single `bundle.tar.gz`,
  downloaded by the service worker on first visit and served from cache
- **Updates**: `version.json` is checked on startup; new bundles download in
  the background while the app stays usable, then apply on user prompt

## Content updates

`build/fetch_content.py` checks the upstream Bugs & Drugs API for new content:

```bash
python3 build/fetch_content.py          # download only if version changed
python3 build/fetch_content.py --force  # always download
```

It generates a persistent device UUID (stored in `data/.device_uuid`) and
verifies the downloaded zip's `export_version.json` matches the upstream
version before replacing `data/content.zip`.

## Build

Requires Docker and an OpenAI API key (for query-affinity generation).
`data/content.zip` must be present (committed to the repo).

```bash
# Export static site to _site/
docker build \
  --target artifact \
  --output type=local,dest=./_site \
  --secret id=openai_key,src=/path/to/openai_key \
  .

# Or build a runnable serve image
docker build --secret id=openai_key,src=/path/to/openai_key -t bdpwa .
docker run -p 8081:8081 bdpwa
```

The build pipeline (`build/pipeline.py`) runs inside Docker:
1. Reads `data/content.zip`
2. Extracts text chunks and builds a BM25 index
3. Generates query-affinity descriptions via GPT-4o-mini (cached in `data/query_affinity.json`)
4. Embeds affinities with BGE-base-en-v1.5 (ONNX, vendored in `vendor/`)
5. Packs everything into `data/bundle.tar.gz` (content HTML, search indices,
   `pages_menu.json`, `version.json`, and vendored JS/models)

For local testing: `python3 -m http.server 8081`

## Dependencies

Python build dependencies are specified in `build/requirements.in` (loose
constraints) and pinned in `build/requirements.txt` (frozen from the Docker
builder image).

## Deploy

GitHub Actions (`.github/workflows/deploy.yml`) runs on push to `main` and
daily. It uses `build/fetch_content.py` to check for new content, builds the
artifact stage, and deploys to GitHub Pages. Requires `OPENAI_API_KEY` in
repository secrets.

## Vendored assets

`vendor/` contains the Transformers.js library, ONNX Runtime WASM files, and
the BGE-base-en-v1.5 model files. These are committed to git and verified
against upstream on every Docker build (`build/vendor.sh` downloads fresh
copies and `diff -r` fails the build if anything has changed upstream).

To re-vendor: `bash build/vendor.sh vendor/`
