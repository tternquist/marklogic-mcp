# Writing flux_reprocess transform modules

`flux_reprocess` runs a server-side transform over many documents with batching,
parallelism, and error recovery. Prefer it over `ml_invoke_module` / `xdmp.invoke` for
any bulk transform — a single `xdmp.invoke` transaction hits MarkLogic's 600 s
transaction timeout on non-trivial collections and cannot use parallel threads.

## The two-phase pattern (required for scale)

Always split into two modules.

### Phase 1 — reader (`read_module` → `--read-invoke`, or `collections` → inline `--read-javascript`)

Collects the URIs Flux distributes across threads. **No `declareUpdate()`.** Must
return a Sequence or Array of URI strings.

```javascript
'use strict';
// No declareUpdate() — this is a read-only collector
var GRAPH = 'http://example.org/graph';
var rows = sem.sparql(
  'SELECT DISTINCT ?s FROM NAMED <' + GRAPH + '> WHERE { GRAPH <' + GRAPH + '> { ?s a ?type } }'
);
Array.from(rows).map(function (r) { return String(r.s); });
```

### Phase 2 — transform (`invoke_module` → `--write-invoke`)

Receives **one URI per invocation** in the external variable `URI`.

```javascript
'use strict';
declareUpdate();          // must be the very first statement in the file
var URI;                  // injected by Flux via --external-variable-name URI
(function run() {
  var doc = cts.doc(URI).toObject();
  if (!doc) { return; }   // bare return only works inside a function — IIFE required
  // ... build transformed doc ...
  xdmp.documentInsert(URI, doc, {
    permissions: xdmp.documentGetPermissions(URI),
    collections: Array.from(xdmp.documentGetCollections(URI)),
  });
})();
```

## Module constraints

**`declareUpdate()` position — the highest-cost mistake.** It must be the first
statement in the file, before any function or IIFE. Inside an IIFE it compiles
cleanly, but the transaction is never marked as an update and every
`xdmp.documentInsert()` **silently does nothing**.

```javascript
WRONG:   (function run() { declareUpdate(); ... })();
CORRECT: declareUpdate(); (function run() { ... })();
```

Also:
- Top-level bare `return` is a SyntaxError in strict-mode SJS — wrap in an IIFE.
- Declare `var URI` at module top level, **not** inside the IIFE. Do not use
  `external.URI` — it fails with `ReferenceError` when invoked from `xdmp.invoke()`.
- `batch_size` defaults to 1 (one URI per invoke). With `batch_size > 1`, URIs arrive
  joined by `--external-variable-delimiter` (`\n` by default) and the module must split
  them. Keep it at 1 unless you handle splitting explicitly.

## Testing before a full run

You cannot test a reprocess module via `xdmp.invoke()` in `ml_eval_javascript` — neither
`var URI` nor `external.URI` is populated there. Test against a single URI:

```
invoke_module: "/transforms/my-transform.sjs"
read_module: omit, collections: omit
extra_args: ["--read-javascript", "Sequence.from(['/path/to/one/doc.json'])"]
```

Then inspect with `ml_document_get` before running the whole collection.

## ⚠ Outbound HTTP silently no-ops

If the transform calls `xdmp.httpPost()` to an external service (e.g. Semaphore CLS),
it may silently do nothing inside Flux's reprocess context — even when the identical
module works from `ml_eval_javascript` or `ml_invoke_module`. Flux appears to run
write-invoke modules in a restricted transaction mode that blocks outbound HTTP or
conflicts with writing back to the same URI in the same transaction.

`Success count: N` only means N invocations returned without throwing. A suspiciously
fast run — 200 documents in ~6 s when each CLS call should take 100–200 ms — is a
strong signal of silent no-ops. **Always spot-check** with `ml_document_get` on 1–2
URIs to confirm the expected fields were written.

**Workaround:** classify at ingest with `flux_import(classify_with_semaphore=true)`, or
use `ml_eval_javascript` in batches of 10–20 URIs passed via `vars`, running the
classify-and-write logic in the eval context.

## Workflow

1. Write the transform module to the Modules database: `ml_document_put(database="Modules")`.
2. Optionally write a reader module for custom URI selection.
3. Call `flux_reprocess` with `invoke_module` plus one of `collections`,
   `read_module`, or `read_javascript`.

## RDF use case — hybrid entity documents from a named graph

- **Reader:** `SPARQL SELECT DISTINCT ?subject` → subject IRIs as an array.
- **Transform:** receives one IRI as `URI`, SPARQLs that subject's predicates, writes
  one JSON entity document with embedded unmanaged triples (JSON `triple` key) for TDE
  indexing.

**Optional-predicate rule.** Do not assign `''` to an unbound SPARQL variable — omit the
key, or use `?? null` instead. Applies to every optional predicate (`skos:broader`,
`dcterms:description`, `owl:sameAs`, and so on). Full rule and examples are in the
**marklogic-data-modeling** skill, §4 (Triple design).
