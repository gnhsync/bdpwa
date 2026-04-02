# Bugs & Drugs PWA

Offline-capable medical reference PWA with hybrid semantic + BM25 search.
Content is sourced from the Bugs & Drugs platform and bundled at build time.

## How it works

- **Search**: BM25 lexical retrieval fused (RRF) with bi-encoder vector search
  over LLM-generated query-affinity descriptions
- **Offline**: all content, models, and data ship as a single `bundle.zip`,
  downloaded by the service worker on first visit and served from cache
- **Updates**: `version.json` is checked on startup; new bundles download in
  the background while the app stays usable, then apply on user prompt

## Build

Requires Docker and an OpenAI API key (for query-affinity generation).

```bash
# Export static site to _site/
docker build \
  --target artifact \
  --output type=local,dest=./_site \
  --secret id=openai_key,src=/path/to/openai_key \
  .

# Or build a runnable serve image
docker build --secret id=openai_key,src=/path/to/openai_key -t bugsanddrugs .
docker run -p 8081:8081 bugsanddrugs
```

The build pipeline (`build/pipeline.py`) runs inside Docker:
1. Downloads content zip from the Bugs & Drugs API
2. Extracts text chunks and builds a BM25 index
3. Generates query-affinity descriptions via GPT-4o-mini (cached in `data/query_affinity.json`)
4. Embeds affinities with BGE-base-en-v1.5 (ONNX, vendored in `vendor/`)
5. Packs everything into `data/bundle.zip`

## Deploy

GitHub Actions (`.github/workflows/deploy.yml`) runs on push to `main` and
weekly. It builds the artifact stage, injects the base path for GitHub Pages,
and deploys to GitHub Pages. Requires `OPENAI_API_KEY` in repository secrets.

## Vendored assets

`vendor/` contains the Transformers.js library, fflate, and the BGE model
files. These are committed to git and verified against upstream on every
Docker build (`build/vendor.sh` downloads fresh copies and `diff -r` fails
the build if anything has changed upstream).

To re-vendor: `bash build/vendor.sh vendor/`
