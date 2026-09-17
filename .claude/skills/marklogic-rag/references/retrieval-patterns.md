# RAG retrieval patterns — working query code

All snippets are for MarkLogic 12 SJS via `ml_eval_javascript`, unless a direct MCP tool
is noted.

---

## Paradigm 1 — Lexical RAG (BM25, no embeddings)

Best where exact terminology matters (legal, medical, technical) and you want a fast
path with no embedding infrastructure.

```javascript
cts.search(cts.andQuery([
  cts.collectionQuery("my-collection"),
  cts.wordQuery(queryTerms)
]), ["score-bm25", "unfiltered"])
```

Via MCP: `ml_search` with the collection and query text.

**Known limitations** (observed on a live corpus):
- Misses cross-concept connections — a query on "chemical contaminants in marine
  ecosystems" can miss an article on "urban air pollution" even when both share a
  Pollutants concept.
- Single-term queries return sparse results when the vocabulary does not overlap the
  document text.

---

## Paradigm 2 — Vector RAG

Requires the TDE vector view deployed and indexed, with an embedding array per document.

### 2a. Pure cosine similarity (simplest)

```javascript
const op = require('/MarkLogic/optic');
// vec is a GLOBAL in MarkLogic 12 — do NOT require('/MarkLogic/vec')
const queryVec = vec.vector(queryEmbedding);   // float[]

op.fromView("my_schema", "my_view")
  .bind(op.as("score", op.vec.cosine(op.col("embedding"), op.vec.vector(queryVec))))
  .orderBy(op.desc(op.col("score")))
  .select(["uri", "content", "score"])
  .limit(10)
  .result()
```

Via MCP: `ml_vector_search(schema=…, view=…, vector_column="embedding", query_vector=[…], k=10)`

### 2b. ANN top-k (faster on large corpora)

```javascript
const op = require('/MarkLogic/optic');
const queryVec = vec.vector(queryEmbedding);

// annTopK is a METHOD on the plan — not op.annTopK()
op.fromView("my_schema", "my_view")
  .annTopK(10, op.col("embedding"), queryVec, op.col("ann_distance"),
           { distanceThreshold: 1.0 })
  .select(["uri", "content", "ann_distance"])
  .result()
// ann_distance is cosine distance: lower = more similar (0 identical, 2 opposite)
```

### 2c. ANN hybrid — ANN + BM25 combined (recommended for production)

```javascript
const op = require('/MarkLogic/optic');
const queryVec = vec.vector(queryEmbedding);
const lexQuery = cts.andQuery([
  cts.collectionQuery("my-collection"),
  cts.wordQuery(queryTerms)
]);

// Step 1 — ANN candidates (over-fetch ~3x the final k)
const annRows = Array.from(
  op.fromView("my_schema", "my_view")
    .annTopK(30, op.col("embedding"), queryVec, op.col("ann_distance"),
             { distanceThreshold: 1.5 })
    .result()
);
const candidateUris = annRows.map(r => r["my_schema.my_view.uri"]);

// Step 2 — BM25 for those candidates via fromSearchDocs (normalised Optic scores)
const lexScores = {};
Array.from(
  op.fromSearchDocs(cts.andQuery([cts.documentQuery(candidateUris), lexQuery]))
    .select(["uri", "score"])
    .result()
).forEach(r => { lexScores[r.uri] = r.score; });

// Step 3 — combine. vec.vectorScore(distance, bm25, weight) returns a RANK, lower = better.
// weight = lexical emphasis, 0.0–1.0
const results = annRows.map(r => {
  const uri  = r["my_schema.my_view.uri"];
  const dist = r["ann_distance"];
  const bm25 = lexScores[uri] || null;
  return { uri, dist, bm25, rank: vec.vectorScore(dist, bm25, 0.7) };
}).sort((a, b) => {
  if (a.rank === null && b.rank === null) return a.dist - b.dist;  // vector-only: by distance
  if (a.rank === null) return 1;    // no BM25 match → last
  if (b.rank === null) return -1;
  return a.rank - b.rank;           // ASCENDING — lower rank wins
}).slice(0, 10);
```

