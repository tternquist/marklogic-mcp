---
name: semaphore-integration
description: Architect a Semaphore + MarkLogic content-classification integration, and know how Semaphore is reached in the first place — through this MCP server's semaphore_* tools, with semaphore_status (CLS) and semaphore_studio_status (KMM) as the first two calls, and SEMAPHORE_* env vars as MCP server config rather than anything the caller supplies. Use when asked whether Semaphore is available or configured, when planning or wiring up Semaphore against MarkLogic, and when choosing between inline classification at ingest, post-ingest reprocess enrichment, a REST transform, or a full Data Hub Framework pipeline. Covers CLS and KMM configuration and connectivity checks, the canonical document model for storing categories, a production SJS enrichment module with the xdmp.httpPost body-Node requirement and CLS response parsing, path range indexes for classification facets, and Kubernetes network constraints. Not for tuning classification quality.
---

# Semaphore + MarkLogic Integration

## Using Semaphore via MCP

Semaphore is reached through this MCP server's `semaphore_*` tools — the same server
that carries the `ml_*` MarkLogic tools. There is no separate client to install, no
SDK, and no host, port, or credential for you to supply at call time. If the
`semaphore_*` tools are in your tool list, this server is already the Semaphore client.

**Two first checks, in this order, before any classification or taxonomy work:**

1. **`semaphore_status`** — Classification Server (CLS). Configured? Reachable? Version?
2. **`semaphore_studio_status`** — KMM / Studio. Reachable? Credentials accepted?

Both take no arguments. CLS and KMM are separate services on separate ports with
separate credential paths, so one can be healthy while the other is not — that is
exactly why both get checked. `semaphore_status` healthy while `semaphore_kmm_*` calls
fail is almost always a KMM settings problem, not a CLS problem.

The `semaphore_*` tools are registered whether or not Semaphore is configured — they
return an explicit not-configured error instead of disappearing. So their presence in
the tool list is not evidence of connectivity, and nothing in the tool list is evidence
of its absence. **Only `semaphore_status` answers the question.** Never tell a user
Semaphore is unavailable, or that they need to set it up, without calling it first.

### `SEMAPHORE_*` variables are server config, not caller parameters

`SEMAPHORE_HOST`, `SEMAPHORE_SCS_PORT`, `SEMAPHORE_KMM_PORT`, `SEMAPHORE_USERNAME`,
`SEMAPHORE_PASSWORD`, `SEMAPHORE_URL`, and `SEMAPHORE_SSL` are read **once, by the MCP
server process, from its own `.env`**, at startup. They are the operator's
configuration. Consequences for you:

- Do not ask the user to export them in their own shell — nothing reads them there.
- Do not read them from the environment and hand-build an HTTP call to the CLS or KMM.
- Do not `curl` the CLS or KMM directly, even as a "quick connectivity check".
  `semaphore_status` and `semaphore_studio_status` *are* the connectivity check.
- When a tool reports "not configured", the fix is an edit to the MCP server's `.env`
  and a server restart. Report that; do not work around it.

The one place these values legitimately appear in your output is Flux's classifier
flags (`--classifier-host` / `--classifier-port`), because the Flux runner is a separate
process that dials the CLS itself. Prefer `flux_import(classify_with_semaphore=true)`,
which fills them in from the server's own config.

## Choose a pattern

| Pattern | How it works | Best for |
|---|---|---|
| **A. Ingest + classify** *(preferred for new pipelines)* | Flux calls the CLS inline via `--classifier-*` flags; categories written at ingest | new data pipelines; no raw/enriched split needed |
| **B. Reprocess + enrich** | Documents already loaded; an SJS transform calls the CLS via `xdmp.httpPost()` and patches each doc, parallelised by Flux | legacy data; adding Semaphore to an existing deployment |
| **C. Transform on ingest** | A REST transform maps raw→canonical *and* classifies in one step; Flux passes `--transform <name>` | simultaneous mapping and classification |
| **D. DHF pipeline** | Ingestion → Mapping → custom Semaphore step → optional Mastering | multiple sources; STAGING/FINAL split; entity mastering |

**Default to Pattern A.** It runs outside MarkLogic, so it sidesteps the outbound-HTTP
restrictions that make B fragile (see the network note below).

## Configuration reference (for whoever runs the MCP server)

Use this when a status check comes back "not configured" and you need to tell the
operator exactly what to put in the server's `.env`.

**CLS (Classification Server)** — required for classification:
- `SEMAPHORE_HOST`, optionally `SEMAPHORE_SCS_PORT` (default 5058)
- or `SEMAPHORE_URL=http://<host>:<port>` for an explicit override
- no authentication by default
- verify with `semaphore_status`

