/**
 * Watay – shared types (owner: dev-core). Contract: ARCHITECTURE.md §3.
 * Erasable TS only (no enums/namespaces/parameter properties); relative imports use ".ts".
 * Additive extensions beyond §3 are marked "(ext)" and are always optional.
 */

// ---------- OpenAPI Intermediate Representation ----------
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';
export type PrimitiveType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';

export interface SchemaIR {
  type?: PrimitiveType;
  format?: string;
  enum?: (string | number | boolean | null)[];
  /** Name of an entry in WatayIR.schemas (NOT "#/components/schemas/..") */
  ref?: string;
  properties?: Record<string, SchemaIR>;
  required?: string[];
  items?: SchemaIR;
  additionalProperties?: boolean | SchemaIR;
  oneOf?: SchemaIR[];
  anyOf?: SchemaIR[];
  allOf?: SchemaIR[];
  nullable?: boolean;
  description?: string;
  default?: unknown;
  /** (ext) OpenAPI 3.1 / JSON Schema const */
  const?: string | number | boolean | null;
  /** (ext) example value */
  example?: unknown;
  // (ext) validation constraints
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  deprecated?: boolean;
  /** (ext) discriminator of oneOf/anyOf */
  discriminator?: { propertyName: string; mapping?: Record<string, string> };
}

export interface ParameterIR {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  schema: SchemaIR;
  description?: string;
  deprecated?: boolean; // (ext)
}

export interface ResponseIR {
  description?: string;
  schema?: SchemaIR;
  contentType?: string;
  /** (ext) all declared content types of this response */
  contentTypes?: string[];
}

export interface OperationIR {
  /** unique + normalized (camelCase, [A-Za-z0-9_]); parser synthesizes `<method><PathSegments>` if absent */
  operationId: string;
  method: HttpMethod;
  path: string; // "/pets/{petId}"
  summary?: string;
  description?: string;
  deprecated?: boolean;
  parameters: ParameterIR[]; // path-level + op-level merged, $ref resolved
  requestBody?: {
    required: boolean;
    contentType: string;
    schema: SchemaIR;
    /** (ext) all declared content types */
    contentTypes?: string[];
  };
  responses: Record<string, ResponseIR>; // "200" | "404" | "default"; keys sorted
  tags?: string[];
  /** (ext) names of security schemes required (union over alternatives); absent/[] = none */
  security?: string[];
}

export interface SecuritySchemeIR {
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect' | 'mutualTLS';
  scheme?: string;
  bearerFormat?: string;
  in?: 'query' | 'header' | 'cookie';
  paramName?: string;
}

export interface WatayIR {
  title: string;
  version: string;
  description?: string;
  servers: string[];
  schemas: Record<string, SchemaIR>; // components.schemas, $refs normalized to names
  operations: OperationIR[]; // deterministically sorted: path, then method
  /** (ext) components.securitySchemes */
  securitySchemes?: Record<string, SecuritySchemeIR>;
}

// ---------- Contract Guard ----------
export type Severity = 'breaking' | 'non-breaking' | 'info';

export interface DiffChange {
  /** stable machine code, e.g. "operation-removed", "required-param-added" */
  code: string;
  severity: Severity;
  /** e.g. "GET /pets/{petId} > response 200 > Pet.name" */
  location: string;
  message: string; // single line, English
  before?: string;
  after?: string;
}

export interface DiffResult {
  breaking: DiffChange[];
  nonBreaking: DiffChange[];
  info: DiffChange[];
  hasBreaking: boolean;
  /** breaking→"major", nonBreaking→"minor", else "patch" */
  suggestedBump: 'major' | 'minor' | 'patch';
  markdown: string; // finished changelog / PR comment
}

// ---------- Generators / Healer ----------
export type Language = 'typescript' | 'python';

export interface GeneratorOutput {
  language: Language;
  /** relPath -> file content (no dates/randomness -> deterministic) */
  files: Record<string, string>;
}

export interface VerifyIssue {
  file?: string;
  line?: number;
  tool: string;
  message: string;
}
export interface VerifyReport {
  language: Language;
  ok: boolean;
  checks: { name: string; status: 'passed' | 'failed' | 'skipped'; detail?: string }[];
  issues: VerifyIssue[];
}
export interface HealOptions {
  maxIterations?: number; // default 3
  /** BYOK hook: gets files + issues, returns patched files. Absent -> deterministic repairs only. */
  repair?: (files: Record<string, string>, issues: VerifyIssue[]) => Promise<Record<string, string>>;
}
export interface HealResult {
  output: GeneratorOutput;
  report: VerifyReport;
  iterations: number;
  healed: boolean;
}

// ---------- License ----------
export type Tier = 'free' | 'pro' | 'scale';
export type LicenseTier = Tier;
export interface LicenseStatus {
  valid: boolean;
  tier: Tier;
  source: 'none' | 'offline-demo' | 'lemonsqueezy' | 'polar' | 'cache';
  reason?: string; // e.g. "no key", "expired", "network-unreachable-fallback-free"
  expiresAt?: string; // ISO-8601
  /** (ext) list of features enabled for the tier */
  features?: string[];
}
