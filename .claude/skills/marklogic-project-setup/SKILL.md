---
name: marklogic-project-setup
description: Scaffold a deployable, source-controlled MarkLogic project using ml-gradle. Use when building an app, API, service, or backend; creating a new project or repo; adding a REST endpoint, transform, index, or TDE template that must survive a rebuild; or setting up multi-environment (dev/prod) config or CI/CD. Prefer this over ad-hoc MCP write tools whenever the work should outlive a single session. Includes a complete working template tree.
---

# MarkLogic Project Setup (ml-gradle)

## When to scaffold instead of using write tools

The MCP write tools (`ml_document_put`, `ml_tde_install`, `ml_extension_put`) change a
running database. They leave nothing in source control and nothing to promote to
another environment.

Scaffold a project instead when you hear any of:

- "build me an app / API / service / backend"
- "create a new project / repo"
- "set up MarkLogic for…"
- "add a REST endpoint" / "expose this as an API"
- "add an index" / "deploy to production" / "promote to staging"
- "I want this in CI/CD" / "version-controlled" / "multi-environment"
- any request naming a custom REST extension, transform, or module path

Ad-hoc exploration and one-off queries do not need a project.

## First decision: plain ml-gradle or DHF?

| Use **plain ml-gradle** when | Use **DHF** when |
|---|---|
| custom application, not a data-integration pipeline | entity-centric integration from multiple source systems |
| a single content database | staging (raw) and final (mastered) databases needed |
| you want full control without DHF conventions | ingestion → mapping → matching/merging (mastering) |
| lighter footprint, simpler deploy | SmartMastering or Entity Services features required |

The template below is plain ml-gradle. For DHF, the `dhf_*` tools scaffold and run flows;
DHF still sits on an ml-gradle project, so most of this skill still applies.

## Using the template

`templates/` is a complete, deploy-ready ml-gradle tree. Copy it into the target
directory and rename:

```bash
cp -r templates/ <project-dir>/
```

Then replace throughout:

| Placeholder | Replace with |
|---|---|
| `myapp` | the application name (also in `mlAppName`, role filenames, TDE schema) |
| `8010` | the REST port (`mlRestPort`) |
| `localhost` | the target host (`mlHost`) |
| `admin` / `admin` | real credentials — **do not commit these** |

Deploy with:

```bash
cd <project-dir>
gradle mlDeploy
```

Drop any part you don't need — `src/main/ml-data`, the roles, the REST extension, and
the environment overlays are all independent.

Credentials do not belong in the checked-in `gradle.properties`. The template ships
`gradle-local.properties.example` and already gitignores `gradle-local.properties`:

```bash
cp gradle-local.properties.example gradle-local.properties   # then edit
```

## Filesystem → server mapping

This mapping is the reason to have a project at all. Everything below is a file on disk
that a Gradle task pushes to the server.

| What | Where | Deployed by |
|---|---|---|
| Indexes, database config | `src/main/ml-config/databases/content-database.json` | `mlDeploy` |
| Roles, users, amps | `src/main/ml-config/security/{roles,users,amps}/` | `mlDeployRoles` |
| Library modules | `src/main/ml-modules/root/` | `mlLoadModules` |
| REST resource extension | `services/<n>.sjs` **+** `services/metadata/<n>.xml` | `mlLoadModules` |
| REST transform | `transforms/<n>.sjs` | `mlLoadModules` |
| Search options | `options/<n>.xml` | `mlLoadModules` |
| TDE templates | `src/main/ml-schemas/tde/<view>.tdej` | `mlLoadSchemas` |
| Seed data | `src/main/ml-data/` + per-dir `collections.properties` | `mlLoadData` |
| Unit tests | `src/test/ml-modules/root/test/suites/` | `mlLoadModules` |

The everyday loop is `gradle mlWatch` (hot-reloads modules on save). Use
`mlReloadModules` when a *deletion* must take effect — `mlLoadModules` is incremental
against a timestamp file and will not remove anything.

The full task table, credential handling, the multi-environment overlay, unit-test
wiring, and a GitHub Actions pipeline are in `references/gradle-tasks.md`.

## REST extensions

A **resource extension** is a new endpoint at `/v1/resources/<name>`. A **transform**
modifies documents flowing through existing REST endpoints. If an extension's only job is
reshaping a document on read or write, you want a transform instead.

Minimum viable resource extension — two files, and both are required:

```
src/main/ml-modules/services/items.sjs           # exports.GET = ...
src/main/ml-modules/services/metadata/items.xml  # title, description, params
```

Four things account for most of the lost time:

1. **Exports are uppercase.** `exports.GET`, not `exports.get` — the lowercase form
   deploys cleanly and never runs.
2. **Custom params need the `rs:` prefix on the wire, and keep it in `params`.** Read
   `params['rs:category']`. Without the prefix the caller gets
   `REST-UNSUPPORTEDPARAM: invalid parameters: category for items`. (`ml_extension_call`
   adds the prefix for you.)
3. **No metadata file → 404.** The module deploys, the endpoint never registers. This is
   the most common ml-gradle REST-extension failure.
4. **Throwing a JS error gives an opaque 500.** Control the status with
   `fn.error(null, 'RESTAPI-SRVEXERR', Sequence.from([400, 'Bad Request', msg]))`.

`templates/src/main/ml-modules/services/items.sjs` is a worked example: param validation,
`context.outputTypes`, a library-module `require()`, `RESTAPI-SRVEXERR` error handling, and
GET plus POST. `templates/src/main/ml-modules/root/lib/items-lib.sjs` is the library module
it calls.

