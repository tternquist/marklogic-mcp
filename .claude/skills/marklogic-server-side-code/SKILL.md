---
name: marklogic-server-side-code
description: Write server-side MarkLogic code — SJS and XQuery modules, REST resource extensions, Content Transformation Framework transforms, Flux reader and transform modules, and TDE templates — and apply MarkLogic application coding practices to them. Use when generating or debugging a module to deploy to the Modules database, building a custom REST endpoint, writing a bulk transform, or authoring a TDE JSON template. Also use when a module takes caller input, writes documents, needs elevated privileges, or must be tested: covers parameterizing queries with bindings instead of string concatenation, xdmp.eval vs invokeFunction vs spawn, amps for privilege escalation, the 600-second transaction limit and spawn-batching, explicit permissions and collections on insert, RESTAPI-SRVEXERR error handling, and marklogic-unit-test suites. Covers module signatures per type, the declareUpdate() placement trap, and the TDE syntax rules behind TDE-INVALIDTEMPLATEPROPNODE and TDE-INVALIDTEMPLATENODEVAL errors.
---

# MarkLogic Server-Side Code

## Module type → signature

| Type | Shape |
|---|---|
| **Library** | `module.exports = {...}` or `exports.fn = …` |
| **REST resource extension** | export `GET` / `PUT` / `POST` / `DELETE`, each `(context, params, input)` |
| **REST transform (CTF)** | export a transform function `(content, context)` |
| **Flux reader** (phase 1) | returns a Sequence/Array of URI strings — **no** `declareUpdate()` |
| **Flux transform** (phase 2) | `declareUpdate()` first, `var URI` injected, one output doc per call |
| **Scheduled task** | self-contained script; `declareUpdate()` if it writes |

Universal conventions: `'use strict';` at the top, `xdmp.log()` for server-side logging,
`cts.search()` rather than `fn.doc()` for retrieval, `try`/`catch` around fallible work,
and JSDoc on exported functions.

## Application coding practices

`references/coding-practices.md` covers the practices that decide whether a module is
production-grade, with worked examples:

1. **Never concatenate untrusted input into a query string** — bind instead
   (`sem.sparql` bindings map, `cts.parse` constraint bindings, `xdmp.eval` external
   variables), and prefer `cts` constructors over any string grammar.
2. **`xdmp.eval` is almost never right** — `require()`, `xdmp.invokeFunction`,
   `xdmp.invoke`, and `xdmp.spawn`, and when each applies.
3. **Amps, not broad roles**, for privilege escalation — including the SJS namespace rule
   that makes amps fail silently.
4. **Transaction discipline** — the 600 s timeout, why a query transaction cannot read its
   own writes, and the spawn-batching pattern.
5. **Writes carry permissions and collections explicitly.**
6. **Error handling that reaches the caller** — `fn.error` with `RESTAPI-SRVEXERR`.
7. **Testing** with marklogic-unit-test rather than ad-hoc eval calls.

Read it before generating any module that takes caller input, writes documents, or is
deployed behind a REST endpoint.

## Flux modules — always two, never one

A monolithic script that queries everything and iterates in one transaction hits the
600 s transaction timeout past ~1,000 documents and cannot use Flux's parallel threads.
The two-module split is the only thing that scales.

**Phase 1 — reader** (`--read-invoke`). Read-only, returns the URI list as the last
expression. Do not `forEach` over it.

```javascript
'use strict';
// No declareUpdate() — read-only collector
var GRAPH = 'http://example.org/graph';
var rows = sem.sparql(
  'SELECT DISTINCT ?s FROM NAMED <' + GRAPH + '> WHERE { GRAPH <' + GRAPH + '> { ?s a ?type } }'
);
Array.from(rows).map(function (r) { return String(r.s); });
```

Keep it lightweight — `SELECT DISTINCT ?subject` only, no optional predicates.

**Phase 2 — transform** (`--write-invoke`). One URI per invocation; scope every query to
that single URI.

