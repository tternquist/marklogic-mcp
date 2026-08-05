/**
 * Semaphore client — Classification Server (CLS) + Studio/KMM connectivity.
 *
 * Progress Data Platform: MarkLogic (storage/search) + Semaphore (taxonomy/classification).
 *
 * Connection model (mirrors MarkLogic pattern):
 *   SEMAPHORE_HOST      — hostname for both CLS and KMM
 *   SEMAPHORE_SCS_PORT  — Classification Server (CLS) port (default 5058)
 *   SEMAPHORE_KMM_PORT  — Studio / KMM port (default 5080)
 *   SEMAPHORE_USERNAME  — for KMM REST API authentication
 *   SEMAPHORE_PASSWORD  — for KMM REST API authentication
 *   SEMAPHORE_SSL       — use https (default false)
 *   SEMAPHORE_URL       — explicit CLS URL override (backward compat, takes precedence)
 *
 * CLS API summary (XML-based HTTP, port 5058 by default):
 *   GET  /?op=version                  → XML version string
 *   POST / (URL-encoded XML_INPUT)     → XML responses for admin ops
 *   POST / (URL-encoded body+threshold) → XML classification result
 *
 * Classification result format:
 *   <META name="<ClassName>" value="<CategoryLabel>" id="<uuid>" score="<float>"/>
 *
 * KMM / Studio API (port 5080 by default):
 *   Two-step Java EE form authentication:
 *     1. POST /j_security_check  (form: j_username, j_password) → JSESSIONID cookie
 *     2. GET  /api/token?lifeTime=86400   (with cookie)         → { tokenId: "<token>" }
 *   Use header  x-api-key: <token>  for all KMM REST calls.
 *
 *   Key KMM endpoints (all prefixed /kmm/api/):
 *     GET  specialgraph:system/teamwork:Tag/rdf:instance          → list models (JSON-LD)
 *     POST sys/sys:Model/rdf:instance  (Content-Type: application/ld+json)  → create model
 *     POST model:<Name>/sparql?checkConstraints=false&runEditRules=false
 *          (Content-Type: application/sparql-update)              → SPARQL UPDATE / LOAD
 *     GET  model:<Name>/sparql?query=<encoded-SELECT>             → SPARQL SELECT (XML)
 *     POST /kmm/api?path=publisher/model:<Name>/publish&async=true → trigger publish
 *     GET  /kmm/api/publisher/workspace/<encoded-uri>/config → ZIP config download
 *     POST /kmm/api/publisher/workspace/<encoded-uri>/config → ZIP config upload (multipart/form-data)
 *
 *   Model URIs use the prefix  urn:x-evn-master:  (shorthand: model:<Name>).
 *   To load third-party SKOS (IPTC, EuroVoc, AGROVOC etc.) always pass
 *     checkConstraints=false&runEditRules=false  — external vocabularies routinely
 *     use properties (e.g. ikos:hasFacet) that fail Semaphore's SHACL shapes.
 *
 *   PLAIN SKOS (no SKOS-XL): The default publisher config uses SKOS-XL reification
 *   for label lookups. Vocabularies that use plain skos:prefLabel (UNESCO, EuroVoc,
 *   AGROVOC, IPTC) need a patched publisher config. Use kmmPatchPublishConfigForPlainSkos()
 *   or the semaphore_publish_config_fix_plain_skos tool to apply the patch.
 *
 *   GRAPH CLAUSE REQUIRED: The publisher's SparqlEndpoint connects to a global SPARQL
 *   endpoint shared across all models. Each model's data lives in a named graph:
 *     urn:x-evn-master:{ModelName}  (e.g. urn:x-evn-master:IPTCMediaTopics)
 *   Without an explicit GRAPH clause in the label SPARQL queries, all queries hit the
 *   empty default graph and return zero rows — the publisher then generates only the
 *   auto-produced ConceptScheme root rule (1 rule total) instead of one rule per concept.
 *   kmmPatchPublishConfigForPlainSkos() now injects the correct GRAPH clause automatically.
 *
 *   PUBLISHER WORKSPACE LIFECYCLE (verified 2026-03-17):
 *     The publisher workspace is a ZIP stored on the Semaphore server filesystem.
 *     It does NOT need to be created manually in Studio.
 *
 *     CREATING A WORKSPACE: Triggering a publish (POST /kmm/api?path=publisher/{uri}/publish)
 *     creates the workspace automatically as a side effect, even if the model has no content.
 *     After the publish returns HTTP 200/202, GET /workspace/{uri}/config returns HTTP 200 + ZIP.
 *
 *     The kmmPatchPublishConfigForPlainSkos() method auto-detects a missing workspace and
 *     bootstraps it via an initial publish before uploading the patched config.
 *
 *     Workspace GET/POST endpoint:
 *       GET  /kmm/api/publisher/workspace/{encodedUri}/config → ZIP download (404 if not created yet)
 *       POST /kmm/api/publisher/workspace/{encodedUri}/config → ZIP upload (multipart/form-data)
 *     where {encodedUri} = encodeURIComponent("urn:x-evn-master:{ModelName}")
 *
 *   PUBLISHER ENVIRONMENTS (verified 2026-03-17):
 *     Semaphore publisher "environments" map named targets to sets of CLS/SES servers.
 *     They are configured once in Semaphore Studio: Admin → Publisher → Environments → Add.
 *     The publish API requires a named environment; if none is configured, publish fails.
 *
 *     ENVIRONMENT DISCOVERY: There is NO global list API (sempubpermissions:ClassificationServerEnvironment
 *     does not exist as an endpoint). Environments are stored per-model: when a user first publishes
 *     a model via Studio, the environment URI is written to:
 *       sys/{modelUri}/user:{username}  →  sempubpermissions:publishMaster
 *     kmmPublish() reads that value, and if absent for a new model, scans other models'
 *     sys records to borrow an existing environment URI and assigns it automatically.
 *
 *     ONE-TIME SETUP REQUIRED: At least one model must have been published via Studio once
 *     (to record the environment). After that, all subsequent models can be published fully
 *     via API with no Studio interaction.
 *
 *     To configure an environment pointing to the CLS (one-time only):
 *       Studio → Administration → Publisher → Classification Server Environments → Add
 *       Name: <any label>, Host: <cls-host>, Port: <cls-port>
 *
 * Flux classifier flags (for bulk classification at ingest time):
 *   --classifier-host <host>  --classifier-port <clsPort>  --classifier-path /
 *   Add --classifier-http when the CLS endpoint is plain HTTP (not HTTPS).
 *
 * NETWORK NOTE (Kubernetes):
 *   xdmp.httpPost() from MarkLogic pods may be blocked by network policy from
 *   reaching the CLS. Prefer Flux (which runs outside MarkLogic) for server-side
 *   classification, or pre-classify from the application tier before insertion.
 *
 * CLS language codes use an indexed format ("en1", "fr1" etc.) not ISO codes.
 * Use listClsLanguages() to discover available codes. The default is usually "en1".
 *
 * Publisher workspace notes (verified 2026-03-17 against Semaphore 5.10.1):
 *   - The workspace config endpoint uses a SINGLE-SLASH: /kmm/api/publisher/workspace/{uri}/config
 *     (an older note said double-slash — that was incorrect; double-slash returns HTTP 400)
 *   - New models have no workspace ZIP until the first publish is triggered via the API.
 *     The Studio Publisher tab is NOT required for workspace initialization.
 *     Triggering a publish (even with an empty model) creates the workspace as a side effect.
 *   - The publish trigger endpoint encodes model URI colons (%3A) but NOT slashes
 *     in the path parameter value: /kmm/api?path=publisher/model%3AName/publish
 */

import axios, { type AxiosInstance } from "axios";
import JSZip from "jszip";
import { logger } from "../utils/logger.js";
import type { SemaphoreConfig } from "../config/schema.js";

// ── Publisher config constants ────────────────────────────────────────────────

/**
 * Build the canonical "plain SKOS" publisher config XML for a given model.
 *
 * Uses AllConcepts + PlainSkosModel (plain skos:prefLabel / skos:altLabel SPARQL queries).
 * This is the same pattern that successfully published the UNESCO Thesaurus (4,408 rules).
 * LANGMATCHES matches @en, @en-US, @en-GB, and all English regional variants — required
 * for vocabularies like IPTC Media Topics (@en-US) and UNESCO Thesaurus (@en).
 * No SKOS-XL triples are required — plain skos:prefLabel labels are used directly.
 */
function buildPlainSkosPublisherXml(modelName: string): string {
  return PLAIN_SKOS_PUBLISHER_XML_TEMPLATE.replaceAll("{{MODEL_NAME}}", modelName);
}

const PLAIN_SKOS_PUBLISHER_XML_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
       xmlns="http://www.springframework.org/schema/beans"
       xsi:schemaLocation="http://www.springframework.org/schema/beans
       http://www.springframework.org/schema/beans/spring-beans.xsd" default-lazy-init="true">

  <bean class="com.smartlogic.workbench.publisher.Configuration">
    <property name="description" value="Publish to CS services only (plain SKOS labels)"/>
    <property name="environments">
      <list/>
    </property>
  </bean>

  <!-- PlainSkosModel: override label SPARQL queries to use plain skos:prefLabel / skos:altLabel.
       Required for vocabularies that store labels directly on the concept node (not SKOS-XL).
       The publisher requires exactly 4 SELECT columns for getPrefLabelsSparql:
         ?termUri, ?prefLabelUri, ?prefLabel, ?prefLabelRelationship
       For plain SKOS (no intermediate label node), bind ?termUri as ?prefLabelUri.

       CRITICAL — GRAPH clause: the publisher's SparqlEndpoint connects to a global SPARQL
       endpoint shared across all models. Each model's data lives in a named graph:
         urn:x-evn-master:{ModelName}  (the "master" branch graph)
       Without the explicit GRAPH clause all queries hit the empty default graph and return
       zero rows, producing only the auto-generated ConceptScheme root rule. -->
  <bean id="PlainSkosModel" parent="SparqlEndpoint">
    <property name="getPrefLabelsSparql">
      <value><![CDATA[
        PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        SELECT ?termUri ?prefLabelUri ?prefLabel ?prefLabelRelationship
        WHERE {
          GRAPH <urn:x-evn-master:{{MODEL_NAME}}> {
            BIND(skos:prefLabel AS ?prefLabelRelationship) .
            ?termUri skos:prefLabel ?prefLabel .
            FILTER(LANG(?prefLabel) = "en")
            BIND(?termUri AS ?prefLabelUri) .
          }
        }
      ]]></value>
    </property>
    <property name="getAltLabelsForwardSparql">
      <value><![CDATA[
        PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        SELECT DISTINCT ?termUri ?labelUri ?labelLiteral
        WHERE {
          GRAPH <urn:x-evn-master:{{MODEL_NAME}}> {
            ?termUri skos:altLabel ?labelLiteral .
            FILTER(LANG(?labelLiteral) = "en")
            BIND(?termUri AS ?labelUri) .
          }
        }
      ]]></value>
    </property>
  </bean>

  <bean class="com.smartlogic.publisher.Publisher">
    <property name="model" ref="PlainSkosModel"/>
    <property name="configurationSets">
      <list>
        <!-- AllConcepts: generates one CLS rule per skos:Concept.
             No rulebaseClass — let Semaphore auto-name the class from the model name. -->
        <bean parent="AllConcepts">
          <property name="languageCodes">
            <list><value>en</value></list>
          </property>
          <property name="outputProcessors">
            <list>
              <bean id="NamedEntityRules" parent="RulebaseWriterTemplate">
                <property name="templateFileName" value="ContextualCitation.kid"/>
              </bean>
              <ref bean="environmentCSWriter"/>
            </list>
          </property>
        </bean>
      </list>
    </property>
    <property name="modelUpdater" ref="OEUpdater"/>
  </bean>

  <!-- The following import lines import many default configuration settings
         that will not usually be altered.
         Therefore be careful editing anything below here -->
  <import resource="file:\${resources.directory}/import/ModelInterface.xml"/>
  <import resource="file:\${resources.directory}/import/ModelDefinition.xml"/>
  <import resource="file:\${resources.directory}/import/RulebaseStructure.xml"/>
  <import resource="file:\${resources.directory}/import/SESConfiguration.xml"/>
  <import resource="file:\${resources.directory}/import/ConfigurationSets.xml"/>