The complete contract — argument shapes, return-value and `outputTypes` rules, multipart
responses, transforms and the `trans:` prefix, why `declareUpdate()` is forbidden in an
extension, both deploy paths and how they shadow each other, and a failure table — is in
`references/rest-extensions.md`.

For the code inside the handler (input validation, query bindings, transactions,
permissions), see **marklogic-server-side-code**.

## What the template already handles

These five defaults exist because each one is a first-deploy failure that costs an hour
to diagnose:

1. **Pre-emptive Basic auth.** `mlAuthentication=basic` plus the Manage / Admin /
   AppServices variants. Without them, clusters whose Manage server answers
   `WWW-Authenticate: Basic realm=public` fail with
   `unsupported auth scheme: [Basic realm=public]` — the default interceptor cannot
   complete a Basic challenge-response. `mlRestAuthentication` stays `digest`.

2. **Schemas and triggers databases are declared.** `content-database.json` references
   `%%SCHEMAS_DATABASE%%` / `%%TRIGGERS_DATABASE%%`, so those files must exist or the
   first deploy fails with `CMA-INVALIDPROPERTIES` (`ADMIN-NOSUCHDATABASE`).

3. **`ml-data` properties use per-file syntax.** `collections.properties` and
   `permissions.properties` use the documented `filename=values` form — a global
   `collections=` key silently does nothing.

4. **TDE templates use `.tdej`.** JSON templates under `src/main/ml-schemas/tde` with
   the `.tdej` extension auto-join the `http://marklogic.com/xdmp/tde` collection.
   A `.json` extension there deploys but is never indexed.

5. **REST extensions ship their metadata.** `services/echo.sjs` with
   `services/metadata/echo.xml`, including `rs:`-prefixed parameter examples.

## Multi-environment

`build.gradle` includes `net.saliman.properties`. `gradle-dev.properties` and
`gradle-prod.properties` layer on top of `gradle.properties` and override
`mlConfigPaths` to overlay `dev-config` / `prod-config` on `ml-config`:

```bash
gradle -PenvironmentName=dev mlDeploy
gradle -PenvironmentName=prod mlDeploy
```

`src/main/dev-config/databases/content-database.json` shows the overlay pattern — only
the properties that differ need restating.

## Project topology

Each project gets **its own content database** (`myapp-content`), distinct from the
built-in `Documents` database, which is for ad-hoc sandbox use only. When working
against an existing project, run `ml_databases_list` and `ml_servers_list` first to find
the right database and app server rather than assuming `Documents`.

## After every deploy — validate, don't assume

`mlDeploy` / `mlReloadModules` exiting cleanly only means the Manage API accepted the
request. The failures worth guarding against here are **silent**: a wrong `mlRestPort`
in `gradle.properties` makes every subsequent request (curl tests, module reloads,
MCP tool calls) target whatever app server actually listens on that port — old code and
404s, not errors. Run this checklist after the first deploy and after any config change:

1. **Port** — `ml_servers_list`, and confirm the app server for *this* project is on the
   port `gradle.properties` says (`mlRestPort`). If they disagree, fix
   `gradle.properties` and re-run `mlReloadModules`; everything deployed so far went to
   the wrong place.
2. **Databases** — `ml_databases_list`: `myapp-content`, `myapp-schemas`, `myapp-triggers`
3. **Indexes** — `ml_indexes_list database=myapp-content`: every range index from
   `content-database.json` is present. Then `ml_reindex_status` until `ready=true`, and
   probe one query per new index (see **marklogic-query-authoring**, "Range-index
   errors") — deployed is not the same as resolvable.
4. **TDE** — `ml_schema_get_tde` to confirm registration; `ml_tde_validate` to prove it
   extracts rows
5. **Extensions** — `ml_extension_list`, then hit one endpoint with a trivial request
   and check the response is from the *new* code

Then load data with the **marklogic-bulk-import** skill and query it with
**marklogic-query-authoring**.

## Common deploy failures

| Error | Cause |
|---|---|
| `unsupported auth scheme: [Basic realm=public]` | missing pre-emptive Basic properties |
| `CMA-INVALIDPROPERTIES` / `ADMIN-NOSUCHDATABASE` | schemas/triggers database files missing |
| TDE deploys but no rows in the view | template used `.json`, not `.tdej` |
| `ml-data` documents load with no collections | used a global `collections=` key |
| REST extension 404s after deploy | missing `services/metadata/<name>.xml` |
| `mlReloadModules` "succeeds" but the endpoint serves old code / 404s | `mlRestPort` in `gradle.properties` doesn't match the actual app server — verify with `ml_servers_list` |

## Further reading

ml-gradle is a community-maintained plugin, documented in its GitHub wiki rather than
on the Progress doc site:

- [ml-gradle wiki](https://github.com/marklogic/ml-gradle/wiki) — start here
- [Project layout](https://github.com/marklogic/ml-gradle/wiki/Project-layout) — the
  authoritative list of `src/main/ml-config` and `ml-modules` directories, worth checking
  when a resource file is being ignored
- [Property reference](https://github.com/marklogic/ml-gradle/wiki/Property-reference)
  and [Task reference](https://github.com/marklogic/ml-gradle/wiki/Task-reference)
- [Configuring ml-gradle](https://github.com/marklogic/ml-gradle/wiki/Configuring-ml-gradle)

For the REST instance the project deploys against:
[Introduction to the MarkLogic REST API (12)](https://docs.progress.com/bundle/marklogic-server-develop-rest-api-12/page/topics/intro.html)
and [Administering REST Client API Instances (11)](https://docs.progress.com/bundle/marklogic-server-develop-rest-api-11/page/topics/service.html).
