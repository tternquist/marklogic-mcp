/**
 * Behaviour guard for `validate-skills.mjs --check-links`.
 *
 * The link checker is the thing that keeps documentation links in the skills
 * from rotting silently, so its own skip rules and failure detection need to be
 * pinned down. It is exercised against a local fixture server rather than the
 * real doc hosts: the point is the checker's logic, and a test that reached out
 * to docs.progress.com would fail offline, in CI, and behind an egress policy.
 *
 * Covers: markdown-links-only collection, fenced-code and placeholder-host skip
 * rules, references/ file attribution, the HEAD -> GET fallback for HEAD-hostile
 * servers, HTTP-status failures, timeouts, and the exit code.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Async on purpose: a sync child process would block this process's event loop,
// and the fixture server runs on it.
const execFileAsync = promisify(execFile);

let server: http.Server;
let base: string;
let tmp: string;

// The validator is run once per mode and the output shared — each --check-links
// run pays the /slow timeout, so re-running it per assertion is pure latency.
let plain: { code: number; out: string };
let checked: { code: number; out: string };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    switch (req.url) {
      case "/ok":
        return void res.writeHead(200).end("ok");
      case "/gone":
        return void res.writeHead(404).end("nope");
      case "/headless":
        // Mimics a doc host that rejects HEAD but serves GET.
        return void (req.method === "HEAD" ? res.writeHead(403).end() : res.writeHead(200).end("ok"));
      case "/slow":
        return; // never responds — exercises the timeout path
      default:
        return void res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  tmp = mkdtempSync(path.join(os.tmpdir(), "skill-links-"));

  const skill = (name: string, body: string): string => {
    const dir = path.join(tmp, ".claude/skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), body);
    return dir;
  };

  skill(
    "good-skill",
    [
      "---",
      "name: good-skill",
      "description: fixture",
      "---",
      `Live [doc](${base}/ok) and [head-hostile](${base}/headless).`,
      "Placeholder [example](https://example.com/nope) must be skipped.",
      "Bare namespace http://marklogic.com/xdmp/tde must be skipped.",
      "",
      "```json",
      `{ "link": "[fenced](${base}/fenced-should-be-skipped)" }`,
      "```",
      "",
    ].join("\n")
  );

  const badDir = skill(
    "bad-skill",
    ["---", "name: bad-skill", "description: fixture", "---", `[dead](${base}/gone) and [hanging](${base}/slow)`, ""].join("\n")
  );
  mkdirSync(path.join(badDir, "references"));
  writeFileSync(path.join(badDir, "references", "extra.md"), `[also dead](${base}/gone?from=references)\n`);

  // Copy the real script, with a short timeout so /slow does not stall the suite
  // and without the 127.0.0.1 placeholder entry the fixture server would trip on
  // (example.com above still exercises the placeholder rule).
  const script = readFileSync("scripts/validate-skills.mjs", "utf8")
    .replace("const LINK_TIMEOUT_MS = 20000;", "const LINK_TIMEOUT_MS = 1500;")
    .replace('  "127.0.0.1",\n', "");
  mkdirSync(path.join(tmp, "scripts"));
  writeFileSync(path.join(tmp, "scripts/validate-skills.mjs"), script);

  plain = await runValidator([]);
  checked = await runValidator(["--check-links"]);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmp, { recursive: true, force: true });
});

async function runValidator(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["scripts/validate-skills.mjs", ...args], {
      cwd: tmp,
      encoding: "utf8",
    });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

describe("validate-skills --check-links", () => {
  it("counts links but does not resolve them without the flag", () => {
    expect(plain.code).toBe(0);
    // /ok, /headless, /gone, /slow, /gone?from=references — the fenced and
    // placeholder links are excluded.
    expect(plain.out).toMatch(/5 documentation links not checked/);
  });

  it("resolves links and fails the run when any is dead", () => {
    expect(checked.code).not.toBe(0);
    expect(checked.out).toContain(`✓ ${base}/ok`);
    expect(checked.out).toMatch(/✗ .*\/gone — HTTP 404/);
    expect(checked.out).toMatch(/✗ .*\/slow — unreachable \(timeout/);
  });

  it("falls back to GET when a host rejects HEAD", () => {
    expect(checked.out).toContain(`✓ ${base}/headless`);
  });

  it("names the references/ file a failing link came from", () => {
    expect(checked.out).toContain("references/extra.md");
  });

  it("skips placeholder hosts and links inside fenced code blocks", () => {
    expect(checked.out).not.toContain("example.com");
    expect(checked.out).not.toContain("fenced-should-be-skipped");
  });
});
