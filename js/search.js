/**
 * search.js — Search pipeline:
 *   1. Embed query (bi-encoder, Transformers.js)
 *   2. Brute-force cosine over QA embeddings       (query language, LLM-generated)
 *   3. BM25 lexical retrieval
 *   4. Reciprocal Rank Fusion
 *
 * QA embeddings are vectors of LLM-generated "query affinity" descriptions —
 * short texts written in the register of search queries. A generic query like
 * "UTI" lands near the QA vector for the overview page; a specific query like
 * "complicated UTI catheter" lands near the detail page.
 */

import { BM25, topK } from "./bm25.js";

const BI_ENCODER_MODEL = "Xenova/bge-base-en-v1.5";
const DIMS = 768;

const VECTOR_CANDIDATES = 50;
const BM25_CANDIDATES   = 50;
export const DEFAULT_TOP_K = 10;

const RRF_K = 60;

export class SearchEngine {
  constructor(onStatus, base = "") {
    this.onStatus = onStatus || (() => {});
    this.base = base.replace(/\/$/, "");
    this.ready = false;
    this.biEncoder = null;
    this.chunks = null;       // [{id, uuid, title, breadcrumb, snippet, type}]
    this.qaEmbeddings = null; // Float32Array, n × DIMS — query affinity vectors
    this.n = 0;
    this.bm25 = new BM25();
  }

  async init() {
    this.onStatus("Loading index…");
    await Promise.all([
      this._loadChunks(),
      this._loadBM25(),
      this._loadQAEmbeddings(),
    ]);

    this.onStatus("Loading language model…");
    await this._loadModels();

    this.ready = true;
    this.onStatus("Ready");
  }

  async _loadChunks() {
    const r = await fetch(`${this.base}/data/chunks_meta.json`);
    if (!r.ok) throw new Error("chunks_meta.json not found — run build/pipeline.py first");
    this.chunks = await r.json();
    this.n = this.chunks.length;
  }

  async _loadQAEmbeddings() {
    const r = await fetch(`${this.base}/data/qa_embeddings.bin`);
    if (!r.ok) { console.warn("qa_embeddings.bin not found; skipping QA retrieval"); return; }
    this.qaEmbeddings = new Float32Array(await r.arrayBuffer());
    console.log("QA embeddings loaded");
  }

  async _loadBM25() {
    const r = await fetch(`${this.base}/data/bm25.json`);
    if (!r.ok) throw new Error("bm25.json not found — run build/pipeline.py first");
    this.bm25.load(await r.json());
  }

  async _loadModels() {
    // Import Transformers.js from bundle (served by SW cache).
    const { pipeline, env } = await import(
      `${location.origin}${this.base}/vendor/js/transformers.min.js`
    );

    // Models are always served from the bundle cache; remote fetching is never needed.
    env.allowLocalModels  = true;
    env.allowRemoteModels = false;
    env.localModelPath    = `${location.origin}${this.base}/vendor/models/`;

    this.biEncoder = await pipeline("feature-extraction", BI_ENCODER_MODEL, {
      quantized: true,
      dtype: "q8",
    });
  }

  async search(query, topK = DEFAULT_TOP_K) {
    if (!this.ready) throw new Error("SearchEngine not initialised");
    if (!query || !query.trim()) return [];

    // Expand partial tokens (e.g. "pyelo" → "pyelonephritis") so that the
    // embedding signals benefit from the same prefix matching as BM25.
    const embedQuery = this._expandQueryForEmbed(query);

    const qVec = await this._embedQuery(embedQuery);

    const qaResults = this.qaEmbeddings
      ? this._cosineBruteForce(qVec, this.qaEmbeddings, VECTOR_CANDIDATES)
      : null;
    const bm25Results = this.bm25.search(query, BM25_CANDIDATES);

    const lists = qaResults
      ? [qaResults, bm25Results]
      : [bm25Results];
    const merged = this._rrfMerge(lists);

    return merged.slice(0, topK).map(({ id, score }) => ({
      ...this.chunks[id],
      score,
    }));
  }

  /**
   * Expand unrecognised query tokens to their prefix matches in the BM25
   * vocabulary, then return the result as a string for embedding.
   * Recognised tokens are kept as-is. "pyelo" → "pyelonephritis".
   * If a token expands to multiple matches they are all included.
   */
  _expandQueryForEmbed(query) {
    const tokens = this.bm25.tokenize(query);
    if (!tokens.length) return query;
    const expanded = this.bm25._expandPrefixes(tokens);
    if (!expanded.length) return query;
    return [...new Set(expanded)].join(" ");
  }

  async _embedQuery(text) {
    const output = await this.biEncoder(text, { pooling: "mean", normalize: true });
    return output.data instanceof Float32Array
      ? output.data
      : new Float32Array(output.data);
  }

  _cosineBruteForce(qVec, embedMatrix, k) {
    const scores = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      let dot = 0;
      const off = i * DIMS;
      for (let d = 0; d < DIMS; d++) dot += qVec[d] * embedMatrix[off + d];
      scores[i] = dot;
    }
    return topK(scores, k);
  }

  _rrfMerge(lists) {
    const fused = new Map();
    for (const list of lists) {
      list.forEach(({ id }, rank) => {
        const rrf = 1 / (RRF_K + rank + 1);
        if (fused.has(id)) fused.get(id).score += rrf;
        else fused.set(id, { id, score: rrf });
      });
    }
    return [...fused.values()].sort((a, b) => b.score - a.score);
  }
}
