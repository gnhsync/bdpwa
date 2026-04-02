#!/usr/bin/env python3
"""
pipeline.py — Build-time indexing pipeline for Bugs & Drugs PWA.

Usage:
    python3 pipeline.py --zip-file PATH [--out-dir DIR] [--openai-key-file FILE]

Outputs (written to --out-dir, default ../data/):
    version.json        — content version info (deployed outside bundle)
    bundle.tar.gz       — everything the app needs: content HTML, BM25 index,
                          QA embeddings, and vendored JS/models
"""

import argparse
import asyncio
import io
import json
import math
import os
import re
import tarfile
import unicodedata
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from bs4 import BeautifulSoup
from tqdm import tqdm

ROOT_DIR   = Path(__file__).parent.parent
VENDOR_DIR = ROOT_DIR / "vendor"
MODEL_DIR  = VENDOR_DIR / "models" / "Xenova" / "bge-base-en-v1.5"

QA_CACHE_PATH = ROOT_DIR / "data" / "query_affinity.json"

EMBED_DIMS  = 768
BATCH_SIZE  = 32
MAX_SEQ_LEN = 512

# ── BM25 ──────────────────────────────────────────────────────────────────────

K1 = 1.5
B  = 0.75
STOPWORDS = {
    "a","an","the","and","or","of","to","in","is","it","for","with",
    "this","that","are","as","be","by","at","from","on","not","no",
}

POPOVER_SIZE_LIMIT = 800  # bytes — skip tiny tooltip-only pages as standalone chunks


# ── Text extraction ───────────────────────────────────────────────────────────

def _clean_html(html_bytes: bytes, popovers: dict[str, str]) -> str:
    soup = BeautifulSoup(html_bytes, "html.parser")
    for el in soup.select(".page_breadcrumb"):
        el.decompose()
    for a in soup.select("a.aa.popover-link"):
        target = a.get("href", "").lstrip("/").split(".html")[0]
        if target in popovers:
            extra = BeautifulSoup(f" ({popovers[target]})", "html.parser").get_text()
            a.replace_with(a.get_text() + extra)
        else:
            a.replace_with(a.get_text())
    for a in soup.select("a.nav, a.internal-link, a.bb, a.jump-link"):
        a.replace_with(a.get_text())
    for table in soup.find_all("table"):
        rows = []
        for tr in table.find_all("tr"):
            cells = [td.get_text(" ", strip=True) for td in tr.find_all(["td", "th"])]
            if cells := [c for c in cells if c]:
                rows.append(" | ".join(cells))
        table.replace_with("\n".join(rows))
    text = soup.get_text(" ", strip=True)
    return re.sub(r"\s{2,}", " ", text).strip()


def _sub_pages(html_bytes: bytes) -> list[str]:
    soup = BeautifulSoup(html_bytes, "html.parser")
    return [a.get_text(strip=True) for a in soup.select("a.nav") if a.get_text(strip=True)]


def _snippet(text: str, max_chars: int = 220) -> str:
    if len(text) <= max_chars:
        return text
    cut = text.rfind(" ", 0, max_chars)
    return text[: cut if cut > 0 else max_chars] + "…"


def build_chunks(files: dict[str, bytes]) -> list[dict]:
    search_menu = json.loads(files["search_menu.json"])
    pages: dict[str, dict] = {}
    for entry in search_menu:
        for page in entry["pages"]:
            pid = page["id"]
            if pid in pages:
                continue
            path = json.loads(page["uuid_path"])
            pages[pid] = {
                "uuid": pid,
                "title": page["title"],
                "breadcrumb": " / ".join(p[0] for p in path),
            }
    print(f"Found {len(pages)} unique content pages in search_menu.json")

    print("Pre-parsing popover pages …")
    popovers: dict[str, str] = {}
    for fname, content in files.items():
        if fname.endswith(".html") and len(content) < POPOVER_SIZE_LIMIT:
            uuid = fname.replace(".html", "")
            soup = BeautifulSoup(content, "html.parser")
            for el in soup.select(".page_breadcrumb"):
                el.decompose()
            text = re.sub(r"\s{2,}", " ", soup.get_text(" ", strip=True)).strip()
            if text:
                popovers[uuid] = text

    print(f"Extracting text from {len(pages)} pages …")
    chunks: list[dict] = []
    for nav in pages.values():
        uuid = nav["uuid"]
        fname = uuid + ".html"
        if fname not in files:
            continue
        html_bytes = files[fname]
        if len(html_bytes) < POPOVER_SIZE_LIMIT and uuid in popovers:
            continue
        text = _clean_html(html_bytes, popovers)
        if len(text) < 30:
            continue
        chunks.append({
            "uuid": uuid,
            "title": nav["title"],
            "breadcrumb": nav["breadcrumb"],
            "snippet": _snippet(text),
            "sub_pages": _sub_pages(html_bytes),
            "text": text,
        })
    print(f"  Produced {len(chunks)} indexable chunks")
    return chunks


