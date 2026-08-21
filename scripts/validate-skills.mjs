#!/usr/bin/env node
/**
 * Validate .claude/skills/<name>/SKILL.md against the Agent Skills spec
 * (https://agentskills.io/specification).
 *
 * Checks the two required frontmatter fields and their constraints:
 *   name        — <=64 chars, lowercase/digits/hyphens, no leading/trailing or
 *                 doubled hyphen, and must match the containing directory
 *   description — <=1024 chars, non-empty
 *
 * Also verifies that every references/ and templates/ file mentioned in a
 * SKILL.md actually exists, so progressive-disclosure links cannot rot.
 *
 * Cross-skill references are checked too: skills name their companions in bold
 * (**marklogic-bulk-import**), and an agent following such a pointer to a skill
 * that does not exist in this corpus is silently stranded. Every bold
 * **marklogic-…** / **semaphore-…** token in a SKILL.md or its references/
 * files must match a real skill directory.
 *
 * With --check-links, additionally resolves every external Markdown hyperlink
 * in the skills over the network. This is opt-in because it needs egress and
 * because vendors reorganise their doc sites on their own schedule — a red
 * build every time Progress moves a page would train people to ignore it.
 * Run it deliberately (locally, or on a scheduled job), not on every commit.
 *
 * Only Markdown hyperlinks — [label](https://…) — outside fenced code blocks
 * are checked. Bare URLs are skipped on purpose: most URL-shaped strings in
 * these skills are XML namespaces, collection URIs, and SPARQL prefixes
 * (http://marklogic.com/xdmp/tde, http://www.w3.org/2004/02/skos/core#) which
 * are identifiers, not pages, and would produce nothing but false failures.
 *
 * Note: Node's built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1
 * (Node >= 22.21). Behind a proxy, run:
 *   NODE_USE_ENV_PROXY=1 npm run validate:skills -- --check-links
 *
 * Exits non-zero on any violation. Run via `npm run validate:skills`.
 */
import fs from "fs";
import path from "path";

const ROOT = ".claude/skills";
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CHECK_LINKS = process.argv.includes("--check-links");
const LINK_TIMEOUT_MS = 20000;
const LINK_CONCURRENCY = 6;

/** Hosts that appear in illustrative links and are not expected to resolve. */
const PLACEHOLDER_HOSTS = new Set([
  "example.com",
  "example.org",
  "localhost",
  "127.0.0.1",
]);

const errors = [];
const summary = [];
const links = [];

/**
 * Markdown hyperlink targets outside fenced code blocks, http(s) only,
 * minus known placeholder hosts.
 */
function collectMarkdownLinks(text) {
  const prose = text.replace(/^```[\s\S]*?^```/gm, "");
  const found = new Set();
  for (const m of prose.matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) {
    const url = m[1];
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (PLACEHOLDER_HOSTS.has(host)) continue;
    found.add(url);
  }
  return found;
}

/** Resolve one URL. Some doc hosts reject HEAD, so fall back to GET. */
async function resolveLink(url) {
  for (const method of ["HEAD", "GET"]) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), LINK_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        signal: ctl.signal,
        headers: { "user-agent": "marklogic-mcp-skill-link-check" },
      });
      if (res.ok) return { ok: true };
      // A HEAD-hostile server answers 403/405; retry once with GET before failing.
      if (method === "HEAD" && (res.status === 403 || res.status === 405)) continue;
      return { ok: false, reason: `HTTP ${res.status}` };
    } catch (err) {
      if (method === "GET") {
        const reason = err.name === "AbortError" ? `timeout after ${LINK_TIMEOUT_MS}ms` : err.message;
        return { ok: false, reason: `unreachable (${reason})` };
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: "unreachable" };
}

/** Check every collected link with a bounded worker pool. */
async function checkLinks() {
  const unique = [...new Map(links.map((l) => [l.url, l])).values()];
  const sourcesFor = (url) =>
    [...new Set(links.filter((l) => l.url === url).map((l) => l.source))].join(", ");

  console.log(`\nChecking ${unique.length} documentation link(s)...`);
  let cursor = 0;
  const failures = [];
  await Promise.all(
    Array.from({ length: Math.min(LINK_CONCURRENCY, unique.length) }, async () => {
      while (cursor < unique.length) {
        const { url } = unique[cursor++];
        const result = await resolveLink(url);
        if (result.ok) {
          console.log(`  ✓ ${url}`);
        } else {
          console.log(`  ✗ ${url} — ${result.reason}`);
          failures.push(`${url} — ${result.reason} (in ${sourcesFor(url)})`);
        }
      }
    })
  );
  return failures;
}