**`vec.vectorScore` semantics — verified by live testing:**
- Returns an integer rank where **lower is better** → sort **ascending**.
- Arg 1: vector distance from `annTopK` (0–2, lower = closer).
- Arg 2: BM25 score from `fromSearchDocs` (large positive integer).
- Arg 3: weight — lexical emphasis (0.7 ≈ 70% lexical influence).
- Vector-only matches get `rank = null` — sort them last.
- Use the Optic `fromSearchDocs` `score` column, **not** raw `cts.score()`.

---

## Paradigm 3 — Graph RAG (Semaphore concept scoping)

Requires the Semaphore Classification Server. Best where cross-concept connections
matter — news, research, policy — because it bridges vocabulary gaps lexical search
cannot.

```javascript
// Step 1: classify the question → concepts
//   MCP: semaphore_classify(content=userQuestion, threshold=40)
//   → [{label:"Health", id:"29a0…"}, {label:"Pollutants", id:"e821…"}]

// Step 2: build a concept-scope query from the returned IDs
const conceptIds   = classificationResults.map(c => c.id);
const conceptQuery = cts.jsonPropertyValueQuery("id", conceptIds);

// Step 3: concept-matched URIs
const scopedUris = Array.from(cts.uris("", ["limit=100"], conceptQuery)).map(String);

// Step 4: lexical search within that scope
const results = Array.from(
  cts.search(cts.andQuery([cts.documentQuery(scopedUris), cts.wordQuery(queryTerms)]),
             ["score-bm25", "unfiltered"])
);
```

### Graph + Vector (highest precision)

```javascript
const queryVec     = vec.vector(queryEmbedding);
const conceptQuery = cts.jsonPropertyValueQuery("id", conceptIds);
const scopedUris   = Array.from(cts.uris("", ["limit=100"], conceptQuery)).map(String);

const op = require('/MarkLogic/optic');
const results = Array.from(
  op.fromView("my_schema", "my_view")
    .where(cts.documentQuery(scopedUris))        // concept filter BEFORE ANN
    .annTopK(10, op.col("embedding"), queryVec,
             op.col("ann_distance"), { distanceThreshold: 1.5 })
    .select(["uri", "content", "ann_distance"])
    .result()
);
```

The concept filter runs before ANN, so it prunes the candidate set rather than
post-filtering it — this is what removes the ANN-hybrid false positives where BM25
matches a query word in an irrelevant context.

---

## Failure reference

| Symptom | Cause |
|---|---|
| `TDE-INVALIDTEMPLATENODEVAL` | used `"scalar"` or `"vec:vector"` instead of `"scalarType": "vector"` |
| `XDMP-CAST` on the embedding column | `"val": "embedding"` instead of `"array-node('embedding')"` |
| `XDMP-CAST: Invalid cast: null cast as vec:vector(dim:...)` | `"dimension"` is a string instead of a JSON number; a preceding `date` column can also trigger the same null-cast path in a specific template |
| `XDMP-MODNOTFOUND` | `require('/MarkLogic/vec')` — `vec` is a global |
| `XDMP-DIMMISMATCH` | stored dimension ≠ query vector length; log `embeddingDim` at ingest |
| `SQL-TABLEREINDEXING` | querying before reindex finished — check `ml_reindex_status` |
| `SQL-TABLENOTFOUND` / `Unknown table` | the TDE document exists but the view is not queryable; check the view registration, the target database, and the `collections` filter shape before assuming the schema is valid |
| `tlsv1 unrecognized name` | `xdmp.httpPost` to an external HTTPS embedding API; generate embeddings in the app tier |
| Results ordered worst-first | `vec.vectorScore` sorted descending — it ranks ascending |
| One document floods the results | chunked corpus not deduplicated by `sourceUri` |

### Decision tree when the view is installed but not queryable

1. Confirm the template is installed and validates (`ml_schema_get_tde`, `ml_tde_validate`).
2. Confirm the query is going to the expected database and app server (`ml_databases_list`,
   `ml_servers_list`).
3. If `ml_reindex_status` says `ready=true` but the view still returns `SQL-TABLENOTFOUND`,
   treat it as a registration or target mismatch problem rather than a generic schema problem —
   the most common silent cases are a wrong `collections` filter shape or a query pointed at the
   wrong database.
4. Do not spend the session debugging the query path; keep a brute-force cosine fallback in
   the application tier until the vector view is confirmed healthy.
