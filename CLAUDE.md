# MarkLogic MCP — Agent Working Instructions

This file is read automatically by Claude Code when working in this repository.
Follow all principles below for every feature addition, bug fix, and refactor.

---

## Core Principle: Problem-First Thinking

Before writing any new tool, prompt, resource, or client method, answer:

1. **What is the user problem?** State it as a concrete goal, not a technical task.
   - Bad: "expose the `/v1/values` REST endpoint"
   - Good: "allow agents to count distinct values of a field without scanning every document"

2. **What is the MarkLogic-native capability?** Every user problem has a best-fit
   MarkLogic API. Identify it before writing any code.
   - Bulk import → Flux pipeline (`flux_import`)
   - Counting/bucketing → Values/range index API (`ml_values_query`)
   - Joins/aggregates → Optic API over TDE views (`ml_optic_query`)
   - Full-text → Universal index search (`ml_search`)
   - Graph traversal → Triple store / SPARQL (`ml_sparql_query`)
   - Content classification / auto-tagging → Semaphore CLS + KMM (`semaphore_classify`,
     `semaphore_publish`, `flux_import` with `classify_with_semaphore: true`)

3. **What must an agent discover first?** If the tool requires a pre-existing index,
   collection, or TDE template, document that prerequisite in the tool's `description`
   string so the agent knows to check before calling.

4. **Is this already covered?** Check the 18 existing tool groups before adding a new
   tool. Extend an existing tool (via a new parameter) rather than adding a new one
   unless the problem type is genuinely distinct.

---

## Where Guidance Lives — Skills First

**Tool descriptions are interface contracts. Skills are the manual.** Do not put
tutorials, recipe collections, or troubleshooting playbooks into a `server.tool()`
description string — that text is loaded into every request whether or not it is
relevant.

### Agent Skills (`.claude/skills/<name>/SKILL.md`)

