import { describe, it, expect } from "vitest";
import { lintSjs, formatLintFindings } from "../../src/utils/eval-lint.js";

describe("lintSjs", () => {
  it("flags cts.search with {limit:N} as the third argument", () => {
    const findings = lintSjs("cts.search(cts.collectionQuery('x'), null, {limit: 10})");
    expect(findings.some((f) => f.severity === "error" && f.message.includes("limit"))).toBe(true);
  });

  it("flags op.fromView(...).count() as a non-existent method", () => {
    const findings = lintSjs("op.fromView('s','v').count()");
    expect(findings.some((f) => f.severity === "error" && f.message.includes(".count()"))).toBe(true);
  });

  it("warns about Optic variable named 'plan'", () => {
    const findings = lintSjs("var plan = op.fromView('s','v');");
    expect(findings.some((f) => f.message.includes("plan"))).toBe(true);
  });

  it("warns about xdmp.httpPost flat headers", () => {
    const findings = lintSjs("xdmp.httpPost('http://x', {'Content-Type': 'application/json'})");
    expect(findings.some((f) => f.message.includes("headers"))).toBe(true);
  });

  it("returns empty for clean code", () => {
    const code = "var q = op.fromView('s','v'); Array.from(q.result());";
    expect(lintSjs(code)).toEqual([]);
  });

  describe("interpolated query text", () => {
    it("warns when sem.sparql concatenates a value into the query", () => {
      const findings = lintSjs("sem.sparql('SELECT ?p WHERE { <' + subj + '> ?p ?o }')");
      expect(findings.some((f) => f.message.includes("sem.sparql"))).toBe(true);
      expect(findings.some((f) => f.hint.includes("bindings map"))).toBe(true);
    });

    it("warns when a template literal interpolates into the query", () => {
      const findings = lintSjs("sem.sparql(`SELECT ?p WHERE { <${subj}> ?p ?o }`)");
      expect(findings.some((f) => f.message.includes("sem.sparql"))).toBe(true);
    });

    it("warns when cts.parse builds its grammar from a value", () => {
      const findings = lintSjs("cts.parse('category:' + userValue)");
      expect(findings.some((f) => f.message.includes("cts.parse"))).toBe(true);
    });

    it("warns when xdmp.eval builds source from a value", () => {
      const findings = lintSjs('xdmp.eval(\'cts.search(cts.wordQuery("\' + term + \'"))\')');
      expect(findings.some((f) => f.message.includes("xdmp.eval"))).toBe(true);
    });

    it("accepts sem.sparql with a bindings map", () => {
      const code = "sem.sparql('SELECT ?p WHERE { ?s ?p ?o }', { s: sem.iri(subj) })";
      expect(lintSjs(code)).toEqual([]);
    });

    it("accepts cts.parse with a constraint bindings map", () => {
      const code = "cts.parse(userQuery, { category: cts.jsonPropertyReference('category') })";
      expect(lintSjs(code)).toEqual([]);
    });

    it("does not flag literal-to-literal concatenation used for line wrapping", () => {
      const code = "sem.sparql('SELECT ?p ' + 'WHERE { ?s ?p ?o }')";
      expect(lintSjs(code)).toEqual([]);
    });
  });
});

describe("formatLintFindings", () => {
  it("renders an empty string when no findings", () => {
    expect(formatLintFindings([])).toBe("");
  });

  it("counts errors and warnings", () => {
    const out = formatLintFindings([
      { severity: "error", message: "boom", hint: "fix" },
      { severity: "warning", message: "watch", hint: "see" },
    ]);
    expect(out).toContain("1 error");
    expect(out).toContain("1 warning");
  });
});
