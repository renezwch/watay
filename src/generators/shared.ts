/**
 * Watay – shared generator helpers (owner: dev-codegen).
 * Pure, deterministic, dependency-free. Erasable TypeScript only.
 */
import type { OperationIR, ParameterIR, ResponseIR, SchemaIR, WatayIR } from '../types.ts';

/** Optional extensions that dev-core may add to the IR; read defensively. */
export type SchemaX = SchemaIR & { const?: string | number | boolean | null; example?: unknown };
export interface SecuritySchemeX {
  type: string;
  scheme?: string;
  in?: 'query' | 'header' | 'cookie';
  paramName?: string;
}
export type WatayIRX = WatayIR & { securitySchemes?: Record<string, SecuritySchemeX> };
export const ext = (s: SchemaIR): SchemaX => s as SchemaX;

// ------------------------------------------------------------------ naming

/** Split an arbitrary identifier into lowercase-able words ("petId" -> ["pet","Id"], "X-Request-ID" -> ["X","Request","ID"]). */
export function words(input: string): string[] {
  const spaced = input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim();
  return spaced === '' ? [] : spaced.split(/\s+/);
}

export function pascalCase(input: string): string {
  const w = words(input).map((x) => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase());
  const s = w.join('');
  if (s === '') return 'Unnamed';
  return /^[0-9]/.test(s) ? '_' + s : s;
}

export function camelCase(input: string): string {
  const p = pascalCase(input);
  const lead = p.startsWith('_') ? '_' : '';
  const body = lead ? p.slice(1) : p;
  return lead + body.charAt(0).toLowerCase() + body.slice(1);
}

export function snakeCase(input: string): string {
  const s = words(input).map((x) => x.toLowerCase()).join('_');
  if (s === '') return 'unnamed';
  return /^[0-9]/.test(s) ? '_' + s : s;
}

export function kebabCase(input: string): string {
  const s = words(input).map((x) => x.toLowerCase()).join('-');
  return s === '' ? 'api' : s;
}

export function isIdent(s: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
}

export const TS_RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null',
  'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'let', 'static', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'await', 'async',
  'any', 'unknown', 'never', 'string', 'number', 'boolean', 'object', 'symbol', 'undefined', 'type', 'of',
]);

export const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case', 'type',
  // builtins we never want to shadow in generated signatures
  'self', 'cls', 'id', 'list', 'dict', 'str', 'int', 'float', 'bool', 'bytes', 'set', 'tuple', 'object', 'input', 'format',
  'filter', 'map', 'min', 'max', 'sum', 'len', 'all', 'any',
]);

/** Make `base` unique within `used` by appending 2, 3, ... (registers the result). */
export function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let i = 2;
  while (used.has(name)) name = base + String(i++);
  used.add(name);
  return name;
}

/** JS/TS property key: bare when valid identifier, else JSON-quoted. */
export function propKey(name: string): string {
  return isIdent(name) ? name : JSON.stringify(name);
}

/** Make text safe inside a block comment. */
export function commentSafe(text: string): string {
  return text.replace(/\*\//g, '*\\/').replace(/\r/g, '');
}

export function docLines(text: string | undefined): string[] {
  if (!text) return [];
  return commentSafe(text).split('\n').map((l) => l.trimEnd());
}

// ------------------------------------------------------------------ schema helpers

export function resolveRef(ir: WatayIR, schema: SchemaIR): SchemaIR | undefined {
  let cur: SchemaIR | undefined = schema;
  let guard = 0;
  while (cur && cur.ref !== undefined && guard++ < 32) cur = ir.schemas[cur.ref];
  return cur;
}

/** Merge an allOf into one object schema when all members are (or resolve to) object-like schemas. */
export function mergeAllOf(ir: WatayIR, schema: SchemaIR, depth = 0): SchemaIR | undefined {
  if (!schema.allOf || depth > 16) return undefined;
  const props: Record<string, SchemaIR> = {};
  const required: string[] = [];
  let additional: boolean | SchemaIR | undefined;
  const parts: SchemaIR[] = [{ ...schema, allOf: undefined }, ...schema.allOf];
  for (const part of parts) {
    let p: SchemaIR | undefined = part;
    if (p.ref !== undefined) p = resolveRef(ir, p);
    if (!p) return undefined;
    if (p.allOf) {
      const inner = mergeAllOf(ir, p, depth + 1);
      if (!inner) return undefined;
      p = inner;
    }
    const isObjectLike = p.type === 'object' || p.properties !== undefined || (p.type === undefined && !p.oneOf && !p.anyOf && !p.enum && p.items === undefined);
    if (!isObjectLike) return undefined;
    for (const [k, v] of Object.entries(p.properties ?? {})) props[k] = v;
    for (const r of p.required ?? []) if (!required.includes(r)) required.push(r);
    if (p.additionalProperties !== undefined) additional = p.additionalProperties;
  }
  const merged: SchemaIR = { type: 'object', properties: props };
  if (required.length) merged.required = required;
  if (additional !== undefined) merged.additionalProperties = additional;
  if (schema.description) merged.description = schema.description;
  if (schema.nullable) merged.nullable = true;
  return merged;
}

/**
 * Wire-validation descriptor: strips docs/examples/defaults and renames `ref` -> `$ref`.
 * Keys are emitted in a fixed order => deterministic output.
 */
export function toDescriptor(schema: SchemaIR): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  if (schema.nullable) d.nullable = true;
  if (schema.ref !== undefined) {
    d.$ref = schema.ref;
    return d;
  }
  if (schema.type !== undefined) d.type = schema.type;
  if (schema.enum !== undefined) d.enum = schema.enum;
  if (ext(schema).const !== undefined) d.const = ext(schema).const;
  if (schema.items !== undefined) d.items = toDescriptor(schema.items);
  if (schema.properties !== undefined) {
    const props: Record<string, unknown> = {};
    for (const k of Object.keys(schema.properties)) props[k] = toDescriptor(schema.properties[k]!);
    d.properties = props;
  }
  if (schema.required !== undefined && schema.required.length) d.required = schema.required;
  if (schema.additionalProperties !== undefined) {
    d.additionalProperties = typeof schema.additionalProperties === 'boolean' ? schema.additionalProperties : toDescriptor(schema.additionalProperties);
  }
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const list = schema[key];
    if (list !== undefined) d[key] = list.map(toDescriptor);
  }
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    if (schema[key] !== undefined) d[key] = schema[key];
  }
  return d;
}