</beans>
`;

/**
 * ContextualCitation.kid — default Semaphore publisher template.
 * Generates CLS rules that fire on exact phrase matches and near-word matches of
 * preferred and alternative labels, with weighted contributions from related concepts.
 */
const CONTEXTUAL_CITATION_TEMPLATE = `<!-- Template: ContextualCitation.kid -->
<rulebase language="\${language.iso_code}">

\t<!--~~
\t\tThis rulebase is designed to look for citations of preferred and alternative labels
\t\tas well as contextual information from hierarchical and associative relationships.

\t\tMentions of all the words near each other have a weight of 50. If the mention is
\t\tand exact phrase mentions it has an additional weight of 20.
\t\tDirect descendants each contribute 60% of their weight if they are firing. All associative
\t\trelationships together contribute 50% of their weight, up to a total weight contribution of 30.

\t\tA single mention, exact or near group, is sufficient for the rulebase to fire.
\t\tIf the rulebase does not find direct evidence, the contribution of one highly scoring descendant
\t\tor 2 moderately scoring descendants is sufficient for the rulebase to fire.
\t\tContributions from associative relationships alone are never enough for the rulebase to fire.
\t-->\

\t<content>

\t\t<!-- Firing category -->
\t\t<category class="\${rulebaseClass}" name="\${resource.label}" id="\${resource.guid}">
\t\t\t<link label="link.\${rulebaseClass}.\${resource.label}.\${language.iso_code}.\${resource.guid}_FINAL"/>
\t\t</category>

\t\t<!-- Combine score from evidence and relationships -->
\t\t<combine label="link.\${rulebaseClass}.\${resource.label}.\${language.iso_code}.\${resource.guid}_FINAL" weight="100">
\t\t\t<!-- Direct evidence contribution -->
\t\t\t<link label="link.\${rulebaseClass}.\${resource.label}.\${language.iso_code}.\${resource.guid}_EVIDENCE"/>
\t\t\t<!-- Contributions of associative relationships -->
\t\t\t<combine weight="30">
\t\t\t\t<linklist label="link.\${rulebaseClass}.\${resource.label}.\${language.iso_code}.\${resource.guid}_EVIDENCE" weight="50" relationshiptypes="Associative"/>
\t\t\t</combine>
\t\t\t<!-- Contributions of direct descendants -->
\t\t\t<combine weight="100">
\t\t\t\t<linklist label="link.\${rulebaseClass}.\${resource.label}.\${language.iso_code}.\${resource.guid}_EVIDENCE" weight="60" relationshiptypes="LowerInHierarchy"/>
\t\t\t</combine>
\t\t</combine>

\t\t<!-- Evidence lookup -->
\t\t<combine label="link.\${rulebaseClass}.\${resource.label}.\${language.iso_code}.\${resource.guid}_EVIDENCE" weight="100">
\t\t\t<!-- All labels, as phrases, anywhere in the document-->
\t\t\t<phraselist pos="0" stem="1" weight="20" foreach="1" />
\t\t\t<!-- Constituent words of the labels, appearing near each other, anywhere in the document. -->
\t\t\t<nearlist pos="0" stem="1" weight="50" foreach="1" />
\t\t</combine>

\t</content>

</rulebase>
`;

// ── XML parsing helpers ──────────────────────────────────────────────────────

/** Extract text content of a named XML element (first match). */
function xmlText(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m?.[1]?.trim();
}

/** Extract all occurrences of an XML element as raw strings. */
function xmlAll(xml: string, tag: string): string[] {
  // The self-closing pattern must handle quoted attribute values (which can contain "/" and ">").
  // [^>"'] matches unquoted content; "[^"]*" and '[^']*' match quoted attribute values.
  const re = new RegExp(
    `<${tag}(?:[^>"']|"[^"]*"|'[^']*')*/>|<${tag}[^>]*>[\\s\\S]*?</${tag}>`,
    "gi"
  );
  return xml.match(re) ?? [];
}

