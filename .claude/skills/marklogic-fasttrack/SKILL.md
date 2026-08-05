---
name: marklogic-fasttrack
description: Build a MarkLogic FastTrack search UI — designing the search options set that drives facets, timelines, and maps, and scaffolding the React app that consumes it. Use when configuring search options for a faceted UI, adding facet or date-bucket or geospatial constraints, deciding between path-index and json-property constraints, debugging XDMP-VALIDATEMISSINGATTR on buckets, or setting up the FastTrack React components against a MarkLogic REST server. Covers the ml_search_options_* tools.
---

# MarkLogic FastTrack

FastTrack is a React component library over MarkLogic's Search API. The UI is driven
almost entirely by a **stored search options set** — get that right and the components
mostly configure themselves.

## Order of work

1. **Confirm the indexes exist** (`ml_indexes_list`). Every facet constraint needs one.
2. **Write the search options** and store with `ml_search_options_put`.
3. **Verify server-side** with `ml_search` before touching React.
4. **Scaffold the React app**.

Skipping step 3 is the usual reason a FastTrack UI shows no facets — the options set was
rejected or the index is missing, and the component just renders empty.

## Constraint index rules

**Prefer path indexes.** For JSON content, a `path-index` with path `//fieldName` uses a
range-path-index, creatable via `admin:database-add-range-path-index` through
`ml_eval_xquery`.

**`json-property` is the fallback** — it needs a range-json-property-index, which is only
creatable through the Management API on port 8002.

```json
// string facet
{"name":"field","range":{"type":"xs:string","facet":true,"path-index":{"text":"//field"}}}

// numeric facet
{"name":"field","range":{"type":"xs:decimal","facet":true,"path-index":{"text":"//field"}}}

// date facet (with buckets)
{"name":"field","range":{"type":"xs:date","facet":true,"path-index":{"text":"//field"}}}
```

**Dates stored as ISO strings** (`YYYY-MM-DD`) should use `xs:string`, not `xs:date` —
ISO strings sort chronologically, and this avoids a cast that will fail on any malformed
value.

**Geospatial (map widget)** — a `geo-elem-pair` constraint with parent/lat/lon. Only add
it if the schema actually has geo fields.

## ⚠ Bucket syntax: `name`, not `label`

```json
CORRECT: {"name":"Under 80k","lt":"80000"}
CORRECT: {"name":"80-100k","ge":"80000","lt":"100000"}
WRONG:   {"label":"Under 80k","lt":"80000"}
```

`label` produces `XDMP-VALIDATEMISSINGATTR` and a 400 from the REST API. Every bucket
needs a `name`.

## Options skeleton

```json
{
  "options": {
    "return-results": true,
    "return-facets":  true,
    "return-metrics": false,
    "extract-document-data": {
      "selected": "include",
      "extract-path": ["/field1", "/field2"]
    },
    "constraint": [
      /* one entry per facet — only for fields with a confirmed range index */
    ]
  }
}
```

`extract-document-data` is what puts field values in the result rows, so the UI does not
have to fetch each document separately. List exactly the fields the result cards render.

## Verifying before React

```
ml_search(q="", options="<options-name>", collection="<collection>", page_length=3)
```

Check that facets come back populated and that the extracted fields are present. If
facets are empty, the constraint's index is missing — go back to `ml_indexes_list`.

## React scaffold

```
npm i @progress/marklogic-fasttrack
```

Wire `MarkLogicContext` with the connection props, then point each component at the
stored options set by name — `SearchBar`, `FacetFilters`, `ResultsList`, and optionally
`Timeline` and `Map`. Every component takes `optionsName="<options-name>"`, which is why
the options set is the real configuration surface.

Be conservative about which widgets you enable: a `Timeline` needs a date constraint with
buckets, and a `Map` needs the `geo-elem-pair` constraint. Enabling either without its
constraint renders an empty widget rather than an error.

## Tools

| Tool | Use |
|---|---|
| `ml_search_options_list` | what option sets already exist |
| `ml_search_options_get` | read one back — useful for diffing after a failed put |
| `ml_search_options_put` | store the set (write-gated by `ML_READONLY`) |
| `ml_search_options_delete` | remove |

For anything that must survive a rebuild, keep the options set in an ml-gradle project
under `src/main/ml-modules/options/` rather than storing it ad hoc — see the
**marklogic-project-setup** skill.

## Further reading

The options set matters more than the widgets — most FastTrack problems are constraint
definitions, not React:

- [Query Options Reference (12)](https://docs.progress.com/bundle/marklogic-server-use-search-12/page/topics/appendixa.html)
  — every constraint type and bucket attribute, including the `ge`/`lt` pair whose
  omission causes `XDMP-VALIDATEMISSINGATTR`
- [Search Customization Using Query Options (12)](https://docs.progress.com/bundle/marklogic-server-use-search-12/page/topics/query-options.html)
- [Browsing With Lexicons (12)](https://docs.progress.com/bundle/marklogic-server-use-search-12/page/topics/lexicon.html)
  — why every facet needs a range index or lexicon behind it

FastTrack itself:

- [FastTrack widgets](https://docs.progress.com/bundle/marklogic-fasttrack-develop-with-fasttrack-1/page/topics/fasttrack-widgets.html)
  — `SearchBox`, `StringFacet`, `BucketRangeFacet`, `DateRangeFacet`, and friends
- [Add the FastTrack UI widgets](https://docs.progress.com/bundle/marklogic-fasttrack-develop-with-fasttrack-1/page/topics/create-a-search-application/add-the-fasttrack-ui-widgets.html)
- [UI Tier: React](https://docs.progress.com/bundle/marklogic-fasttrack-develop-with-fasttrack-1/page/topics/set-up-a-three-tiered-application/ui-tier--react.html)
  — the three-tier layout (MarkLogic / Node Express / React) the scaffolding assumes
- [AISummary widget (3.0)](https://docs.progress.com/bundle/marklogic-fasttrack-develop-with-fasttrack-3.0/page/topics/fasttrack-widgets/aisummary.html)
- [Crime Map AI example app](https://docs.progress.com/bundle/marklogic-fasttrack-develop-with-fasttrack/page/topics/fasttrack-example-applications/crime-map-ai.html)
  — a worked faceted-search-plus-RAG application
