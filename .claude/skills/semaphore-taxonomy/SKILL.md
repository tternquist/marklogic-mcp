---
name: semaphore-taxonomy
description: Author, load, validate, and publish SKOS taxonomies in Semaphore KMM for use with MarkLogic content classification. Use when creating a new taxonomy or concept scheme, writing or editing SKOS Turtle, loading plain SKOS vocabularies (UNESCO, EuroVoc, AGROVOC, IPTC), fixing "No preferred labels" in Semaphore Studio, managing concept labels (prefLabel/altLabel/hiddenLabel), or publishing a model so the Classification Server can use it. Covers the semaphore_kmm_*, semaphore_concept_*, semaphore_taxonomy_validate, and semaphore_publish tools.
---

# Semaphore Taxonomy Authoring

All of this runs through **this MCP server's `semaphore_*` tools** — no separate
Semaphore client, and no host/port/credential passed at call time. `semaphore_status`
(CLS) and `semaphore_studio_status` (KMM) are the connectivity checks; the `SEMAPHORE_*`
variables they mention are the MCP server's own config, not something the user sets in
their shell. See **semaphore-integration → Using Semaphore via MCP**.

## Build order (follow exactly — steps 5 and 6 are the ones people miss)

0. **Check connectivity** — `semaphore_status`, `semaphore_studio_status`
1. **Create the model** — `semaphore_kmm_model_create(name=…, default_namespace=…)`
   → model URI is `model:<Name>`
2. **Author the SKOS Turtle** — start from `templates/taxonomy-skeleton.ttl`
3. **Load it** — `semaphore_kmm_skos_load` with `skos_content=<turtle>`
4. **Validate structure** — `semaphore_taxonomy_validate`
5. **⚠ Add SKOS-XL reification — REQUIRED, immediately after loading**
6. **Fix plain-SKOS publish config** — `semaphore_publish_config_fix_plain_skos`
7. **Publish** — `semaphore_publish(wait_for_completion=true)`
8. **Confirm active** — `semaphore_publish_sets` shows the model (lowercased) as ACTIVE
9. **Verify** — `semaphore_classify(content=…, threshold=0)` on representative text

## ⚠ The ConceptScheme URI convention

The ConceptScheme URI **must** be `{namespace}{ModelId}Taxonomy`. For a model named
`Example` in namespace `http://example.com/tax/`, that is
`http://example.com/tax/ExampleTaxonomy`.

Get this wrong and the publish appears to succeed but emits **one rule** — for the
scheme root — instead of one per concept.

```turtle
@prefix ns: <http://example.com/tax/> .
ns:ExampleTaxonomy a skos:ConceptScheme ;
    skos:prefLabel "Example Taxonomy"@en ;
    skos:hasTopConcept ns:TopConcept1 .
```

## ⚠ SKOS only — no OWL

KMM supports SKOS, not OWL. Loading an OWL ontology yields **0 concepts** with no
obvious error. Convert first:

| OWL | SKOS |
|---|---|
| `owl:Class` | `skos:Concept` |
| `rdfs:subClassOf` | `skos:broader` |
| `owl:Ontology` | `skos:ConceptScheme` |

`sem:guid` is generated automatically by KMM during `semaphore_kmm_skos_load` — no
manual INSERT needed.

## Verifying a load

```
semaphore_kmm_sparql(model_uri="model:<Name>",
  query="PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
         SELECT (COUNT(?c) AS ?n)
         WHERE { GRAPH <urn:x-evn-master:<Name>> { ?c a skos:Concept } }")
```

The model's named graph is `urn:x-evn-master:<ModelName>`.

## Step 5: SKOS-XL reification (the "No preferred labels" fix)

Semaphore Studio manages **SKOS-XL** labels, not plain `skos:prefLabel` triples.
Without this step Studio shows *"No preferred labels"* / *"Create a preferred label"*
even though your `skos:prefLabel` triples loaded correctly.

```
semaphore_kmm_sparql_update  model_uri='<your-model>'
sparql='PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        PREFIX skosxl: <http://www.w3.org/2008/05/skos-xl#>
        INSERT { ?c skosxl:prefLabel ?n . ?n a skosxl:Label . ?n skosxl:literalForm ?l . }
        WHERE  { { ?c a skos:Concept } UNION { ?c a skos:ConceptScheme }
                 ?c skos:prefLabel ?l .
                 BIND(IRI(CONCAT(STR(?c),"/xlabels/",LANG(?l),"/pref/",ENCODE_FOR_URI(STR(?l)))) AS ?n)
                 FILTER NOT EXISTS { ?n a skosxl:Label } }'
```

