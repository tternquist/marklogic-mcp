import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { appendRangeIndexHint, toToolError } from "../utils/errors.js";
import { formatLintFindings, lintSjs } from "../utils/eval-lint.js";

export function registerEvalTools(server: McpServer, clients: MarkLogicClients, allowEval: boolean): void {
  if (!allowEval) return; // Tools not registered at all when eval is disabled

  server.tool(
    "ml_eval_xquery",
    "Execute an XQuery expression on the MarkLogic server and return results. Requires ML_ALLOW_EVAL=true.\n\n" +
    "COMMON XQUERY GOTCHAS:\n" +
    "• AMPERSAND IN STRINGS: '&' is an XML entity delimiter in XQuery. A URL like " +
    "'?view=status&format=json' causes XDMP-ENTITYREF. Use fn:concat() to build URLs " +
    "or escape as '&amp;' inside element constructors.\n" +
    "• xdmp:database-status() DOES NOT EXIST: Database-level status (in-memory-size, " +
    "reindex state) is only available via the Management REST API — use ml_database_statistics " +
    "instead. For forest-level status use xdmp:forest-status($forestId).\n" +
    "• xdmp:forest-counts() NESTED STRUCTURE: Fragment counts (active-fragment-count, " +
    "deleted-fragment-count) live under stands-counts/stand-counts, NOT at the forest " +
    "level. Only document-count is a direct child. Sum across stands: " +
    "fn:sum($fc//fs:active-fragment-count). Use ml_forest_metrics instead for a simpler interface.\n" +
    "• xdmp:merge() SIGNATURE: Takes an <options xmlns=\"xdmp:merge\"> element, NOT a forest ID. " +
    "Forest IDs go inside <forests><forest>{$id}</forest></forests>. Use ml_force_merge for a simpler interface.\n" +
    "• xdmp:host-size() takes NO arguments — always returns the current host's size. " +
    "For a specific host, use xdmp:host-status($host)/*:host-size instead.",
    {
      xquery: z.string().describe("XQuery expression to evaluate on the server"),
      vars: z.record(z.unknown()).optional().describe("External variable bindings as key/value pairs"),
      database: z.string().optional().describe("Target database. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
    },
    async ({ xquery, vars, database }) => {
      try {
        const results = await clients.eval.evalXQuery(xquery, vars as Record<string, unknown> | undefined, database);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: appendRangeIndexHint(toToolError(err)) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_eval_javascript",
    "Execute Server-Side JavaScript (SJS) on the MarkLogic server and return results. Requires ML_ALLOW_EVAL=true.\n\nNOT recommended for bulk data import, URL ingestion, or loading more than ~5 documents at once — use flux_import instead, which handles HTTP fetch, format parsing, batching, and optional TDE generation natively in a single call. NOT recommended for write-heavy batch operations — use ml_document_put for individual documents or flux_import for any bulk load.\n\nBest for: server-side computation, calling MarkLogic built-ins (xdmp.*, cts.*) not exposed by other tools, custom in-database transformations, and small one-off reads/writes.\n\nCAP ABILITIES: server-side-logic, xdmp-access, cts-access, custom-transformation\n\nTips:\n- Use Array.from() instead of .toArray() on MarkLogic sequences\n- xdmp.httpGet() / xdmp.httpPost() require outbound network access from the MarkLogic host and may fail for some HTTPS endpoints with SSL SNI errors (tlsv1 unrecognized name) due to MarkLogic's embedded Java SSL client — if you need to call an external HTTPS API, fetch the data via WebFetch and load it via ml_document_put or ml_eval_javascript with vars instead\n- Object literal syntax: returning { key: val } as the last expression is a SyntaxError — JavaScript parses it as a block statement. Use var r = { key: val }; r or wrap in parens: ({ key: val })\n- Inline large data (e.g. column name arrays) as variables via the vars parameter rather than literals in the script to stay under the ~10 KB payload limit\n- Prefer XQuery eval for collection/metadata operations\n- PERMISSIONS: Always use explicit xdmp.permission('role','capability') calls for writes — xdmp.defaultPermissions() is unreliable in the eval context and will cause opaque HTTP 500 errors\n- BULK TRANSFORMS: Combining declareUpdate() with cts.search() iteration in a single eval transaction can cause 500 errors for large collections. For bulk field renames or transforms, write a module to the Modules DB (ml_document_put + database='Modules') and run it via flux_reprocess (preferred for > ~1 000 docs) or ml_invoke_module\n- xdmp.invoke() TRANSACTION ISOLATION: if the invoked module starts with declareUpdate(), call it from eval as xdmp.invoke('/path.sjs', null, {isolation: 'different-transaction', update: 'true'}) — otherwise the caller's query transaction blocks the update\n- xdmp.httpPost() BODY: the third argument must be a Node, not a string. Use new NodeBuilder().addText(str).toNode() to wrap a string body. Passing a raw string causes XDMP-ARGTYPE errors.\n- xdmp.httpPost() MULTIPART: CLS and other REST APIs require multipart/form-data. Build the body as a multipart string with a boundary, then wrap with NodeBuilder. Example: var BOUNDARY='----MLBound'; var body='--'+BOUNDARY+'\\r\\nContent-Disposition: form-data; name=\"field\"\\r\\n\\r\\n'+value+'\\r\\n--'+BOUNDARY+'--\\r\\n'; xdmp.httpPost(url, {headers:{'Content-Type':'multipart/form-data; boundary='+BOUNDARY}}, new NodeBuilder().addText(body).toNode())\n- IIFE PATTERN IN MODULES: When writing an SJS module to the Modules DB and invoking it, bare 'return' at the top level throws SyntaxError: Illegal return statement (strict-mode). Wrap ALL code in an IIFE: (function run() { ... })(). This is especially important for early-exit guard clauses like 'if (!doc) { return; }'\n- WRITING MODULES TO MODULES DB: Use ml_document_put (database='Modules', content_type='application/javascript') — do NOT use xdmp.documentInsert() in eval for this. The xdmp.documentInsert() cross-database write has a confusing arg signature (arg5 is xs:int? quality, not a database name) and will throw XDMP-ARGTYPE. ml_document_put also auto-runs a static syntax check on .sjs files.\n- RDF SEMANTICS: sem.rdfGet() does NOT exist in SJS (only XQuery). To load RDF from a URL server-side, use xdmp.httpGet() (watch for SSL SNI errors on HTTPS) or fetch via WebFetch + inject content through vars, then call sem.rdfParse(content, ['turtle']) and sem.rdfStore(triples). For loading Turtle/N-Triples files directly into a named graph use ml_graph_put instead.\n- sem.store() USAGE: call sem.store() with NO arguments to use the default triple store in sem.sparql(). sem.store('default') is INVALID — causes XDMP-OPTION: Invalid option 'default'. Use sem.store() or omit the store argument entirely.\n- Use fn.subsequence(cts.search(...), start, length) to page through results — do NOT pass {limit:N} as a third arg to cts.search() (that parameter is quality, not a limit)\n- OPTIC API: op.fromView(...).result() returns a MarkLogic Sequence, NOT an array. Always wrap with Array.from(q.result()) to materialize results — bare .result() as a final expression serializes as an empty string and returns no data\n- OPTIC VARIABLE NAME: Do NOT name your Optic plan variable 'plan' — this conflicts with an internal variable in optic-amped.sjs and causes ReferenceError: plan is not defined. Use 'q', 'query', 'myPlan', or any other name.\n- OPTIC ROW COUNT: op.fromView(...).count() does NOT exist. To count rows use groupBy with op.count: op.fromView('s','v').groupBy(null, op.count('n', op.col('someCol'))).result() — this returns [{n: 123}]. Passing null as the first arg to groupBy means 'no group-by key' (count all rows).\n- xdmp.httpPost() OPTIONS: the second argument is an options object with a nested 'headers' key: {headers: {'Content-Type': '...'}}. A flat object like {'Content-Type': '...'} causes XDMP-INVOPTNAM: Invalid option name.\n- OPTIC IN EVAL: 'op' is NOT a global — you must require it: var op = require('/MarkLogic/optic'); Then use op.fromView(...) etc. Prefer ml_optic_query for analytics queries — it handles the require, plan serialization, and result unwrapping automatically.\n- OPTIC JOINS — viewCol vs col: After a joinInner with aliases (op.fromView('s','v','e')), ALL subsequent operators (groupBy, where, select, orderBy) must use op.viewCol('e','colName'). Using op.col('e.colName') FAILS with SQL-NOCOLUMN. Result keys use the dotted form though: r['e.colName'].\n- OPTIC STRING VALUES ARE TEXT NODES: String columns from Optic .result() in SJS are MarkLogic text nodes, not native JS strings. Calling .split(), .indexOf(), .startsWith() etc. directly throws 'is not a function'. Always wrap with String(val) first: String(r['g.Themes']).split(';')\n- cts.search() SJS OPTIONS: valid string options include 'score-zero', 'score-simple', 'score-logtf', 'score-logtfidf', 'score-random', 'unfiltered', 'filtered', 'document-order', 'empties'. 'unfragmented' is NOT a valid SJS option (it's XQuery-only in some contexts). 'unfiltered' skips document-level verification — use it when false positives from index resolution are acceptable.",
    {
      javascript: z.string().describe("Server-Side JavaScript code to execute. Keep scripts concise — large inline literals can exceed the ~10 KB payload limit and return a bare HTTP 500. Pass large values via the vars parameter instead."),
      vars: z.record(z.unknown()).optional().describe(
        "Variable bindings injected into the script as top-level JavaScript variables. " +
        "Values are serialized to JSON by the /v1/eval endpoint and deserialized server-side — " +
        "each key becomes a top-level variable of the corresponding JS type.\n\n" +
        "PASSING PATTERNS:\n" +
        "  String:      vars: { name: 'Alice' }          → var name; // = 'Alice'\n" +
        "  Number:      vars: { limit: 100 }             → var limit; // = 100\n" +
        "  JSON array:  vars: { uris: ['/a.json', '/b.json'] }  → var uris; // = ['/a.json', '/b.json']\n" +
        "  JSON object: vars: { cfg: { threshold: 0.5 } }       → var cfg; // = { threshold: 0.5 }\n\n" +
        "IMPORTANT — values arrive already parsed: a string value is a JS string (not a JSON string " +
        "requiring JSON.parse). An array value is a JS array. Do NOT call JSON.parse() on vars " +
        "unless you intentionally passed a JSON string as a string value.\n\n" +
        "SIZE LIMITS: vars are included in the POST body alongside the script. Combined payload " +
        "limit is ~10 MB, but practical limits are lower because the server also needs to process " +
        "the script. Tested safe up to ~1–2 MB. For larger data, load it server-side via cts.doc() " +
        "or import via flux_import instead.\n\n" +
        "BATCH PATTERN: passing an array of URIs and processing them in one eval transaction " +
        "is practical for 10–50 documents. For 200+ documents in one transaction, expect timeouts " +
        "— break into batches or use flux_reprocess instead."
      ),
      database: z.string().optional().describe("Target database. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
    },
    async ({ javascript, vars, database }) => {
      // Preflight lint: catch a handful of well-known SJS pitfalls before
      // round-tripping to the server so the caller gets actionable hints
      // instead of an opaque HTTP 500.
      const findings = lintSjs(javascript);
      const hardErrors = findings.filter((f) => f.severity === "error");
      if (hardErrors.length) {
        return {
          content: [{
            type: "text",
            text:
              "Eval rejected by preflight lint (no request was sent):\n" +
              formatLintFindings(findings) +
              "\n\nFix the issue above and call ml_eval_javascript again. " +
              "If you believe the lint is wrong, you can bypass it by adjusting the code shape " +
              "(e.g. rename a variable, wrap an object literal in parens).",
          }],
          isError: true,
        };
      }
      const lintWarnings = formatLintFindings(findings);
      try {
        const results = await clients.eval.evalJavaScript(javascript, vars as Record<string, unknown> | undefined, database);
        const text = JSON.stringify(results, null, 2);
        return {
          content: [{ type: "text", text: lintWarnings ? `${lintWarnings}\n\n${text}` : text }],
        };
      } catch (err) {
        const msg = toToolError(err);
        // Range-index resolution failures get their own hint and skip the generic
        // XDMP branch below — "index deployed but reference not resolving" has a
        // specific fix (exact-match the configured index) the generic text buries.
        const withIdxHint = appendRangeIndexHint(msg);
        if (withIdxHint !== msg) {
          return { content: [{ type: "text", text: withIdxHint }], isError: true };
        }
        const is500 = err instanceof Error && msg.includes("500");
        if (is500) {
          const scriptKb = Math.round(Buffer.byteLength(javascript, "utf8") / 1024);
          // Try to extract a MarkLogic error code embedded in the response (often in an HTML body)
          // Detect JS-JAVASCRIPT SyntaxError — common when returning an object literal
          // as an expression statement: `{ key: val }` is parsed as a block, not an object.
          // Detect SQL-NOCOLUMN — common when using op.col('alias.col') instead of op.viewCol('alias','col') after a join
          if (msg.includes("SQL-NOCOLUMN") && msg.includes("Column not found")) {
            const colMatch = msg.match(/Column not found:\s*(\S+)/);
            const col = colMatch?.[1] ?? "unknown";
            return {
              content: [{
                type: "text",
                text: `${msg}\nHint: "${col}" was not resolved. After a joinInner with aliases (e.g. op.fromView('s','v','e')), use op.viewCol('e','colName') — NOT op.col('e.colName'). The dotted form only works in result row keys, not as Optic operator arguments.`,
              }],
              isError: true,
            };
          }
          // Detect 'is not a function' on Optic text node values — need String() coercion
          if (msg.includes("is not a function") && (msg.includes(".split") || msg.includes(".indexOf") || msg.includes(".startsWith") || msg.includes(".trim"))) {
            return {
              content: [{
                type: "text",
                text: `${msg}\nHint: String columns from Optic .result() are MarkLogic text nodes, not native JS strings. Wrap with String() before calling string methods: String(r['col']).split(';')`,
              }],
              isError: true,
            };
          }
          const isSyntaxErr = msg.includes("JS-JAVASCRIPT") && msg.includes("SyntaxError");
          if (isSyntaxErr) {
            return {
              content: [{
                type: "text",
                text: `${msg}\nHint: a bare object literal \`{ key: val }\` at the end of a script is parsed as a block statement, not a return value. Fix: assign to a variable (\`var r = {...}; r\`) or wrap in parens (\`({...})\`).`,
              }],
              isError: true,
            };
          }
          const mlCodeMatch = msg.match(/(XDMP-[A-Z][A-Z0-9]*)/);
          const mlCode = mlCodeMatch?.[1];
          if (mlCode) {
            return {
              content: [{
                type: "text",
                text: `${msg}\nHint: Error code ${mlCode} — check your script for undefined variables, type mismatches, missing modules, or permission issues.`,
              }],
              isError: true,
            };
          }
          return {
            content: [{
              type: "text",
              text: `${msg}\nHint: The script payload may be too large (~${scriptKb} KB). Move large inline values (arrays, strings) into the vars parameter and reference them by variable name in the script.`,
            }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    }
  );

  server.tool(
    "ml_sparql",
    "Execute a SPARQL query against the MarkLogic triple store using the sem:sparql() XQuery API. " +
    "Wraps your SPARQL in the required XQuery boilerplate and returns results as JSON.\n\n" +
    "USE THIS INSTEAD OF ml_eval_xquery when you need to run SPARQL — it handles all the boilerplate.\n\n" +
    "TRIPLE SOURCES:\n" +
    "  • Managed triples loaded via ml_graph_put or flux_import (RDF files)\n" +
    "  • TDE-projected triples from documents (once a TDE with 'triples' section is installed in Schemas DB)\n" +
    "  • Embedded 'triples' arrays in JSON documents (sem:triple format)\n\n" +
    "IMPORTANT — SPARQL vs ml_sparql_query:\n" +
    "  • ml_sparql_query (in graphs.ts) executes SPARQL directly via the MarkLogic SPARQL endpoint\n" +
    "  • ml_sparql (this tool) uses sem:sparql() inside an XQuery eval — same results but goes through\n" +
    "    the eval endpoint. Use ml_sparql_query for pure SPARQL; use ml_sparql when you need to\n" +
    "    combine SPARQL results with XQuery logic.\n\n" +
    "TDE-BACKED SPARQL:\n" +
    "  Once a TDE template with a 'triples' section is installed in the Schemas database, MarkLogic\n" +
    "  automatically projects triples from documents into the triple index. No extra setup is needed —\n" +
    "  just run your SPARQL query and it will find TDE-generated triples alongside managed triples.\n\n" +
    "EXAMPLES:\n" +
    "  SELECT ?title ?director WHERE {\n" +
    "    ?movie a schema:Movie ;\n" +
    "           schema:name ?title ;\n" +
    "           schema:director ?d .\n" +
    "    ?d schema:name ?director .\n" +
    "  }\n\n" +
    "  CONSTRUCT { ?movie schema:genre ?genre } WHERE { ?movie schema:genre ?genre }\n\n" +
    "Requires ML_ALLOW_EVAL=true.",
    {
      sparql: z.string().describe(
        "SPARQL query string. Include PREFIX declarations. " +
        "Supports SELECT, CONSTRUCT, ASK, DESCRIBE. " +
        "Use FROM NAMED <graph-uri> or GRAPH { } to scope to a specific named graph."
      ),
      bindings: z.record(z.unknown()).optional().describe(
        "Variable bindings to pass to the SPARQL query (mapped to sem:binding() calls). " +
        "Keys are variable names (without '?'), values are strings (treated as IRIs if they start with 'http')."
      ),
      database: z.string().optional().describe("Target database. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
    },
    async ({ sparql, bindings, database }) => {
      // Build the XQuery wrapper around sem:sparql()
      const bindingLines = Object.entries(bindings ?? {}).map(([k, v]) => {
        const val = typeof v === "string" && v.startsWith("http")
          ? `sem:iri("${v}")`
          : `"${String(v)}"`;
        return `sem:binding("${k}", ${val})`;
      });
      const bindingsArg = bindingLines.length > 0
        ? `(${bindingLines.join(", ")})`
        : "()";

      const xquery = `xquery version "1.0-ml";
import module namespace sem = "http://marklogic.com/semantics"
  at "/MarkLogic/semantics.xqy";

let $results := sem:sparql(
  ${JSON.stringify(sparql)},
  ${bindingsArg}
)
return
  array-node {
    for $row in $results
    return object-node {
      for $key in map:keys($row)
      return ($key, map:get($row, $key))
    }
  }`;

      try {
        const results = await clients.eval.evalXQuery(xquery, undefined, database);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        const msg = toToolError(err);
        return {
          content: [{
            type: "text",
            text: `${msg}\nHint: ensure the triple data exists (run ml_graphs_list or check TDE with ml_schema_get_tde). For TDE-backed triples, the template must be in the Schemas database (use ml_tde_install).`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "ml_invoke_module",
    "Invoke a stored XQuery or SJS module from the MarkLogic modules database. Requires ML_ALLOW_EVAL=true.\n\n" +
    "WHEN TO PICK THIS vs ALTERNATIVES:\n" +
    "  • flux_reprocess    → bulk transforms over many documents (parallel batching, preferred).\n" +
    "  • ml_document_patch → declarative edits to a single document (no module needed).\n" +
    "  • ml_extension_call → module deployed as a REST resource extension (stable API endpoint).\n" +
    "  • ml_invoke_module  → one-off diagnostic invocation of a module that is already deployed,\n" +
    "                        OR a custom orchestration that is NOT well-served by the above.\n\n" +
    "SJS EXTERNAL VARIABLES (ML 12): In ML 12, the `external` global does NOT exist in SJS modules. " +
    "Variables passed via the vars parameter are available as a JSON string via xdmp.getRequestField('vars'). " +
    "Pattern: var vars = JSON.parse(xdmp.getRequestField('vars') || '{}'); var myVar = vars.myVar || 'default'; " +
    "For XQuery modules, declare: declare variable $myVar external;",
    {
      module_uri: z.string().describe("URI of the stored module, e.g. /lib/transform.xqy"),
      vars: z.record(z.unknown()).optional().describe("Variable bindings to pass to the module (JSON object; in SJS access via JSON.parse(xdmp.getRequestField('vars')||'{}'))"),
      database: z.string().optional().describe("Content database. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
      modules_database: z.string().optional().describe("Modules database name (uses server default if omitted)"),
    },
    async ({ module_uri, vars, database, modules_database }) => {
      try {
        const results = await clients.eval.invokeModule(module_uri, vars as Record<string, unknown> | undefined, database, modules_database);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );
}
