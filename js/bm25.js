/**
 * BM25 — offline full-text scoring.
 *
 * Index format (produced by build/pipeline.py):
 * {
 *   n: number,         total documents
 *   avgdl: number,     average doc length in tokens
 *   k1: number,        BM25 k1 param
 *   b: number,         BM25 b param
 *   idf: {term: idf},  pre-computed IDF per term
 *   posting: {term: [[docId, tf], ...]},
 *   dl: [number, ...], per-document token counts
 * }
 */
export class BM25 {
  constructor() {
    this.index = null;
  }

  load(indexData) {
    this.index = indexData;
  }

  /** Tokenize the same way as the Python pipeline. */
  tokenize(text) {
    const stopwords = new Set([
      "a","an","the","and","or","of","to","in","is","it","for","with",
      "this","that","are","as","be","by","at","from","on","not","no",
    ]);
    return (text.toLowerCase().match(/[a-z0-9]+(?:['\-][a-z0-9]+)*/g) || [])
      .filter((t) => !stopwords.has(t) && t.length > 1);
  }

  /** Return the IDF map from the loaded index, or null if not loaded. */
  idf() {
    return this.index ? this.index.idf : null;
  }

  /**
   * Expand query tokens to include prefix matches from the vocabulary.
   * Exact matches are kept as-is. Tokens with no exact match are replaced
   * with all vocabulary terms that start with that token.
   * This enables partial/incremental search ("cholecy" → "cholecystitis").
   */
  _expandPrefixes(tokens) {
    const { idf } = this.index;
    const vocab = Object.keys(idf);
    const expanded = [];
    for (const t of tokens) {
      if (idf[t]) {
        expanded.push(t); // exact match
      } else {
        for (const v of vocab) {
          if (v.startsWith(t)) expanded.push(v);
        }
      }
    }
    return expanded;
  }

  /**
   * Score all documents for `query`.
   * Returns a Float32Array of scores, length = n.
   */
  scoreAll(query) {
    const { n, avgdl, k1, b, idf, posting, dl } = this.index;
    const scores = new Float32Array(n);
    const tokens = this._expandPrefixes(this.tokenize(query));

    for (const term of tokens) {
      if (!(term in idf)) continue;
      const termIdf = idf[term];
      const postList = posting[term];
      if (!postList) continue;
      for (const [docId, tf] of postList) {
        const docLen = dl[docId];
        const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / avgdl)));
        scores[docId] += termIdf * tfNorm;
      }
    }

    return scores;
  }

  /**
   * Return top-k document indices sorted by BM25 score descending.
   * Returns [{id, score}, ...].
   */
  search(query, k = 50) {
    const scores = this.scoreAll(query);
    return topK(scores, k);
  }
}

/** Return [{id, score}] for the top-k values in a Float32Array. */
export function topK(scores, k) {
  const n = scores.length;
  const actualK = Math.min(k, n);
  // Partial sort: maintain a min-heap of size k
  const heap = []; // [{id, score}], min-heap by score

  for (let i = 0; i < n; i++) {
    const s = scores[i];
    if (s <= 0) continue;
    if (heap.length < actualK) {
      heap.push({ id: i, score: s });
      if (heap.length === actualK) _heapify(heap);
    } else if (s > heap[0].score) {
      heap[0] = { id: i, score: s };
      _siftDown(heap, 0, actualK);
    }
  }

  return heap.sort((a, b) => b.score - a.score);
}

function _heapify(arr) {
  const n = arr.length;
  for (let i = Math.floor(n / 2) - 1; i >= 0; i--) _siftDown(arr, i, n);
}

function _siftDown(arr, i, n) {
  while (true) {
    let smallest = i;
    const l = 2 * i + 1, r = 2 * i + 2;
    if (l < n && arr[l].score < arr[smallest].score) smallest = l;
    if (r < n && arr[r].score < arr[smallest].score) smallest = r;
    if (smallest === i) break;
    [arr[i], arr[smallest]] = [arr[smallest], arr[i]];
    i = smallest;
  }
}
