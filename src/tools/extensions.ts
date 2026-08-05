import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

export function registerExtensionTools(
  server: McpServer,
  clients: MarkLogicClients,
  readonly: boolean
): void {
  // ── Read tools (always available) ─────────────────────────────────────────

  server.tool(
    "ml_extension_list",
    "List all REST resource extensions deployed to MarkLogic. " +
    "Extensions live at /v1/resources/{name} and are managed at /v1/config/resources/{name}. " +
    "Use ml_extension_get to retrieve source code, ml_extension_call to invoke an extension.",
    {},
    async () => {
      try {
        const result = await clients.extensions.listExtensions();
        if (result.length === 0) {
          return { content: [{ type: "text", text: "No REST extensions deployed." }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_extension_get",
    "Retrieve the source code of a deployed REST resource extension. " +
    "Use ml_extension_list first to see available extension names.",
    {
      name: z.string().describe("Extension name (as shown by ml_extension_list)"),
    },
    async ({ name }) => {
      try {
        const code = await clients.extensions.getExtension(name);
        return { content: [{ type: "text", text: code }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_extension_call",
    "Invoke a deployed REST resource extension at /v1/resources/{name}. " +
    "GET extensions are read-safe; POST extensions may perform writes. " +
    "Call ml_extension_list first to see available extension names.\n" +
    "Pass params WITHOUT the rs: prefix — this tool adds the prefix MarkLogic requires " +
    "on the wire, so {department:'Engineering'} is sent as ?rs:department=Engineering.\n" +
    "GUIDANCE: see the marklogic-project-setup skill (references/rest-extensions.md).",
    {
      name: z.string().describe("Extension name"),
      method: z.enum(["GET", "POST"]).default("GET").describe("HTTP method to use"),
      params: z.record(z.string()).optional().describe(
        "URL query parameters as key/value string pairs, e.g. {department: 'Engineering', 'salary-min': '100000'}"
      ),
      body: z.record(z.unknown()).optional().describe(
        "Request body for POST extensions (sent as JSON)"
      ),
    },
    async ({ name, method, params, body }) => {
      try {
        const result = await clients.extensions.callExtension(name, method, params ?? {}, body);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: toToolError(err) +
              "\nHint: Check that the extension is deployed (ml_extension_list) and that " +
              "the module has no syntax errors (try ml_extension_get to inspect source code). " +
              "REST extensions run in the App Server's database context — ensure indexes " +
              "referenced in the extension exist (ml_indexes_list).",
          }],
          isError: true,
        };
      }
    }
  );

  // ── Write tools (gated on readonly) ───────────────────────────────────────

  if (!readonly) {
    server.tool(
      "ml_extension_put",
      "Deploy (or replace) a REST resource extension on MarkLogic. Requires ML_READONLY=false. " +
      "PUTs source to /v1/config/resources/{name}, which manages three asset files under " +
      "/marklogic.rest.resource/{name}/assets/ in the Modules DB — never write those by hand. " +
      "Exports must be uppercase (exports.GET, exports.POST); declareUpdate() is forbidden here " +
      "because the REST framework owns the transaction.\n" +
      "This leaves nothing on disk. For anything that must survive a rebuild or reach another " +
      "environment, scaffold an ml-gradle project instead.\n" +
      "GUIDANCE: see the marklogic-project-setup skill (references/rest-extensions.md).",
      {
        name: z.string().describe(
          "Extension name — becomes the URL path segment: /v1/resources/{name}"
        ),
        code: z.string().describe(
          "Complete SJS or XQuery module source code. SJS must export handlers via exports.GET, exports.POST, etc."
        ),
        language: z.enum(["javascript", "xquery"]).default("javascript").describe(
          "Module language (default: javascript)"
        ),
      },
      async ({ name, code, language }) => {
        try {
          await clients.extensions.putExtension(name, code, language);
          return {
            content: [{
              type: "text",
              text: `Extension '${name}' deployed successfully.\n` +
                    `Invoke with ml_extension_call: name='${name}', method='GET', params={...}\n` +
                    `REST URL: /v1/resources/${name}`,
            }],
          };
        } catch (err) {
          return {
            content: [{
              type: "text",
              text: toToolError(err) +
                "\nHint: Syntax errors in the module cause a 400 or 500 on deployment — check the " +
                "error message for line numbers. The marklogic-project-setup skill " +
                "(references/rest-extensions.md) has a working module and a failure table.",
            }],
            isError: true,
          };
        }
      }
    );

    server.tool(
      "ml_extension_delete",
      "Remove a deployed REST resource extension from MarkLogic. Requires ML_READONLY=false. " +
      "Deletes both the module from the Modules database and its registration. " +
      "Any client calling /v1/resources/{name} will receive 404 after deletion.",
      {
        name: z.string().describe("Extension name to delete"),
      },
      async ({ name }) => {
        try {
          await clients.extensions.deleteExtension(name);
          return { content: [{ type: "text", text: `Extension '${name}' deleted.` }] };
        } catch (err) {
          return { content: [{ type: "text", text: toToolError(err) }], isError: true };
        }
      }
    );
  }
}
