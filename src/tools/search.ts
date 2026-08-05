import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { appendRangeIndexHint, toToolError } from "../utils/errors.js";
import {
  aggregateByField,
  projectRow,
  type ProjectedRow,
} from "../utils/projection.js";

export function registerSearchTools(server: McpServer, clients: MarkLogicClients): void {
  server.tool(
    "ml_search",
    "Full-text and structured search across MarkLogic documents. Accepts a string query (q, universal index) or a JSON structured query (structured_query, field-scoped).\n\n" +
    "PICKING THE FORM: q= matches a word anywhere in the document and over-matches for field-scoped questions. A value-query on a json-property gives exact field-scoped matching and needs NO range index. A word-query gives tokenised text in one field. Only range-query (GE/LE comparisons) requires a range index.\n\n" +
    "PROJECTION: select_fields=[...] returns field values inline, so no follow-up ml_document_get is needed. distinct= and group_by=+count=true do single-call aggregation.\n\n" +
    "DISCOVER FIRST: ml_search_surface (fields + indexes + options in one call) or ml_schema_discover — guessing field names is the most common cause of empty results.\n\n" +
    "GUIDANCE: the marklogic-query-authoring skill (references/structured-query-cookbook.md) has the full structured-query recipe set — value/word/range, multi-value OR, collection and directory scoping, and-query, not-query — plus empty-result triage.",
    {
      q: z.string().optional().describe("Full-text query string (Google-style syntax supported)"),
      structured_query: z.record(z.unknown()).optional().describe("MarkLogic structured query JSON object"),
      collection: z.string().optional().describe("Limit search to this collection URI"),
      directory: z.string().optional().describe("Limit search to documents under this directory path"),
      start: z.number().int().positive().optional().describe("Pagination start position (default: 1)"),
      page_length: z.number().int().positive().max(200).optional().describe("Results per page (default: 10, max 200 when select_fields is used)"),
      options: z.string().optional().describe("Named search options node configured on the server"),
      database: z.string().optional().describe("Database to search. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
      select_fields: z.array(z.string()).optional().describe(
        "Field paths to project from each matched document. Each result becomes a flat row " +
        "with the requested fields plus uri/score. Paths support dot navigation and a leading " +
        "'*' for recursive search."
      ),
      distinct: z.string().optional().describe(
        "Return distinct values of this field with their document count instead of per-document rows. " +
        "Cannot be combined with group_by."
      ),
      group_by: z.string().optional().describe(
        "Group matched documents by this field; combined with count=true returns a frequency table. " +
        "Cannot be combined with distinct."
      ),
      count: z.boolean().optional().describe(
        "When grouping or projecting, include per-group counts. Implied by `distinct` and `group_by`."
      ),
      normalize_whitespace: z.boolean().optional().describe(
        "Collapse runs of whitespace in projected/grouped values (default: false). Useful when extracting from XML mixed content."
      ),
      response_mode: z.enum(["inline_summary", "paged", "full"]).optional().describe(
        "How to render the response. inline_summary (default): tabular + truncated to first 50 rows for readability. " +
        "paged: full rows for the requested page. full: same as paged, kept for API symmetry."
      ),
    },
    async ({
      q,
      structured_query,
      collection,
      directory,
      start,
      page_length,
      options,
      database,
      select_fields,
      distinct,
      group_by,
      count,
      normalize_whitespace,
      response_mode,
    }) => {
      if (distinct && group_by) {
        return {
          content: [{ type: "text", text: "Pass either distinct or group_by, not both." }],
          isError: true,
        };
      }

      const aggField = distinct ?? group_by;
      const wantProjection = !!select_fields?.length || !!aggField;
      const effectivePageLength = page_length ?? (wantProjection ? 50 : 10);

      try {
        const result = await clients.search.search({
          q,
          structuredQuery: structured_query,
          collection,
          directory,
          start,
          pageLength: effectivePageLength,
          options,
          database,
        });

        // Default path (no projection / no aggregation): preserve historical
        // behaviour so existing callers and tests stay working.
        if (!wantProjection) {
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        // Projection / aggregation path: fetch the matched documents and
        // assemble flat rows.
        const fields = new Set<string>(select_fields ?? []);
        if (aggField) fields.add(aggField);
        const uris = result.results.map((r) => r.uri);
        const docs = await clients.search.fetchDocs(uris, database);

        const rows: ProjectedRow[] = result.results.map((r) =>
          projectRow(r.uri, docs.get(r.uri), Array.from(fields), {
            normalizeWhitespace: normalize_whitespace,
            score: r.score,
          })
        );

        if (aggField) {
          const aggregated = aggregateByField(rows, aggField, {
            normalizeWhitespace: normalize_whitespace,
          });
          const payload = {
            total: result.total,
            sampled: rows.length,
            aggregation: distinct ? "distinct" : "group_by",
            field: aggField,
            values: aggregated,
            note:
              rows.length < result.total
                ? `Aggregation covers the first ${rows.length} matches of ${result.total}. ` +
                  `Increase page_length to widen the sample.`
                : undefined,
          };
          return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
        }

        const mode = response_mode ?? "inline_summary";
        const visibleRows = mode === "inline_summary" ? rows.slice(0, 50) : rows;
        const payload: Record<string, unknown> = {
          total: result.total,
          start: result.start,
          pageLength: result.pageLength,
          fields: Array.from(fields),
          rows: visibleRows,
        };
        if (count) payload.count = result.total;
        if (mode === "inline_summary" && rows.length > visibleRows.length) {
          payload.truncated = `Showing first ${visibleRows.length} of ${rows.length} rows on this page. ` +
            `Pass response_mode='paged' for the full page.`;
        }
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_search_qbe",
    "Query By Example — find MarkLogic documents that match an example document structure.",
    {
      qbe: z.record(z.unknown()).describe("Example document structure to match against"),
      start: z.number().int().positive().optional().describe("Pagination start (default: 1)"),
      page_length: z.number().int().positive().max(100).optional().describe("Results per page (default: 10)"),
      database: z.string().optional().describe("Database name. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
    },
    async ({ qbe, start, page_length, database }) => {
      try {
        const result = await clients.search.qbe(qbe, { start, pageLength: page_length, database });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_values_query",
    "Return distinct values (plus frequency and optional aggregate) from a single range-indexed field. " +
    "Use this for: value-frequency lists (\"top 20 categories by count\"), simple numeric aggregates on a " +
    "field (sum/avg/min/max/stddev over a range index), and fast counting without scanning documents.\n\n" +
    "WHEN TO PICK THIS vs ALTERNATIVES:\n" +
    "  • ml_values_query  → no TDE needed; one field; fastest for simple frequency / 1D aggregate.\n" +
    "  • ml_search distinct=… → no range index needed; samples up to page_length matched docs.\n" +
    "  • ml_facets_query  → multiple facets at once; requires search options with facet constraints.\n" +
    "  • ml_optic_query   → GROUP BY across multiple columns, joins, or tabular SELECT — requires TDE view.\n" +
    "  • ml_aggregate_query → single-row totals across filtered documents (no grouping).\n\n" +
    "PREREQUISITES:\n" +
    "  1. Range index on the target field — check with ml_indexes_list.\n" +
    "  2. A named values definition in a search-options set that references the index.\n" +
    "     Inspect with ml_search_options_get; create with ml_search_options_put.\n" +
    "  3. If options is omitted, the default app-services options set is used (which typically has\n" +
    "     no values defined — you'll get an empty result). Always pass an explicit options name.",
    {
      values_name: z.string().describe("Named values/tuples definition configured in search options"),
      query: z.string().optional().describe("Constraining search query to filter values"),
      limit: z.number().int().positive().max(1000).optional().describe("Maximum values to return (default: 20)"),
      direction: z.enum(["ascending", "descending"]).optional().describe("Sort direction (default: descending by frequency)"),
      aggregate: z.string().optional().describe("Aggregate function: sum, count, avg, min, max, stddev"),
      options: z.string().optional().describe("Named search options node that contains the values definition (deploy via ml_search_options_put)"),
      database: z.string().optional().describe("Database name. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
    },
    async ({ values_name, query, limit, direction, aggregate, options, database }) => {
      try {
        const result = await clients.search.values(values_name, { query, limit, direction, aggregate, options, database });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: appendRangeIndexHint(toToolError(err)) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_geospatial_search",
    "Find MarkLogic documents within a geospatial region — circle (radius from a point), bounding box, or polygon. " +
    "For JSON documents: requires a geospatial JSON property pair index (geospatial-json-property-pair type in ml_indexes_list). " +
    "For XML documents: requires a geospatial element pair index. " +
    "Call ml_indexes_list with index_type='geospatial' first to confirm the index type and property names.",
    {
      region_type: z.enum(["circle", "box", "polygon"]).describe("Shape of the search region"),
      // Circle params
      center_lat: z.number().min(-90).max(90).optional().describe("Center latitude (required for circle)"),
      center_lon: z.number().min(-180).max(180).optional().describe("Center longitude (required for circle)"),
      radius_km: z.number().positive().optional().describe("Search radius in kilometres (required for circle)"),
      // Box params
      south: z.number().min(-90).max(90).optional().describe("Southern latitude bound (required for box)"),
      west: z.number().min(-180).max(180).optional().describe("Western longitude bound (required for box)"),
      north: z.number().min(-90).max(90).optional().describe("Northern latitude bound (required for box)"),
      east: z.number().min(-180).max(180).optional().describe("Eastern longitude bound (required for box)"),
      // Polygon params
      points: z.array(z.object({
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
      })).optional().describe("Polygon vertices as [{lat, lon}] array (required for polygon; first and last point should be the same to close the ring)"),
      // Index parameters
      parent_property: z.string().optional().describe("JSON property name of the parent object containing lat/lon (default: 'location'). Must match the geospatial element pair index."),
      lat_property: z.string().optional().describe("JSON property name for latitude within parent (default: 'latitude'). Must match the index."),
      lon_property: z.string().optional().describe("JSON property name for longitude within parent (default: 'longitude'). Must match the index."),
      // Scope
      collection: z.string().optional().describe("Limit search to this collection URI"),
      page_length: z.number().int().positive().max(100).optional().describe("Max results to return (default: 10)"),
      database: z.string().optional().describe("Database name. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
    },
    async ({ region_type, center_lat, center_lon, radius_km, south, west, north, east, points,
             parent_property, lat_property, lon_property, collection, page_length, database }) => {
      try {
        const parentName = parent_property ?? "location";
        const latName = lat_property ?? "latitude";
        const lonName = lon_property ?? "longitude";

        // Build the geo-elem-pair-query region
        let region: Record<string, unknown>;
        if (region_type === "circle") {
          if (center_lat == null || center_lon == null || radius_km == null) {
            return { content: [{ type: "text", text: "circle requires center_lat, center_lon, and radius_km" }], isError: true };
          }
          region = { circle: { radius: radius_km, point: [{ latitude: center_lat, longitude: center_lon }] } };
        } else if (region_type === "box") {
          if (south == null || west == null || north == null || east == null) {
            return { content: [{ type: "text", text: "box requires south, west, north, and east" }], isError: true };
          }
          region = { box: [{ s: south, w: west, n: north, e: east }] };
        } else {
          if (!points?.length) {
            return { content: [{ type: "text", text: "polygon requires a points array" }], isError: true };
          }
          region = { polygon: [{ point: points.map(p => ({ latitude: p.lat, longitude: p.lon })) }] };
        }

        // Use JSON property pair query — the correct type for JSON documents.
        // If documents are XML, use "geo-elem-pair-query" with {ns:"", name:...} syntax instead.
        const geoQuery = {
          "geo-json-property-pair-query": {
            "parent-property": parentName,
            "lat-property": latName,
            "lon-property": lonName,
            ...region,
          },
        };

        const structuredQuery = collection
          ? { "and-query": { queries: [{ "collection-query": { uri: [collection] } }, geoQuery] } }
          : geoQuery;

        const result = await clients.search.search({
          structuredQuery,
          pageLength: page_length,
          database,
        });

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: toToolError(err) +
              "\nHint: ml_geospatial_search requires a geospatial element pair index on the parent/lat/lon properties. " +
              "Run ml_indexes_list with index_type='geospatial' to verify the index exists. " +
              "If no index exists, create one with ml_eval_javascript using the Admin module.",
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "ml_parse_query",
    "Parse a MarkLogic string-grammar query into a structured cts.query JSON object WITHOUT executing it. The result is in the same shape ml_search accepts via structured_query, so it can be piped straight through, stored, or edited first.\n\n" +
    "USE FOR: previewing how free text is interpreted, catching grammar errors before an expensive search, or canonicalising an LLM-written query.\n\n" +
    "⚠ PREREQUISITE: cts.parse requires a RANGE INDEX on every tagged binding; without one it fails with XDMP-ELEMRIDXNOTFOUND. For exact-value filtering on a non-indexed JSON property, skip this tool and pass a value-query structured_query directly to ml_search — the value index is on by default.\n\n" +
    "BINDINGS map tag names in qtext to range-indexed fields. Without them only AND/OR/NOT/NEAR, quoted phrases, parens, and bare words are recognised.\n\n" +
    "GUIDANCE: see the marklogic-query-authoring skill for the NL-to-query pipeline and index-requirement table.",
    {
      qtext: z.string().describe("String-grammar query text to parse, e.g. 'diabetes AND state:TX'"),
      bindings: z.record(z.object({
        type: z.enum([
          "json-property",
          "json-property-range",
          "element",
          "element-range",
          "path",
          "path-range",
          "field",
          "field-range",
        ]).describe("Reference type — see tool description for selection guidance"),
        name: z.string().describe("Indexed field name (or path expression for path types)"),
        scalar_type: z.string().optional().describe("Scalar type for range bindings: 'int', 'long', 'double', 'decimal', 'dateTime', 'date', 'string', etc."),
        namespace: z.string().optional().describe("XML namespace URI for element bindings (default: empty)"),
      })).optional().describe(
        "Tag→reference map. Keys are the tag names that appear in qtext before a colon. " +
        "Values describe the indexed field. Omit for boolean-only parsing."
      ),
      database: z.string().optional().describe("Database context for index resolution. Default: server's content DB. Projects have their own DBs — run ml_databases_list to discover them."),
    },
    async ({ qtext, bindings, database }) => {
      try {
        const results = await clients.eval.parseCtsQuery(qtext, bindings, database);
        // evalJavaScript returns an array of EvalResult entries; the cts.query payload is the first/only item.
        const first = results[0];
        const payload = first?.value ?? first;
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        const msg = appendRangeIndexHint(toToolError(err));
        const hint = msg.includes("XDMP-QUERY") || msg.includes("XDMP-PARSE")
          ? "\nHint: a grammar parse error usually means an unmatched quote, an unknown operator (only AND/OR/NOT/NEAR/-/+ are built in), or a tag without a matching binding. Run ml_parse_query without bindings to confirm the boolean structure parses, then add bindings one at a time."
          : msg.includes("CTSDIRQUERY") || msg.includes("scalar")
          ? "\nHint: a binding scalar_type may not match the underlying range index. Verify with ml_indexes_list — find the index and read its scalar-type. Common types: int, long, double, decimal, dateTime, date, string."
          : "";
        return { content: [{ type: "text", text: msg + hint }], isError: true };
      }
    }
  );

  server.tool(
    "ml_suggest",
    "Get search query autocomplete suggestions from MarkLogic based on a partial query string.",
    {
      partial_q: z.string().describe("Partial query string to complete"),
      limit: z.number().int().positive().max(50).optional().describe("Max suggestions to return (default: 10)"),
      options: z.string().optional().describe("Named search options node"),
      database: z.string().optional().describe("Database name. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
    },
    async ({ partial_q, limit, options, database }) => {
      try {
        const suggestions = await clients.search.suggest(partial_q, options, database, limit);
        return { content: [{ type: "text", text: JSON.stringify(suggestions, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );
}
