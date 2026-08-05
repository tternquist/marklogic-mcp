---
name: marklogic-data-modeling
description: Design MarkLogic multi-model data architecture — documents, RDF triples, and vectors — plus document URI schemes and the envelope pattern for data integration. Use when modelling a new domain, deciding whether relationships need triples or just nesting, laying out collections and URIs, designing TDE views, harmonizing data from multiple source systems, or auditing whether existing documents follow the envelope pattern. Covers the entity-oriented triple pattern, the six URI design rules, envelope header/instance/attachments/triples zones, and the managed-triples-then-reprocess path for raw RDF.
---

# MarkLogic Data Modeling

Three decisions, in order: **which models**, **how documents are shaped and named**, and
**whether an envelope is warranted**.

## 1. Model selection

Choose the least machinery that answers the query goals.

| Use | When | Skip it when |
|---|---|---|
| **Documents** | always — the base model | never |
| **Triples** | cross-entity relationships, graph traversal, taxonomy links | relationships are simple parent-child → just nest them in the document |
| **Vectors** | semantic similarity, RAG, recommendations | no similarity requirement |
| **TDE / Optic** | GROUP BY, joins, aggregation | no analytical queries |

State for each model you keep: why it fits, what it holds, what query capability it
unlocks. Being explicit about what you are *not* using is as valuable as the inclusions.

## 2. Document design

- **Collection strategy** — one collection per entity type; a `<source>-raw` collection
  per source system when harmonizing.
- **URI pattern** — see §3.
- **Range index candidates** — the fields used for filtering, sorting, or
  `ml_values_query`. Check what exists with `ml_indexes_list`.
- **TDE view candidates** — the fields needing GROUP BY or JOIN.
- **Never store `""`.** Empty strings pollute range indexes, break range queries, and
  create misleading TDE rows. Omit the field, or use `null`.
- **Dates as ISO-8601 strings**, to match a `dateTime` range index scalar type.

## 3. URI design — six rules

URIs are stable identity. Get them wrong and every later query is awkward.

1. **Prefix with the collection or entity type.** The prefix is the directory;
   `ml_document_list` scopes to it.
   `/orders/order-{orderId}.json` ✓ — `/{orderId}.json` ✗ (no grouping possible)
2. **Embed every primary key value.** Deterministic and collision-free. Avoid UUIDs
   unless the source has no key.
   `/events/gdelt/{GlobalEventID}.json` ✓ — `/orders/order.json` ✗ (overwrites on every write)
3. **Match the URI prefix to the collection short name.** Collection `orders` →
   URIs under `/orders/`.
4. **URL-safe characters only** — letters, digits, `/`, `-`, `_`, `.`. Replace spaces
   and colons with `-`; turn slashes in values into path segments.
5. **Right extension** — `.json` / `.xml` for content, `.sjs` / `.xqy` for modules
   (Modules database), `.tdej` for JSON TDE templates (Schemas database).
6. **Nest child entities under the parent key.**
   `/customers/{customerId}/orders/{orderId}.json` lets you list one customer's orders
   by directory.

**Never put mutable fields in a URI** — status, owner, or date in a URI means the
document has to move when the value changes.

For bulk loads, the URI pattern becomes the `flux_import` `uri_template`; Flux
substitutes `{FieldName}` per source row. Field names with spaces silently produce
malformed URIs — rename with `column_names` first.

## 4. Triple design

MarkLogic's preferred layout is **entity-oriented**: one document per entity, triples
embedded inside it, **document URI = entity IRI**. Both `cts.search` and
`ml_sparql_query` then find the entity through the same co-located record.

```json
{
  "id": "12345",
  "name": "Example",
  "triples": [
    { "triple": { "subject": "http://ex.org/e/12345",
                  "predicate": "http://schema.org/relatedTo",
                  "object": "http://ex.org/e/67890" } },
    { "triple": { "subject": "http://ex.org/e/12345",
                  "predicate": "http://schema.org/name",
                  "object": { "datatype": "http://www.w3.org/2001/XMLSchema#string",
                              "value": "Example" } } }
  ]
}
```