# ── BM25 index ────────────────────────────────────────────────────────────────

def _tokenize(text: str) -> list[str]:
    tokens = re.findall(r"[a-z0-9]+(?:['\-][a-z0-9]+)*", text.lower())
    return [t for t in tokens if t not in STOPWORDS and len(t) > 1]


def build_bm25(chunks: list[dict]) -> dict:
    print("Building BM25 index …")
    n = len(chunks)
    doc_tokens  = [_tokenize(c["text"]) for c in chunks]
    doc_lengths = [len(t) for t in doc_tokens]
    avgdl = sum(doc_lengths) / n if n else 1

    df: Counter = Counter()
    for tokens in doc_tokens:
        df.update(set(tokens))

    idf: dict[str, float] = {
        term: math.log((n - freq + 0.5) / (freq + 0.5) + 1)
        for term, freq in df.items()
    }

    posting: dict[str, list] = defaultdict(list)
    for doc_id, tokens in enumerate(doc_tokens):
        for term, count in Counter(tokens).items():
            posting[term].append([doc_id, count])

    MIN_IDF = 0.1
    idf     = {t: v for t, v in idf.items() if v > MIN_IDF}
    posting = {t: v for t, v in posting.items() if t in idf}

    print(f"  Vocabulary: {len(idf):,} terms  |  avg doc length: {avgdl:.0f} tokens")
    return {"n": n, "avgdl": avgdl, "k1": K1, "b": B, "idf": idf, "posting": posting, "dl": doc_lengths}


# ── Query-affinity generation (GPT-4o-mini) ───────────────────────────────────

QA_CONCURRENCY    = 40
QA_CHECKPOINT     = 100

SYSTEM_PROMPT = """\
You annotate clinical reference pages for a medical search engine.

Each page is described with a title, section path (breadcrumb), a list of
sub-pages it links to (if any), and a content excerpt.

Use the "Sub-pages" field to determine the page's role in the hierarchy:
- If Sub-pages is non-empty, this is a SECTION OVERVIEW page that introduces
  multiple sub-topics. Its query_affinity should match broad, introductory
  queries from users who want a general entry point, not a specific case.
- If Sub-pages is empty, this is a LEAF/DETAIL page covering one specific
  topic. Its query_affinity should use narrow, specific clinical terms.

For each page produce a JSON object with exactly one key:

"query_affinity"
  60–100 words written in search-query language — the terms a physician or
  pharmacist would actually type. Requirements:
  • Include all common abbreviations AND their expansions
    (e.g. "UTI" and "urinary tract infection", "CA-UTI" and
    "catheter-associated UTI", "MRSA" and "methicillin-resistant S. aureus")
  • Include synonyms and lay terms where relevant
  • Include the condition, patient population, key drugs, and organisms
  • For overview pages: cover the full range of sub-topics listed in Sub-pages
  • For detail pages: include the specific distinguishing clinical features
    (population, severity, resistance pattern, anatomical site, etc.)
  • Do NOT include terms that primarily belong to a different page —
    be specific enough that this page is preferred over closely related pages

Return only the JSON object, no other text.\
"""

USER_TEMPLATE = """\
Title: {title}
Section path: {breadcrumb}
Sub-pages: {sub_pages}
Content: {context}\
"""


async def _fetch_one(client, semaphore, chunk, results, lock):
    async with semaphore:
        cid = chunk["uuid"]
        async with lock:
            if results.get(cid, {}).get("query_affinity"):
                return

        def _clean(s):
            return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", s)

        sub_pages = chunk.get("sub_pages", [])
        prompt = USER_TEMPLATE.format(
            title=_clean(chunk["title"]),
            breadcrumb=_clean(chunk["breadcrumb"]),
            sub_pages=", ".join(_clean(p) for p in sub_pages) if sub_pages else "(none)",
            context=_clean(chunk.get("qa_context", chunk["snippet"])),
        )
        resp = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "system", "content": SYSTEM_PROMPT},
                      {"role": "user",   "content": prompt}],
            max_tokens=300,
            temperature=0.2,
            response_format={"type": "json_object"},
        )
        raw = resp.choices[0].message.content.strip()
        try:
            entry = {"query_affinity": json.loads(raw).get("query_affinity", "")}
        except json.JSONDecodeError:
            entry = {"query_affinity": raw}

        async with lock:
            results[cid] = entry


