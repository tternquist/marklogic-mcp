# MarkLogic application coding practices

Practices that shape module code once you have already decided to write a module. For
which tool to reach for in the first place, see the **marklogic** router skill; for
anything that must survive a rebuild, see **marklogic-project-setup**.

## 1. Never concatenate untrusted input into a query string

Every MarkLogic query language accepts parameter bindings. Concatenation is both an
injection vector and the most common source of opaque parse errors, because a value
containing a quote, angle bracket, or brace produces a syntax error hundreds of
characters from the actual bug.

**SPARQL** — bind, don't interpolate. The second argument to `sem.sparql` is a bindings
map; `?name` in the query resolves against it.

```javascript
WRONG:
  sem.sparql('SELECT ?p WHERE { <' + subjectFromUser + '> ?p ?o }');

CORRECT:
  sem.sparql(
    'SELECT ?p WHERE { ?s ?p ?o }',
    { s: sem.iri(subjectFromUser) }
  );
```

Bindings carry type information, so `sem.iri()`, `xs.dateTime()`, and plain strings each
land as the right RDF term. Concatenation makes everything a lexical guess.

**Named graphs are the exception that catches people.** `FROM NAMED` will not accept a
binding — the graph must be lexically present in the query. Validate the graph IRI
against a known list rather than accepting it from a caller:

```javascript
const GRAPHS = { items: 'http://example.org/items', tags: 'http://example.org/tags' };
const graph = GRAPHS[params['rs:graph']];
if (!graph) { fn.error(null, 'RESTAPI-SRVEXERR', Sequence.from([400, 'Bad Request', 'unknown graph'])); }
```

**cts.parse** — the second argument is a bindings map of tag → constraint reference.
Pass the user's search string as the *first* argument unmodified; never splice it into a
grammar you built yourself.

```javascript
WRONG:   cts.parse('category:' + userValue);
CORRECT: cts.parse(userQueryString, { category: cts.jsonPropertyReference('category') });
```

**Prefer cts constructors over any string grammar** when the shape of the query is known.
`cts.jsonPropertyValueQuery('category', userValue)` takes the value as data — there is no
grammar for input to escape out of.

**xdmp.eval / xdmp.xqueryEval** — pass values through the external-variables map, never
by building source text.

```javascript
WRONG:
  xdmp.eval('cts.search(cts.wordQuery("' + term + '"))');

CORRECT:
  xdmp.eval(
    'declare variable $term external; cts.search(cts.wordQuery($term))',
    { term: term }
  );
```

Better still: don't `eval`. See §2.

## 2. `xdmp.eval` is almost never the right call

| Need | Use | Why |
|---|---|---|
| Call your own logic | `require()` the module and call the function | Compiled, cached, testable, no injection surface |
| Run in another database | `xdmp.invokeFunction(fn, { database: xdmp.database('Other') })` | Passes a *function*, not source text |
| Run a deployed module | `xdmp.invoke('/lib/thing.sjs', vars)` | Module is on disk and reviewable |
| Fire-and-forget / parallelise | `xdmp.spawn('/lib/thing.sjs', vars)` | Queues on the Task Server, own transaction |
| Different transaction mode | `xdmp.invokeFunction(fn, { isolation: 'different-transaction' })` | Read your own prior writes |

`xdmp.eval` compiles source at runtime: nothing is cached, nothing is statically
checkable, and any string that reaches it is executable. Reserve it for genuinely dynamic
query text that cannot be expressed as a parameterised module — and even then, bind the
values.

`xdmp.invokeFunction` is the one most people miss. It takes a closure, so there is no
serialization boundary and no source text:

```javascript
const counts = xdmp.invokeFunction(
  function () { return cts.estimate(cts.collectionQuery('items')); },
  { database: xdmp.database('myapp-content') }
);
```

## 3. Amps, not broad roles, for privilege escalation

When a library function needs a privilege its callers should not hold — reading the
Security database, inserting into a restricted collection, calling `xdmp.documentInsert`
from an otherwise read-only endpoint — amp that single function rather than granting the
privilege to the calling role.

An amp binds (module URI, namespace, local name) to a role, so the elevation lasts
exactly as long as that one function call.

```xml
<!-- src/main/ml-config/security/amps/audit-write.json equivalent, in ml-gradle: -->
{
  "local-name": "writeAuditEntry",
  "document-uri": "/lib/audit.sjs",
  "modules-database": "myapp-modules",
  "namespace": "http://marklogic.com/javascript/lib/audit.sjs",
  "role": ["myapp-writer"]
}
```

Rules that make amps work in practice:

- The amped function must live in a **library module** and be called from another module.
  Amping a `main` module or an inline function does nothing.
- The SJS namespace for an amp is `http://marklogic.com/javascript/<module-path>` —
  getting this wrong fails silently (no elevation, `SEC-PRIV` at the call site).
