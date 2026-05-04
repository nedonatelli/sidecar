---
title: "ADR-004: FlatVectorStore over dedicated vector DB"
layout: docs
---

# ADR-004: FlatVectorStore over dedicated vector DB

**Date**: 2025-02
**Status**: Accepted

## Context

SideCar's semantic retrieval layer (symbol-level PKI search, episodic memory, prose chunking) needs a vector store. The options were:

- **Dedicated vector DB** (LanceDB, Chroma, Qdrant, Weaviate): rich query APIs, disk persistence, approximate nearest-neighbor indexes. All require native binaries or a running process — significant extension-host overhead.
- **`@huggingface/transformers` + in-process store**: embed in the Node.js extension host using ONNX Runtime Web. No external process. Requires a pure-JS/WASM store.
- **`FlatVectorStore`**: brute-force cosine scan over a `Float32Array` matrix. O(n) per query. Simple, zero deps beyond the embedding model.

The embedding model chosen was MiniLM-L6-v2 (384 dimensions, ~22MB ONNX). At the expected scale (≤50k symbols per workspace, ≤1k episodic entries per session), O(n) scan is fast enough: a 50k-symbol scan completes in ~30ms on a modern laptop.

## Decision

SideCar uses `FlatVectorStore<M>` (`src/config/vectorStore.ts`) as the sole vector backend. The `VectorStore<M>` interface is defined so a future LanceDB adapter can drop in without changing callers.

Persistence is via `persist()`/`restore()` methods that write/read a JSON file. The `sidecarDir` parameter accepts `null` for session-only stores (episodic memory) that don't need persistence.

A Merkle tree layer (`src/config/merkleTree.ts`) sits above the flat store to prune the candidate set before scoring: subtrees whose aggregated embedding is far from the query are skipped, reducing the effective scan to ~5–15% of the total corpus on typical queries.

## Consequences

**Positive**:
- Zero native binary dependencies — extension installs cleanly on all platforms without a post-install build step
- Single in-process store — no IPC, no process management, no port conflicts
- `VectorStore<M>` interface means the decision is reversible; LanceDB backend reserved in config (`sidecar.projectKnowledge.backend: 'flat' | 'lance'`)

**Negative**:
- O(n) scan degrades on very large codebases (>200k symbols). The Merkle pruning layer partially mitigates this but is not a substitute for approximate nearest-neighbor at scale.
- No HNSW or IVF index — cannot support the approximate recall + speed tradeoffs that production RAG systems expect
- WASM ONNX Runtime adds ~15MB to the extension bundle; first-embed call is slow (~1–2s) due to WASM JIT compilation