This is idempotent — the `FILTER NOT EXISTS` guard makes re-running safe.

## Authoring rules

### ⚠ No `dcterms:*` on the ConceptScheme

KMM's domain/range validation rejects Dublin Core properties on
`skos:ConceptScheme` with *"Definition incomplete — domain or range not valid"*.

| Instead of | Use |
|---|---|
| `dcterms:description` | `skos:definition` |
| general notes | `skos:note` |
| `dcterms:created` | nothing — KMM tracks creation internally |

### Hierarchy vs synonyms

- `skos:narrower` / `skos:broader` = hierarchy (the child **is-a** the parent). Always
  write both directions.
- `skos:altLabel` = synonyms and abbreviations **for that concept only**.
- `skos:related` = cross-cutting association between sibling branches.

**Do not list narrower concept names as altLabels on the parent.** This is the single
most common authoring error and it produces false positives at classification time —
the parent concept fires on any document mentioning a child.

```turtle
WRONG:
  ex:Compute skos:altLabel "Virtual Machines", "Serverless" .

CORRECT:
  ex:Compute          skos:narrower ex:VirtualMachines .
  ex:VirtualMachines  skos:broader  ex:Compute ;
                      skos:altLabel "VM", "Virtual Machine" .
```

### Labels and language tags

Tag every label with a BCP 47 language (`@en`, `@fr`, `@de`, `@nl`). Untagged
literals are treated as a distinct language by Studio and will not match.

Every concept needs exactly one `skos:prefLabel` per language. Put synonyms,
abbreviations, and spelling variants in `skos:altLabel`; put disqualifying-context or
never-display terms in `skos:hiddenLabel`.

## Starting a new taxonomy

`templates/taxonomy-skeleton.ttl` is a working two-branch example with the correct
structure: a `skos:ConceptScheme` with `skos:hasTopConcept`, top concepts with
`skos:topConceptOf` + `skos:narrower`, and children with `skos:broader` + `skos:altLabel`.

Copy it, replace the namespace and prefix, and build out the branches. Then fill in
**meaningful** altLabels on each child — the skeleton's are placeholders, and a
taxonomy with no synonyms classifies poorly.

## Plain-SKOS vocabularies (UNESCO, EuroVoc, AGROVOC, IPTC)

Public SKOS files load without modification, but they arrive as plain SKOS and need
the same steps 5–7 as hand-authored taxonomies:

1. `semaphore_kmm_skos_load` the file
2. SKOS-XL reification (step 5 above)
3. `semaphore_publish_config_fix_plain_skos`
4. `semaphore_publish`

Skipping step 3 gives a model that publishes but returns no classification results.

## Editing an existing taxonomy

- `semaphore_concept_search` — find a concept URI by label
- `semaphore_concept_get` — inspect all labels on a concept
- `semaphore_concept_labels_update` — add/remove `altLabel` / `hiddenLabel`
- `semaphore_kmm_sparql` / `semaphore_kmm_sparql_update` — bulk changes

**Every label change requires a re-`semaphore_publish` before it affects
classification.** Verify with `semaphore_classify` afterwards.

If classification quality is the problem rather than structure, use the
**semaphore-classification-tuning** skill instead — label edits are only the first of
three fix levels.

## Common pitfalls

| Symptom | Cause |
|---|---|
| Only **1 rule** published | ConceptScheme URI does not match `{ns}{ModelId}Taxonomy`, or the plain-SKOS config fix was skipped |
| **0 concepts** after load | an OWL ontology was loaded instead of SKOS |
| Studio shows "No preferred labels" | SKOS-XL reification (step 5) not applied |
| Label/language check returns 0 | `prefLabel`s missing their `@en` (or correct) language tag |
| Publishes but classifies nothing | plain-SKOS publisher config not fixed |
| `score=0` right after publish | Rulenet index still building — wait 1–2 minutes and retry |
| Low rule count warning | run `semaphore_publish_diagnose`, then retry the publish |

Rule count should be roughly proportionate to concept count. A large mismatch means one
of the first two rows above.

## Authentication

KMM uses a separate credential path from the Classification Server. If
`semaphore_kmm_*` tools fail while `semaphore_classify` works, check
`SEMAPHORE_USERNAME` / `SEMAPHORE_PASSWORD` and the KMM port
(`SEMAPHORE_KMM_PORT`) rather than the CLS settings. KMM uses Java EE form auth, not
Basic auth.
