# ml-gradle task reference, credentials, and CI

## Filesystem → server mapping

The whole point of an ml-gradle project is that this mapping is fixed and repeatable.

| What | Where it lives | Deployed by |
|---|---|---|
| Database config, indexes | `src/main/ml-config/databases/content-database.json` | `mlDeploy`, `mlDeployDatabases` |
| App servers | `src/main/ml-config/servers/` | `mlDeploy`, `mlDeployServers` |
| Roles, users, amps | `src/main/ml-config/security/{roles,users,amps}/` | `mlDeploy`, `mlDeployRoles` |
| Modules (library code) | `src/main/ml-modules/root/` | `mlLoadModules` |
| REST resource extensions | `src/main/ml-modules/services/<n>.sjs` **+** `services/metadata/<n>.xml` | `mlLoadModules` |
| REST transforms | `src/main/ml-modules/transforms/<n>.sjs` | `mlLoadModules` |
| Search options | `src/main/ml-modules/options/<n>.xml` | `mlLoadModules` |
| TDE templates | `src/main/ml-schemas/tde/<view>.tdej` | `mlLoadSchemas` |
| Seed data | `src/main/ml-data/` + per-directory `collections.properties` | `mlLoadData` |
| Unit tests | `src/test/ml-modules/root/test/suites/` | `mlLoadModules` |

Roles deploy in filename order, which is why the template names them `1-myapp-reader.json`
and `2-myapp-writer.json` — a role that inherits another must deploy second.

## Tasks

| Task | Does | Notes |
|---|---|---|
| `mlDeploy` | Everything: databases, servers, security, modules, schemas | The one to run first |
| `mlPreviewDeploy` | Prints what would change | Run before a prod deploy |
| `mlPrintTokens` | Shows `%%TOKEN%%` substitutions applied to config JSON | Debugging `%%SCHEMAS_DATABASE%%` etc. |
| `mlLoadModules` | Copies changed modules into the modules DB | Incremental; uses a timestamp file |
| `mlReloadModules` | **Clears** the modules DB, then loads | Use when a delete needs to take effect |
| `mlWatch` | Hot-reloads modules on file change | The normal dev loop |
| `mlLoadSchemas` / `mlReloadSchemas` | TDE templates and schemas | Reload after changing a `.tdej` |
| `mlLoadData` | Loads `src/main/ml-data` | Dev fixtures only, not bulk ingest |
| `mlDeployRoles` / `mlDeployUsers` / `mlDeployAmps` | Security only | Faster than a full deploy |
| `mlUnitTest` | Runs marklogic-unit-test suites | Needs the dependency below |
| `mlUndeploy -Pconfirm=true` | **Destroys** databases, servers, forests, and content | Irreversible |

`mlLoadModules` is incremental against a timestamp file in `build/`. If a module change
seems not to take, `mlReloadModules` is the answer — and note it clears the *whole* modules
database, including anything `ml_extension_put` or `ml_document_put(database="Modules")`
wrote out-of-band.

For bulk data use `flux_import` (see **marklogic-bulk-import**), not `mlLoadData`. Wire it
into the project as a Gradle `Exec` task so it stays reproducible:

```groovy
task importItems(type: Exec) {
  commandLine 'flux', 'import-files',
    '--path', 'data/items',
    '--connection-string', "${mlUsername}:${mlPassword}@${mlHost}:8000/${mlAppName}-content"
}
```

## Credentials

`gradle.properties` is checked in, so it must not hold real credentials. Two mechanisms,
both already wired in the template:

**1. `gradle-local.properties`** — listed in the template `.gitignore`. The
`net.saliman.properties` plugin layers it over `gradle.properties`. Copy the example and
fill it in:

```bash
cp gradle-local.properties.example gradle-local.properties
```

**2. `-P` overrides / environment** — for CI, where nothing should touch disk:

```bash
gradle mlDeploy -PmlPassword="$ML_PASSWORD" -PmlManagePassword="$ML_PASSWORD"
```

