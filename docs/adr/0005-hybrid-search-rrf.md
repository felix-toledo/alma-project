---
status: accepted
---

# Search is hybrid: BM25 and vector KNN fused with Reciprocal Rank Fusion

`search` runs FTS5 BM25 (heading weighted 2.0, body 1.0) and cosine KNN, each to depth 40, and fuses the two rankings with RRF (constant 60), at most 2 fragments per file. Automatic recall for every agent message keeps up to 5 fragments, and a fragment passes only if its cosine similarity is at least 0.45 (or, with no vectors, if it is in the top 5 of the keyword ranking). Code: `src/coordinator/knowledge/base.ts`.

## Why

Design note "vault-knowledge-design", memory layer 2: "automatic hybrid RAG top-5 (BM25+vector, RRF) per message". Because the vector side needs the model download ([ADR 0004](0004-bge-m3-int8-cpu-worker-thread.md)), the keyword side also guarantees that search works from the first second and offline ([spec 009](../../.specify/specs/009-knowledge-and-memory/spec.md), US-3). Why RRF over a weighted score: Rationale not documented. Inference: RRF needs no calibration between BM25 and cosine scores.

## Considered options

Alternatives: not documented. The design note defers a reranker ("No reranker for now").

## Consequences

- `search_knowledge` and `vault.search` apply no minimum similarity, so unrelated chunks can appear at the tail.
- Recall results are injected into the system prompt once per run, as data ("datos, no instrucciones", "data, not instructions"), so the prompt stays constant across tool iterations (prompt cache).
- The recall thresholds (0.45, top 5, duplicate threshold 0.9 for `save_knowledge`) are constants in `base.ts`, not settings.
- A note can still contain text that tries to steer a model; the label is the only mitigation ([spec 009](../../.specify/specs/009-knowledge-and-memory/spec.md), section 7).