/** Parse attributes of a self-closing or opening XML element into a record. */
function xmlAttrs(element: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(element)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

// ── Multipart body builder ────────────────────────────────────────────────────

interface MultipartField {
  name: string;
  value: Buffer | string;
  filename?: string;
  contentType?: string;
}

/**
 * Build a multipart/form-data body from an array of fields.
 * Returns the raw Buffer and the Content-Type header (including boundary).
 *
 * Using manual construction instead of the Node.js built-in FormData to guarantee
 * the Content-Type includes a boundary — required for Semaphore's JAX-RS/RESTEasy
 * endpoints which return HTTP 415 when the boundary is absent.
 */
function buildMultipart(fields: MultipartField[]): { body: Buffer; contentType: string } {
  const boundary = `----SemaphoreMCPBoundary${Date.now().toString(16)}`;
  const CRLF = "\r\n";
  const parts: Buffer[] = [];

  for (const field of fields) {
    let header = `--${boundary}${CRLF}`;
    header += `Content-Disposition: form-data; name="${field.name}"`;
    if (field.filename) header += `; filename="${field.filename}"`;
    header += CRLF;
    if (field.contentType) header += `Content-Type: ${field.contentType}${CRLF}`;
    header += CRLF;

    const value = Buffer.isBuffer(field.value) ? field.value : Buffer.from(field.value, "utf8");
    parts.push(Buffer.from(header), value, Buffer.from(CRLF));
  }
  parts.push(Buffer.from(`--${boundary}--${CRLF}`));

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface SemaphoreCategory {
  /** Taxonomy class name (e.g. "Bluey-Episodes", "IPTC-NewsML") */
  className: string;
  /** Category label (e.g. "Season 1 Episode 1 - Magic Xylophone") */
  label: string;
  /** Stable concept UUID from the taxonomy */
  id: string;
  /** Classification confidence score as a float returned by the CLS (0.0–1.0).
   *  Note: the `threshold` parameter uses a 0–100 integer scale (default 48),
   *  but the XML response contains scores as 0.0–1.0 floats. */
  score: number;
}

export interface SemaphoreClassificationResult {
  categories: SemaphoreCategory[];
  /** Raw XML response from the server — useful for debugging */
  rawXml: string;
}

export interface SemaphorePublishSet {
  name: string;
  type: string;
  active: boolean;
  rulesCount?: number;
}

export interface SemaphoreClass {
  name: string;
  ruleCount: number;
}

export interface SemaphoreLanguage {
  /** CLS language code, e.g. "en1", "fr1" — use this in classify() language param */
  id: string;
  /** Human-readable language name, e.g. "English" */
  name: string;
  /** True if this is the CLS default language */
  default: boolean;
  /** True if rules have been published for this language */
  hasRules: boolean;
}

// ── Client ───────────────────────────────────────────────────────────────────

export interface KmmModel {
  id: string;
}

export interface KmmTask {
  /** Full KMM task ID, e.g. "task:ATCDrugClassification:Test" */
  id: string;
  /** Parent model URI, e.g. "model:ATCDrugClassification" */
  modelId: string;
  /** Short task name, e.g. "Test" */
  taskName: string;
  /** Human-readable label */
  label?: string;
  /** Status short name, e.g. "Uncommitted", "Committed" */
  status?: string;
  /** ISO 8601 creation timestamp */
  created?: string;
}

export interface KmmSparqlResult {
  /** Raw SPARQL XML result string */
  xml: string;
  /** Parsed bindings — each row is a map of variable name → value string */
  rows: Array<Record<string, string>>;
}

export class SemaphoreClient {
  private readonly clsHttp: AxiosInstance;
  private readonly kmmHttp: AxiosInstance;

  /** True when a host or explicit URL is configured (CLS reachable). */
  readonly configured: boolean;
  /** CLS base URL (e.g. http://semaphore.example.com:5058) */
  readonly baseUrl: string;
  /** KMM / Studio base URL (e.g. http://semaphore.example.com:5080) */
  readonly kmmBaseUrl: string;
  /** The raw hostname (for passing to Flux --classifier-host). */
  readonly clsHost: string | undefined;
  /** CLS port number (for passing to Flux --classifier-port). */
  readonly clsPort: number;
  /** True when KMM credentials are configured. */
  readonly kmmConfigured: boolean;

  /** @deprecated Use clsHost */
  get scsHost(): string | undefined { return this.clsHost; }
  /** @deprecated Use clsPort */
  get scsPort(): number { return this.clsPort; }

  /** Cached KMM API token (x-api-key) and its expiry epoch ms. */
  private kmmToken: string | null = null;
  private kmmTokenExpiry = 0;
  /** Single-flight guard: when a token refresh is in progress, concurrent
   *  callers await this same promise instead of each performing a redundant
   *  login + token-exchange round-trip. */
  private kmmTokenRefresh: Promise<string> | null = null;
  private readonly kmmUsername: string | undefined;
  private readonly kmmPassword: string | undefined;

  constructor(config: SemaphoreConfig) {
    const { host, scsPort, kmmPort, username, password, ssl, timeoutMs, url } = config;

    this.clsHost = host;
    this.clsPort = scsPort;
    this.configured = !!(host ?? url);
    this.kmmUsername = username;
    this.kmmPassword = password;

    const scheme = ssl ? "https" : "http";

    // Explicit URL override takes precedence over host:clsPort
    this.baseUrl = url ?? (host ? `${scheme}://${host}:${scsPort}` : "");
    this.kmmBaseUrl = host ? `${scheme}://${host}:${kmmPort}` : "";

    this.kmmConfigured = !!(host && (username ?? password));

    this.clsHttp = axios.create({
      baseURL: this.baseUrl || "http://localhost:5058",
      timeout: timeoutMs,
    });

    // KMM HTTP client — auth is handled dynamically via kmmApiKey()
    this.kmmHttp = axios.create({
      baseURL: this.kmmBaseUrl || "http://localhost:5080",
      timeout: timeoutMs,
    });

    this.clsHttp.interceptors.response.use(
      (res) => res,
      (err) => {
        const status = (err as { response?: { status?: number } }).response?.status;
        logger.debug("Semaphore CLS HTTP error", { status, message: String(err) });
        throw err;
      }
    );
  }

  // ── KMM authentication ───────────────────────────────────────────────────────

  /**
   * Return a valid KMM API token, performing the two-step Java EE form auth if
   * necessary or if the cached token has expired.
   *
   * Step 1: POST /j_security_check  (j_username + j_password form fields)
   *         → sets JSESSIONID cookie in the cookie jar string we hold in memory.
   * Step 2: GET  /api/token?lifeTime=86400  (with JSESSIONID cookie)
   *         → { tokenId: "<token>" }
   * Use result as  x-api-key: <token>  header on subsequent KMM requests.
   */
  private async kmmApiKey(): Promise<string> {
    const now = Date.now();
    // Re-use cached token if still valid (with a 60-second safety margin)
    if (this.kmmToken && now < this.kmmTokenExpiry - 60_000) {
      return this.kmmToken;
    }

    // Single-flight: if a refresh is already underway, await it rather than
    // launching a second concurrent login. Cleared in a finally so a failed
    // refresh does not poison subsequent attempts.
    if (this.kmmTokenRefresh) {
      return this.kmmTokenRefresh;
    }

    this.kmmTokenRefresh = this.refreshKmmToken().finally(() => {
      this.kmmTokenRefresh = null;
    });
    return this.kmmTokenRefresh;
  }

  /** Perform the two-step KMM login (form auth → token exchange) and cache the
   *  resulting API token. Always run through kmmApiKey()'s single-flight guard. */
  private async refreshKmmToken(): Promise<string> {
    if (!this.kmmUsername || !this.kmmPassword) {
      throw new Error(
        "KMM credentials not configured. Set SEMAPHORE_USERNAME and SEMAPHORE_PASSWORD."
      );
    }

    // Step 1 — form login; capture Set-Cookie header manually (no cookie jar in axios)
    const loginBody = new URLSearchParams({
      j_username: this.kmmUsername,
      j_password: this.kmmPassword,
    }).toString();

    const loginRes = await this.kmmHttp.post("/j_security_check", loginBody, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      maxRedirects: 0,
      validateStatus: (s) => s < 400,
    });

    const setCookieHeader = loginRes.headers["set-cookie"];
    const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ""];
    const jsessionid = cookies
      .flatMap((c) => c.split(";"))
      .find((part) => part.trim().toUpperCase().startsWith("JSESSIONID="));

    if (!jsessionid) {
      throw new Error(
        "KMM login did not return a JSESSIONID cookie. Check SEMAPHORE_USERNAME / SEMAPHORE_PASSWORD."
      );
    }

    // Step 2 — exchange session for a long-lived API token
    const TOKEN_TTL_S = 86_400; // 24 hours
    const tokenRes = await this.kmmHttp.get<{ tokenId: string }>(
      `/api/token?lifeTime=${TOKEN_TTL_S}`,
      { headers: { Cookie: jsessionid.trim() } }
    );

    const token = tokenRes.data?.tokenId;
    if (!token) {
      throw new Error("KMM token endpoint did not return a tokenId.");
    }

    this.kmmToken = token;
    // Base expiry on completion time, not the pre-login timestamp, so the
    // safety margin reflects when the token actually became valid.
    this.kmmTokenExpiry = Date.now() + TOKEN_TTL_S * 1_000;
    logger.debug("KMM API token acquired", { expiresIn: `${TOKEN_TTL_S}s` });
    return token;
  }

  /** Perform an authenticated GET against the KMM REST API. */
  private async kmmGet<T = unknown>(path: string): Promise<T> {
    const token = await this.kmmApiKey();
    const res = await this.kmmHttp.get<T>(path, {
      headers: { "x-api-key": token },
      validateStatus: (s) => s < 500,
    });
    if (res.status === 404) throw new Error(`KMM resource not found: ${path}`);
    if (res.status === 401 || res.status === 403) {
      // Token may have been invalidated on a server restart — clear and let caller retry
      this.kmmToken = null;
      throw new Error(`KMM authentication failed (HTTP ${res.status}) — credentials may have changed.`);
    }
    return res.data;
  }

  /** Perform an authenticated POST against the KMM REST API. */
  private async kmmPost<T = unknown>(
    path: string,
    body: unknown,
    contentType: string
  ): Promise<{ status: number; location?: string; data: T }> {
    const token = await this.kmmApiKey();
    const res = await this.kmmHttp.post<T>(path, body, {
      headers: { "x-api-key": token, "Content-Type": contentType },
      validateStatus: (s) => s < 500,
    });
    if (res.status === 401 || res.status === 403) {
      this.kmmToken = null;
      throw new Error(`KMM authentication failed (HTTP ${res.status}).`);
    }
    return {
      status: res.status,
      location: res.headers["location"] as string | undefined,
      data: res.data,
    };
  }

  // ── KMM model management ─────────────────────────────────────────────────────

  /**
   * List all models (taxonomies/ontologies) registered in KMM.
   * Calls GET /kmm/api/sys/sys:Model/rdf:instance (the correct endpoint for model instances).
   * Note: the legacy teamwork:Tag endpoint (/kmm/api/specialgraph:system/teamwork:Tag/rdf:instance)
   * returns empty — it lists a different object type than what createKmmModel creates.
   */
  async listKmmModels(): Promise<KmmModel[]> {
    const data = await this.kmmGet<{ "@graph"?: Array<{ "@id": string; "rdfs:label"?: unknown }> }>(
      "/kmm/api/sys/sys:Model/rdf:instance"
    );
    return (data["@graph"] ?? [])
      // The sys:Model/rdf:instance endpoint returns .tch (change-history) graph URIs like
      // "model:IPTCMediaTopics.tch". Strip the suffix to get the canonical model URI.
      .map((item) => ({ id: item["@id"].replace(/\.tch$/, "") }))
      // Deduplicate in case both bare and .tch forms appear
      .filter((item, idx, arr) => arr.findIndex((x) => x.id === item.id) === idx)
      // Drop any remaining internal IDs that don't look like user-created model URIs
      .filter((item) => item.id.startsWith("model:"));
  }

  /**
   * List working copies (tasks) registered in KMM.
   *
   * Uses the global system task list endpoint which returns Studio-created tasks with
   * full metadata (status, created date). API-created tasks may not appear here.
   *
   * ENDPOINT (global): GET /kmm/api/specialgraph:system/teamwork:Tag/rdf:instance
   * ENDPOINT (per-model, documented): GET /kmm/api/{modelUri}/semsys:hasTask/meta:transitiveInstance
   *   (Documented in KMM API reference but not yet implemented in Semaphore 5.10.x)
   *
   * Task IDs follow the pattern "task:{ModelName}:{TaskName}" (using the "task:" prefix which
   * expands to "urn:x-tags:"). The named graph for a task is "urn:x-evn-tag:{ModelName}:{TaskName}".
   *
   * Status values: teamwork:Uncommitted (open), teamwork:Committed (submitted), teamwork:Implemented (merged).
   */
  async listKmmTasks(modelUri?: string): Promise<KmmTask[]> {
    const props = "teamwork%3Astatus%2Crdfs%3Alabel%2Cdcterms%3Acreated";
    // Global list returns only Studio-created tasks with full metadata.
    // Per-model semsys:hasTask/meta:transitiveInstance is the documented endpoint but requires
    // a newer KMM version; fall back to specialgraph:system/teamwork:Tag filtering by model.
    const endpoint = `/kmm/api/specialgraph:system/teamwork:Tag/rdf:instance?properties=${props}`;
    const data = await this.kmmGet<{ "@graph"?: Array<Record<string, unknown>> }>(endpoint);
    const tasks = (data["@graph"] ?? []).map((node) => {
      const fullId = node["@id"] as string;
      // fullId format: "task:{ModelName}:{TaskName}"
      const withoutPrefix = fullId.startsWith("task:") ? fullId.slice("task:".length) : fullId;
      const colonIdx = withoutPrefix.indexOf(":");
      const modelName = colonIdx >= 0 ? withoutPrefix.slice(0, colonIdx) : withoutPrefix;
      const taskName = colonIdx >= 0 ? withoutPrefix.slice(colonIdx + 1) : "";
      const labelArr = node["rdfs:label"];
      const label = Array.isArray(labelArr)
        ? (labelArr[0] as Record<string, string>)["@value"]
        : undefined;
      const statusArr = node["teamwork:status"];
      const status = Array.isArray(statusArr)
        ? (statusArr[0] as Record<string, string>)["@id"]?.split("#").pop()
        : undefined;
      const createdArr = node["dcterms:created"];
      const created = Array.isArray(createdArr)
        ? (createdArr[0] as Record<string, string>)["@value"]
        : undefined;
      return { id: fullId, modelId: `model:${modelName}`, taskName, label, status, created } as KmmTask;
    });
    // Filter to the requested model if specified
    return modelUri ? tasks.filter((t) => t.modelId === modelUri) : tasks;
  }

  /**
   * Create a new task (working copy) for a model.
   *
   * DOCUMENTED ENDPOINT (KMM API reference):
   *   POST /{graphUri}/semsys:hasTask/rdf:instance
   *   Body: JSON-LD with @type, rdfs:label, rdfs:comment
   *   Response: 201 Created
   *
   * LEGACY ENDPOINT (Semaphore 5.10.x — current latest release):
   *   POST /{modelUri}/teamwork:Tag/rdf:instance
   *   — Creates a model-level tag but NOT a system-level task (does not appear
   *     in the global task list, lacks dcterms:created, and has no urn:x-evn-tag graph).
   *
   * This method tries the documented semsys:hasTask endpoint first. If it fails (HTTP 400
   * with "missing rdf:type" on semsys:hasTask — meaning the property isn't defined on this
   * KMM version), it falls back to the legacy teamwork:Tag endpoint with a warning.
   *
   * @returns The task ID (e.g. "task:MyModel:MyTask") if the server returns one, or a
   *          constructed ID based on the model and label.
   */
  async createKmmTask(
    modelUri: string,
    label: string,
    description?: string
  ): Promise<{ id: string; fullSupport: boolean }> {
    const modelName = modelUri.replace(/^model:/, "");
    const token = await this.kmmApiKey();

    // Body for the documented semsys:hasTask endpoint
    const body = {
      "@graph": [{
        "rdfs:label": label,
        ...(description ? { "rdfs:comment": description } : {}),
      }],
    };

    // Try documented endpoint first
    try {
      const res = await this.kmmHttp.post(
        `/kmm/api/${modelUri}/semsys:hasTask/rdf:instance`,
        body,
        {
          headers: { "x-api-key": token, "Content-Type": "application/ld+json" },
          validateStatus: (s) => s < 500,
        }
      );
      if (res.status === 201 || res.status === 200) {
        // Extract task ID from response or Location header
        const location = res.headers?.location as string | undefined;
        const id = location?.split("/").pop() ?? `task:${modelName}:${label}`;
        return { id, fullSupport: true };
      }
      // If semsys:hasTask isn't recognized, fall through to legacy
      const errType = (res.data as Record<string, unknown>)?.errors;
      const isUnsupported = JSON.stringify(errType).includes("semsys:hasTask");
      if (!isUnsupported) {
        throw new Error(`Task creation failed: HTTP ${res.status} — ${JSON.stringify(res.data)}`);
      }
    } catch (e) {
      // If it's our own thrown error, re-throw
      if (e instanceof Error && e.message.startsWith("Task creation failed")) throw e;
      // Otherwise fall through to legacy
    }

    // Fallback: legacy teamwork:Tag endpoint (Semaphore ≤5.10.x)
    logger.info("semsys:hasTask not available, falling back to legacy teamwork:Tag", { modelUri });
    const legacyBody = {
      "@graph": [{
        "@type": "http://topbraid.org/teamwork#Tag",
        "http://www.w3.org/2000/01/rdf-schema#label": [{ "@value": label }],
        ...(description ? { "http://www.w3.org/2000/01/rdf-schema#comment": [{ "@value": description }] } : {}),
      }],
    };
    const res = await this.kmmHttp.post(
      `/kmm/api/${modelUri}/teamwork:Tag/rdf:instance`,
      legacyBody,
      {
        headers: { "x-api-key": token, "Content-Type": "application/ld+json" },
        validateStatus: (s) => s < 500,
      }
    );
    if (res.status === 201 || res.status === 200) {
      return { id: `task:${modelName}:${label}`, fullSupport: false };
    }
    throw new Error(`Task creation failed: HTTP ${res.status} — ${JSON.stringify(res.data)}`);
  }

  /**
   * Commit (merge) a task's changes into master.
   *
   * DOCUMENTED ENDPOINT (KMM API reference):
   *   POST /sys/{taskGraphUri}
   *   Merges the task delta graph into the master graph.
   *
   * AVAILABILITY: This endpoint returns "not yet supported" on Semaphore 5.10.x
   * (the current latest release). Tasks must be committed via the Studio UI.
   *
   * @throws Error with a descriptive message if the server doesn't support this endpoint.
   */
  async commitKmmTask(
    modelUri: string,
    taskName: string
  ): Promise<{ committed: boolean; message: string }> {
    const modelName = modelUri.replace(/^model:/, "");
    const taskGraphUri = `task:${modelName}:${taskName}`;
    const token = await this.kmmApiKey();

    const res = await this.kmmHttp.post(
      `/kmm/api/sys/${taskGraphUri}`,
      {},
      {
        headers: { "x-api-key": token, "Content-Type": "application/ld+json" },
        validateStatus: (s) => s < 500,
      }
    );

    if (res.status === 200 || res.status === 204) {
      return { committed: true, message: `Task "${taskName}" committed to master.` };
    }

    const errMsg = JSON.stringify(res.data);
    if (errMsg.includes("not yet supported")) {
      return {
        committed: false,
        message:
          `Task commit via API is not supported on this Semaphore version.\n` +
          `Use Semaphore Studio: open ${modelUri} → Working Copies → ${taskName} → Submit → Merge to Master.`,
      };
    }

    throw new Error(`Task commit failed: HTTP ${res.status} — ${errMsg}`);
  }

  /**
   * Estimate how many CLS classification rules are loaded for a given publish-set name.
   *
   * The CLS rulenet view shows pak file sizes but not per-set rule counts. We use the
   * pak file size as a proxy: each concept rule compiles to ~180-250 bytes. A healthy
   * publish of 1000+ concepts produces a file well over 100 KB; the "1 rule only"
   * failure mode produces a file under 2 KB.
   *
   * LIMITATION: Small taxonomies (≤ ~25 concepts) legitimately produce paks under 5 KB,
   * so this function returns 1 for them even when publishing succeeded. Callers should
   * compare against the KMM concept count (kmmConceptCount()) before raising a warning —
   * only flag as broken if ruleCount ≤ 1 AND kmmCount > 10.
   *
   * Returns:
   *   > 1   estimated rule count based on pak file size (may not match exact rule count)
   *   1     publish set exists but pak is < 5 KB (may be the 1-rule failure mode OR a small taxonomy)
   *   0     publish set not found in CLS
   *  -1     could not reach CLS or parse HTML
   */
  async clsRuleCount(publishSetName: string): Promise<number> {
    try {
      const res = await this.clsHttp.get("/rulenetview.html", {
        validateStatus: (s: number) => s < 500,
      });
      const html: string = res.data as string;
      // Look for the publish set row:
      //   <td>iptcmediatopics</td><td>1 (256.9 KB)</td>
      // The "1" is the pak file count, the size is the pak file size.
      const re = new RegExp(
        `<td>${publishSetName.toLowerCase()}</td>\\s*<td>\\d+\\s*\\(([\\d.]+)\\s*(Bytes|KB|MB)\\)`,
        "i"
      );
      const m = html.match(re);
      if (m) {
        const size = parseFloat(m[1]);
        const unit = m[2].toLowerCase();
        const bytes = unit === "mb" ? size * 1_048_576 : unit === "kb" ? size * 1_024 : size;
        if (bytes < 5_000) return 1;       // < 5 KB → likely only the ConceptScheme rule
        return Math.round(bytes / 200);    // estimate: ~200 bytes per concept rule
      }
      // Publish set not found in the HTML table
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * Count skos:Concept instances for a model via the KMM OE API.
   * Returns the count, or -1 on error.
   */
  async kmmConceptCount(modelUri: string): Promise<number> {
    try {
      const token = await this.kmmApiKey();
      const res = await this.kmmHttp.get(
        `/kmm/api/${modelUri}/skos:Concept/rdf:instance`,
        { headers: { "x-api-key": token }, validateStatus: () => true }
      );
      const graph = (res.data as Record<string, unknown>)?.["@graph"] as unknown[] | undefined;
      return graph?.length ?? -1;
    } catch {
      return -1;
    }
  }

  /**
   * Create a new taxonomy model in KMM.
   * Calls POST /kmm/api/sys/sys:Model/rdf:instance with application/ld+json.
   * Returns the new model's URI from the Location header (e.g. "model:MyModel").
   *
   * @param name              Short identifier used as the model name and URI suffix.
   * @param defaultNamespace  Base namespace for concepts in the model.
   * @param description       Optional human-readable description.
   */
  async createKmmModel(
    name: string,
    defaultNamespace: string,
    description?: string
  ): Promise<string> {
    const body: Record<string, unknown> = {
      "@type": ["sys:Model"],
      "rdfs:label": [{ "@value": name }],
      "swa:defaultNamespace": [{ "@value": defaultNamespace }],
    };
    if (description) {
      body["rdfs:comment"] = { "@value": description };
    }

    const { status, location } = await this.kmmPost(
      "/kmm/api/sys/sys:Model/rdf:instance",
      JSON.stringify(body),
      "application/ld+json"
    );

    if (status !== 201) {
      throw new Error(`KMM model creation returned HTTP ${status} (expected 201).`);
    }
    // Location is e.g. "../model:MyModel" — extract the model: part
    const modelUri = location?.replace(/^.*?(model:[^/\s]+).*$/, "$1") ?? `model:${name}`;
    return modelUri;
  }

  /**
   * Load a SKOS taxonomy into an existing KMM model via SPARQL LOAD.
   * Uses POST /kmm/api/{graphUri}/sparql with Content-Type application/sparql-update.
   * Always passes checkConstraints=false&runEditRules=false so that third-party
   * SKOS vocabularies (IPTC, EuroVoc, AGROVOC …) load without SHACL failures.
   *
   * @param modelUri  KMM model URI, e.g. "model:IPTCMediaTopics"
   * @param skosUrl   Public HTTP/HTTPS URL of the SKOS RDF file to load.
   */
  async kmmLoadSkos(modelUri: string, skosUrl: string): Promise<void> {
    const sparql = `LOAD <${skosUrl}>`;
    const { status } = await this.kmmPost(
      `/kmm/api/${modelUri}/sparql?checkConstraints=false&runEditRules=false`,
      sparql,
      "application/sparql-update"
    );
    if (status !== 200 && status !== 204) {
      throw new Error(`SPARQL LOAD returned HTTP ${status}. The SKOS URL may be unreachable from the KMM server.`);
    }
  }

  /**
   * Import a SKOS taxonomy into a KMM model using the Studio backup/import API.
   *
   * This mirrors the mechanism used by the Semaphore Studio UI when importing a model
   * from a file (Model → Import). It differs from kmmLoadSkos (SPARQL LOAD) in that:
   *   • The MCP server fetches the RDF file and POSTs it as multipart/form-data
   *   • The import job is async — use kmmWaitForAsyncJob() to poll until complete
   *   • The resulting model structure is identical to a Studio UI import, which the
   *     publisher can query correctly (SPARQL LOAD produces a raw-triples model that
   *     the publisher may not index properly)
   *
   * Endpoint: POST /kmm/api?path=backup/{modelUri}/import&async=true
   * Form fields (matching Studio UI payload):
   *   content=existing, format=<mime>, overwrite=<bool>, file=<binary>
   *
   * @param modelUri  KMM model URI, e.g. "model:IPTCMediaTopics"
   * @param skosUrl     Public URL of the RDF/SKOS file to fetch and import. One of skosUrl or
   *                    options.skosContent must be provided.
   * @param options     format — MIME type (auto-detected if omitted), overwrite — default false,
   *                    skosContent — inline RDF string (skips URL fetch when provided)
   * @returns           jobId string for use with kmmWaitForAsyncJob()
   */
  async kmmImportSkos(
    modelUri: string,
    skosUrl: string | null,
    options: { format?: string; overwrite?: boolean; skosContent?: string } = {}
  ): Promise<string> {
    let fileBuffer: Buffer;
    let format = options.format;

    if (options.skosContent) {
      // Inline content path — no network fetch needed (works regardless of MCP server location)
      logger.info("kmmImportSkos: using inline RDF content", { modelUri, bytes: options.skosContent.length });
      fileBuffer = Buffer.from(options.skosContent, "utf-8");
      // Auto-detect format from content prefix when not explicitly set
      if (!format) {
        const prefix = options.skosContent.trimStart().substring(0, 100);
        if (prefix.startsWith("@prefix") || prefix.startsWith("@base") || prefix.startsWith("PREFIX")) {
          format = "text/turtle";
        } else if (prefix.startsWith("{")) {
          format = "application/ld+json";
        } else {
          format = "application/rdf+xml"; // safe default for XML-ish content
        }
      }
    } else {
      // URL fetch path — skosUrl must be reachable from the MCP server process
      if (!skosUrl) throw new Error("Either skos_url or skos_content must be provided.");
      logger.info("kmmImportSkos: fetching RDF file", { modelUri, skosUrl });
      const fileRes = await axios.get(skosUrl, {
        responseType: "arraybuffer",
        timeout: 120_000,
        validateStatus: (s) => s < 400,
      });
      fileBuffer = Buffer.from(fileRes.data as ArrayBuffer);

      // Auto-detect format from Content-Type or URL
      if (!format) {
        const ct = (fileRes.headers["content-type"] as string | undefined) ?? "";
        if (ct.includes("turtle") || skosUrl.includes(".ttl")) format = "text/turtle";
        else if (ct.includes("n-triples") || skosUrl.includes(".nt")) format = "application/n-triples";
        else if (ct.includes("json") || skosUrl.includes(".jsonld")) format = "application/ld+json";
        else format = "application/rdf+xml"; // default (RDF/XML)
      }
    }

    const ext = format === "text/turtle" ? ".ttl"
              : format === "application/n-triples" ? ".nt"
              : format === "application/ld+json" ? ".jsonld"
              : ".rdf";
    const filename = `${modelUri.replace(/^model:/, "")}_import${ext}`;

    logger.info("kmmImportSkos: uploading to backup/import", { modelUri, format, bytes: fileBuffer.length });

    // 2. POST as multipart/form-data to backup/import.
    // Use content=automatic (matching Semaphore Studio UI behaviour) so KMM triggers
    // full OE indexing — required for the publisher's AllConcepts to enumerate concepts.
    // content=existing bypasses OE indexing and results in 0 concept rules at publish time.
    const token = await this.kmmApiKey();
    const { body, contentType } = buildMultipart([
      { name: "content",             value: "automatic" },
      { name: "templateName",        value: "" },
      { name: "templateDescription", value: "" },
      { name: "record",              value: "false" },
      { name: "sheetIndex",          value: "0" },
      { name: "format",              value: format },
      { name: "overwrite",           value: options.overwrite ? "true" : "false" },
      { name: "file",                value: fileBuffer, filename, contentType: format },
    ]);

    const res = await this.kmmHttp.post(
      `/kmm/api?path=backup/${modelUri}/import&async=true`,
      body,
      {
        headers: { "x-api-key": token, "Content-Type": contentType },
        validateStatus: (s) => s < 500,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );

    if (res.status !== 200 && res.status !== 202) {
      const msg = (res.data as Record<string, unknown>)?.message as string | undefined;
      throw new Error(`Backup import returned HTTP ${res.status}${msg ? `: ${msg}` : ""}.`);
    }

    // Response: { status:"ACCEPTED", jobId:"...", resultLifetimeMs, ... }
    const data = res.data as Record<string, unknown>;
    const jobId = (data?.jobId ?? data?.id) as string | undefined;
    if (!jobId) throw new Error(`Backup import did not return a job ID. Response: ${JSON.stringify(data)}`);
    logger.info("kmmImportSkos: import job started", { modelUri, jobId });
    return jobId;
  }

  /**
   * Poll a KMM async job until it completes, fails, or times out.
   *
   * Endpoint: GET /kmm/api?path=async/jobs/{jobId}
   * Result:   GET /kmm/api?path=async/jobs/{jobId}/result
   *
   * @returns { status: "COMPLETE"|"FAILED"|"TIMEOUT", result }
   */
  async kmmWaitForAsyncJob(
    jobId: string,
    timeoutMs = 300_000,
    pollMs = 3_000
  ): Promise<{ status: "COMPLETE" | "FAILED" | "TIMEOUT"; result?: unknown; error?: string }> {
    const deadline = Date.now() + timeoutMs;
    const token = await this.kmmApiKey();

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      try {
        const statusRes = await this.kmmHttp.get(
          `/kmm/api?path=async/jobs/${jobId}`,
          { headers: { "x-api-key": token }, validateStatus: (s) => s < 500 }
        );
        const data = statusRes.data as Record<string, unknown>;
        const jobStatus = (data?.status as string | undefined)?.toUpperCase();

        // Terminal success states: COMPLETE, FINISHED
        if (jobStatus === "COMPLETE" || jobStatus === "FINISHED" || data?.complete === true) {
          let result: unknown;
          try {
            const resultRes = await this.kmmHttp.get(
              `/kmm/api?path=async/jobs/${jobId}/result`,
              { headers: { "x-api-key": token }, validateStatus: (s) => s < 500 }
            );
            result = resultRes.data;
          } catch { /* result endpoint is optional */ }
          return { status: "COMPLETE", result };
        }
        if (jobStatus === "FAILED" || jobStatus === "ERROR") {
          return { status: "FAILED", error: data?.message as string | undefined };
        }
        // Still running — continue polling
        logger.debug("kmmWaitForAsyncJob: still running", { jobId, jobStatus });
      } catch {
        // Transient error — keep polling
      }
    }
    return { status: "TIMEOUT" };
  }

  /**
   * One-shot status check of a KMM async job — no polling, no waiting.
   * Lets semaphore_publish re-check a previously triggered publish (job_id param)
   * after a timeout instead of blindly re-triggering it.
   *
   * @returns status normalized to COMPLETE | FAILED | RUNNING | NOT_FOUND, plus
   *          the server's message when present.
   */
  async kmmAsyncJobStatus(
    jobId: string
  ): Promise<{ status: "COMPLETE" | "FAILED" | "RUNNING" | "NOT_FOUND"; message?: string }> {
    const token = await this.kmmApiKey();
    const res = await this.kmmHttp.get(
      `/kmm/api?path=async/jobs/${jobId}`,
      { headers: { "x-api-key": token }, validateStatus: (s) => s < 500 }
    );
    if (res.status === 404) return { status: "NOT_FOUND" };
    const data = res.data as Record<string, unknown>;
    const jobStatus = (data?.status as string | undefined)?.toUpperCase();
    const message = data?.message as string | undefined;
    if (jobStatus === "COMPLETE" || jobStatus === "FINISHED" || data?.complete === true) {
      return { status: "COMPLETE", message };
    }
    if (jobStatus === "FAILED" || jobStatus === "ERROR") {
      return { status: "FAILED", message };
    }
    return { status: "RUNNING", message };
  }

  /**
   * Delete a KMM model and all its triples permanently.
   * THIS IS IRREVERSIBLE. Does not remove published CLS rule sets — deactivate
   * those separately via the CLS publish-set API.
   *
   * @param modelUri  KMM model URI, e.g. "model:MyModel"
   */
  async kmmDeleteModel(modelUri: string): Promise<void> {
    const token = await this.kmmApiKey();
    const res = await this.kmmHttp.delete(
      `/kmm/api/sys/${modelUri}`,
      {
        headers: { "x-api-key": token },
        validateStatus: (s) => s < 500,
      }
    );
    if (res.status !== 200 && res.status !== 204) {
      throw new Error(`Failed to delete KMM model ${modelUri} (HTTP ${res.status}).`);
    }
  }

  /**
   * Run a SPARQL SELECT query against a KMM model graph.
   * Calls GET /kmm/api/{graphUri}/sparql?query=<encoded>.
   *
   * @param modelUri  KMM model URI, e.g. "model:IPTCMediaTopics"
   * @param query     SPARQL SELECT query string.
   */
  async kmmSparqlQuery(modelUri: string, query: string): Promise<KmmSparqlResult> {
    const encoded = encodeURIComponent(query);
    const xml = await this.kmmGet<string>(
      `/kmm/api/${modelUri}/sparql?query=${encoded}`
    );
    const xmlStr = typeof xml === "string" ? xml : JSON.stringify(xml);

    // Parse SPARQL XML results into row objects
    const rows: Array<Record<string, string>> = [];
    const resultRe = /<result>([\s\S]*?)<\/result>/g;
    const bindingRe = /<binding\s+name="([^"]+)"[^>]*>[\s\S]*?<(?:uri|literal)[^>]*>([^<]*)<\/(?:uri|literal)>/g;
    let resultMatch: RegExpExecArray | null;
    while ((resultMatch = resultRe.exec(xmlStr)) !== null) {
      const row: Record<string, string> = {};
      let bm: RegExpExecArray | null;
      while ((bm = bindingRe.exec(resultMatch[1])) !== null) {
        row[bm[1]] = bm[2];
      }
      rows.push(row);
    }

    return { xml: xmlStr, rows };
  }

  /**
   * Run a SPARQL UPDATE (INSERT DATA / DELETE DATA / DELETE+INSERT / LOAD) against a KMM model.
   * Unlike kmmSparqlQuery (SELECT only), this modifies model triples.
   *
   * Always passes checkConstraints=false&runEditRules=false so that standard SPARQL
   * UPDATE operations work without triggering Semaphore's SHACL validation.
   *
   * Common use cases:
   *   • Fix or backfill labels
   *   • Remove unwanted triples before publishing
   *   • Manually add sem:guid if loading via raw SPARQL INSERT (not needed when using semaphore_kmm_skos_load)
   *
   * @param modelUri  KMM model URI, e.g. "model:UNESCO"
   * @param sparql    SPARQL UPDATE string (INSERT DATA / DELETE DATA / etc.)
   */
  async kmmSparqlUpdate(modelUri: string, sparql: string): Promise<void> {
    const { status } = await this.kmmPost(
      `/kmm/api/${modelUri}/sparql?checkConstraints=false&runEditRules=false`,
      sparql,
      "application/sparql-update"
    );
    if (status !== 200 && status !== 204) {
      throw new Error(`SPARQL UPDATE returned HTTP ${status}. Check the query syntax and model URI.`);
    }
  }

  /** Run a SPARQL SELECT against a KMM model and return raw SPARQL JSON results. */
  private async kmmSparqlSelect(
    modelUri: string,
    query: string
  ): Promise<{ results: { bindings: Array<Record<string, { value: string }>> } }> {
    const token = await this.kmmApiKey();
    const res = await this.kmmHttp.get(
      `/kmm/api/${modelUri}/sparql?query=${encodeURIComponent(query)}`,
      {
        headers: { "x-api-key": token, "Accept": "application/sparql-results+json" },
        validateStatus: (s) => s < 500,
      }
    );
    return res.data as { results: { bindings: Array<Record<string, { value: string }>> } };
  }

  /**
   * Trigger a KMM publisher run for a model, pushing rules to the Classification Server.
   *
   * Uses the Studio-mirrored publish flow, discovered via browser DevTools:
   *   1. GET sempubpermissions:publishMaster for the current user on the model
   *      → returns the Studio environment URI (e.g. studio#environment_<hash>)
   *   2. Clear any stale sempub:publishScheduled via SPARQL DELETE
   *   3. PATCH path={modelUri}/{modelUri}&language={lang}&checkConstraints=false
   *      with JSON-Patch body: [{"op":"add","path":"@graph/0/sempub:publishScheduled/-",
   *                              "value":{"@id":"<environmentUri>"}}]
   *   The publisher service detects the publishScheduled change and runs the publish.
   *
   * This replaces the old POST /kmm/api?path=publisher/{model}/publish which failed
   * with "Environment doesn't exist" because the publisher backend's environment
   * registry is only populated when Studio calls it with the full CLS config inline.
   *
   * @param modelUri    KMM model URI, e.g. "model:UNESCO"
   * @param options     Optional publish parameters:
   *   language  — language code to publish (default: "en")
   */
  async kmmPublish(
    modelUri: string,
    options: {
      config?: string;
      environment?: string;
      language?: string;
      async?: boolean;
      /** Task name to publish (e.g. "Test" from "task:ATCDrugClassification:Test").
       *  When set, publishes the task's working copy graph instead of master.
       *  Looks up sempubpermissions:publishTask on sys/task:{Model}:{Task}/user:{user}.
       *  Falls back to publishMaster env if publishTask is not separately configured. */
      taskName?: string;
    } = {}
  ): Promise<{ accepted: boolean; jobId?: string; status?: string }> {
    const lang = options.language ?? "en";
    const username = this.kmmUsername;
    const modelName = modelUri.replace(/^model:/, "");
    const useAsync = options.async !== false;
    const taskName = options.taskName;

    // For task publishing: use the task's sys record and publishTask permission.
    // For model publishing: use the model's sys record and publishMaster permission.
    const sysPath = taskName
      ? `sys/task:${modelName}:${taskName}/user:${username}`
      : `sys/${modelUri}/user:${username}`;
    const permPropKey = taskName
      ? "sempubpermissions:publishTask"
      : "sempubpermissions:publishMaster";
    const permProps = "sempubpermissions:publishMaster%2Csempubpermissions:publishTask";
    let envUri: string | undefined;

    // Accept an explicit environment override (full URI or name)
    if (options.environment) {
      envUri = options.environment;
    } else {
      try {
        const permData = await this.kmmGet<{ "@graph"?: Array<Record<string, unknown>> }>(
          `/kmm/api?path=${sysPath}&properties=${permProps}&language=${lang}`
        );
        const graph = permData["@graph"] ?? [];
        for (const node of graph) {
          // For tasks: prefer publishTask; fall back to publishMaster.
          // For models: use publishMaster.
          const pt = node[permPropKey];
          const pm = node["sempubpermissions:publishMaster"];
          const preferred = Array.isArray(pt) && pt.length > 0 ? pt : (Array.isArray(pm) && pm.length > 0 ? pm : null);
          if (preferred) {
            envUri = (preferred[0] as Record<string, string>)["@id"];
            break;
          }
        }
      } catch {
        // ignore — will throw below if envUri is still undefined
      }
    }

    // If publishMaster isn't set (new model created via API), auto-discover the environment
    // by scanning other models' sys records.
    //
    // BACKGROUND (verified 2026-03-17):
    //   The KMM API endpoint sempubpermissions:ClassificationServerEnvironment/rdf:instance
    //   does NOT exist as a global list. Environments are stored per-model — when a user
    //   first publishes a model via Studio, Semaphore writes the environment URI into:
    //     sys/{modelUri}/user:{username}  →  sempubpermissions:publishMaster
    //   So to auto-discover the environment for a NEW model, we must scan other models that
    //   have already been published at least once.
    if (!envUri) {
      try {
        const allModels = await this.listKmmModels();
        const otherModels = allModels.filter((m) => m.id !== modelUri);
        for (const m of otherModels) {
          try {
            const sysPath = `sys/${m.id}/user:${username}`;
            const sysData = await this.kmmGet<{ "@graph"?: Array<Record<string, unknown>> }>(
              `/kmm/api?path=${sysPath}&properties=${permProps}&language=${lang}`
            );
            const sysGraph = sysData["@graph"] ?? [];
            for (const node of sysGraph) {
              const pm = node["sempubpermissions:publishMaster"];
              if (Array.isArray(pm) && pm.length > 0) {
                const candidateUri = (pm[0] as Record<string, string>)["@id"];
                if (candidateUri) {
                  // Assign environment to the target resource (task or model).
                  // For tasks: write publishTask (+ publishMaster as fallback).
                  // For models: write both publishMaster and publishTask.
                  const token = await this.kmmApiKey();
                  const targetSysPath = taskName
                    ? `sys/task:${modelName}:${taskName}/user:${username}`
                    : `sys/${modelUri}/user:${username}`;
                  const patch = [
                    {
                      op: "add",
                      path: "@graph/0/sempubpermissions:publishMaster/-",
                      value: { "@id": candidateUri },
                    },
                    {
                      op: "add",
                      path: "@graph/0/sempubpermissions:publishTask/-",
                      value: { "@id": candidateUri },
                    },
                  ];
                  const patchRes = await this.kmmHttp.patch(
                    `/kmm/api/${targetSysPath}`,
                    patch,
                    {
                      headers: {
                        "x-api-key": token,
                        "Content-Type": "application/json-patch+json",
                      },
                      validateStatus: (s) => s < 500,
                    }
                  );
                  if (patchRes.status === 200 || patchRes.status === 204) {
                    envUri = candidateUri;
                    logger.info("Auto-assigned publisher environment from sibling model", {
                      modelUri,
                      sourceModel: m.id,
                      envUri,
                    });
                  }
                  break;
                }
              }
            }
            if (envUri) break;
          } catch {
            // skip this model — try next
          }
        }
      } catch {
        // ignore — will throw below if envUri still undefined
      }
    }

    if (!envUri) {
      const subject = taskName ? `task "${taskName}" of model "${modelUri}"` : `model "${modelUri}"`;
      throw new Error(
        `Publish failed: no publisher environment is assigned to user "${username}" for ${subject},\n` +
        `and no sibling model with an existing environment was found to borrow from.\n` +
        `Open Semaphore Studio → Administration → Publisher → Classification Server Environments\n` +
        `and ensure a CLS environment is configured. Then publish any model once from the Studio UI\n` +
        `to record the environment — subsequent API publishes will discover it automatically.`
      );
    }

    // Step 2 — POST directly to the publisher API.
    // For model publishing:   publisher/model:{Name}/publish
    // For task publishing:    publisher/task:{ModelName}:{TaskName}/publish
    //
    // The publisher service returns HTTP 202 with:
    //   { status: "ACCEPTED", jobId: "...", resultLifetimeMs: ..., nextStatusCheckMs: ... }
    // Poll GET /kmm/api?path=async/jobs/{jobId} until status = "FINISHED" or "FAILED".
    //
    // NOTE: The environment URI must exist in the publisher service's configuration.
    // If the service was restarted or the environment was deleted in Studio Admin,
    // the publish job will complete in ~2ms with 0 rules (silent failure).
    // Fix: Studio → Administration → Publisher → Classification Server Environments → (re)create.

    // Determine config path and publisher target path.
    // Semaphore stores workspace files at {ModelName}/{configFile} on the publisher filesystem.
    const configPath = options.config ?? `${modelName}/Semaphore-Publisher-CS-only.xml`;
    const publisherTarget = taskName ? `task:${modelName}:${taskName}` : modelUri;

    const qs = new URLSearchParams({
      path: `publisher/${publisherTarget}/publish`,
      config: configPath,
      environment: envUri,
      async: String(useAsync),
      language: lang,
    });

    // Pass classificationServers inline so the publisher knows which CLS to write rules to.
    // Without this body, the publisher looks up CLS servers from the environment URI on its
    // internal store — which is empty after a server restart/wipe, causing a silent 2ms
    // completion with 0 rules pushed to CLS.
    const clsBody = this.clsHost
      ? JSON.stringify({ classificationServers: [{ host: this.clsHost, port: this.clsPort, path: "/" }] })
      : "";

    const res = await this.kmmHttp.post(
      `/kmm/api?${qs.toString()}`,
      clsBody,
      {
        headers: {
          "x-api-key": await this.kmmApiKey(),
          ...(clsBody ? { "Content-Type": "application/json" } : {}),
        },
        validateStatus: (s) => s < 500,
      }
    );

    if (res.status === 202 || res.status === 200) {
      const data = res.data as Record<string, unknown>;
      const jobId = (data?.jobId ?? data?.id) as string | undefined;
      return { accepted: true, jobId, status: data?.status as string ?? "ACCEPTED" };
    }

    const msg = (res.data as Record<string, unknown>)?.message as string | undefined;
    throw new Error(
      `Publish returned HTTP ${res.status}${msg ? `: ${msg}` : ""}. ` +
      `Ensure a publisher environment is configured in Studio Admin and the model workspace exists.`
    );
  }

  /**
   * Poll the model's publish event graph until a new PublishEvent appears or times out.
   *
   * Instead of polling the old async job API (which was unreliable), this queries
   * the model's .tch graph for sempub:PublishEvent triples written by the publisher.
   *
   * @param modelUri        KMM model URI used in kmmPublish()
   * @param sinceTimestamp  ISO timestamp — only events newer than this count as "new"
   * @param timeoutMs       Max wait time in ms (default: 300 000 = 5 min)
   * @param pollMs          Polling interval in ms (default: 5 000 = 5 s)
   */
  async waitForPublish(
    modelUri: string,
    sinceTimestamp: string,
    timeoutMs = 300_000,
    pollMs = 5_000
  ): Promise<{ status: "COMPLETE" | "FAILED" | "TIMEOUT"; message?: string }> {
    const deadline = Date.now() + timeoutMs;
    const tchGraph = `urn:x-evn-master:${modelUri.replace(/^model:/, "")}.tch`;
    const q = [
      "PREFIX sempub: <http://www.smartlogic.com/2017/06/semaphore-publisher#>",
      "SELECT ?status ?publishId ?completedAt WHERE {",
      `  GRAPH <${tchGraph}> {`,
      "    ?e a sempub:PublishEvent ;",
      "       sempub:hasStatus ?status ;",
      "       sempub:publishId ?publishId ;",
      "       sempub:completedAt ?completedAt .",
      `    FILTER(?completedAt > "${sinceTimestamp}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)`,
      "  }",
      "} ORDER BY DESC(?completedAt) LIMIT 1",
    ].join("\n");

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      try {
        const result = await this.kmmSparqlSelect(modelUri, q);
        const bindings = result?.results?.bindings ?? [];
        if (bindings.length > 0) {
          const statusUri: string = bindings[0].status?.value ?? "";
          const isSuccess = statusUri.includes("PublishSuccess");
          const isFailure = statusUri.includes("PublishFailure");
          if (isSuccess) return { status: "COMPLETE" };
          if (isFailure) return { status: "FAILED", message: `Publish failed. Check Studio publish log.` };
        }
      } catch {
        // ignore transient errors, keep polling
      }
    }
    return { status: "TIMEOUT" };
  }

  /**
   * Download the publisher workspace config ZIP for a model.
   *
   * The ZIP typically contains:
   *   • Publisher XML config file(s) (e.g. Semaphore-Publisher-CS-only.xml)
   *   • templates/ directory with .kid rule template files
   *
   * Correct workspace endpoint (verified against Semaphore 5.10.1):
   *   GET /kmm/api/publisher/workspace/{encodedUri}/config
   * where encodedUri = encodeURIComponent("urn:x-evn-master:{ModelName}")
   *
   * NOTE: A previous (incorrect) pattern used a double-slash prefix:
   *   /kmm/api//{encodedUri}/publisher/workspace/{encodedUri}/config  ← WRONG
   * That URL returns HTTP 400 "invalid uris: publisher" on current Semaphore builds.
   *
   * @returns ZIP buffer, or null if no workspace exists yet for this model.
   */
  async kmmDownloadPublishConfigZip(modelUri: string): Promise<Buffer | null> {
    const modelName = modelUri.replace(/^model:/, "");
    const encodedUri = encodeURIComponent(`urn:x-evn-master:${modelName}`);
    const token = await this.kmmApiKey();
    const res = await this.kmmHttp.get(
      `/kmm/api/publisher/workspace/${encodedUri}/config`,
      {
        headers: { "x-api-key": token },
        responseType: "arraybuffer",
        validateStatus: (s) => s < 500,
      }
    );
    // 404 = workspace does not exist (no publish has been triggered for this model yet)
    // Caller (kmmPatchPublishConfigForPlainSkos) bootstraps the workspace by triggering a publish.
    if (res.status === 404) return null;
    if (res.status !== 200) {
      throw new Error(`Failed to download publish config (HTTP ${res.status}).`);
    }
    return Buffer.from(res.data as ArrayBuffer);
  }

  /**
   * Upload a publisher workspace config ZIP for a model.
   *
   * Uses multipart/form-data POST (field name "file") to the workspace config endpoint.
   * Returns on HTTP 204 (success) or throws on failure.
   *
   * PREREQUISITE: The workspace must already exist (triggered by a prior publish call).
   * kmmPatchPublishConfigForPlainSkos() handles this automatically — it bootstraps the
   * workspace by triggering an initial publish before uploading the patched config.
   * Manual Studio interaction is not required.
   */

  /**
   * Grant the publisher workspace upload permission on a KMM model via JSON-Patch.
   *
   * The Semaphore publisher workspace requires the `sempubpermissions:UploadModelConfiguration`
   * permission before a config ZIP can be uploaded. By default this is only granted when a
   * user opens the model's Publisher tab in Semaphore Studio.
   *
   * This method grants it programmatically via the PATCH /sys/{graphUri} endpoint
   * (RFC 6902 JSON-Patch, Content-Type: application/json-patch+json) — confirmed working in
   * Semaphore 5.10.1. It appends the given principal (default: "user:admin") to the
   * sempubpermissions:UploadModelConfiguration array on the model's sys graph node.
   *
   * NOTE: This grants the API-level permission but does NOT create the workspace ZIP file
   * on the server filesystem. If the workspace doesn't exist yet, trigger a publish first
   * (which creates it as a side effect). kmmPatchPublishConfigForPlainSkos() does this
   * automatically via its bootstrap-publish logic.
   *
   * @param modelUri   KMM model URI, e.g. "model:IPTCMediaTopics"
   * @param principal  JSON-LD @id of the user/group to grant, default "user:admin"
   */
  async kmmGrantPublisherPermission(
    modelUri: string,
    principal = "user:admin"
  ): Promise<void> {
    const modelName = modelUri.replace(/^model:/, "");
    const graphUri = `model:${modelName}`;
    const encodedGraph = encodeURIComponent(graphUri);
    const token = await this.kmmApiKey();

    const patch = [
      {
        op: "add",
        path: "@graph/0/sempubpermissions:UploadModelConfiguration/-",
        value: { "@id": principal },
      },
    ];

    const res = await this.kmmHttp.patch(
      `/kmm/api/sys/${encodedGraph}`,
      patch,
      {
        headers: {
          "x-api-key": token,
          "Content-Type": "application/json-patch+json",
        },
        validateStatus: (s) => s < 500,
      }
    );

    if (res.status !== 200 && res.status !== 204) {
      logger.warn("kmmGrantPublisherPermission returned non-success", {
        status: res.status,
        modelUri,
        principal,
      });
    } else {
      logger.info("Granted sempubpermissions:UploadModelConfiguration", {
        modelUri,
        principal,
      });
    }
  }

  async kmmUploadPublishConfigZip(modelUri: string, zipBuffer: Buffer): Promise<void> {
    const modelName = modelUri.replace(/^model:/, "");
    const encodedUri = encodeURIComponent(`urn:x-evn-master:${modelName}`);
    const token = await this.kmmApiKey();

    const { body, contentType } = buildMultipart([
      { name: "file", value: zipBuffer, filename: "config.zip", contentType: "application/zip" },
    ]);

    const doUpload = async () =>
      this.kmmHttp.post(
        `/kmm/api/publisher/workspace/${encodedUri}/config`,
        body,
        {
          headers: { "x-api-key": token, "Content-Type": contentType },
          validateStatus: (s) => s < 500,
        }
      );

    let res = await doUpload();

    // On 403 try granting the permission via JSON-Patch and retry once.
    // This handles models created via API that have never had the Publisher tab opened.
    // Note: the grant alone is sufficient when the workspace file already exists on the
    // server (i.e. the model was created in Studio or the Publisher tab was opened once).
    if (res.status === 403) {
      logger.info("kmmUploadPublishConfigZip got 403 — attempting auto-grant of UploadModelConfiguration", { modelUri });
      try {
        await this.kmmGrantPublisherPermission(modelUri);
        res = await doUpload();
      } catch {
        // Permission grant failed — fall through to the informative error below
      }
    }

    if (res.status === 403) {
      throw new Error(
        `Publisher workspace for ${modelUri} has not been initialized. ` +
        `Open Semaphore Studio, navigate to the model's Publisher tab to initialize the workspace, then retry. ` +
        `(HTTP 403 "UploadModelConfiguration" — the workspace file simply does not exist yet.)`
      );
    }

    if (res.status !== 204 && res.status !== 200) {
      throw new Error(`Failed to upload publish config (HTTP ${res.status}).`);
    }
  }

  /**
   * Patch the publisher workspace config ZIP for a plain-SKOS model.
   *
   * Standard Semaphore publisher configs use SKOS-XL reification (skosxl:prefLabel
   * + skosxl:Label nodes) for label lookups. Plain-SKOS vocabularies that use
   * skos:prefLabel literals directly (UNESCO, EuroVoc, AGROVOC) will generate only
   * a single rule (for the ConceptScheme) with the default config.
   *
   * This method fixes that by:
   *   1. Downloading the current workspace config ZIP (or creating a fresh one)
   *   2. Ensuring AllResources (not AllConcepts) is used in the publisher XML.
   *      AllConcepts does NOT find skos:Concept typed resources — the publisher reports 0 Concepts
   *      and generates only 1 rule (the ConceptScheme root). AllResources works correctly.
   *   3. Adding a PlainSkosModel bean that overrides the SPARQL queries to use
   *      plain skos:prefLabel and skos:altLabel instead of SKOS-XL reification
   *   4. Ensuring the ContextualCitation.kid rule template is present
   *   5. Re-uploading the patched ZIP
   *
   * @returns Human-readable summary of what was changed (or a no-op message if already patched).
   */
  async kmmPatchPublishConfigForPlainSkos(modelUri: string): Promise<string> {
    // Try to download the existing workspace config ZIP.
    //
    // WORKSPACE AUTO-INIT (verified 2026-03-17):
    //   The publisher workspace (a ZIP on the publisher service filesystem) is created
    //   automatically when a publish is triggered — even if the model has no content.
    //   Before this was discovered, we thought the Studio Publisher tab had to be opened
    //   manually. Now we bootstrap: trigger a dummy publish → workspace is created → upload
    //   the patched plain-SKOS config → do the real publish.
    //
    //   Bootstrap publish uses the default SKOS-XL config (AllResources, no GRAPH clause)
    //   and produces only 1 CLS rule (the ConceptScheme root). That is fine because:
    //     a) The model is brand new — no rules exist in CLS for it yet.
    //     b) We immediately overwrite the workspace config and re-publish.
    let zip: JSZip;
    let existing = await this.kmmDownloadPublishConfigZip(modelUri);

    if (!existing) {
      logger.info("No publisher workspace found — bootstrapping via initial publish", { modelUri });
      // Bootstrap publish: initializes the workspace directory on the publisher service.
      // Uses async=false so the workspace is guaranteed to exist when we try to download it.
      // The model may have no content, in which case this completes in <2 s.
      try {
        await this.kmmPublish(modelUri, { async: false });
        existing = await this.kmmDownloadPublishConfigZip(modelUri);
        if (existing) {
          logger.info("Bootstrap publish succeeded — workspace is now available", { modelUri });
        }
      } catch (e) {
        logger.warn("Bootstrap publish failed — will attempt upload anyway", { modelUri, err: String(e) });
      }
    }

    if (existing) {
      zip = await JSZip.loadAsync(existing);
      logger.debug("Downloaded existing publisher config ZIP", { modelUri, size: existing.length });
    } else {
      zip = new JSZip();
      logger.debug("No existing publisher config even after bootstrap — creating fresh ZIP", { modelUri });
    }

    // Always target the CS-only config — this is what kmmPublish() uses by default
    // (config="{ModelName}/Semaphore-Publisher-CS-only.xml"). The ZIP may contain
    // other XML files (Semaphore-Publisher-Concepts.xml, Semaphore-Publisher.xml, etc.)
    // that are NOT used by the publish call, so patching those has no effect.
    const xmlFilename = "Semaphore-Publisher-CS-only.xml";

    const currentXml = zip.files[xmlFilename]
      ? await zip.files[xmlFilename].async("string")
      : "";

    // Check what needs to change.
    // Canonical config: AllConcepts + PlainSkosModel with explicit GRAPH clause.
    //
    // ROOT CAUSE (discovered 2026-03-17): the publisher's SparqlEndpoint connects to a
    // global SPARQL endpoint shared across all models. Each model's data lives in the
    // named graph urn:x-evn-master:{ModelName}. Without an explicit GRAPH clause, all
    // label queries hit the empty default graph and return 0 rows, so the publisher
    // generates only the auto-produced ConceptScheme root rule (1 rule total instead of
    // one rule per concept).
    //
    // Fix: add GRAPH <urn:x-evn-master:{ModelName}> { ... } around all WHERE clauses.
    // Strip both short-form (model:) and full-URI (urn:x-evn-master:) prefixes to get
    // the bare model name for the GRAPH clause (e.g. "PSForecastDrivers").
    const modelName = modelUri.replace(/^model:/, "").replace(/^urn:x-evn-master:/, "");
    const graphUri = `urn:x-evn-master:${modelName}`;
    const alreadyHasAllConcepts = currentXml.includes('parent="AllConcepts"');
    const alreadyHasPlainSkosModel = currentXml.includes("PlainSkosModel");
    const alreadyHasGraphClause = currentXml.includes(graphUri);
    const alreadyHasPrefLabelUri = currentXml.includes("?prefLabelUri");
    const alreadyHasPrefLabelRelationship = currentXml.includes("?prefLabelRelationship");

    if (alreadyHasAllConcepts && alreadyHasPlainSkosModel && alreadyHasGraphClause &&
        alreadyHasPrefLabelUri && alreadyHasPrefLabelRelationship) {
      return (
        `Publisher config for ${modelUri} is already patched for plain SKOS.\n` +
        "No changes needed — proceed with semaphore_publish to rebuild the rule set."
      );
    }

    const changes: string[] = [];
    if (!alreadyHasAllConcepts) {
      changes.push("AllResources → AllConcepts (generates one rule per skos:Concept)");
    }
    if (!alreadyHasPlainSkosModel) {
      changes.push("Added PlainSkosModel bean with plain skos:prefLabel / skos:altLabel SPARQL queries");
    }
    if (!alreadyHasGraphClause) {
      changes.push(`Added GRAPH <${graphUri}> clause (publisher uses global SPARQL endpoint; data is in named graph, not default graph)`);
    }
    if (!alreadyHasPrefLabelUri || !alreadyHasPrefLabelRelationship) {
      changes.push("Fixed getPrefLabelsSparql to return all 4 required columns (?termUri ?prefLabelUri ?prefLabel ?prefLabelRelationship)");
    }

    // Write the canonical patched XML to the target file
    zip.file(xmlFilename, buildPlainSkosPublisherXml(modelName));

    // Ensure the ContextualCitation.kid template is present
    if (!zip.files["templates/ContextualCitation.kid"]) {
      zip.file("templates/ContextualCitation.kid", CONTEXTUAL_CITATION_TEMPLATE);
      changes.push("Added templates/ContextualCitation.kid");
    }

    // Generate and upload patched ZIP
    const zipBuffer = Buffer.from(
      await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
    );
    await this.kmmUploadPublishConfigZip(modelUri, zipBuffer);

    logger.debug("Uploaded patched publisher config ZIP", { modelUri, changes });
    return (
      `Publisher config for ${modelUri} patched and uploaded successfully.\n` +
      `Changes applied:\n${changes.map((c) => `  • ${c}`).join("\n")}\n\n` +
      "Next step: run semaphore_publish to rebuild the CLS rule set with the new config."
    );
  }

  // ── Publisher .kid template management ──────────────────────────────────────

  /**
   * Retrieve the content of a publisher rule template (.kid file) from the
   * model's workspace config ZIP.
   *
   * @param modelUri     KMM model URI, e.g. "model:IPTCMediaTopics"
   * @param templateName Template filename, e.g. "ContextualCitation.kid" (default)
   * @returns The raw .kid XML string, or null if the workspace / template does not exist yet.
   */
  async kmmGetKidTemplate(
    modelUri: string,
    templateName = "ContextualCitation.kid"
  ): Promise<string | null> {
    const zipBuffer = await this.kmmDownloadPublishConfigZip(modelUri);
    if (!zipBuffer) return null;

    const zip = await JSZip.loadAsync(zipBuffer);
    const key = `templates/${templateName}`;
    if (!zip.files[key]) return null;
    return zip.files[key].async("string");
  }

  /**
   * Upload a publisher rule template (.kid file) into the model's workspace config ZIP.
   *
   * If the workspace does not exist yet, an initial bootstrap publish is triggered to
   * create it before uploading. If a non-default template name is provided, the
   * publisher XML is also patched to reference the new template file.
   *
   * After calling this method, run kmmPublish() to rebuild the CLS rule set.
   *
   * @param modelUri        KMM model URI, e.g. "model:IPTCMediaTopics"
   * @param templateContent Raw .kid XML string
   * @param options         templateName — filename to store (default: "ContextualCitation.kid")
   */
  async kmmSetKidTemplate(
    modelUri: string,
    templateContent: string,
    options: { templateName?: string } = {}
  ): Promise<void> {
    const templateName = options.templateName ?? "ContextualCitation.kid";
    const modelName = modelUri.replace(/^model:/, "");
    const xmlFilename = "Semaphore-Publisher-CS-only.xml";

    let zipBuffer = await this.kmmDownloadPublishConfigZip(modelUri);

    if (!zipBuffer) {
      logger.info("kmmSetKidTemplate: no workspace yet — bootstrapping via initial publish", { modelUri });
      try {
        await this.kmmPublish(modelUri, { async: false });
        zipBuffer = await this.kmmDownloadPublishConfigZip(modelUri);
      } catch (e) {
        logger.warn("Bootstrap publish failed — creating fresh ZIP", { modelUri, err: String(e) });
      }
    }

    const zip = zipBuffer ? await JSZip.loadAsync(zipBuffer) : new JSZip();

    // Add or replace the template file
    zip.file(`templates/${templateName}`, templateContent);

    // If a non-default template name is used, update the publisher XML reference
    if (templateName !== "ContextualCitation.kid") {
      const currentXml = zip.files[xmlFilename]
        ? await zip.files[xmlFilename].async("string")
        : buildPlainSkosPublisherXml(modelName);
      const updatedXml = currentXml.replace(
        /(<property name="templateFileName" value=")[^"]*("(?:\s*\/)?>)/,
        `$1${templateName}$2`
      );
      zip.file(xmlFilename, updatedXml);
    }

    const newZipBuffer = Buffer.from(
      await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
    );
    await this.kmmUploadPublishConfigZip(modelUri, newZipBuffer);
    logger.info("kmmSetKidTemplate: template uploaded", { modelUri, templateName });
  }

  // ── CLS methods ─────────────────────────────────────────────────────────────

  /** Returns true if the Classification Server (CLS) is reachable. */
  async healthCheck(): Promise<{ healthy: boolean; version?: string }> {
    if (!this.configured) return { healthy: false };
    try {
      const res = await this.clsHttp.get<string>("/?op=version", {
        timeout: 5_000,
        responseType: "text",
      });
      const version = xmlText(String(res.data), "version");
      return { healthy: true, version };
    } catch {
      return { healthy: false };
    }
  }

  /** Returns true if the KMM / Studio server is reachable. */
  async kmmHealthCheck(): Promise<{ healthy: boolean; statusCode?: number }> {
    if (!this.kmmBaseUrl) return { healthy: false };
    try {
      const res = await this.kmmHttp.get<string>("/", {
        timeout: 5_000,
        responseType: "text",
        // 401/403 still mean the server is up — only network errors mean it's down
        validateStatus: () => true,
      });
      return { healthy: true, statusCode: res.status };
    } catch {
      return { healthy: false };
    }
  }

  /** List published rule sets (equivalent to "models" or "taxonomies"). */
  async listPublishSets(): Promise<SemaphorePublishSet[]> {
    const xml = await this.postXmlOp("listPublishSets");
    const sets: SemaphorePublishSet[] = [];
    for (const el of xmlAll(xml, "publishset")) {
      const a = xmlAttrs(el);
      if (a.name) {
        sets.push({
          name: a.name,
          type: a.type ?? "unknown",
          active: a.active === "true",
        });
      }
    }
    return sets;
  }

  /** List classification classes (taxonomy roots) from the active rulenet. */
  async listClasses(): Promise<SemaphoreClass[]> {
    const xml = await this.postXmlOp("listRulenetClasses");
    const classes: SemaphoreClass[] = [];
    for (const el of xmlAll(xml, "Class")) {
      const a = xmlAttrs(el);
      if (a.Name) {
        classes.push({
          name: a.Name,
          ruleCount: parseInt(a.count_rules ?? "0", 10),
        });
      }
    }
    return classes;
  }

  /**
   * List available language packs in the Classification Server.
   *
   * CLS language codes use an indexed format (e.g. "en1", "fr1") not ISO codes.
   * Use the returned `id` values for the `language` parameter in classify() calls.
   * The default language (usually "en1") is used when no language is specified.
   */
  async listClsLanguages(): Promise<SemaphoreLanguage[]> {
    const xml = await this.postXmlOp("listlanguages");
    const languages: SemaphoreLanguage[] = [];
    for (const el of xmlAll(xml, "language")) {
      const a = xmlAttrs(el);
      if (a.id) {
        languages.push({
          id: a.id,
          name: a.name ?? a.id,
          default: a.default === "true",
          hasRules: a.has_rules_defined === "true",
        });
      }
    }
    return languages;
  }

  /**
   * Classify text content.
   *
   * @param content      Plain text or HTML to classify.
   * @param threshold    Minimum confidence threshold, integer 0–100 (default: 48). Lower = more results.
   *                     Use 0 to return all candidates regardless of score.
   *                     Note: the threshold is on a 0–100 integer scale, but the CLS XML @score
   *                     attribute is a 0.0–1.0 float (e.g. threshold=48 filters below score 0.48).
   * @param publishSet   Restrict to a single publish set (e.g. "softwareengineering").
   *                     Passed as a multipart form field "publish_set".
   * @param publishSets  Restrict to multiple publish sets (e.g. ["iptcmediatopics", "unescothesaurus"]).
   *                     Passed as "publish_set_name_list" (pipe-separated). Takes precedence over publishSet.
   *                     When neither is supplied all active publish sets are used.
   */
  async classify(
    content: string,
    threshold = 48,
    publishSet?: string,
    publishSets?: string[]
  ): Promise<SemaphoreClassificationResult> {
    const fields: Array<{ name: string; value: string }> = [
      { name: "body", value: content },
      { name: "threshold", value: String(threshold) },
      { name: "singlearticle", value: "true" },
    ];
    if (publishSets && publishSets.length > 0) {
      // pipe-separated list filters to the specified publish sets
      fields.push({ name: "publish_set_name_list", value: publishSets.join("|") });
    } else if (publishSet) {
      fields.push({ name: "publish_set", value: publishSet });
    }
    const { body, contentType } = buildMultipart(fields);

    const res = await this.clsHttp.post<string>("/", body, {
      headers: { "Content-Type": contentType },
      responseType: "text",
    });

    const xml = String(res.data);
    const categories: SemaphoreCategory[] = [];

    for (const el of xmlAll(xml, "META")) {
      const a = xmlAttrs(el);
      // Skip non-classification META elements (Type, Template, etc.)
      if (!a.name || !a.value || !a.id || a.score === undefined) continue;
      // Filter out internal system META
      if (a.name === "Type" || a.name === "Template") continue;
      const score = parseFloat(a.score);
      categories.push({
        className: a.name,
        label: a.value,
        id: a.id,
        score,
      });
    }

    return { categories, rawXml: xml };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async postXmlOp(op: string, publishSet?: string): Promise<string> {
    let xmlInput = `<?xml version="1.0" ?><request op="${op}">`;
    if (publishSet) xmlInput += `<publish_set>${publishSet}</publish_set>`;
    xmlInput += "</request>";

    const { body, contentType } = buildMultipart([
      { name: "XML_INPUT", value: xmlInput },
    ]);

    const res = await this.clsHttp.post<string>("/", body, {
      headers: { "Content-Type": contentType },
      responseType: "text",
    });
    return String(res.data);
  }
}