- Plural `"triples"` for the array key; each element wrapped in `"triple"`.
- IRI objects are plain strings. Literal objects are `{"datatype":…,"value":…}` — a bare
  string is read as an IRI.
- **`"sem:triples"` as the root key means managed triples**, which is a different
  storage model. Do not use it for embedded triples.

### Starting from raw RDF files

Two steps, not one:

1. `flux_import(subcommand="import-rdf-files")` — loads managed triples into named
   graphs. Fast, lossless, inspectable with `ml_sparql_query`.
2. `flux_reprocess` with an SJS transform that groups triples by subject IRI
   (`SELECT ?s WHERE { ?s ?p ?o } GROUP BY ?s`), writes one JSON document per IRI, and
   embeds the triples in unmanaged form.

Group by IRI where reasonable — avoid documents aggregating thousands of triples from
unrelated subjects.

**Optional-predicate rule.** When a SPARQL `OPTIONAL` yields an unbound variable, never
write `""`:

```javascript
WRONG:   broaderUri: row.broader || ""
CORRECT: if (row.broader) doc.broaderUri = row.broader;   // omit the key
CORRECT: broaderUri: row.broader ?? null
```

Mark TDE columns backed by optional predicates `"nullable": true`.

## 5. Vector design

Which entity needs embeddings and why; which text fields to embed; dimensionality and
model. Store as an `embedding` JSON float array. The TDE column spec and query patterns
are in the **marklogic-rag** skill — the vector column has four easy-to-get-wrong fields.

## 6. The envelope pattern

Use it when integrating **multiple source systems**, or when provenance and raw-source
preservation matter. It is overhead for a single-source, single-format load.

```json
{
  "envelope": {
    "headers":     { "...provenance, permissions, ingest metadata..." },
    "instance":    { "...canonical business model — this is what queries target..." },
    "attachments": { "raw": "<original source document>" },
    "triples":     []
  }
}
```

Zone responsibilities:

- **`headers`** — provenance, permissions, ingest metadata, classifications. Never
  business data.
- **`instance`** — the canonical, normalized model. Queries and TDE views target this.
- **`attachments`** — the raw source document, for audit and reprocessing. Optional but
  recommended.
- **`triples`** — RDF relationships, same format rules as §4.

Header fields, the ingest sequence, conformance levels for auditing existing documents,
and query patterns over envelopes are in `references/envelope-pattern.md`.

## 7. Discovery before designing

- `ml_document_sample` — what the source documents actually look like
- `ml_schema_discover` — real field names and types
- `ml_indexes_list` — what is already indexed
- `ml_collections_list` — what exists

Design against observed structure, not assumed structure.

## Further reading

- [Template Driven Extraction (TDE) (12)](https://docs.progress.com/bundle/marklogic-server-develop-server-side-apps-12/page/topics/TDE.html)
  — full template element reference
- [SQL on MarkLogic Server (12)](https://docs.progress.com/bundle/marklogic-server-model-relational-data-12/page/topics/intro.html)
  — how TDE rows become relational views
- [Unmanaged Triples (12)](https://docs.progress.com/bundle/marklogic-server-develop-with-semantic-graphs-12/page/topics/embedded.html)
  — triples embedded in documents, which is what the envelope `triples` zone holds
- [Using a Template to Identify Triples in a Document (12)](https://docs.progress.com/bundle/marklogic-server-develop-with-semantic-graphs-12/page/topics/tde.html)
  — the managed-triples-via-TDE path
- [Loading Semantic Triples (12)](https://docs.progress.com/bundle/marklogic-server-develop-with-semantic-graphs-12/page/topics/loading.html)
- [Introduction to Entity Services (11)](https://docs.progress.com/bundle/marklogic-server-use-entity-services-11/page/topics/intro.html)
  — MarkLogic's own envelope-based modelling framework, worth comparing against the
  hand-rolled envelope described here
