---
name: marklogic-rag
description: Design and build Retrieval-Augmented Generation pipelines on MarkLogic 12 as vector store and/or knowledge graph. Covers the three composable paradigms — Lexical RAG (BM25, no embeddings), Vector RAG (cosine, ANN top-k, and ANN+BM25 hybrid via vec.vectorScore), and Graph RAG (Semaphore concept classification scoping retrieval) — plus embedding storage design, the TDE vector column spec, reranking, and chunking. Use when building RAG or semantic search over MarkLogic, writing vector queries, designing embedding storage, or debugging TDE-INVALIDTEMPLATENODEVAL, XDMP-DIMMISMATCH, or SQL-TABLEREINDEXING on a vector view.
---

# RAG on MarkLogic 12

Requires MarkLogic 12+. Check for an existing vector view first with `ml_views_list`
and `ml_schema_get_tde`.

## Pick a paradigm

| Situation | Approach |
|---|---|
| No embeddings, fast prototype | Lexical RAG |
| Embeddings available, simple queries | Pure vector (cosine) |
| Mixed vocabulary + semantic queries | ANN hybrid (ANN + BM25) |
| Taxonomy / knowledge graph available | Graph + Lexical |
| Highest precision, full infrastructure | **Graph + Vector** |

The graph layer composes with *any* paradigm — it only supplies a URI scope filter, so
apply it before the search or ANN step.

## 1. Storing embeddings

Store the embedding as a JSON array of floats in an `embedding` field, sibling to the
content fields. Carry `embeddingModel`, `embeddingDim`, and — when chunking —
`chunkIndex`, `chunkText`, `sourceUri`.

Chunking strategy by domain: legal contracts → by clause; news articles →
whole-document or paragraph; product manuals → by section.

