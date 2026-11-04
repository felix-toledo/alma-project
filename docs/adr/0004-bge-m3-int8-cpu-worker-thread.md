---
status: accepted
---

# Embeddings: bge-m3 int8 on CPU, in a worker thread, downloaded on first use

The embedding model is `Xenova/bge-m3` quantized to int8 (`q8`), run by `@huggingface/transformers` on the CPU (1024 dimensions, normalized CLS vector). It runs in a `worker_threads` Worker of the coordinator (`src/coordinator/knowledge/embedder.ts` and `embed-worker.ts`, emitted as `embedWorker.js`). The roughly 570 MB model is downloaded on first use into `<userData>/models`; until it is ready, search works with keywords only.

## Why

Design note "vault-knowledge-design": the user asked for local-first, plain-Markdown and fully optimized; bge-m3 int8 was chosen with no reranker "for now". Indexing and embedding need no cloud service; the only network use is the one-time download ([spec 009](../../.specify/specs/009-knowledge-and-memory/spec.md), section 2). The same note says "in a separate process"; the code uses a worker thread, and the code wins. Why bge-m3 over other models: Rationale not documented.

## Considered options

Alternatives: not documented (the note mentions only "No reranker for now").

## Consequences

- First download is large; CPU inference is slow on weak machines; the index becomes fully semantic only when `pending` reaches 0.
- Model loading failures (offline on first use) leave state `error`; there is no automatic retry timer, only a later scan, write or save tries again.
- The query is embedded as-is, with no retrieval instruction prefix.
- Changing the model means re-embedding every vault (the model id `Xenova/bge-m3:q8` is stored in the index).
- It shares the same engine, `onnxruntime-node`, as the voice models ([ADR 0008](0008-voice-in-js-on-onnxruntime.md)).
- Models come only from Hugging Face downloads (`allowLocalModels` is off); `huggingface.co` sees no personal data ([PRIVACY.md](../security/PRIVACY.md)).