async def _run_qa(chunks, api_key):
    from openai import AsyncOpenAI
    client    = AsyncOpenAI(api_key=api_key)
    semaphore = asyncio.Semaphore(QA_CONCURRENCY)
    lock      = asyncio.Lock()

    results: dict[str, dict] = {}
    if QA_CACHE_PATH.exists():
        raw = json.loads(QA_CACHE_PATH.read_text(encoding="utf-8"))
        for k, v in raw.items():
            results[k] = v if isinstance(v, dict) else {"query_affinity": v}
        print(f"  Resuming — {len(results)} cached")

    to_process = [c for c in chunks
                  if c["uuid"] not in results or not results[c["uuid"]].get("query_affinity")]
    print(f"  {len(to_process)} to process ({QA_CONCURRENCY} concurrent)")

    completed = 0

    async def tracked(chunk):
        nonlocal completed
        await _fetch_one(client, semaphore, chunk, results, lock)
        completed += 1
        if completed % QA_CHECKPOINT == 0:
            async with lock:
                _save_qa(results)
            print(f"    {completed}/{len(to_process)}")

    await asyncio.gather(*[tracked(c) for c in to_process])
    _save_qa(results)
    print(f"  Done — {len(results)} entries saved")
    return results


def _save_qa(data: dict) -> None:
    QA_CACHE_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def gen_query_affinity(chunks: list[dict], api_key: str) -> dict[str, dict]:
    return asyncio.run(_run_qa(chunks, api_key))


# ── ONNX embedder ─────────────────────────────────────────────────────────────

class WordpieceTokenizer:
    def __init__(self):
        self.vocab: dict[str, int] = {}
        self.ids_to_tokens: dict[int, str] = {}
        with open(MODEL_DIR / "vocab.txt", encoding="utf-8") as f:
            for idx, line in enumerate(f):
                token = line.strip()
                self.vocab[token] = idx
                self.ids_to_tokens[idx] = token
        self.cls_id = self.vocab.get("[CLS]", 101)
        self.sep_id = self.vocab.get("[SEP]", 102)
        self.pad_id = self.vocab.get("[PAD]", 0)
        self.unk_id = self.vocab.get("[UNK]", 100)

    def _basic_tokenize(self, text: str) -> list[str]:
        text = text.lower()
        output, current = [], []
        for ch in text:
            cat = unicodedata.category(ch)
            if cat.startswith("P") or cat.startswith("S"):
                if current: output.append("".join(current)); current = []
                output.append(ch)
            elif ch in (" ", "\t", "\n", "\r"):
                if current: output.append("".join(current)); current = []
            else:
                current.append(ch)
        if current: output.append("".join(current))
        return output

    def _wordpiece(self, word: str) -> list[str]:
        if word in self.vocab:
            return [word]
        tokens, start = [], 0
        while start < len(word):
            end, found = len(word), None
            while start < end:
                substr = ("##" if start > 0 else "") + word[start:end]
                if substr in self.vocab:
                    found = substr; break
                end -= 1
            if found is None:
                return ["[UNK]"]
            tokens.append(found); start = end
        return tokens

    def encode(self, text: str, max_length: int = MAX_SEQ_LEN) -> dict:
        tokens = []
        for w in self._basic_tokenize(text):
            tokens.extend(self._wordpiece(w))
        tokens = tokens[: max_length - 2]
        ids      = [self.cls_id] + [self.vocab.get(t, self.unk_id) for t in tokens] + [self.sep_id]
        mask     = [1] * len(ids)
        type_ids = [0] * len(ids)
        pad      = max_length - len(ids)
        return {
            "input_ids":      ids      + [self.pad_id] * pad,
            "attention_mask": mask     + [0] * pad,
            "token_type_ids": type_ids + [0] * pad,
        }


