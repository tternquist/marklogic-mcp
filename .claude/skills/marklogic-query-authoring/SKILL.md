---
name: marklogic-query-authoring
description: Choose and write the right MarkLogic query for a goal — full-text search, exact-value filtering, structured cts queries, string-grammar (cts.parse) queries, QBE, facets and distinct-value counts, Optic row queries over TDE views, SPARQL over the triple store, and vector similarity search. Use when composing any query, when a query returns no results or too many, when deciding between ml_search, ml_optic_query, ml_values_query, ml_sparql_query, and ml_vector_search, or when hitting index errors like XDMP-ELEMRIDXNOTFOUND.
---

# MarkLogic Query Authoring

## Pick the tool from the goal

| Goal | Tool | Index prerequisite |
|---|---|---|
| Free-text across whole documents | `ml_search` with `q` | universal index (on by default) |
| Exact value on a JSON property | `ml_search` with `structured_query` | **none** — value index is on by default |
| Tokenised text in one field | `ml_search` `word-query` | none |
| Distinct values / counts / buckets | `ml_values_query` | **range index** on the field |
| Facet counts alongside results | `ml_facets_query` | range index per facet |
| GROUP BY, joins, aggregates | `ml_optic_query` | **TDE template** in Schemas |
| Entity relationships, graph traversal | `ml_sparql_query` | triple index on |
| Semantic / similarity search | `ml_vector_search` | vector index (ML 12+) |
| Query-by-example from a sample doc | `ml_search_qbe` | none |
| Geospatial | `ml_geospatial_search` | geospatial index |

Before composing anything non-trivial, run `ml_schema_discover` (structure),
`ml_indexes_list` (what is actually indexed), and `ml_collections_list` (what exists).
Guessing at field names is the most common cause of empty results.

## The most important rule: you usually don't need a range index

`cts.parse` (via `ml_parse_query`) requires a **range index on every tagged binding** —
tags become `cts.<kind>Reference` objects. On a non-indexed field it fails with
`XDMP-ELEMRIDXNOTFOUND`. That is a limitation of `cts.parse`, **not of MarkLogic**.

For exact-value filtering on a non-indexed JSON property, skip `cts.parse` and pass a
structured query straight to `ml_search`:

```json
{"query":{"value-query":{"json-property":"incidentType","text":["Hurricane"]}}}
```

For tokenised free text in one field:

```json
{"query":{"word-query":{"json-property":"description","text":["hurricane"]}}}
```

For free text across the whole document, just use `ml_search q="hurricane"`.

Reach for `ml_parse_query` only when you specifically need string-grammar parsing — an
LLM-written `X AND Y NOT Z` expression with range comparisons on **indexed** fields — or
when round-tripping a string query through MarkLogic's parser to canonicalise it.

## Natural language → query pipeline

1. `ml_search_surface` — fields, range indexes, options sets in one call. **Never skip
   this**; guessing field names is what produces empty results.
2. Write a string-grammar query: `diabetes AND state:TX AND age GE 65`
3. `ml_parse_query` validates it and returns structured-query JSON
4. `ml_search` executes that JSON via `structured_query`

The parsed output is in exactly the shape `ml_search` accepts, so it can be piped
through, stored, or modified first.

**Bindings** map tag names in the query text to range-indexed fields. Without bindings,
only boolean operators (`AND`, `OR`, `NOT`, `NEAR/k`), quoted phrases, parens, and bare
words are recognised — `state:TX` becomes a literal word query for the token `state:TX`.

```
qtext: "diabetes AND importedAt GE 2024-01-01"
bindings: { importedAt: { type: "element-range", name: "importedAt", scalar_type: "dateTime" } }
```

Grammar is strict: comparison operators need spaces on both sides (`age >= 65`, never
`age:>=65`), and the only legal colon is the `tag:value` equality delimiter.

Full translation method — intent extraction, the no-range-index fallback, bindings, and
how to state assumptions — is in `references/nl-to-query.md`.

## Optic over TDE views

`ml_optic_query` is the right tool for GROUP BY, aggregates, and joins. It requires a
TDE template in the Schemas database (collection `http://marklogic.com/xdmp/tde`).

Check the view exists first with `ml_schema_get_tde` or `ml_views_list`. If no view
exists, create one at import time with `flux_import(generate_tde=true)` or install one
with `ml_tde_install`.

Validate a template against real documents with `ml_tde_validate` before relying on it —
a template installs successfully even when it extracts zero rows.

## SPARQL

See `references/sparql-and-triples.md` for the three triple storage layouts (embedded,
named graph, hybrid), the JSON object-encoding rules that silently turn literals into
IRIs, and the four-step checklist for debugging empty results after installing a TDE
with a `triples` section.

Two rules worth stating up front:

- **Always add `LIMIT`** to exploratory SELECTs. Cross-graph joins are prone to
  cartesian explosions when predicate patterns overlap. `LIMIT 100` by default.
- Use `ml_graphs_list` to discover graph URIs before writing `FROM NAMED`.

## When a query returns nothing

Work down this list before rewriting the query:

1. **Does the data exist?** `ml_search q="*"` or `ml_document_sample` on the collection.
2. **Is the field name right?** `ml_schema_discover` — case and nesting matter.
3. **Right database?** Projects use their own content database, not `Documents`.
   `ml_databases_list` to check.
4. **Right collection?** `ml_collections_list`.
5. **Index missing?** `ml_indexes_list`. A range-index-dependent tool on an unindexed
   field fails or returns empty.
6. **Reindex still running?** `ml_reindex_status`. TDE and index changes need a full
   reindex before they take effect.

## When a query returns too much

- Add `LIMIT` / `page_length`.
- Add a collection constraint — almost always the cheapest narrowing.
- For counts rather than documents, use `ml_values_query` or `ml_optic_query` with
  `group-by` instead of paging through results.

## Diagnosing performance

- `ml_explain_optic` — Optic plan before running it
- `ml_search_query_plan` — how a search resolves against indexes
- `ml_profile_query` — actual query meters

A query that scans instead of using an index almost always means a missing range index
or a field name that does not match the indexed one.

## Further reading

- [Composing cts:query Expressions (12)](https://docs.progress.com/bundle/marklogic-server-use-search-12/page/topics/cts_query.html)
  — the full cts constructor catalogue
- [Search API: Understanding and Using (12)](https://docs.progress.com/bundle/marklogic-server-use-search-12/page/topics/search-api.html)
- [Search Customization Using Query Options (12)](https://docs.progress.com/bundle/marklogic-server-use-search-12/page/topics/query-options.html)
  and the exhaustive [Query Options Reference (12)](https://docs.progress.com/bundle/marklogic-server-use-search-12/page/topics/appendixa.html)
- [Browsing With Lexicons (12)](https://docs.progress.com/bundle/marklogic-server-use-search-12/page/topics/lexicon.html)
  — the lexicon and range-index machinery behind `ml_values_query`
- [Optic API for Multi-Model Data Access (12)](https://docs.progress.com/bundle/marklogic-server-develop-server-side-apps-12/page/topics/OpticAPI.html)
- [Introduction to Semantic Graphs (12)](https://docs.progress.com/bundle/marklogic-server-develop-with-semantic-graphs-12/page/topics/intro.html)
  and [SPARQL Update (12)](https://docs.progress.com/bundle/marklogic-server-develop-with-semantic-graphs-12/page/topics/sparql-update.html)
- [cts:parse](https://docs.marklogic.com/cts:parse) — the string-grammar reference, including
  the bindings map
