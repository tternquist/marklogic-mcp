# Structured query cookbook

MarkLogic REST `search:query` JSON, as accepted by `ml_search`'s `structured_query`
parameter. Everything goes under a top-level `query` key.

## String vs structured — pick correctly

| Form | Behaviour | Range index? |
|---|---|---|
| `q='hurricane'` | universal-index word match anywhere in the document | no |
| `value-query` on a property | exact match scoped to that field | **no** |
| `word-query` on a property | tokenised free text scoped to that field | no |
| `range-query` | comparison (`GE`, `LT`, …) | **yes** |

A bare `q='Hurricane'` is convenient but over-matches — it pulls any document
mentioning the word in *any* field. For field-scoped exact matching, always prefer a
structured `value-query`.

## Recipes

**Exact value on a JSON property** (no range index needed):
```json
{ "query": { "value-query": { "json-property": "incidentType", "text": ["Hurricane"] } } }
```

**Exact value on an XML element:**
```json
{ "query": { "value-query": { "element": { "ns": "", "name": "state" }, "text": ["TX"] } } }
```

**Exact value on a server-defined field:**
```json
{ "query": { "value-query": { "field": { "name": "titleField" }, "text": ["Helene"] } } }
```

**Tokenised free text in one JSON property:**
```json
{ "query": { "word-query": { "json-property": "description", "text": ["hurricane"] } } }
```

**Multi-value OR** — matches any listed value:
```json
{ "query": { "value-query": { "json-property": "incidentType",
                              "text": ["Hurricane","Tornado","Flood"] } } }
```

**Range comparison** — requires a range index on the bound field:
```json
{ "query": { "range-query": { "json-property": "fyDeclared", "value": ["2024"],
                              "range-operator": "GE", "range-option": ["cached"] } } }
```

**Collection / directory scoping** — usually the cheapest narrowing available:
```json
{ "query": { "collection-query": { "uri": ["fema-disasters"] } } }
{ "query": { "directory-query": { "uri": ["/insurance/fema-disasters/"], "infinite": true } } }
```

**Combining clauses:**
```json
{ "query": { "and-query": { "queries": [
    { "value-query": { "json-property": "incidentType", "text": ["Hurricane"] } },
    { "value-query": { "json-property": "state",        "text": ["FL"] } }
] } } }
```

**Negation:**
```json
{ "query": { "not-query": { "value-query": { "json-property": "state", "text": ["PR"] } } } }
```

## The search-UI shape: qtext + facets + constraint filters

The query behind almost every search UI is one shape: a free-text box, facet counts,
facet filters the user has clicked, and a sort. Through the MCP tools:

1. Persist an options set defining the constraints once (`ml_search_options_put` — the
   marklogic-fasttrack skill covers authoring it), then
2. call `ml_search` with `q` for the free text, `options=<set-name>`, and a
   `structured_query` whose `range-constraint-query` clauses reference the constraint
   names. The REST layer ANDs `q` with the structured query.

When composing the raw `/v1/search` REST body instead (no persisted options), everything
goes in one **combined query** — POST with `Content-Type: application/json`, body root
`search`:

```json
{ "search": {
    "qtext": "diabetes",
    "query": { "and-query": { "queries": [
      { "range-constraint-query": { "constraint-name": "plan",   "value": ["Managed Care"] } },
      { "range-constraint-query": { "constraint-name": "county", "value": ["Albany"] } }
    ] } },
    "options": {
      "constraint": [
        { "name": "plan",   "range": { "type": "xs:string", "json-property": "planName", "facet": true } },
        { "name": "county", "range": { "type": "xs:string", "json-property": "county",   "facet": true } }
      ],
      "return-facets": true,
      "sort-order": [ { "direction": "descending", "json-property": "enrollmentDate", "type": "xs:date" } ]
    }
} }
```

Rules that make or break this shape:

- **Free text goes in `search.qtext`**, not improvised as a query object under `query`.
  `qtext` is parsed with the search grammar and ANDed with `query`; a free-text object
  misplaced inside `query` is one of the shapes that gets silently ignored (below).
- **`range-constraint-query` resolves by name** against a `constraint` defined in the
  same body's `options` (or in the persisted set named by `?options=`). A filter whose
  `constraint-name` matches nothing does not filter.
- **Every `range` constraint needs a range index** on the property — for both the
  filtering and the facet counts. If the index was created with a non-default collation,
  the constraint must state the same `collation`, or resolution fails as if the index
  were missing.
- `sort-order` on a property also needs a range index; to sort by relevance use
  `{ "direction": "descending", "score": null }`.

### A query MarkLogic can't interpret matches everything, silently

`/v1/search` does not reject unrecognised query JSON. Keys the parser does not expect at
a given position are ignored, and what remains after ignoring them can be an empty
query — which matches **every document in scope**. A misnested body therefore looks
exactly like a working, filtered query until you read `total`.

Sanity-check every new query shape before trusting it:

1. Run it and note `total`.
2. Run it again with the filter removed (or against `q="*"`).
3. If the totals are equal, the filter was ignored — fix the shape; do not build on it.

A "filtered" query whose `total` equals the whole corpus count is the signature of this
failure, not a coincidence.

## Projection and inline aggregation

`ml_search` can return field values directly, avoiding follow-up `ml_document_get` calls.

- `select_fields=['declarationTitle','incidentType','state']` — project those fields into
  each result row. Paths support dot navigation (`envelope.instance.id`) and a leading
  `*` for recursive search at any depth (`*.declarationTitle`).
- `distinct='declarationTitle'` — one row per distinct value with its document count.
- `group_by='incidentType'` + `count=true` — frequency table over matched documents.
- `normalize_whitespace=true` — collapse whitespace runs before grouping or projection.
- `response_mode='inline_summary'` (default) — keeps chat-scale answers inline.

Server-side snippets via the `options` parameter still work, but `select_fields` is
preferred for ad-hoc questions because it needs no pre-deployed search-options node.

## Choosing projection vs a dedicated tool

- One-off field extraction alongside results → `select_fields`
- Distinct values / counts as the *primary* answer → `ml_values_query` (needs a range
  index, but is far cheaper than paging)
- Facet counts beside results → `ml_facets_query`
- GROUP BY across joined entities → `ml_optic_query` over a TDE view