Both `mlPassword` (REST/app) and `mlManagePassword` (Manage API) are needed; overriding
only one produces a confusing partial deploy that creates databases but fails on modules.

Do not commit a `gradle-prod.properties` containing a real password. Keep environment
overlays for *non-secret* differences — forest counts, hostnames, log levels — and inject
secrets separately.

## Multi-environment

`gradle-dev.properties` and `gradle-prod.properties` layer over `gradle.properties` and
override `mlConfigPaths` so a per-environment config directory overlays `ml-config`:

```bash
gradle -PenvironmentName=dev  mlDeploy
gradle -PenvironmentName=prod mlDeploy
```

Only the properties that differ need restating in the overlay JSON —
`src/main/dev-config/databases/content-database.json` in the template shows the pattern.
Verify with `mlPreviewDeploy` before a prod run; overlays merge in ways that are easy to
get wrong, and `mlPrintTokens` shows what the `%%TOKEN%%` values resolved to.

## Unit tests

Add to `build.gradle`:

```groovy
dependencies {
  mlBundle "com.marklogic:marklogic-unit-test-modules:1.4.0"
}

ext {
  mlUnitTestRunner = "/test/default.xqy"
}
```

Then:

```
src/test/ml-modules/root/test/suites/items/
  setup.sjs
  test-find-by-category.sjs
  teardown.sjs
```

```bash
gradle mlReloadModules mlUnitTest
```

`mlReloadModules` first, always — `mlUnitTest` runs whatever is in the modules database,
so a green run against stale modules proves nothing. Assertion helpers come from
`require('/test/test-helper.xqy')`.

## CI/CD

The deployable unit is the repository; CI runs the same tasks a developer does.

```yaml
# .github/workflows/deploy.yml
name: deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: '17' }
      - name: Preview
        run: >
          ./gradlew -PenvironmentName=prod mlPreviewDeploy
          -PmlPassword="${{ secrets.ML_PASSWORD }}"
          -PmlManagePassword="${{ secrets.ML_PASSWORD }}"
      - name: Deploy
        run: >
          ./gradlew -PenvironmentName=prod mlDeploy
          -PmlPassword="${{ secrets.ML_PASSWORD }}"
          -PmlManagePassword="${{ secrets.ML_PASSWORD }}"
      - name: Test
        run: ./gradlew mlUnitTest -PmlPassword="${{ secrets.ML_PASSWORD }}"
```

Practical notes:

- Commit the Gradle wrapper (`gradlew`, `gradle/wrapper/`) so CI does not depend on a
  system Gradle. Generate it once with `gradle wrapper`.
- `mlDeploy` is idempotent — re-running it on an unchanged project is a no-op, which is
  what makes it safe as a deploy step.
- An index or TDE change triggers a **reindex**, which continues after `mlDeploy` returns.
  A test job that runs immediately can fail on partially-reindexed data. Gate on
  `ml_reindex_status` (or the Manage API equivalent) rather than a sleep.
- Never put `mlUndeploy` in a pipeline that can run against production.

## Deploy failure table

| Error | Cause |
|---|---|
| `unsupported auth scheme: [Basic realm=public]` | missing pre-emptive Basic properties (`mlManageAuthentication=basic` et al.) |
| `CMA-INVALIDPROPERTIES` / `ADMIN-NOSUCHDATABASE` | `content-database.json` references `%%SCHEMAS_DATABASE%%` but the schemas/triggers database files are absent |
| TDE deploys, view has no rows | template used `.json` instead of `.tdej`, so it never joined the TDE collection |
| `ml-data` docs load with no collections | used a global `collections=` key instead of the per-file `filename=values` form |
| REST extension 404s after deploy | missing `services/metadata/<name>.xml` |
| Databases created but modules fail | `mlManagePassword` overridden without `mlPassword` (or vice versa) |
| Role deploy fails on inheritance | roles deployed out of order — prefix filenames `1-`, `2-` |
| Module change has no effect | `mlLoadModules` incremental timestamp — use `mlReloadModules` |
