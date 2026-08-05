---
name: marklogic-project-setup
description: Scaffold a deployable, source-controlled MarkLogic project using ml-gradle. Use when the goal implies something repeatable, version-controlled, or deployed to another environment — building an app, API, service, or backend; creating a new project or repo; adding a REST endpoint, transform, or resource extension; adding indexes or TDE templates that must survive a rebuild; setting up multi-environment (dev/prod) config or CI/CD. Prefer this over the MCP write tools whenever the work should outlive an ad-hoc session. Includes a complete working template tree.
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

## After the first deploy

- `ml_databases_list` — confirm `myapp-content`, `myapp-schemas`, `myapp-triggers`
- `ml_servers_list` — confirm the REST server on the configured port
- `ml_schema_get_tde` — confirm the TDE template registered
- `ml_extension_list` — confirm REST extensions deployed

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