class ONNXEmbedder:
    def __init__(self):
        import onnxruntime as ort
        print("Loading ONNX model…")
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = os.cpu_count() or 4
        self.session = ort.InferenceSession(
            str(MODEL_DIR / "onnx" / "model_quantized.onnx"),
            opts, providers=["CPUExecutionProvider"],
        )
        self.tokenizer = WordpieceTokenizer()

    def _mean_pool(self, token_emb: np.ndarray, mask: np.ndarray) -> np.ndarray:
        m = mask[:, :, np.newaxis].astype(np.float32)
        return (token_emb * m).sum(axis=1) / m.sum(axis=1).clip(min=1e-9)

    def _normalize(self, x: np.ndarray) -> np.ndarray:
        return x / np.linalg.norm(x, axis=1, keepdims=True).clip(min=1e-12)

    def encode_batch(self, texts: list[str]) -> np.ndarray:
        enc            = [self.tokenizer.encode(t) for t in texts]
        input_ids      = np.array([e["input_ids"]      for e in enc], dtype=np.int64)
        attention_mask = np.array([e["attention_mask"] for e in enc], dtype=np.int64)
        token_type_ids = np.array([e["token_type_ids"] for e in enc], dtype=np.int64)
        outputs = self.session.run(None, {
            "input_ids": input_ids, "attention_mask": attention_mask, "token_type_ids": token_type_ids,
        })
        return self._normalize(self._mean_pool(outputs[0], attention_mask)).astype(np.float32)

    def encode(self, texts: list[str], batch_size: int = 32,
               show_progress_bar: bool = True) -> np.ndarray:
        batches = range(0, len(texts), batch_size)
        if show_progress_bar:
            batches = tqdm(batches, desc="Embedding", unit="batch")
        return np.vstack([self.encode_batch(texts[i : i + batch_size]) for i in batches])


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip-file",       type=Path, required=True)
    parser.add_argument("--out-dir",        type=Path, default=ROOT_DIR / "data")
    parser.add_argument("--openai-key-file", type=Path, default=Path("/root/openai"),
                        help="File containing the OpenAI API key")
    args = parser.parse_args()

    out_dir: Path = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    # ── 1. Load content zip ──────────────────────────────────────────────────
    files: dict[str, bytes] = {}
    with zipfile.ZipFile(args.zip_file) as zf:
        for name in zf.namelist():
            files[name] = zf.read(name)

    # ── 2. Version info ──────────────────────────────────────────────────────
    version_info = json.loads(files.get("export_version.json", b"{}"))

    (out_dir / "version.json").write_text(json.dumps(version_info, indent=2))
    print(f"Content version: {version_info.get('version')}  ({version_info.get('date')})")

    # ── 3. Build text chunks ─────────────────────────────────────────────────
    chunks = build_chunks(files)

    # ── 4. chunks_meta.json ──────────────────────────────────────────────────
    meta_qa = [{**{k: v for k, v in c.items() if k != "text"},
                "qa_context": c["text"][:600]} for c in chunks]
    meta    = [{k: v for k, v in m.items() if k not in ("sub_pages", "qa_context")}
               for m in meta_qa]
    (out_dir / "chunks_meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    print(f"Saved chunks_meta.json ({len(meta)} chunks)")

    # ── 5. BM25 index ────────────────────────────────────────────────────────
    bm25_path = out_dir / "bm25.json"
    bm25_path.write_text(json.dumps(build_bm25(chunks), ensure_ascii=False), encoding="utf-8")
    print(f"Saved bm25.json ({bm25_path.stat().st_size / 1e6:.1f} MB)")

    # ── 6. Query-affinity generation + embedding ─────────────────────────────
    key_file: Path = args.openai_key_file
    if not key_file.exists():
        raise FileNotFoundError(
            f"OpenAI key file '{key_file}' not found. Pass --openai-key-file."
        )
    api_key    = key_file.read_text().strip()
    print("\n── Query affinity generation ────────────────────────────────────────────")
    affinities = gen_query_affinity(meta_qa, api_key)

    ordered_texts = [
        (affinities[c["uuid"]].get("query_affinity", "") if isinstance(affinities.get(c["uuid"]), dict)
         else affinities.get(c["uuid"], ""))
        for c in meta_qa
    ]
    print("Embedding query affinities …")
    qa_emb = ONNXEmbedder().encode(ordered_texts, batch_size=BATCH_SIZE)
    assert qa_emb.shape == (len(chunks), EMBED_DIMS), qa_emb.shape
    (out_dir / "qa_embeddings.bin").write_bytes(qa_emb.tobytes())
    print(f"Saved qa_embeddings.bin ({qa_emb.nbytes / 1e6:.1f} MB)")

    # ── 7. bundle.tar.gz ─────────────────────────────────────────────────────
    print("\nCreating bundle.tar.gz …")
    bundle_path = out_dir / "bundle.tar.gz"
    with tarfile.open(bundle_path, "w:gz") as tf:
        html_count = 0
        for fname, data in files.items():
            if fname.endswith(".html"):
                info = tarfile.TarInfo(name=f"content/{fname}")
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
                html_count += 1
        print(f"  Packed {html_count} content HTML files")
        # Include pages_menu.json from the content zip for client-side navigation
        if b"pages_menu.json" in files or "pages_menu.json" in files:
            pm = files.get("pages_menu.json", files.get(b"pages_menu.json"))
            info = tarfile.TarInfo(name="data/pages_menu.json")
            info.size = len(pm)
            tf.addfile(info, io.BytesIO(pm))
        for name in ("version.json", "chunks_meta.json", "bm25.json", "qa_embeddings.bin"):
            tf.add(out_dir / name, arcname=f"data/{name}")
        for f in sorted(VENDOR_DIR.rglob("*")):
            if f.is_file():
                tf.add(f, arcname=f"vendor/{f.relative_to(VENDOR_DIR)}")
    print(f"Saved bundle.tar.gz ({bundle_path.stat().st_size / 1e6:.1f} MB)")

    print("\nDone. Run: docker build -t bugsanddrugs . && docker run -p 8081:8081 bugsanddrugs")


if __name__ == "__main__":
    main()
