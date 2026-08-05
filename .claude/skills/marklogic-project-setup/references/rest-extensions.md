# REST extensions, transforms, and search options

Three things extend the MarkLogic REST API, and they are frequently confused:

| Kind | Lives at | Deployed from | Invoked as |
|---|---|---|---|
| **Resource extension** | `/v1/resources/<name>` | `src/main/ml-modules/services/<name>.sjs` | `GET /v1/resources/<name>?rs:p=v` |
| **Transform (CTF)** | applied to any REST read/write | `src/main/ml-modules/transforms/<name>.sjs` | `?transform=<name>&trans:p=v` |
| **Search options** | named query configuration | `src/main/ml-modules/options/<name>.xml` | `?options=<name>` |

A resource extension is a **new endpoint**. A transform **modifies documents flowing
through an existing endpoint**. If you find yourself writing a resource extension whose
only job is to reshape a document on read or write, you want a transform.

---

## Resource extension contract

Export one function per HTTP method you support. The names are case-sensitive on the
export and MarkLogic looks for uppercase:

```javascript
'use strict';

// GET  /v1/resources/items?rs:category=books
function get(context, params) {
  context.outputTypes = ['application/json'];
  return { items: [] };
}

// POST /v1/resources/items   (body arrives as `input`)
function post(context, params, input) {
  context.outputTypes = ['application/json'];
  const body = input.toObject();     // input is a Node, not a string
  return { created: body.id };
}

exports.GET = get;
exports.POST = post;
exports.PUT = put;         // (context, params, input)
exports.DELETE = del;      // (context, params)
```

| Argument | What it is |
|---|---|
| `context` | Request/response metadata. Set `context.outputTypes` before returning. Read `context.inputTypes`, `context.acceptTypes`. |
| `params` | Query params as a plain object, **keys still carrying the `rs:` prefix** |
| `input` | Request body as a `Node` (POST/PUT only). `.toObject()` for JSON, `.root` for XML. Absent for GET/DELETE. |

### Return values

- A plain JS object → serialized as JSON. Set `context.outputTypes = ['application/json']`.
- A `Node` (from `xdmp.toJSON`, `xdmp.unquote`, or a document) → returned as-is.
- A `Sequence` of nodes → returned as a `multipart/mixed` response; `outputTypes` must
  then have one entry **per part**.
- Nothing → 204 No Content.

`outputTypes` length must match the number of returned items. A single object with a
two-entry `outputTypes` produces `RESTAPI-INVALIDCONTENT`.

### The `rs:` prefix

Custom parameters must be prefixed `rs:` **on the wire**, and the prefix is still present
in the `params` object your handler receives:

```javascript
const category = params['rs:category'];   // not params.category
```

Calling without the prefix returns:

```
REST-UNSUPPORTEDPARAM: invalid parameters: category for items
```

The `services/metadata/<name>.xml` file declares parameters *without* the prefix — those
declarations are documentation, surfaced by `GET /v1/config/resources/<name>`. They do not
relax the runtime rule.

`ml_extension_call` adds the prefix automatically, so pass params unprefixed to that tool.

### Errors and HTTP status

A thrown JavaScript error becomes an opaque 500 with no useful body. To control the
status, raise `RESTAPI-SRVEXERR` with a three-item sequence of
`[status, statusMessage, body]`:

```javascript
function get(context, params) {
  const category = params['rs:category'];
  if (!category) {
    fn.error(null, 'RESTAPI-SRVEXERR',
      Sequence.from([400, 'Bad Request', 'rs:category is required']));
  }
  context.outputTypes = ['application/json'];
  try {
    return { items: require('/lib/items-lib.sjs').findByCategory(category) };
  } catch (e) {
    xdmp.log('items GET failed: ' + (e.stack || e.toString()), 'error');
    fn.error(null, 'RESTAPI-SRVEXERR',
      Sequence.from([500, 'Internal Server Error', 'lookup failed']));
  }
}
```

Log the real cause with `xdmp.log` and return a generic message — the body of a
`RESTAPI-SRVEXERR` goes to the client verbatim, so stack traces there leak internals.

### Writes from an extension

