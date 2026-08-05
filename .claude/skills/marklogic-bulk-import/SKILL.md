---
name: marklogic-bulk-import
description: Load data into MarkLogic in bulk via the Flux pipeline — from an HTTP/HTTPS URL, local or S3 files, a JDBC database, or RDF files — and reprocess existing documents through server-side transform modules. Use when importing CSV, TSV, JSON, JSONL, Parquet, Avro, ORC, MLCP archives, or RDF; when loading open-data portals (Socrata, GDELT, data.gov); when auto-generating a TDE view at ingest; when classifying documents with Semaphore at ingest time; or when bulk-transforming an existing collection. Covers the flux_import and flux_reprocess tools and their failure modes.
---

# MarkLogic Bulk Import & Reprocess

Flux is the first-choice path for any bulk or URL-based load. Prefer it over
`ml_eval_javascript` (≈10 KB payload cap, no parallelism) and `ml_document_put`
(one document at a time) for anything beyond ~5–10 documents.

## Choosing the subcommand

| Source | `subcommand` |
|---|---|
| CSV / TSV / delimited | `import-delimited-files` |
| Individual JSON or XML files (one file → one document) | `import-files` |
| A JSON file containing an array of records, **or** JSONL | `import-aggregate-json-files` |
| Parquet / Avro / ORC | `import-parquet-files` / `import-avro-files` / `import-orc-files` |
| Relational database | `import-jdbc` |
| MLCP archive | `import-mlcp-archive` |
| Turtle / N-Triples / JSON-LD / RDF-XML | `import-rdf-files` |

`import-files` does **not** parse JSONL — each line would be treated as a separate
file path. Multi-record JSON always uses `import-aggregate-json-files`.

## Canonical recipes

**1. CSV from a public URL with auto-TDE (most common)**
```
subcommand="import-delimited-files", http_url="https://example.com/data.csv",
collections=["my-data"], generate_tde=true, tde_schema="myschema", tde_view="myview"
```

**2. Socrata open data** — use the *resource* API, not the bulk export:
```
a) subcommand="import-delimited-files", http_url="https://data.wa.gov/resource/abc.csv?$limit=50000"
b) subcommand="import-files",           http_url="https://data.wa.gov/resource/abc.json?$limit=50000"
```
See `references/socrata-and-open-data.md` before using any `/rows.*` endpoint.

**3. Headerless CSV (e.g. GDELT events)**
```
subcommand="import-delimited-files", http_url="https://...",
column_names=["Col1","Col2",...], extra_args=["--delimiter","\t","--ignore-null-fields"]
```

**4. JDBC**
```
subcommand="import-jdbc", jdbc_url="jdbc:postgresql://host/db",
jdbc_driver="org.postgresql.Driver", query="SELECT * FROM mytable",
collections=["my-data"], generate_tde=true
```
The driver JAR must be on the flux-runner classpath.

**5. S3**
```
subcommand="import-files", path="s3a://my-bucket/data/", collections=["my-data"]
```

**6. RDF into a named graph**
```
subcommand="import-rdf-files", http_url="https://example.org/data.ttl",
extra_args=["--graph","http://example.org/mygraph"]
```
`generate_tde` does not apply to RDF imports. For a small RDF string (< ~1 MB), use
`ml_graph_put` instead of Flux.

**7. JSON array or JSONL**
```
a) array at root:  subcommand="import-aggregate-json-files", http_url="https://example.com/records.json"
b) JSONL:          subcommand="import-aggregate-json-files", path="/tmp/data.jsonl",
                   extra_args=["--json-lines"], uri_template="/data/{id}.json"
```
If the API wraps records in an object (`{"results":[...]}`), read
`references/jsonl-and-api-wrappers.md` first — this is the most common silent failure.

**8. Classify at ingest with Semaphore**
```
Add to any recipe: classify_with_semaphore=true
Scope it:          classifier_publish_sets=["iptcmediatopics","unescothesaurus"]
```
Verify reachability with `semaphore_status` and list taxonomies with
`semaphore_publish_sets` first. See `references/semaphore-at-ingest.md` for the output
structure and the META array-vs-object trap.

**9. Locally-generated data (synthetic loads, script output)**
Do not use `docker cp` or `local_file`. Serve it over HTTP:
```
python3 -m http.server 19999 &        # in the directory holding the file
flux_import(http_url="http://localhost:19999/data.jsonl", ...)
```
The runner intercepts `--http-url` (a runner extension, not a Flux CLI flag — it will
not appear in `flux_help` output), downloads to `/tmp`, and passes `--path` to Flux.

## Path and file-access rules

- **`http_url` is the most reliable source.** The URL must be reachable from the
  flux-runner host, not your machine. `.gz` passes through to Spark; `.zip` is
  extracted by the runner and the directory is passed as `--path`.
- **`path` volume-mount caveat.** Files mounted into the runner container may not be
  visible to Flux — the runner spawns Flux as a Spark subprocess that does not inherit
  the same filesystem context, producing `PATH_NOT_FOUND` even when `docker exec ls`
  finds the file. Use `path` for S3 URIs and files baked into the image; otherwise use
  `http_url`.
- **`local_file` means the MCP server host** — not your laptop, not the runner. Files
  written by shell commands land on the host, not inside the MCP server container.

## URI templates

Template variables must exactly match source field names. Field names containing
spaces (`State Abbreviation`) silently produce malformed URIs — rename them via
`column_names` first, or omit `uri_template` and accept generated URIs.

With `import-files`, template variables resolve from *file* metadata (`{filename}`,
`{filepath}`), **not** from fields inside the JSON content. To build URIs from a
document field, use `extra_args: ["--uri-replace", ".*/source-dir/","'/target-prefix/'"]`.

## Permissions

Comma-separated `role:capability` pairs. Valid capabilities are lowercase:
`read`, `insert`, `update`, `execute`, `node-update`.

## Reprocessing existing documents

For bulk server-side transforms use `flux_reprocess`, not `ml_invoke_module` — a single
`xdmp.invoke` transaction times out past ~1,000 documents. The two-phase module pattern,
the `declareUpdate()` placement trap, and the silent-no-op warning for outbound HTTP are
in `references/reprocess-transforms.md`. Read it before writing a transform module.

## Verifying a load

`Success count: N` means N invocations returned without throwing — it does **not**
guarantee N documents changed. Always spot-check with `ml_document_get` on 1–2 URIs,
and confirm counts with `ml_search` or `ml_values_query`.

## Further reading

Flux is documented separately from MarkLogic Server and is **not** on docs.progress.com
— look for it on GitHub Pages:

- [MarkLogic Flux overview](https://marklogic.github.io/flux/)
- [Getting started](https://marklogic.github.io/flux/getting-started.html) — command
  structure, and `flux help <command>` for per-command options
- [Common options](https://marklogic.github.io/flux/common-options.html) — the
  connection options every command shares
- [Common import features](https://marklogic.github.io/flux/import/common-import-features.html)
  — URI templates, collections, permissions, batch sizing
- [Importing RDF](https://marklogic.github.io/flux/import/import-files/rdf.html) — the
  `--graph` option used above

For comparison with existing scripts built on the older tool this server does not wrap,
see [Introduction to MarkLogic Content Pump (11)](https://docs.progress.com/bundle/marklogic-server-use-mlcp-11/page/topics/introduction-to-marklogic-content-pump.html).
