# Context Selection Pipeline

Before every agent turn, SideCar assembles a system prompt that includes retrieved context relevant to the user's query. The retrieval layer fuses three independent sources — documentation, agent memory, and the workspace itself — under a single shared budget using reciprocal-rank fusion (RRF). This keeps one noisy source from dominating the limited context window.

## Assembly flow

```mermaid
flowchart TD
    Turn[New agent turn] --> Inject[injectSystemContext<br/>src/webview/handlers/systemPrompt.ts]
    Inject --> Assemble[Assemble retrievers array]

    Assemble --> DR[DocRetriever<br/>DocumentationIndexer]
    Assemble --> MR[MemoryRetriever<br/>AgentMemory]
    Assemble --> SR[SemanticRetriever<br/>WorkspaceIndex]

    DR --> Fuse[fuseRetrievers query, topK, perSourceK]
    MR --> Fuse
    SR --> Fuse

    Fuse --> ReadyFilter[filter r.isReady]
    ReadyFilter --> Parallel[Promise.all<br/>retrieve per source]
    Parallel --> RRF[reciprocalRankFusion<br/>1 / k+rank per list, sum]
    RRF --> Slice[.slice 0, topK]
    Slice --> Render[renderFusedContext<br/>markdown block]
    Render --> Prompt[system prompt<br/>streamed to client]

    classDef retrieverStyle fill:#dbeafe,stroke:#2563eb
    classDef fuseStyle fill:#fef3c7,stroke:#d97706
    class DR,MR,SR retrieverStyle
    class RRF,Slice fuseStyle
```

