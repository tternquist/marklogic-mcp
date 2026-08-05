# myapp

An ml-gradle MarkLogic project scaffolded from the `marklogic-project-setup` skill's
`templates/` tree.

## Credentials first

`gradle.properties` is checked in and ships `admin`/`admin` so a local dev deploy works
out of the box. For anything else:

```bash
cp gradle-local.properties.example gradle-local.properties   # gitignored
```

## Deploy
```bash
gradle mlDeploy
gradle mlLoadData     # load src/main/ml-data into the content DB
```
## Common tasks
| Task | Purpose |
|------|---------|
| `gradle mlDeploy` | Full deploy (databases, servers, security, modules, schemas) |
| `gradle mlReloadModules` | Clear modules DB and reload from `src/main/ml-modules` |
| `gradle mlReloadSchemas` | Clear schemas DB and reload TDE templates |
| `gradle mlLoadData` | Load `src/main/ml-data` into the content database |
| `gradle mlPrintTokens` | Show all `%%TOKEN%%` replacements applied to JSON/XML config |
| `gradle mlPreviewDeploy` | Show what would change without applying it |
| `gradle mlWatch` | Hot-reload modules whenever a file changes |
| `gradle mlUnitTest` | Run marklogic-unit-test suites (see `build.gradle`) |
| `gradle mlUndeploy -Pconfirm=true` | Tear down the entire app (destructive) |

`mlLoadModules` is incremental against a timestamp file in `build/`. Use
`mlReloadModules` when a deletion must take effect.

## Try the REST extensions

```bash
# minimal example
curl -u admin:admin --digest "http://localhost:8010/v1/resources/echo?rs:text=hello"

# worked example: param validation, library module, RESTAPI-SRVEXERR error handling
gradle mlLoadData
curl -u admin:admin --digest "http://localhost:8010/v1/resources/items?rs:category=demo"

curl -u admin:admin --digest -X POST \
  -H "Content-Type: application/json" -d '{"id":"i-9","category":"demo"}' \
  "http://localhost:8010/v1/resources/items"
```

Custom params must use the `rs:` prefix — without it MarkLogic returns
`REST-UNSUPPORTEDPARAM`. A resource extension also needs its
`services/metadata/<name>.xml` file, or the module deploys and the endpoint 404s.

## Tests

```bash
# uncomment the marklogic-unit-test block in build.gradle first
gradle mlReloadModules mlUnitTest
```

Suites live in `src/test/ml-modules/root/test/suites/`. The `items` suite shows the
setup / test / teardown convention.

## Environment switching

```bash
gradle -PenvironmentName=dev  mlDeploy
gradle -PenvironmentName=prod mlDeploy
```

`gradle-{env}.properties` overrides values from `gradle.properties`. The pattern
shipped here uses `mlConfigPaths` to layer `src/main/{env}-config/` on top of
`src/main/ml-config/` so each environment can patch the database/server JSON.

