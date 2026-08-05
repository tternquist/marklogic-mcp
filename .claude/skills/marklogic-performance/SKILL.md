---
name: marklogic-performance
description: Diagnose and fix MarkLogic performance problems — slow searches, slow Optic or SPARQL queries, timeouts, high memory use, and ingest or merge trouble. Covers the E-node/D-node split, the two-step filtered-search process, cache interpretation, when a range index is mandatory, Optic plan reading, SPARQL join cost, and forest health thresholds. Use when a query is slow or times out, when interpreting ml_profile_query or ml_explain_optic output, when forests show high stand or fragment counts, or when deciding whether a range index will help.
---

# MarkLogic Performance

## Architecture in one paragraph

**E-nodes** (Evaluator) parse requests, execute XQuery/SJS, and do filtering,
snippeting, and **all SPARQL joins**. **D-nodes** (Data Manager) store data and indexes,
resolve indexes, read from disk, and run background merges. A combined node does both.
Around 16+ nodes, separate E and D for analytics workloads.

## The two-step search process — the usual culprit

1. **Index resolution** (D-nodes) → candidate fragment IDs from indexes.
2. **Filtering** (E-nodes) → load each candidate document and verify the full match.

`cts:search` runs **filtered by default**. When a query is fully backed by range and word
indexes, add the `"unfiltered"` option and step 2 disappears.

Diagnostics:
- `ml_profile_query` → `filterMisses > 0` means step 2 is doing real work.
- `cts:contains(result, query)` returns false for a false positive — a quick way to
  measure the false-positive rate directly.

## Reading cache stats

| Cache | Holds | A miss means |
|---|---|---|
| List cache | index term lists (D-node) | disk read during index resolution |
| Compressed tree cache | document bodies (D-node) | disk read during filtering |
| Expanded tree cache | uncompressed doc trees (E-node) | document expansion work |
| Triple cache | triple data for SPARQL | normal on first query |

**Always compare a cold run against a warm run.** Many misses on the first query are
expected; the same misses on repeat runs indicate a structural bottleneck, not startup.

## When a range index is mandatory

- `cts:range-query`, `cts:element-range-query`
- `ORDER BY` in a FLWOR — on the ORDER BY field (last XPath step)
- `ml_values_query`, `ml_facets_query` — range index or element word index
- Optic `ORDER BY` — on the sort column; without one, all documents load to sort

**Missing range index + filtered search is the worst case: a full document scan.**
Run `ml_indexes_list` before writing any range-dependent query.

## Optic rules

`ml_explain_optic` shows the plan. Read the node types:

| Node | Meaning |
|---|---|
| `lexicon` / `TemplateLexiconPlan` | index-only — fast, no document expansion |
| `document` / `DocumentPlan` | document expansion needed — acceptable but slower |
| `join` | join between two sources — confirm both have TDE views |

- Push `.where()` **before** `.groupBy()` to cut rows before aggregation.
- `.select()` only the columns you need.
- `.limit(N)` during development prevents accidental full-collection scans.
- `document` nodes with no `limit` is a full-scan risk.

## SPARQL cost

**All SPARQL joins execute in memory on the E-node.** Large joins mean high E-node
memory; production semantics workloads want a minimum of 64 GB on E-nodes.

- Filter by `rdf:type` first — the cheapest triple filter — before traversal predicates.
- Scope with `GRAPH <uri> { … }` so you are not scanning every graph.
- `GROUP BY` and `COUNT` also run on the E-node and need Expanded Tree Cache headroom.

## Forest and ingest health (`ml_forest_metrics`)

| Metric | Threshold |
|---|---|
| Stand count | max 64 per forest — the forest goes unavailable at 64 |
| Fragment count | warn at 96 M per forest; hard limit ~160 M |
| `deletedFragmentPct` | > 20% is significant fragmentation |
| Merge in progress | expected during heavy ingest; high background I/O is normal |

Fragmentation is normal during heavy ingest — background merges reclaim it. After a
**bulk delete**, run `ml_force_merge` to reclaim space before making capacity
projections.

In-memory stand full errors (`XDMP-INMMTREEFULL`, `XDMP-INMMLISTFULL`) mean the
database's in-memory stand settings need raising in the Admin UI.
`background-io-limit = 100` (MB/sec per host) is a reasonable throttle starting point.

## Diagnostic tools — cheapest first

| Tool | Eval? | Gives |
|---|---|---|
| `ml_explain_optic` | no | Optic plan: join strategy, index vs document access |
| `ml_search_query_plan` | no | resolved CTS query, candidate count |
| `ml_forest_metrics` | no | fragment counts, stand count, merge status |
| `ml_profile_query` | **yes** | elapsed time, cache stats, filter activity |
| `ml_force_merge` | **yes** | reclaim space after bulk deletes |

Also useful inside XQuery/SJS:
- `xdmp:plan(search_expr)` — which indexes will be used
- `xdmp:estimate(search_expr)` — fast index-only count, no search execution
- `xdmp:query-trace(true())` — logs searchable/unsearchable steps to `ErrorLog.txt`

## Metric → diagnosis

| Observation | Diagnosis |
|---|---|
| `elapsedMs > 1000` + `filterMisses > 0` | filtered-search bottleneck |
| `elapsedMs > 1000` + `filterMisses = 0` + `listCacheMisses > 0` | cold cache, or index too large |
| `ml_explain_optic` shows `document` nodes, no `limit` | full-scan risk |
| `standCount > 50` | merges falling behind ingest |
| `ml_search_query_plan` total ≫ expected results | query not selective enough |

## Quick wins — no schema change required

1. Add `"unfiltered"` to `cts:search` when the query is fully index-backed.
2. Add a collection scope before field filters — usually the cheapest narrowing there is.
3. Add `.limit(N)` to Optic queries.
4. Push `.where()` before `.groupBy()`.
5. Scope SPARQL with `GRAPH <uri>` and lead with `rdf:type`.

If those do not close the gap, the next step is a schema change — usually adding the
range index the query has been scanning without.

## Further reading

- [Tuning Query Performance in MarkLogic Server (11)](https://docs.progress.com/bundle/marklogic-server-tune-query-performance-11/page/topics/perftune.html)
  — the guide this skill condenses
- [Tuning Queries with query-meters and query-trace (12)](https://docs.progress.com/bundle/marklogic-server-tune-query-performance-12/page/topics/query_meters.html)
  — how to read what `ml_profile_query` returns, including cache hits vs misses
- [Indexing in MarkLogic (12)](https://docs.progress.com/bundle/marklogic-server-understand-concepts-12/page/topics/indexing.html)
- [Understanding Range Indexes (11)](https://docs.progress.com/bundle/marklogic-server-administrate-11/page/topics/range-indexes-and-lexicons/understanding-range-indexes.html)
  — why an inequality without one degrades to a scan
- [Defining Path Range Indexes (11)](https://docs.progress.com/bundle/marklogic-server-administrate-11/page/topics/range-indexes-and-lexicons/defining-path-range-indexes.html)