`declareUpdate()` cannot be used in a resource extension module — the REST framework owns
the transaction. A POST/PUT handler may call `xdmp.documentInsert` directly and the
enclosing REST request is already an update transaction. If you need update semantics from
a `GET`, that is a design error: use POST.

### Validate input, always

`params` values arrive as strings straight from the caller. Never concatenate them into a
query — bind them. See **marklogic-server-side-code** → `references/coding-practices.md` §1.

---

## Two deploy paths

**ml-gradle (preferred — survives a rebuild).** Two files, side by side:

```
src/main/ml-modules/services/items.sjs
src/main/ml-modules/services/metadata/items.xml
```

`gradle mlLoadModules` (or `mlReloadModules`) deploys both. **A resource extension without
its `services/metadata/<name>.xml` deploys the module but never registers the endpoint —
the symptom is a 404 at `/v1/resources/<name>` after an apparently successful deploy.**
This is the single most common ml-gradle REST-extension failure.

**MCP write tool (ad-hoc, leaves nothing on disk).** `ml_extension_put` PUTs source to
`/v1/config/resources/<name>`, which writes three files into the modules database:

```
/marklogic.rest.resource/<name>/assets/metadata.xml   — declares source-format
/marklogic.rest.resource/<name>/assets/resource.sjs   — your handler
/marklogic.rest.resource/<name>/assets/resource.xqy   — auto-generated stub
```

The `source-format` field in that generated `metadata.xml` decides which of the two asset
files MarkLogic loads. Let the REST endpoint manage all three — writing them by hand with
`ml_document_put` produces an extension that lists but does not execute.

The two paths write to different URIs and can shadow each other. If an extension behaves
like an older version after a gradle deploy, check for a leftover
`/marklogic.rest.resource/<name>/` tree from an earlier `ml_extension_put`, and delete it
with `ml_extension_delete`.

---

## Transforms

```javascript
'use strict';
function transform(context, params, content) {
  const doc = content.toObject();
  doc.envelope = doc.envelope || {};
  doc.envelope.ingested = fn.currentDateTime();
  return doc;
}
exports.transform = transform;
```

- Custom params use the `trans:` prefix on the wire (`?transform=stamp&trans:src=api`).
- `context.acceptTypes` / `context.inputTypes` tell you the direction; the same transform
  can run on read and on write.
- Return a plain object or Node. Returning `content` unchanged is a valid no-op.
- Metadata lives at `src/main/ml-modules/transforms/metadata/<name>.xml` — unlike resource
  extensions, a transform **works without** its metadata file; the metadata only feeds
  `GET /v1/config/transforms`.
- Flux and CTF transforms are a different signature — see
  **marklogic-server-side-code**.

---

## Testing an extension

```bash
# digest auth is the default for the REST app server
curl -u admin:admin --digest \
  "http://localhost:8010/v1/resources/items?rs:category=books"

# a POST with a JSON body
curl -u admin:admin --digest -X POST \
  -H "Content-Type: application/json" -d '{"id":"i-1"}' \
  "http://localhost:8010/v1/resources/items"
```

From this MCP server: `ml_extension_list` to confirm registration, `ml_extension_get` to
read back what is actually deployed (not what you think you deployed), `ml_extension_call`
to invoke it. For repeatable assertions, write a marklogic-unit-test suite instead — see
`references/gradle-tasks.md`.

---

## Failure table

| Symptom | Cause |
|---|---|
| 404 at `/v1/resources/<name>` after deploy | missing `services/metadata/<name>.xml` |
| `REST-UNSUPPORTEDPARAM: invalid parameters: x` | param sent without the `rs:` prefix |
| `RESTAPI-INVALIDCONTENT` | `context.outputTypes` length ≠ number of returned items |
| Handler never runs, no error | exported `get` instead of `GET` |
| Opaque 500, empty body | JS error thrown instead of `fn.error(RESTAPI-SRVEXERR)` |
| `XDMP-UPDATEFUNCTIONFROMQUERY` | `declareUpdate()` in an extension module |
| Old behaviour after gradle deploy | stale `/marklogic.rest.resource/<name>/` from `ml_extension_put` |
| `input` is `undefined` | reading the body in a `GET` handler |
| `SEC-PRIV` calling the endpoint | caller lacks `rest-extension-user`, or module permissions omit `rest-extension-user,execute` |