if (!fs.existsSync(ROOT)) {
  console.error(`No ${ROOT} directory found.`);
  process.exit(1);
}

/** Bold cross-references to companion skills, e.g. **marklogic-bulk-import**. */
const SKILL_REF_RE = /\*\*((?:marklogic|semaphore)-[a-z0-9-]+)\*\*/g;
const skillNames = new Set(
  fs
    .readdirSync(ROOT)
    .filter((d) => fs.statSync(path.join(ROOT, d)).isDirectory())
);

for (const dir of fs.readdirSync(ROOT).sort()) {
  const skillDir = path.join(ROOT, dir);
  if (!fs.statSync(skillDir).isDirectory()) continue;
  const file = path.join(skillDir, "SKILL.md");

  if (!fs.existsSync(file)) {
    errors.push(`${dir}: missing SKILL.md`);
    continue;
  }

  const raw = fs.readFileSync(file, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) {
    errors.push(`${dir}: missing YAML frontmatter delimited by --- at the very start`);
    continue;
  }

  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }

  const { name, description } = fm;

  if (!name) errors.push(`${dir}: frontmatter missing required field 'name'`);
  else {
    if (name.length > 64) errors.push(`${dir}: name is ${name.length} chars (max 64)`);
    if (!NAME_RE.test(name)) errors.push(`${dir}: name "${name}" must be lowercase letters/digits/hyphens, no leading, trailing or doubled hyphen`);
    if (name !== dir) errors.push(`${dir}: name "${name}" does not match its directory`);
  }

  if (!description) errors.push(`${dir}: frontmatter missing required field 'description'`);
  else if (description.length > 1024) errors.push(`${dir}: description is ${description.length} chars (max 1024)`);

  // Referenced support files must exist.
  const body = raw.slice(m[0].length);
  for (const ref of body.matchAll(/(?:references|templates)\/[A-Za-z0-9._/-]+/g)) {
    const p = path.join(skillDir, ref[0]);
    if (!fs.existsSync(p)) errors.push(`${dir}: references missing file ${ref[0]}`);
  }

  // External documentation hyperlinks, from the skill and its references/ files.
  const refDir = path.join(skillDir, "references");
  const linkSources = [{ label: `${dir}/SKILL.md`, text: body }];
  if (fs.existsSync(refDir)) {
    for (const f of fs.readdirSync(refDir).sort().filter((f) => f.endsWith(".md"))) {
      linkSources.push({
        label: `${dir}/references/${f}`,
        text: fs.readFileSync(path.join(refDir, f), "utf8"),
      });
    }
  }
  for (const src of linkSources) {
    for (const url of collectMarkdownLinks(src.text)) {
      links.push({ source: src.label, url });
    }
    // Companion-skill references must resolve to a skill in this corpus.
    const prose = src.text.replace(/^```[\s\S]*?^```/gm, "");
    for (const ref of prose.matchAll(SKILL_REF_RE)) {
      if (!skillNames.has(ref[1])) {
        errors.push(
          `${src.label}: references companion skill "${ref[1]}" which does not exist in ${ROOT}`
        );
      }
    }
  }

  summary.push({
    skill: dir,
    descChars: description ? description.length : 0,
    bodyChars: body.length,
    support: fs.existsSync(path.join(skillDir, "references"))
      ? fs.readdirSync(path.join(skillDir, "references")).length
      : 0,
    links: new Set(links.filter((l) => l.source.startsWith(`${dir}/`)).map((l) => l.url)).size,
  });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad("skill", 36)}${pad("desc", 7)}${pad("body", 8)}${pad("refs", 6)}links`);
for (const r of summary) {
  console.log(
    `${pad(r.skill, 36)}${pad(r.descChars, 7)}${pad(r.bodyChars, 8)}${pad(r.support, 6)}${r.links}`
  );
}

if (CHECK_LINKS) {
  for (const f of await checkLinks()) errors.push(`link: ${f}`);
} else {
  console.log(`\n(${new Set(links.map((l) => l.url)).size} documentation links not checked — pass --check-links to resolve them)`);
}

if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log(`\n✓ ${summary.length} skills valid against the Agent Skills spec.`);