- Keep the amped function tiny and give it no parameters that can widen its blast radius.
  `writeAuditEntry(event)` is ampable; `insertDocument(uri, content, permissions)` is a
  privilege-escalation hole with extra steps.

## 4. Transaction discipline

**Every update runs in one transaction with a 600-second default timeout** and holds
locks on every document it touches for that whole window. This is the single most common
production failure mode in MarkLogic application code.

- Past roughly a thousand documents, a single update transaction will time out
  (`XDMP-EXTIME`) or block writers. Batch it.
- `declareUpdate()` must be the **first statement in the file** — see the trap in the
  parent SKILL.md. Inside a function or IIFE it compiles fine and every insert silently
  does nothing.
- A query transaction sees a single consistent snapshot. A write made earlier in the same
  transaction is **not** visible to a later `cts.search()` in that transaction — use
  `xdmp.invokeFunction(fn, { isolation: 'different-transaction' })` if you need to read
  your own writes.
- Never `xdmp.commit()` in a normal (auto-commit) transaction. Multi-statement
  transactions require `xdmp.setTransactionMode('update')` first, and are rarely worth it
  inside an application module.

**Batching pattern** — spawn bounded work units onto the Task Server rather than looping
in one transaction:

```javascript
'use strict';
const BATCH = 200;
const uris = Array.from(cts.uris(null, null, cts.collectionQuery('needs-work')));
for (let i = 0; i < uris.length; i += BATCH) {
  xdmp.spawn('/lib/process-batch.sjs', { uris: uris.slice(i, i + BATCH) });
}
```

Each spawned unit gets its own transaction, so a failure in one batch does not roll back
the others — which also means you need idempotent work units and a way to find stragglers
(a `processed` collection or a status property, not an in-memory list).

For anything over a few thousand documents, don't hand-roll this at all: `flux_reprocess`
already does batching, threading, and retry. See **marklogic-bulk-import**.

## 5. Writes carry permissions and collections explicitly

`xdmp.documentInsert(uri, content)` with no options applies the *default* permissions of
the calling user, which in practice means documents that the application role cannot read
back. Always pass both, and preserve them when rewriting an existing document:

```javascript
xdmp.documentInsert(URI, doc, {
  permissions: xdmp.documentGetPermissions(URI),
  collections: Array.from(xdmp.documentGetCollections(URI)),
});
```

For new documents, name the roles rather than inheriting: `xdmp.permission('myapp-reader',
'read')`, `xdmp.permission('myapp-writer', 'update')`.

## 6. Error handling that reaches the caller

In a REST resource extension, a thrown JS error becomes an opaque 500. Use `fn.error`
with the `RESTAPI-SRVEXERR` code to control the HTTP status, and log the real cause
server-side:

```javascript
try {
  return doWork(params);
} catch (e) {
  xdmp.log('items endpoint failed: ' + (e.stack || e.toString()), 'error');
  fn.error(null, 'RESTAPI-SRVEXERR', Sequence.from([400, 'Bad Request', e.message]));
}
```

The three-item sequence is `[status, message, body]`. Details are in the
**marklogic-project-setup** skill's `references/rest-extensions.md`.

Use `xdmp.log(msg, 'error' | 'warning' | 'info' | 'debug')` — not `console.log`, which
lands in the ErrorLog without a level. Read it back with `ml_logs_read`.

## 7. Testing

Use [marklogic-unit-test](https://github.com/marklogic/marklogic-unit-test) rather than
ad-hoc eval calls. It is an ml-gradle dependency and a test-runner module in the modules
database:

```
src/test/ml-modules/root/test/suites/<suite-name>/
  setup.sjs        — insert fixtures
  test-<case>.sjs  — assertions via /test/test-helper.xqy
  teardown.sjs     — remove fixtures
```

```javascript
'use strict';
const test = require('/test/test-helper.xqy');
const result = require('/lib/items-lib.sjs').findByCategory('books');
test.assertEqual(2, fn.count(result));
```

Run with `gradle mlUnitTest` (add `mlUnitTestRunner` config per that project's README).
Wire-up details and the gradle dependency are in
**marklogic-project-setup** → `references/gradle-tasks.md`.

Two rules that save time: assert against a fixture you inserted in `setup.sjs` rather
than whatever happens to be in the database, and remember that a test module runs in the
modules database of the *app server you point the runner at* — a passing test against a
stale modules database proves nothing. `gradle mlReloadModules` first.

## 8. Outbound HTTP has a no-op trap

`xdmp.httpPost` and friends need the body as a **Node**, not a string, and options nest
under a `headers` key. A flat options object throws `XDMP-INVOPTNAM`; a string body
sometimes posts nothing at all without erroring. The worked example is in
**semaphore-integration** → `references/enrichment-module.md`.
