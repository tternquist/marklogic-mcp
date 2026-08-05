---
name: semaphore-classification-tuning
description: Diagnose and fix Semaphore content-classification quality problems in MarkLogic — false positives, missed matches, uniform or low scores, hierarchy not propagating, nearlist noise, poor results on short text, ignored title zones, and over-firing associative links. Covers the three fix levels (concept labels, classify threshold, .kid Velocity template weights), zone-biasing, absence-firing rules, and the semaphore_kid_template_get/set and semaphore_concept_labels_update tools. Use when classification results are wrong rather than when the taxonomy structure is wrong.
---

# Semaphore Classification Tuning

## The three fix levels — always try them in order

| Level | Tool | Scope | Use when |
|---|---|---|---|
| **1. Labels** | `semaphore_concept_labels_update` | one concept | a *specific* concept fires wrongly or misses |
| **2. Threshold** | `semaphore_classify(threshold=…)` | one query | exploring precision/recall without changing the model |
| **3. Template** | `semaphore_kid_template_set` | **every concept** | the same scoring problem affects all concepts |

**The decisive question:** is the problem with *one concept* or with *scoring behaviour*?

A `.kid` template applies **identically to every concept in the model** — a weight
change moves all concepts equally. That makes it the right fix for systemic problems
and the wrong fix for a misbehaving concept.

**Practical trigger for reaching for level 3:** you find yourself wanting to make the
same label edit to many concepts for the same reason. That reason is a scoring
behaviour that belongs in the template.

Every change at any level requires `semaphore_publish` before it takes effect, then
`semaphore_classify` to verify.

## Symptom → action

Full step-by-step playbooks for all eight symptoms are in
`references/symptom-playbooks.md`. Summary:

| Symptom | Most likely cause | First move |
|---|---|---|
| `false_positives` | over-broad altLabel; nearlist on scattered words | inspect labels (`semaphore_concept_get`) |
| `missing_matches` | missing synonyms; threshold too high | add altLabels; drop threshold to 0 to see raw scores |
| `score_too_uniform` | evidence types weighted too evenly | raise `phraselist_weight`, lower `nearlist_weight` |
| `hierarchy_not_firing` | `lower_hierarchy_weight` too low, or no `skos:broader` links | verify hierarchy exists, then `preset=hierarchy_heavy` |
| `nearlist_noise` | multi-word labels matching scattered constituents | lower `nearlist_weight`, or `preset=precision` |
| `short_text_poor` | default weights assume long documents | `preset=short_text` |
| `zone_ignored` | no zone-biasing configured | set `title_weight` / `body_weight` |
| `associative_overfiring` | related-concept score propagation | `associative_cap=0` |

## What a .kid template actually is

A Velocity template that runs at **publish time**, controlling how the publisher turns
each SKOS concept into CLS classification rules. It defines which evidence types score
— exact phrases, near-word matches, child-concept firing, related-concept firing — and
how much each contributes. It compiles once per publish; the resulting `.rules` file is
what the CLS uses at classification time.

## Presets

| Preset | phrase | near | hierarchy | assoc | For |
|---|---:|---:|---:|---:|---|
| `balanced` | 20 | 50 | 60 | 50 / cap 30 | Semaphore default; general starting point |
| `short_text` | 60 | 20 | 40 | 0 | headlines, metadata, short snippets |
| `exact_only` | 100 | 0 | 0 | 0 | maximum precision, no inference |
| `precision` | 70 | 20 | 0 | 0 | high precision, no hierarchy |
| `hierarchy_heavy` | 20 | 30 | 90 | 40 / cap 20 | coarse topics, deep taxonomies |
| `entity` | 70 | 30 | 0 | 0 | named-entity style taxonomies |

Individual weight parameters override preset values when both are given.

## Individual weights

- **`phraselist_weight`** — exact phrase matches. Higher = literal mentions dominate.
- **`nearlist_weight`** — near-word matches. Higher = constituent words appearing near
  each other score more. **Requires multi-word labels** — single-word concepts score
  entirely via phraselist regardless of this value.
- **`lower_hierarchy_weight`** — child-concept firing crediting the parent.
- **`associative_weight`** / **`associative_cap`** — raw weight and the combine cap
  limiting total associative contribution.

## Zone-biasing

Setting `title_weight` / `body_weight` applies separate evidence combines per zone.
CLS zones come from document structure: title zone = `pos=1`, body zone = `pos=0`.

`title_weight=80, body_weight=20` makes a title phrase count 4× a body phrase.

Use when document structure is reliable — news articles, academic papers, product
descriptions. **Do not use** for plain-text blobs, RSS descriptions, or short snippets
with no distinct zones.

## Absence-firing with `not="1"` (advanced)

The CLS `not` attribute means **absence-firing**, not score reduction:

- `not="1"` fires when the pattern is **not** found → boosts true positives
- `not="1"` contributes 0 when the pattern **is** found → no effect on false-positive scores

To use it: add disqualifying-context words as `skos:hiddenLabel` via
`semaphore_kmm_sparql_update`, then supply custom `content` containing:

```xml
<phraselist pos="0" stem="1" weight="N" not="1" foreach="1" labeltypes="hiddenLabel" />
```

Publish and classify, then confirm the true/false-positive gap widened.

## Raw templates

Pass `content` with full `.kid` XML for a fully custom template. Start from the current
one via `semaphore_kid_template_get`. Needed for KID elements the weight presets do not
cover — `labeltypes` filtering, custom combine structures, pos-specific phraselist rules.

## Verification loop

1. Change (label / threshold / template)
2. `semaphore_publish`
3. `semaphore_classify` on a known true-positive **and** a known false-positive
4. Compare the score gap, not just the absolute scores

Keep a small fixed set of test documents. Absolute scores shift as the model changes;
the gap between right and wrong answers is the signal that matters.

## What CLS actually receives

Knowing the pipeline explains why the three levels behave differently. `semaphore_publish`
compiles each concept into rulebase files — XML documents of scoring rules — bundles
them into a single `.pak` archive, and sends that to CLS. CLS processes every published
rulebase into one rule network and evaluates it per document; a category is emitted when
its rule score exceeds the threshold carried on the request.

So the threshold is applied at *request* time and the rules at *publish* time. That is
the whole reason level 2 (`semaphore_classify(threshold=…)`) gives instant feedback
while levels 1 and 3 do nothing until the next `semaphore_publish` — and why exploring
with `threshold=0` to see raw scores costs nothing.

## Further reading

- [What is a rulebase?](https://docs.progress.com/bundle/semaphore-5-classification-server-rulebase/page/topics/classification-server-rulebase/rulebase.html)
  — rule structure, category rules, and how scores relate to the request threshold
- [The Classification & Language Service Client](https://docs.progress.com/bundle/semaphore-5-classification-and-language-service/page/topics/classification-and-language-service/the_command_line_client.html)
  — useful for reproducing a classification outside MarkLogic when isolating a problem
- [Semaphore documentation hub](https://docs.progress.com/category/semaphore-documentation)
