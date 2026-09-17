/**
 * Guidance-artifact sync guard. CLAUDE.md mandates that the two guidance
 * mechanisms — the marklogic://instructions resource (INSTRUCTIONS_TEXT) and
 * the problem_advisor prompt's Section 4 tool list — stay in sync with the
 * actually-registered tools. This drift recurred across three review passes;
 * this test makes it a build failure instead of a review finding.
 *
 * It registers the FULL tool surface (readonly=false, allowEval=true, DHF JAR
 * configured) against a capturing mock server, then asserts:
 *   1. every registered tool name appears in INSTRUCTIONS_TEXT
 *   2. every registered tool name appears in the problem_advisor prompt text
 *   3. every tool-shaped token mentioned in either text refers to a real
 *      registered tool or prompt (catches typos and stale names)
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { registerAllTools } from "../../src/tools/index.js";
import { registerAllPrompts } from "../../src/prompts/index.js";
import { INSTRUCTIONS_TEXT } from "../../src/resources/index.js";
import type { AppConfig } from "../../src/config/index.js";

/** Infinitely-chainable, callable, truthy stub: any property access or call
 *  returns another stub. Registration only reads flags off clients (e.g.
 *  semaphore.kmmConfigured) — handlers are never invoked in this test. */
function anyStub(): unknown {
  const fn = (): unknown => anyStub();
  return new Proxy(fn, {
    get: (_target, prop) => {
      // Keep primitive coercion safe if a register function logs a value.
      if (prop === Symbol.toPrimitive || prop === "toString") return () => "stub";
      return anyStub();
    },
    apply: () => anyStub(),
  });
}

function captureFullSurface() {
  const toolNames: string[] = [];
  const promptTexts = new Map<string, string>();

  const server = {
    tool: (name: string) => {
      toolNames.push(name);
    },
    prompt: (
      name: string,
      _desc: string,
      _schema: unknown,
      cb: (args: Record<string, string>) => { messages: Array<{ content: { text: string } }> }
    ) => {
      // Always record the name (used by the stale-token check). Rendering only
      // matters for problem_advisor; other prompts may require args of other
      // shapes (arrays, enums) that this generic stub doesn't satisfy.
      promptTexts.set(name, "");
      try {
        const result = cb({ goal: "g", entity_type: "e", primary_key_fields: "id" });
        promptTexts.set(name, result.messages.map((m) => m.content.text).join("\n"));
      } catch {
        /* args mismatch for non-advisor prompt — name still recorded */
      }
    },
  };

  // Most permissive config: every conditionally-registered tool must show up.
  const config = {
    safety: { readonly: false, allowEval: true },
    connection: {
      host: "localhost",
      port: 8000,
      managementPort: 8002,
      username: "u",
      password: "p",
      database: "Documents",
      ssl: false,
      rejectUnauthorized: true,
      authType: "digest",
      timeoutMs: 5000,
    },
    dhf: { clientJarPath: "/opt/dhf-client.jar" },
  } as unknown as AppConfig;

  registerAllTools(server as never, anyStub() as never, config);
  registerAllPrompts(server as never);

  return { toolNames, promptTexts };
}

const { toolNames, promptTexts } = captureFullSurface();

/** The `marklogic` router skill carries the exhaustive tool index that the
 *  problem_advisor prompt used to hold. The index itself lives in a
 *  references/ file for progressive disclosure — read straight from disk and
 *  concatenated, since skills are plain files, not module exports. */
const ROUTER_SKILL = ".claude/skills/marklogic/SKILL.md";
const ROUTER_TOOL_INDEX = ".claude/skills/marklogic/references/tool-index.md";
const routerSkillText =
  readFileSync(ROUTER_SKILL, "utf8") + "\n" + readFileSync(ROUTER_TOOL_INDEX, "utf8");

/** Word-boundary check so e.g. a mention of ml_search_qbe doesn't satisfy ml_search. */
function mentions(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(text);
}

describe("guidance-artifact sync (CLAUDE.md mandate)", () => {
  it("captured a plausible full tool surface", () => {
    expect(toolNames.length).toBeGreaterThan(100);
    expect(new Set(toolNames).size).toBe(toolNames.length);
    expect(routerSkillText.length).toBeGreaterThan(0);
  });

  it("every registered tool is mentioned in INSTRUCTIONS_TEXT", () => {
    const missing = toolNames.filter((name) => !mentions(INSTRUCTIONS_TEXT, name));
    expect(
      missing,
      `Tools registered but missing from INSTRUCTIONS_TEXT (src/resources/index.ts): ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("every registered tool is mentioned in the marklogic router skill", () => {
    const missing = toolNames.filter((name) => !mentions(routerSkillText, name));
    expect(
      missing,
      `Tools registered but missing from the tool index in ${ROUTER_SKILL} or ${ROUTER_TOOL_INDEX}: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("every tool-shaped token in the guidance texts refers to a real tool or prompt", () => {
    const known = new Set([...toolNames, ...promptTexts.keys()]);
    const tokenRe = /\b(?:ml|flux|dhf|semaphore)_[a-z0-9_]+\b/g;
    const stale = new Set<string>();
    for (const text of [INSTRUCTIONS_TEXT, routerSkillText]) {
      for (const match of text.matchAll(tokenRe)) {
        if (!known.has(match[0])) stale.add(match[0]);
      }
    }
    expect(
      [...stale].sort(),
      `Tool-shaped names mentioned in guidance texts that are not registered tools or prompts (typos or stale names?): ${[...stale].join(", ")}`
    ).toEqual([]);
  });
});