Each retriever implements the `Retriever` interface in [`src/agent/retrieval/retriever.ts`](../src/agent/retrieval/retriever.ts): `isReady()` and `retrieve(query, k) → RetrievalHit[]`. `fuseRetrievers` silently skips retrievers that aren't ready, Promise.all's the rest, catches per-retriever throws (so one failing source doesn't kill the others), then feeds the ranked lists into RRF. The output is capped at `topK` hits and rendered as a single markdown block prepended to the system prompt.

## Inside SemanticRetriever (the workspace source)

The workspace retriever has two paths — a v0.62+ symbol-level path that ships with PKI, and a legacy file-level path for when PKI isn't wired. Knowing which path you're on matters for understanding why a query surfaced what it did.

```mermaid
flowchart TD
    Q[SemanticRetriever.retrieve query, k] --> PkiCheck{symbolEmbeddings<br/>wired + ready +<br/>count > 0?}

    PkiCheck -- no --> FileLegacy[rankFiles query, activeFilePath<br/>heuristic + file-level embedding]
    FileLegacy --> FileSlice[slice 0, k]
    FileSlice --> FileLoad[loadFileContent each]
    FileLoad --> FileTrunc[truncate to<br/>maxCharsPerFile default 3000]
    FileTrunc --> FileHit["emit RetrievalHit<br/>id: workspace:path<br/>score: file.score"]
    FileHit --> Done[return hits]

    PkiCheck -- yes --> SymSearch[SymbolEmbeddingIndex.search<br/>query, k]
    SymSearch --> Merkle{merkleTree<br/>attached?}
    Merkle -- yes --> Descend[tree.descend queryVec,<br/>max 10, 3×k<br/>pick candidate file subtrees]
    Descend --> ScoreLeaves[cosine-score only<br/>candidate leaves]
    Merkle -- no --> ScoreAll[cosine-score every leaf]
    ScoreLeaves --> TopK[top-k by similarity]
    ScoreAll --> TopK
    TopK --> SymLoad[loadFileContent per hit]
    SymLoad --> SymSlice["sliceSymbolBody<br/>startLine-endLine"]
    SymSlice --> SymTrunc[truncate to<br/>maxCharsPerSymbol default 1500]
    SymTrunc --> SymHit["emit RetrievalHit<br/>id: workspace-sym:path::qname<br/>score: similarity"]
    SymHit --> Done

    classDef pkiStyle fill:#dcfce7,stroke:#16a34a
    classDef legacyStyle fill:#fef3c7,stroke:#d97706
    class SymSearch,Merkle,Descend,ScoreLeaves,TopK,SymLoad,SymSlice,SymTrunc,SymHit pkiStyle
    class FileLegacy,FileSlice,FileLoad,FileTrunc,FileHit legacyStyle
```

**Symbol path** (PKI enabled, v0.62+):

- Every parsed symbol's body is embedded (MiniLM, 384-dim) and stored in a `FlatVectorStore` keyed by `filePath::qualifiedName`.
- When `sidecar.merkleIndex.enabled` (default `true`), a content-addressed Merkle tree sits over the vector store. Aggregated file-node embeddings let `descend(queryVec, k)` pick candidate subtrees *before* scoring leaves, turning `O(total symbols)` cosine scans into `O(picked files × avg symbols per file)`.
- Hit IDs use a `workspace-sym:` prefix so the RRF fusion layer dedupes symbol hits independently from any legacy file-level hit that might still arrive from a parallel retriever in hybrid test setups.
- Hit content renders as a fenced code block with the symbol's line-range slice — a tighter "evidence unit" than a file head.

**File path** (legacy, pre-PKI or PKI unavailable):

- `WorkspaceIndex.rankFiles` blends heuristic scoring (path-locality to the active file, file-name token overlap, recent-edit boost) with a file-level embedding over first-N-bytes MiniLM vectors.
- Top-k file contents load, truncate to `maxCharsPerFile`, and emit with a `workspace:` ID prefix.

The retriever prefers symbol-level when available (PKI wired + ready + non-empty). Empty symbol search returns `[]` (not `null`) — that's a PKI result, just a negative one, and the caller doesn't fall through to file-level. The fall-through triggers only when PKI genuinely isn't usable yet (still warming up, disabled, or `getCount() === 0`).

## Reciprocal-rank fusion

```mermaid
flowchart LR
    subgraph lists ["Per-retriever ranked lists"]
        direction TB
        Dl[Doc: D1, D2, D3]
        Ml[Mem: M1, M2, M3]
        Wl[Work: W1, W2, W3]
    end

    lists --> RRF["score hit = Σ 1 / k + rank_in_list <br/>k = 60"]
    RRF --> Sort[sort desc by score]
    Sort --> Dedup[dedupe by hit.id<br/>keep highest score]
    Dedup --> Out[topK hits across all sources]

    classDef formulaStyle fill:#fef3c7,stroke:#d97706
    class RRF formulaStyle
```

RRF works well for this problem because it only needs **ordinal rank** from each source, not comparable score distributions. A doc retriever scoring in `[0, 1]` cosine similarity and a memory retriever scoring in arbitrary BM25 units both contribute the same way — rank 1 in each list is worth `1 / (60 + 1)`, rank 2 is `1 / (60 + 2)`, and so on. The `k=60` constant is standard (from the IR literature) and is not tunable from config; changing it would require re-baselining the RAG-eval suite.

## Budget + sizing knobs

- **Per-source K** — each retriever is asked for `perSourceK` items (default: `topK`). The fusion layer then picks `topK` across the union. Giving each source extra headroom means a weaker retriever can still contribute lower-ranked items when the stronger one also has matches.
- **Char caps per hit**:
  - Symbol hits: `sidecar.projectKnowledge.maxCharsPerSymbol` (default 1500).
  - File hits: `SemanticRetriever.maxCharsPerFile` (default 3000).
  - Doc hits + memory hits: each source owns its own truncation upstream.
- **System-prompt budget** — injected context is capped at the system block's overall byte cap so it can't crowd out the conversation history. When the combined hits exceed the cap, the fusion output is sliced in order — highest-ranked hits survive.

## Observability

The RAG-eval harness at [`src/test/retrieval-eval/`](../src/test/retrieval-eval/) runs every golden case through the metrics suite (`contextPrecisionAtK`, `contextRecallAtK`, `f1ScoreAtK`, `reciprocalRank`) and a CI ratchet in [`baseline.test.ts`](../src/test/retrieval-eval/baseline.test.ts) gates retrieval quality against floor thresholds. An LLM-as-judge layer at `tests/llm-eval/retrieval.eval.ts` runs under `npm run eval:llm` and adds `Faithfulness` + `AnswerRelevancy` scoring.

## Source layout

| File | Role |
| --- | --- |
| [`src/agent/retrieval/index.ts`](../src/agent/retrieval/index.ts) | `fuseRetrievers` + `renderFusedContext` — the public fusion entrypoint |
| [`src/agent/retrieval/retriever.ts`](../src/agent/retrieval/retriever.ts) | `Retriever` interface + `RetrievalHit` type |
| [`src/agent/retrieval/fusion.ts`](../src/agent/retrieval/fusion.ts) | `reciprocalRankFusion` — pure function, side-effect-free |
| [`src/agent/retrieval/docRetriever.ts`](../src/agent/retrieval/docRetriever.ts) | Wraps `DocumentationIndexer` |
| [`src/agent/retrieval/memoryRetriever.ts`](../src/agent/retrieval/memoryRetriever.ts) | Wraps `AgentMemory` |
| [`src/agent/retrieval/semanticRetriever.ts`](../src/agent/retrieval/semanticRetriever.ts) | Wraps `WorkspaceIndex`; branches on PKI readiness |
| [`src/config/symbolEmbeddingIndex.ts`](../src/config/symbolEmbeddingIndex.ts) | `SymbolEmbeddingIndex` — symbol-level vector store + optional Merkle descent |
| [`src/config/merkleTree.ts`](../src/config/merkleTree.ts) | Content-addressed hash tree over symbol leaves |
| [`src/config/vectorStore.ts`](../src/config/vectorStore.ts) | `VectorStore<M>` interface + `FlatVectorStore<M>` |
| [`src/config/workspaceIndex.ts`](../src/config/workspaceIndex.ts) | File-level index used by the legacy path |
| [`src/webview/handlers/systemPrompt.ts`](../src/webview/handlers/systemPrompt.ts) | `injectSystemContext` — the caller that assembles retrievers and renders into the prompt |