// ------------------------------------------------------------------ examples (for mock servers & contract tests)

const EXAMPLE_DATE_TIME = '2024-01-01T00:00:00Z';

/** Build a schema-conforming example value. Returns undefined when it can only be produced by infinite recursion. */
export function exampleValue(ir: WatayIR, schema: SchemaIR | undefined, stack: string[] = [], depth = 0): unknown {
  if (!schema) return null;
  if (depth > 12) return undefined;
  if (schema.ref !== undefined) {
    if (stack.includes(schema.ref)) return undefined;
    const target = ir.schemas[schema.ref];
    if (!target) return null;
    return exampleValue(ir, target, [...stack, schema.ref], depth + 1);
  }
  if (ext(schema).example !== undefined) return ext(schema).example;
  if (ext(schema).const !== undefined) return ext(schema).const;
  if (schema.enum !== undefined && schema.enum.length > 0) return schema.enum[0];
  if (schema.allOf) {
    const merged = mergeAllOf(ir, schema);
    if (merged) return exampleValue(ir, merged, stack, depth + 1);
    return exampleValue(ir, schema.allOf[0], stack, depth + 1);
  }
  const alts = schema.oneOf ?? schema.anyOf;
  if (alts && alts.length > 0) {
    for (const alt of alts) {
      const v = exampleValue(ir, alt, stack, depth + 1);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  if (schema.default !== undefined) return schema.default;
  switch (schema.type) {
    case 'string': {
      let s: string;
      switch (schema.format) {
        case 'date-time': s = EXAMPLE_DATE_TIME; break;
        case 'date': s = '2024-01-01'; break;
        case 'uuid': s = '123e4567-e89b-42d3-a456-426614174000'; break;
        case 'email': s = 'user@example.com'; break;
        case 'uri': case 'url': s = 'https://example.com/resource'; break;
        case 'byte': s = 'dGVzdA=='; break;
        default: s = 'string';
      }
      if (schema.minLength !== undefined && s.length < schema.minLength) s = s.padEnd(schema.minLength, 'x');
      if (schema.maxLength !== undefined && s.length > schema.maxLength) s = s.slice(0, schema.maxLength);
      return s;
    }
    case 'integer':
    case 'number': {
      let n = schema.type === 'integer' ? 1 : 1.5;
      if (schema.minimum !== undefined && n < schema.minimum) n = Math.ceil(schema.minimum);
      if (schema.exclusiveMinimum !== undefined && n <= schema.exclusiveMinimum) n = Math.floor(schema.exclusiveMinimum) + 1;
      if (schema.maximum !== undefined && n > schema.maximum) n = Math.floor(schema.maximum);
      if (schema.exclusiveMaximum !== undefined && n >= schema.exclusiveMaximum) n = Math.ceil(schema.exclusiveMaximum) - 1;
      return n;
    }
    case 'boolean': return true;
    case 'null': return null;
    case 'array': {
      const item = exampleValue(ir, schema.items, stack, depth + 1);
      if (item === undefined) return [];
      const count = Math.max(1, schema.minItems ?? 1);
      return Array.from({ length: Math.min(count, 3) }, () => item);
    }
    case 'object':
    default: {
      if (schema.type === undefined && schema.properties === undefined) {
        if (schema.additionalProperties === undefined) return {};
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) {
        const ev = exampleValue(ir, v, stack, depth + 1);
        if (ev !== undefined) out[k] = ev;
      }
      if (schema.properties === undefined && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const ev = exampleValue(ir, schema.additionalProperties, stack, depth + 1);
        if (ev !== undefined) out.key = ev;
      }
      return out;
    }
  }
}

// ------------------------------------------------------------------ operation helpers

export type ContentKind = 'json' | 'form' | 'multipart' | 'text' | 'binary' | 'none';

export function contentKind(contentType: string | undefined, hasSchema = true): ContentKind {
  if (contentType === undefined) return hasSchema ? 'json' : 'none';
  const ct = contentType.toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('x-www-form-urlencoded')) return 'form';
  if (ct.includes('multipart/')) return 'multipart';
  if (ct.startsWith('text/')) return 'text';
  return 'binary';
}

export function isSuccessStatus(status: string): boolean {
  return /^2\d\d$/.test(status) || /^2XX$/i.test(status);
}

export interface StatusResponse extends ResponseIR {
  status: string;
}

/** Responses as a sorted list (numeric statuses ascending, then ranges, then "default"). */
export function responseList(op: OperationIR): StatusResponse[] {
  const rank = (k: string): number => (/^\d{3}$/.test(k) ? 0 : /^\dXX$/i.test(k) ? 1 : 2);
  return Object.keys(op.responses)
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map((status) => ({ status, ...op.responses[status]! }));
}

/** The response the SDK method returns on success (first 2xx; falls back to a 2XX range). */
export function successResponse(op: OperationIR): StatusResponse | undefined {
  const list = responseList(op);
  return list.find((r) => /^2\d\d$/.test(r.status)) ?? list.find((r) => /^2XX$/i.test(r.status));
}

export function paramsIn(op: OperationIR, where: ParameterIR['in']): ParameterIR[] {
  return op.parameters.filter((p) => p.in === where);
}

export interface AuthRequirement {
  scheme: string;
  kind: 'bearer' | 'basic' | 'apiKey';
  in?: 'query' | 'header' | 'cookie';
  name?: string;
}

export function authRequirements(ir: WatayIR, op: OperationIR): AuthRequirement[] {
  const schemes = (ir as WatayIRX).securitySchemes;
  const out: AuthRequirement[] = [];
  for (const name of op.security ?? []) {
    const s = schemes?.[name];
    if (!s) {
      // IR carries no scheme definition: fall back to a bearer token.
      out.push({ scheme: name, kind: 'bearer' });
    } else if (s.type === 'http' && (s.scheme ?? '').toLowerCase() === 'basic') out.push({ scheme: name, kind: 'basic' });
    else if (s.type === 'http' || s.type === 'oauth2' || s.type === 'openIdConnect') out.push({ scheme: name, kind: 'bearer' });
    else if (s.type === 'apiKey') out.push({ scheme: name, kind: 'apiKey', in: s.in ?? 'header', name: s.paramName ?? name });
  }
  return out;
}

/** Effective request-body content kind. */
export function requestKind(op: OperationIR): ContentKind {
  return op.requestBody ? contentKind(op.requestBody.contentType) : 'none';
}

export const GENERATED_BANNER = 'Generated by Watay (https://watay.dev) - do not edit by hand; re-run `npx watay generate`.';

export function sortedSchemaNames(ir: WatayIR): string[] {
  return Object.keys(ir.schemas).sort();
}

/** Deterministic pretty JSON (insertion order is already deterministic). */
export function jsonBlock(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).split('\n').join('\n' + indent);
}

/** Render a JSON-compatible value as a Python literal. */
export function pyLiteral(value: unknown, indent = '', step = '    '): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'None';
  if (typeof value === 'string') return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const inner = indent + step;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return '[\n' + value.map((v) => inner + pyLiteral(v, inner, step)).join(',\n') + ',\n' + indent + ']';
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  return '{\n' + entries.map(([k, v]) => inner + JSON.stringify(k) + ': ' + pyLiteral(v, inner, step)).join(',\n') + ',\n' + indent + '}';
}

/** Options accepted by both generators (superset of ARCHITECTURE §3: `{ packageName? }`). */
export interface CodegenOptions {
  packageName?: string;
  sdkVersion?: string;
  /** Also emit generated contract tests under tests/. */
  withContractTests?: boolean;
}

/** `Title Case API` -> `TitleCaseApi`, always suffixed with `Client` exactly once. */
export function clientClassName(title: string): string {
  const base = pascalCase(title).replace(/^_+/, '') || 'Api';
  return /Client$/.test(base) ? base : base + 'Client';
}