**KMM (Knowledge Model Manager / Studio)** — required for taxonomy authoring:
- `SEMAPHORE_USERNAME` and `SEMAPHORE_PASSWORD` — KMM uses **Java EE form auth**, not
  Basic auth, so these are a separate credential path from the CLS
- `SEMAPHORE_KMM_PORT` (default 5080)
- verify with `semaphore_studio_status`

If `semaphore_classify` works but `semaphore_kmm_*` fails, the problem is almost always
these KMM-specific settings, not the CLS.

## Discovery before designing

1. `semaphore_publish_sets` — which taxonomy rule sets are loaded and active in the CLS
2. `semaphore_classes` — classification class names (taxonomy domain names)
3. `semaphore_classify` with a sample snippet and `threshold=0` — validate real output

If no rule sets are loaded, use `semaphore_kmm_model_create` + `semaphore_kmm_skos_load`
to import a vocabulary, then publish. The full authoring workflow — including the
mandatory SKOS-XL reification step — is in the **semaphore-taxonomy** skill.

## Pipeline recipes

**Pattern A** — via the `flux_import` tool, prefer the first-class parameters over raw
flags:
```
flux_import(subcommand="import-files", http_url="<source>",
            collections=["<type>-raw"],
            classify_with_semaphore=true,
            classifier_publish_sets=["<set>"])
```
The equivalent manual form is
`extra_args: ["--classifier-host","<host>","--classifier-port","<port>","--classifier-path","/","--classifier-http"]`.

**Pattern B**:
```
flux_reprocess(collections=["<existing>"], invoke_module="/transforms/enrich-with-semaphore.sjs",
               thread_count=4, batch_size=50)
```

## Canonical document model

Store classification alongside content, not in a separate document:

```json
{
  "id": "<source-id>",
  "title": "...",
  "body":  "...",
  "semaphore": {
    "classifiedAt": "<timestamp>",
    "classifiedBy": "flux-import",
    "clsHost":      "<host>",
    "threshold":    48,
    "categoryCount": 3,
    "categories": [
      { "className": "IPTC-MediaTopics", "label": "Sport",    "id": "...", "score": 0.875 },
      { "className": "IPTC-MediaTopics", "label": "Football", "id": "...", "score": 0.721 }
    ],
    "topCategory": { "className": "IPTC-MediaTopics", "label": "Sport", "id": "..." }
  }
}
```

Collections: one per content type, **plus** a `semaphore-classified` collection after
enrichment so you can scope queries to what has actually been processed. Permissions:
`rest-reader:read`, `rest-writer:update` minimum.

Note that Flux's own inline classification writes a different shape —
`classification.STRUCTUREDDOCUMENT.META` — documented in the **marklogic-bulk-import**
skill. Normalise to the model above in a later step if you want one consistent schema.

## The enrichment module (Pattern B)

Full production module in `references/enrichment-module.md`. Three things that are easy
to get wrong:

1. **`xdmp.httpPost()` arg 3 must be a Node, not a string.** Wrap with
   `fn.head(xdmp.unquote(bodyStr, null, ['format-text']))`.
2. **The CLS takes a URL-encoded form POST to `/`**, not JSON:
   `body=<urlencoded>&threshold=<int>&singlearticle=1`.
3. **Two different score scales.** The `threshold` you *send* is a 0–100 integer; the
   `score` you *get back* is a 0.0–1.0 float. Do not divide the response by 100.

Filter out the `Type` and `Template` META entries — they are metadata, not concepts.

### ⚠ Kubernetes network note

`xdmp.httpPost()` from MarkLogic pods is frequently blocked by network policy from
reaching the CLS, surfacing as `SVC-SOCCONN`. When that happens, switch to **Pattern A**
(the Flux classifier flags run outside MarkLogic), or pre-classify from the application
/ MCP tier and write results back with `ml_document_patch`.

This is the main reason Pattern A is the default recommendation.

## Indexing for facets

To expose categories as search facets and range-query targets, add a **path range index**
on the category label path — for the model above,
`/semaphore/categories/label` (string) — via `content-database.json` in ml-gradle so it
survives a rebuild.

Then `ml_facets_query` and `ml_values_query` work against it directly. Without the range
index those tools return empty rather than erroring.

For a TDE view with one row per (document × category), see the classified-document TDE
context in **marklogic-bulk-import**.

## Related skills

- **semaphore-taxonomy** — authoring, loading, and publishing the model
- **semaphore-classification-tuning** — when results are wrong rather than absent
- **marklogic-bulk-import** — Flux inline classification output shape and TDE