**⚠ Generate embeddings in your application tier, not in MarkLogic.**
`xdmp.httpPost` to external HTTPS embedding APIs commonly fails with
`tlsv1 unrecognized name` (an SSL SNI limitation in MarkLogic's Java SSL client).
Produce the float array outside, then store it with `flux_import` or `ml_document_put`.

## 2. The TDE vector column

```json
{
  "template": {
    "context": "/",
    "collections": ["my-collection"],
    "rows": [{
      "schemaName": "my_schema",
      "viewName": "my_view",
      "columns": [
        { "name": "uri",       "scalarType": "string", "val": "xdmp:node-uri(.)" },
        { "name": "content",   "scalarType": "string", "val": "chunkText" },
        { "name": "embedding", "scalarType": "vector", "val": "array-node('embedding')",
          "dimension": "1536", "invalidValues": "reject" }
      ]
    }]
  }
}
```

Four rules that each cause a distinct failure:

- **`"scalarType": "vector"`** — not `"vec:vector"`, not `"scalar"`. Either of those
  gives `TDE-INVALIDTEMPLATENODEVAL`.
- **`"val": "array-node('embedding')"`** — plain `"val": "embedding"` atomises the array
  into N individual number nodes and throws `XDMP-CAST`.
- **`"dimension"`** is required and must match the model output exactly, or queries
  fail with `XDMP-DIMMISMATCH`.
- **`"invalidValues": "reject"`** — skips malformed documents instead of failing the
  whole view.

Deploy with `ml_document_put` to the Schemas database (a URI starting `/tde/` joins the
TDE collection automatically). Then wait for `ml_reindex_status(database=...)` to report
`ready=true` — vector queries return `SQL-TABLEREINDEXING` until reindexing completes.

Validate before querying: `tde.validate([cts.doc('/tde/your/template.json')],[])` via
`ml_eval_javascript` — an empty array means no errors.

## 3. Retrieval

Full query code for all three paradigms — pure cosine, ANN top-k, the two-step ANN+BM25
hybrid, Graph RAG, and Graph+Vector — is in `references/retrieval-patterns.md`.

Via MCP, the simple path is
`ml_vector_search(schema=…, view=…, vector_column="embedding", query_vector=[…], k=10)`.

### API traps (all verified against a live cluster)

- **`vec` is a global**, not a module. `require('/MarkLogic/vec')` throws
  `XDMP-MODNOTFOUND`. Use `vec.vector([...])` and `vec.vectorScore(...)` directly.
- **`annTopK` is a plan method**, not `op.annTopK()`. Call
  `.annTopK(k, op.col('embedding'), queryVec, op.col('distance'), opts)` on a ModifyPlan.
  Its query-vector argument uses the global `vec.vector()`, not `op.vec.vector()`.
- **`vec.vectorScore` returns a rank where LOWER IS BETTER** → sort **ascending**.
  Documents matching only the vector arm get `rank=null`; sort those last. Note the
  asymmetry: `op.vec.vectorScore` used *inside* an Optic plan sorts descending.
- **`ann_distance` is cosine distance** — lower is more similar (0 identical, 2 opposite).

### ⚠ Require 12.0.1 or later

Two vector defects in 12.0.0 are easy to misdiagnose as a bug in your own retrieval
code. Check `ml_cluster_status` before debugging further:

- **`annTopK` served stale results.** Changing the query vector did not change the
  rows — the previous vector's results were returned until the query plan cache timed
  out. A pipeline that returns plausible-but-unrelated passages, and returns the *same*
  passages for different questions, is showing this and not a bad embedding.
- **Vector parameters bound to `POST /v1/rows` were not typed correctly**, so passing a
  query vector as a bound parameter over REST failed. Relevant to any Optic vector
  query issued through the REST API rather than `ml_eval_javascript`.

Both are fixed in 12.0.1.

## 4. Reranking

- Cosine alone is enough for whole-document embeddings with a good model.
- Add a cross-encoder reranker (Cohere Rerank v3, `cross-encoder/ms-marco-MiniLM`) when
  chunks are sentence-level, the query is multi-faceted, or top-k quality is uneven.
- **A graph pre-filter often replaces reranking** — if concept scoping already removed
  off-topic results, a reranker is overhead.
- **Deduplicate chunked results by `sourceUri`** after reranking, or one document's
  chunks will fill the LLM context window.
- Thresholds: for pure vector, discard cosine similarity < 0.5 (distance > 1.0). For ANN
  hybrid, discard rank > 50 as a starting heuristic and tune per domain.

## 5. Production sequence (Graph + Vector)

1. `semaphore_classify` on the user question → concept IDs
2. `ml_eval_javascript` — `cts.uris("", ["limit=100"], cts.jsonPropertyValueQuery("id", conceptIds))` → scoped URIs
3. `ml_views_list` — confirm the view exists
4. `ml_reindex_status` — confirm `ready=true`
5. `ml_eval_javascript` — ANN hybrid scoped to those URIs → ranked top-k
6. `ml_document_get` per URI → full content
7. *(application tier)* assemble content + scores into the LLM prompt

For Lexical-only, skip 1–5 and use `ml_search` with a collection constraint.

## Why the graph layer earns its place

From live testing on a small corpus: a query about *"health impacts of environmental
pollution"* retrieved an article on urban air pollution and surfaced a cross-concept
link through a shared **Pollutants** taxonomy concept that pure lexical search missed.

In the other direction, Graph+Vector *eliminated* a CRISPR article that matched
"chemical" and "ecosystem" lexically for a marine-pollution query — the concept filter
blocked it because it lacked the Marine Ecosystems concept.

Lexical RAG's characteristic failure is exactly this: missing cross-concept connections
when vocabulary does not overlap.

## Further reading

- [What's new in MarkLogic 12](https://docs.progress.com/bundle/marklogic-server-whats-new-12/page/topics/what-s-new-in-marklogic-12.html)
  — vectors as a native indexed model
- [Release notes (12)](https://docs.progress.com/bundle/marklogic-server-whats-new-12/page/topics/release-notes.html)
  — check this first when vector behaviour looks wrong; the 12.0.1 fixes above are here
- [Building Vector Queries (Optic, 12)](https://docs.progress.com/bundle/marklogic-server-get-started-optic-12/page/topics/building-vector-queries.html)
- [Optic API for Multi-Model Data Access (12)](https://docs.progress.com/bundle/marklogic-server-develop-server-side-apps-12/page/topics/OpticAPI.html)
- [vec:vector-score](https://docs.marklogic.com/vec:vector-score) — the hybrid scoring
  function's exact signature and weighting parameter
- [Template Driven Extraction (12)](https://docs.progress.com/bundle/marklogic-server-develop-server-side-apps-12/page/topics/TDE.html)
  — the template reference behind the vector column spec above