```javascript
'use strict';
declareUpdate();          // FIRST statement — see the trap below
var URI;                  // injected by Flux via --external-variable-name URI
(function run() {
  var doc = cts.doc(URI).toObject();
  if (!doc) { return; }   // bare return needs the IIFE
  xdmp.documentInsert(URI, doc, {
    permissions: xdmp.documentGetPermissions(URI),
    collections: Array.from(xdmp.documentGetCollections(URI)),
  });
})();
```

### ⚠ `declareUpdate()` placement

It must be the first statement in the file, before any function or IIFE. Inside an IIFE
it compiles cleanly but the transaction is never marked as an update, and every
`xdmp.documentInsert()` **silently does nothing**.

```javascript
WRONG:   (function run() { declareUpdate(); ... })();
CORRECT: declareUpdate(); (function run() { ... })();
```

Other constraints: top-level bare `return` is a SyntaxError in strict-mode SJS — wrap in
an IIFE. Declare `var URI` at module top level, not inside the IIFE, and never use
`external.URI` (it throws `ReferenceError` under `xdmp.invoke()`).

More on testing and the outbound-HTTP no-op in the **marklogic-bulk-import** skill.

## Never write `""` for an unbound value

When building entity documents from SPARQL results, an unbound optional variable must
not become an empty string — it pollutes indexes, breaks range queries, and creates
misleading TDE rows.

```javascript
WRONG:   broaderUri: row.broader || ''
CORRECT: if (row.broader) doc.broaderUri = row.broader;   // omit the key
CORRECT: broaderUri: row.broader ?? null
```

Mark TDE columns backed by optional predicates `"nullable": true`.

## TDE templates

Deploy with `ml_tde_install`, or `ml_document_put` with `database='Schemas'`. A URI
starting `/tde/` joins the TDE collection automatically. Always follow with
`ml_tde_validate` — a template installs successfully even when it extracts zero rows.

Basics: a `context` matching the document structure, a `schemaName` + `viewName`, columns
mapped to `string`, `long`, `double`, `dateTime`, `date`, `boolean`, or `anyURI`,
`nullable: true` for optional fields, `object-node()` paths for nested objects, and a
separate row-level template for arrays.

### Three syntax rules that cause `TDE-INVALIDTEMPLATEPROPNODE`

**1. Triples use `val`, never `column`.**
```json
WRONG:   { "subject": { "column": "movieIRI" } }
CORRECT: { "subject": { "val": "sem:iri(fn:concat('http://example.org/movie/', id))" } }
```

**2. Parent-axis navigation (`../id`) does not work in JSON sub-templates.** Use
`fn:root()`.
```json
WRONG:   { "val": "fn:concat('http://example.org/', ../id)" }
CORRECT: { "val": "fn:concat('http://example.org/', fn:root()/rootElement/id)" }
```

**3. `scalarType: "IRI"` is not a valid row column type.** Use `string` for URI columns
and build IRIs only in the triples section via `sem:iri()`.
```json
WRONG:   { "name": "movieUri", "scalarType": "IRI" }
CORRECT: { "name": "movieId",  "scalarType": "string" }
```

### Vector columns

`"scalarType": "vector"` with `"val": "array-node('embedding')"` and an explicit
`"dimension"`. The full spec and its four failure modes are in the **marklogic-rag**
skill.

### Classified documents

For one row per (document × category) from Semaphore output, set
`context: 'classification/STRUCTUREDDOCUMENT/META'` and navigate up four levels for
parent fields. Details in **marklogic-bulk-import**.

## Deploying

- Modules database → `ml_document_put(database="Modules")`, URIs ending `.sjs` / `.xqy`
- Schemas database → `ml_document_put(database="Schemas")` or `ml_tde_install`
- REST extensions → `ml_extension_put`, or ml-gradle with a
  `services/metadata/<name>.xml` alongside the module

For anything that must survive a rebuild or reach another environment, put the modules
in an ml-gradle project instead — see the **marklogic-project-setup** skill.

## REST extensions and transforms

The full contract — method exports, `context.outputTypes`, the `rs:` / `trans:` prefix
rules, `RESTAPI-SRVEXERR` status control, why `declareUpdate()` is forbidden in an
extension, the two deploy paths and how they shadow each other — is in the
**marklogic-project-setup** skill's REST-extensions reference.
