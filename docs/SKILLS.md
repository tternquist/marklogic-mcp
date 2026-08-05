# Agent Skills

This repository ships **13 Agent Skills** in `.claude/skills/`. They carry the MarkLogic
know-how that used to live inside tool descriptions and advisory prompts: Flux import
recipes, index prerequisites, TDE syntax traps, SKOS publishing order, OAuth claim
mapping, and so on.

A skill is a plain Markdown file with YAML frontmatter, following the open
[Agent Skills spec](https://agentskills.io/specification). Nothing to install into the
server, nothing to configure — the agent reads them off disk.

> **Skills are guidance, not capability.** The MCP server is still what talks to
> MarkLogic. Skills tell the agent *which* tool to reach for and how not to misuse it.
> You can run the server with no skills at all; you'll just get worse first attempts.

## The short version

```bash
# from a clone of this repo
npm run skills:install -- --user                     # Claude Code → ~/.claude/skills
npm run skills:install -- --dest ~/.copilot/skills   # Copilot CLI → ~/.copilot/skills
```

Then restart your agent session. That's the whole installation — skills are files on the
*agent's* disk, so they are independent of how the MCP server is deployed (stdio or HTTP) and of
where MarkLogic runs.

Working inside this repo? Nothing to install; `/skills` in Claude Code already lists them.
Client without skill support? The `marklogic://instructions` resource carries the same routing
table. Details for both cases are [below](#getting-the-skills-in-front-of-your-agent).

---

## Why they exist

Every MCP tool description is sent to the model on **every single request**. Before this
change the server spent ~50,700 tokens of context per request on tool descriptions
alone, because the biggest tools carried operator manuals in their descriptions —
`flux_import` alone was 4,184 tokens, paid for whether or not the task involved
importing anything.

Skills invert that. Only the ~500-character `description` line of each skill is
always resident; the body loads when the model decides the task matches. The full
analysis is in [SKILLS_EVALUATION.md](./SKILLS_EVALUATION.md).

**Progressive disclosure, three levels:**

| Level | What loads | When |
|---|---|---|
| 1 | `name` + `description` (~500 chars each) | always in context |
| 2 | The SKILL.md body (~4–9 KB) | when the model matches the task to the description |
| 3 | `references/*.md`, `templates/*` | when the body points at them and the agent needs them |

So the cost of having all 13 skills available is roughly 2 KB of context. Reading one
costs a few thousand tokens, and only on the tasks that need it.

---

## Getting the skills in front of your agent

Which of these applies depends on where your agent is running — not on how the MCP
server is deployed.

### 1. You're working inside this repository

Nothing to do. Claude Code discovers `.claude/skills/` in the project root automatically, and so
does GitHub Copilot CLI. Confirm with `/skills` (Claude Code) or `/skills list` (Copilot CLI).

### 2. You use the MCP server from your own project

This is the common case, and skills do **not** travel with the MCP connection — the
server exposes tools, resources, and prompts, but `.claude/skills/` is a filesystem
convention on the agent's side. Copy them in:

```bash
# From a clone of this repo:
npm run skills:install -- --user            # → ~/.claude/skills (all your projects)
npm run skills:install -- --project ~/my-app   # → ~/my-app/.claude/skills (checked in)

# See what's available first:
npm run skills:install -- --list
```

**Where your agent looks matters.** Project-level `.claude/skills` is read by both Claude Code
and Copilot CLI, so `--project` serves a mixed team from one checked-in directory. Home-level
paths differ:

| Agent | Project skills | Personal skills |
|---|---|---|
| Claude Code | `<project>/.claude/skills` | `~/.claude/skills` |
| Copilot CLI | `<repo>/.claude/skills`, `.github/skills`, `.agents/skills` | `~/.copilot/skills`, `~/.agents/skills` |

Copilot CLI does **not** read `~/.claude/skills`, so `--user` does nothing for it — use
`--dest ~/.copilot/skills` instead.

| Flag | Effect |
|---|---|
| `--user` | Install to `~/.claude/skills`, available in every project |
| `--project [dir]` | Install to `<dir>/.claude/skills` (defaults to the current directory) |
| `--dest <dir>` | Install straight into `<dir>` with no `.claude/skills` suffix — for agents that look elsewhere, e.g. `--dest ~/.copilot/skills` |
| `--only a,b` | Install a subset — e.g. skip the Semaphore skills if you don't use Semaphore |
| `--force` | Overwrite skills that are already there |
| `--dry-run` | Print what would be copied, change nothing |
| `--list` | List available skills with their descriptions |

Existing skill directories are **skipped, not overwritten**, unless you pass `--force`,
so re-running after a `git pull` will not discard local edits.

Choose `--project` when your team should all get the same guidance (check
`.claude/skills/` into your app's repo); choose `--user` (or `--dest`) for your own machine.

Restart the agent session afterwards — skills are read at session start. Copilot CLI can pick up
new ones mid-session with `/skills reload`.

### 3. Your client doesn't support skills

The skills are ordinary Markdown; point the agent at them directly, or rely on the
built-in fallback:

- **`marklogic://instructions` resource** — always served by the MCP server regardless
  of client. It carries the same problem→capability routing table plus an `AGENT SKILLS`
  index naming each skill and what it covers, so a skill-less client still learns the
  right approach and knows which file to open for detail.
- **Read the file** — `.claude/skills/<name>/SKILL.md` needs no tooling to be useful.

---

## The catalog

Start at **`marklogic`** — it's the router. It maps a goal to the MarkLogic-native
capability, names the tools that implement it, and points at the deeper skill.

| Skill | Reach for it when | Bundled files |
|---|---|---|
| **`marklogic`** | Any MarkLogic task where the right approach isn't obvious. Problem→capability table, the discovery-before-querying sequence, choosing between overlapping tools, what `ML_READONLY`/`ML_ALLOW_EVAL` hide, and the complete tool index. | — |
| **`marklogic-bulk-import`** | Loading data in bulk via Flux — HTTP/S3/local files, JDBC, RDF, CSV/JSON/JSONL/Parquet/Avro — open-data portals, generating a TDE at ingest, classifying at ingest, or bulk-transforming an existing collection. | 4 references: Socrata/open data, JSONL & API wrappers, reprocess transforms, Semaphore at ingest |
| **`marklogic-query-authoring`** | Composing any query, or triaging one that returns nothing or everything. Covers `ml_search` vs `ml_optic_query` vs `ml_values_query` vs `ml_sparql_query` vs `ml_vector_search`, index prerequisites, and `XDMP-ELEMRIDXNOTFOUND`. | 3 references: structured-query cookbook, NL→query, SPARQL & triples |
| **`marklogic-data-modeling`** | Modelling a new domain — documents vs triples vs vectors, URI schemes, collection layout, TDE view design, the envelope pattern for harmonizing multiple sources. | 1 reference: envelope pattern |
| **`marklogic-project-setup`** | The goal implies something repeatable or deployable — an app, an API, a new repo, indexes that must survive a rebuild, dev/prod config, CI/CD. Prefer this over the MCP write tools whenever the work should outlive the session. Covers the gradle task set, credential handling, and the REST resource-extension contract. | Complete ml-gradle template tree (30 files), `references/rest-extensions.md`, `references/gradle-tasks.md` |
| **`marklogic-server-side-code`** | Writing or debugging SJS/XQuery modules, REST resource extensions, CTF transforms, Flux reader/transform pairs, or TDE JSON templates. Covers the `declareUpdate()` placement trap, TDE syntax errors, and application coding practices — query bindings vs concatenation, eval vs invoke vs spawn, amps, transactions, unit tests. | `references/coding-practices.md` |
| **`marklogic-rag`** | Building RAG or semantic search on MarkLogic 12 — Lexical (BM25), Vector (cosine/ANN, hybrid via `vec.vectorScore`), and Graph RAG; embedding storage, TDE vector columns, reranking, chunking. | 1 reference: retrieval patterns |
| **`marklogic-performance`** | A query is slow or times out, or you're reading `ml_profile_query`/`ml_explain_optic` output, or forests look unhealthy. E-node/D-node split, filtered search, cache interpretation, when a range index is actually mandatory. | — |
| **`marklogic-fasttrack`** | Building a faceted search UI — designing the stored search options set that drives facets, timelines, and maps, then scaffolding the React app. Covers `XDMP-VALIDATEMISSINGATTR` on buckets. | — |
| **`marklogic-oauth-setup`** | Enabling OAuth2/OIDC bearer auth on an app server, or debugging "token authenticates but has no roles". Requires MarkLogic 11+. | 1 reference: OAuth configuration |
| **`semaphore-integration`** | Wiring Semaphore to MarkLogic — choosing between ingest-time classification, reprocess enrichment, a REST transform, or a DHF pipeline; CLS/KMM config; the enrichment module; facet indexes. | 1 reference: enrichment module |
| **`semaphore-taxonomy`** | Authoring, loading, validating, and publishing SKOS taxonomies in KMM. Covers the SKOS-XL reification step behind "No preferred labels" and plain-SKOS vocabularies (UNESCO, EuroVoc, AGROVOC, IPTC). | 1 template: taxonomy skeleton (Turtle) |
| **`semaphore-classification-tuning`** | Classification results are *wrong* rather than the taxonomy being wrong — false positives, missed matches, flat scores, nearlist noise. The three fix levels: concept labels → threshold → `.kid` template weights. | 1 reference: 8 symptom playbooks |

`npm run validate:skills` prints this roster with description and body sizes.

---

## Using them

Skills are **model-invoked**. You do not call them; you describe the goal and the agent
loads what matches. That is the entire point of the migration away from advisor prompts —
a prompt only fires when a human already knows to ask for it by name.

```
"Load the Chicago crime dataset from the city's open data portal into MarkLogic."
    → marklogic router → marklogic-bulk-import → references/socrata-and-open-data.md

"Why does this Optic query take 40 seconds?"
    → marklogic-performance

"Set up a project for this so we can deploy it to staging."
    → marklogic-project-setup (and its templates/ tree)

"Our classifier keeps tagging press releases as legal filings."
    → semaphore-classification-tuning → references/symptom-playbooks.md
```

You can also name one explicitly — *"use the marklogic-rag skill"* — which is worth
doing when you know exactly which one you want, or when a skill isn't firing on its own.

### Skills, tools, prompts, resources — which is which

| Surface | Invoked by | Cost | Holds |
|---|---|---|---|
| **Tools** (103) | the model, at will | schema + description on **every** request | the actual MarkLogic calls |
| **Skills** (13) | the model, when the task matches | ~500 chars each until loaded | how-to guidance, recipes, failure modes |
| **Prompts** (3) | a human, by name | listed but not resident | narrow one-shot flows |
| **Resources** (6) | the client, on request | nothing until read | live cluster state + the routing fallback |

The rule the repo follows: if something takes arguments and turns them into *text*, it's
a skill, not a tool — a tool would charge every request for schema it rarely uses.

---

## What moved here

PR #29 removed five tools and 22 prompts that only ever returned advice. If you had a
workflow pinned to one of these, here's where it went.

**Tools removed** (109 → 103) — these performed no I/O against MarkLogic; they turned
arguments into text, which is what a skill does for free:

| Was | Now |
|---|---|
| `ml_suggest_approach` | `marklogic` skill (router table) |
| `ml_capabilities` | `marklogic` skill ("Complete tool index") |
| `ml_gradle_scaffold` | `marklogic-project-setup` skill (`templates/` tree) |
| `semaphore_taxonomy_scaffold` | `semaphore-taxonomy` skill (`templates/taxonomy-skeleton.ttl`) |
| `semaphore_kid_template_diagnose` | `semaphore-classification-tuning` skill |

**Prompts removed** — 25 prompts became 3:

| Was | Now |
|---|---|
| `problem_advisor` | `marklogic` |
| `query_approach_advisor`, `nl_to_search_query`, `structured_query_builder`, `optic_query_builder`, `sparql_query_builder` | `marklogic-query-authoring` |
| `xquery_function_generator`, `sjs_module_generator`, `tde_schema_generator`, `rest_extension_generator` | `marklogic-server-side-code` |
| `data_modeling_advisor`, `uri_designer`, `envelope_pattern_advisor` | `marklogic-data-modeling` |
| `data_import_advisor` | `marklogic-bulk-import` |
| `project_setup_advisor` | `marklogic-project-setup` |
| `rag_pipeline_designer` | `marklogic-rag` |
| `performance_advisor` | `marklogic-performance` |
| `fasttrack_search_designer`, `fasttrack_app_scaffold` | `marklogic-fasttrack` |
| `oauth_setup_advisor` | `marklogic-oauth-setup` |
| `semaphore_integration_advisor` | `semaphore-integration` |
| `semaphore_model_workflow` | `semaphore-taxonomy` |

Still prompts, because they're narrow one-shot flows a human invokes by name:
`gdelt_import`, `quicksight_dataset_designer`, `quicksight_dashboard_planner`.

---

## Authoring and contributing

A skill is a directory under `.claude/skills/` containing `SKILL.md`:

```markdown
---
name: marklogic-thing          # must equal the directory name; lowercase/digits/hyphens; ≤64 chars
description: What this covers and when to use it.   # ≤1024 chars — this is the trigger
---

# Title

Body in Markdown. Keep it under ~500 lines; push depth into references/.
```

Guidelines that matter in practice:

- **The `description` is the trigger.** It is the only part the model sees before
  deciding to load the skill, so write it as *what it covers and when to use it*,
  naming the symptoms and error codes someone would actually hit. Vague descriptions
  mean the skill never fires.
- **Split at ~500 lines.** Deep material goes in `references/*.md`, working files in
  `templates/`, and the SKILL.md body links to them by relative path.
- **Don't duplicate tool descriptions.** The tool description is the interface
  contract; the skill is the manual. See `CLAUDE.md` for the full rule.

Then:

```bash
npm run validate:skills   # spec compliance: frontmatter, name/dir match, dead reference links
npm test                  # includes the catalog sync guard below
```

Two guards keep this from rotting:

- `scripts/validate-skills.mjs` enforces the spec constraints and fails if a SKILL.md
  links to a `references/` or `templates/` file that doesn't exist.
- `tests/skills/skills-catalog.test.ts` fails the build if a skill directory is added or
  removed without updating this catalog, the README table, and the `AGENT SKILLS`
  section of `marklogic://instructions`.

Both run in CI.

---

## Troubleshooting

**The agent ignored a skill it should have used.**
Check it's actually visible — `/skills` in Claude Code, or ask the agent to list them.
If it's present but idle, the description probably doesn't name the symptom you
described; either name the skill explicitly for now, or widen the description and send a
PR. Descriptions are the trigger surface, and they're meant to be tuned.

**`/skills` shows nothing.**
Skills are read at session start. Restart the session. If you installed with
`--project`, confirm you started the agent from that directory — Claude Code looks for
`.claude/skills/` relative to the project root, not the MCP server's location.

**Copilot CLI's `/skills list` is empty after `--user`.**
Expected: `~/.claude/skills` is Claude-specific. Copilot CLI takes personal skills from
`~/.copilot/skills` or `~/.agents/skills` — re-run with `--dest ~/.copilot/skills`, then
`/skills reload`. Project-level `.claude/skills` *is* read by both.

**The guidance contradicts what the server does.**
The skills describe this server's tool surface. If you're pointed at a different or
older deployment, trust `marklogic://instructions` from the live server. File an issue
if the two disagree against the same version.

**A skill references a tool that doesn't exist.**
Most likely `ML_READONLY=true` or `ML_ALLOW_EVAL=false` — write and eval tools are not
registered at all under those flags, rather than failing when called. The `marklogic`
skill's "Safety flags change which tools exist" section lists exactly what disappears.

**I edited a skill and nothing changed.**
If you installed copies with `npm run skills:install`, you're editing the source, not
the copy the agent reads. Re-run with `--force`, or edit the installed copy directly.