Skills follow the [Agent Skills spec](https://agentskills.io/specification) and are
discovered automatically by Claude Code, GitHub Copilot CLI, and other spec-adopting
agents from `.claude/skills/`. A skill is YAML frontmatter plus Markdown:

```yaml
---
name: marklogic-bulk-import     # <=64 chars, lowercase/digits/hyphens, == directory name
description: ...                # <=1024 chars, states WHAT it does AND WHEN to use it
---
```

Run `npm run validate:skills` after any change — it enforces both limits, the
name/directory match, and that every `references/` or `templates/` path mentioned in a
SKILL.md actually exists.

**Adding or removing a skill also means updating three catalogs**, or the build fails
(`tests/skills/skills-catalog.test.ts`):

1. the Agent Skills table in `README.md`
2. the catalog table in `docs/SKILLS.md`
3. the `AGENT SKILLS` section of `INSTRUCTIONS_TEXT` (`src/resources/index.ts`)

`docs/SKILLS.md` is the human-facing guide — installation, the tool/skill/prompt
distinction, where the removed advisory tools and prompts went, and troubleshooting.
Users who connect this MCP server from another project get skills only by copying them:
`npm run skills:install -- --user` (`scripts/install-skills.mjs`).

Current skills (13): `marklogic` (router), `marklogic-bulk-import`,
`marklogic-query-authoring`, `marklogic-data-modeling`, `marklogic-rag`,
`marklogic-performance`, `marklogic-server-side-code`, `marklogic-project-setup`,
`marklogic-oauth-setup`, `marklogic-fasttrack`, `semaphore-taxonomy`,
`semaphore-integration`, `semaphore-classification-tuning`.

**What belongs in a tool description** (keep it to a few lines):
- what the tool does
- prerequisites — required index, TDE template, config flag, database
- when to pick it over a neighbouring tool
- one pointer: "GUIDANCE: see the `<skill-name>` skill"

**What belongs in a skill:** recipes, worked examples, failure modes, workarounds,
decision trees, templates, anything longer than a few lines.

**Never register a tool that performs no I/O.** If a handler only transforms its own
arguments into text, it is a skill, not a tool — it costs schema tokens on every
request and duplicates knowledge the model already has. Six such tools were removed in
the skills migration; do not reintroduce that pattern.

### `marklogic://instructions` resource (`src/resources/index.ts`)

The `INSTRUCTIONS_TEXT` constant is the fallback for MCP clients that do not implement
the Agent Skills spec. It carries the problem→solution map and an index of the skills,
**not** a second copy of their contents. **Every time you add a new tool or prompt,
update both:**

- The **PROBLEM → MARKLOGIC-NATIVE SOLUTION TABLE** (add a row if it covers a new
  problem type, or add the tool name to an existing row's PRIMARY TOOLS column)
- The **TOOL GROUPS AT A GLANCE** section (add the tool name to its group)

If you add a skill, add one line to the **AGENT SKILLS** section — the description
only, never the body. Detail belongs in the SKILL.md.

Keep the text in plain `text/plain` with ASCII column alignment. Do not use JSON.

`tests/resources/guidance-sync.test.ts` fails the build if a registered tool is missing
from this text, or if this text names a tool that no longer exists.

### The `marklogic` router skill (`.claude/skills/marklogic/SKILL.md`)

This is the problem→capability router and the canonical **complete tool index**. It
replaced the `problem_advisor` prompt. **When adding a new tool, add it to the relevant
group in the "Complete tool index" section** — `tests/resources/guidance-sync.test.ts`
reads this file from disk and fails the build if any registered tool is missing from it.

### MCP prompts (`src/prompts/index.ts`)

Only three remain — `gdelt_import`, `quicksight_dataset_designer`,
`quicksight_dashboard_planner` — because they are narrow, one-shot flows where explicit
slash-command invocation is the right ergonomics. **Do not add advisor or generator
prompts.** MCP prompts are user-invoked in most clients, so an advisor only fires if the
human already knew to ask for it; a skill is model-invoked and fires when the task
matches. Write a skill instead.

---

## Tool Design Conventions

**Descriptions must state prerequisites.**
If a tool requires a range index, TDE template, specific database, or config flag,
say so in the `server.tool()` description string. Agents read descriptions to decide
whether to call a tool.

```typescript
// Good — states the prerequisite
server.tool(
  "ml_optic_query",
  "Execute an Optic query against a TDE view. Requires a TDE template in the Schemas " +
  "database (collection http://marklogic.com/xdmp/tde). Call ml_schema_get_tde first " +
  "to verify the view exists.",
  ...
);
```

**Error messages must be actionable.**
Append `\nNOTE: ...` or `\nHint: ...` to error text when the failure has a known fix.
See `flux.ts` (`buildTdeNote`, `condenseWriteErrors`) and `optic.ts` for patterns.

**No silent no-ops.**
If a config flag disables a tool, either skip registration entirely (see `eval.ts`)
or return an explicit error with instructions for enabling it. Never silently return
empty results when the real cause is a missing permission or disabled feature.

**Readonly gating** — write tools check `readonly` at registration time (`documents.ts` pattern).

**Eval gating** — eval tools check `allowEval` at registration time (`eval.ts` pattern).

---

## Adding a New Tool Group

1. Create `src/tools/<domain>.ts` with a `registerXxxTools(server, clients, ...)` function.
2. Import and call it in `src/tools/index.ts` inside `registerAllTools()`.
3. If new API calls are needed, add `src/client/<domain>.ts` implementing a typed client
   class, and export it from `src/client/index.ts` in the `MarkLogicClients` interface.
4. Update `INSTRUCTIONS_TEXT` in `src/resources/index.ts`:
   - Add row(s) to the problem table
   - Add the tool group to TOOL GROUPS AT A GLANCE
5. Add the tool to the "Complete tool index" in `.claude/skills/marklogic/SKILL.md`.
5b. If the new group needs more than a few lines of explanation, create a skill under
   `.claude/skills/` for it rather than growing the tool descriptions, and add one line
   to the AGENT SKILLS section of `INSTRUCTIONS_TEXT`. Run `npm run validate:skills`.
6. Update this file (`CLAUDE.md`) — add the new tool group to the Core Principle section
   if it covers a new problem type.

## Adding a New Prompt

Prefer a **skill**. Add an MCP prompt only for a narrow, one-shot flow the user will
invoke explicitly by name (the three QuickSight/GDELT prompts are the pattern). Anything
advisory, exploratory, or reference-shaped belongs in `.claude/skills/`.

If a prompt really is right:

1. Add a `server.prompt()` call in `src/prompts/index.ts` inside `registerAllPrompts()`.
2. All parameters must have `.describe()` strings.
3. Return `{ messages: [{ role: "user", content: { type: "text", text: "..." } }] }`.
4. Include explicit requirements as a bullet list so the output is directly usable.
5. Add the prompt name to the Prompts line in `INSTRUCTIONS_TEXT`.

---

## File Map

```
.claude/skills/       — Agent Skills (spec: agentskills.io); read by Claude Code,
                        Copilot CLI, and other spec-adopting agents
  marklogic/                        — problem -> capability router + complete tool index
  marklogic-bulk-import/            — Flux recipes, wrappers, reprocess transforms
  marklogic-query-authoring/        — query selection, structured-query cookbook, SPARQL
  marklogic-data-modeling/          — multi-model design, URI rules, envelope pattern
  marklogic-rag/                    — lexical/vector/graph RAG, TDE vector column
  marklogic-performance/            — E/D nodes, filtered search, caches, forest health
  marklogic-server-side-code/       — SJS/XQuery modules, REST extensions, TDE syntax;
                                      references/coding-practices.md (query bindings vs
                                      concatenation, eval vs invoke vs spawn, amps,
                                      transactions, permissions, unit tests)
  marklogic-project-setup/          — ml-gradle template tree (templates/);
                                      references/rest-extensions.md (resource extension +
                                      transform contract), references/gradle-tasks.md
                                      (task set, credentials, multi-env, CI)
  marklogic-oauth-setup/            — OIDC external security, JWT -> role mapping
  marklogic-fasttrack/              — search options for facets/timeline/map
  semaphore-taxonomy/               — SKOS authoring + Turtle template
  semaphore-integration/            — CLS/KMM setup, four integration patterns
  semaphore-classification-tuning/  — classification quality playbooks
scripts/
  validate-skills.mjs   — Agent Skills spec compliance check (npm run validate:skills)
  install-skills.mjs    — copy skills into another project / ~/.claude (npm run skills:install)
docs/
  SKILLS.md          — human-facing skills guide: install, catalog, migration, troubleshooting
src/
  server.ts          — factory: createMcpServer() wires tools + resources + prompts
  index.ts           — CLI entry point; selects stdio or HTTP transport
  tools/
    index.ts            — calls all registerXxxTools() — add new groups here
    answer.ts           — ml_answer_query: one-shot NL question answering over a collection
    admin.ts            — cluster, databases, forests, servers (readonly-gated writes)
    documents.ts        — get/sample/list/put/delete/patch/patch-batch (readonly-gated)
    search.ts           — search, QBE, values, suggest
    schema.ts           — discover, TDE, indexes, collections, namespaces
    eval.ts             — XQuery, SJS, SPARQL-via-eval, invoke (allowEval-gated)
    graphs.ts           — SPARQL, graphs list (readonly-gated writes)
    optic.ts            — Optic query
    quicksight.ts       — aggregate, timeseries, export, facets
    flux.ts             — import/export/copy/reprocess/preview/help/status (readonly-gated)
    fasttrack.ts        — FastTrack scaffolding (readonly-gated)
    extensions.ts       — REST resource/transform extension management (readonly-gated)
    security.ts         — users/roles/permissions introspection (read-only)
    performance.ts      — database/forest metrics, merge/reindex status (eval-gated bits)
    dhf.ts              — Data Hub Framework flow run/scaffold (eval + readonly + JAR gated)
    semaphore.ts        — CLS + KMM + taxonomy + KID templates (~27 tools)
  resources/
    index.ts         — all resources; INSTRUCTIONS_TEXT constant at top
  prompts/
    index.ts         — the 3 remaining one-shot prompts (gdelt, quicksight x2)
  client/
    index.ts         — MarkLogicClients factory + interface
    base.ts          — Axios HTTP + Digest/Basic/OAuth auth + error mapping
    admin.ts         — cluster, databases, forests, servers
    documents.ts     — CRUD + patch
    search.ts        — full-text, structured, QBE, values, suggest
    schema.ts        — TDE, indexes, collections, namespaces, discovery
    eval.ts          — XQuery, SJS, module invocation, cts.parse, static check
    graphs.ts        — SPARQL
    optic.ts         — Optic plan execution
    flux.ts          — Flux runner HTTP client (SSE /run-stream + /run fallback)
    fasttrack.ts     — FastTrack client
    extensions.ts    — REST extension management client
    security.ts      — users/roles/permissions client
    performance.ts   — metrics + status client
    dhf.ts           — Data Hub Framework client
    semaphore.ts     — CLS XML API + KMM REST API (SPARQL, publish, workspace ZIP)
  config/
    index.ts         — dotenv loading + validation
    schema.ts        — Zod schemas for all config sections
  transport/
    stdio.ts         — StdioServerTransport wrapper
    http.ts          — Express server with session management + Bearer/OAuth token binding
  utils/
    errors.ts            — error classes + toToolError() string formatter
    tool-error.ts        — structured makeToolError() envelope + edit-distance "did you mean"
    logger.ts            — Winston configuration
    digest.ts            — HTTP Digest auth builder
    multipart.ts         — Multipart form-data builder + multipart/mixed parser
    eval-lint.ts         — preflight SJS lint for ml_eval_javascript
    projection.ts        — field projection / aggregation for ml_answer_query
    recipes.ts           — canned query recipes for ml_answer_query
    value-normalize.ts   — case/plural/closest-value normalization
    collection-routing.ts— score-based collection routing for ml_answer_query
    security-posture.ts  — startup security-misconfig analysis (readonly/eval/TLS/admin-user)
```

---

## Build & Test

```bash
npm run build             # TypeScript → dist/; always run after editing .ts files
npm test                  # Vitest; tests skip gracefully if ML_HOST is not set
npm run lint              # ESLint over src/
npm run validate:skills   # Agent Skills spec compliance for .claude/skills/
npm run skills:install    # Copy skills elsewhere (-- --user | --project <dir> | --list)
npm run dev               # Watch mode for development
```

The project uses ES modules (`"type": "module"`). All local imports must use `.js`
extensions even though the source files are `.ts`.
