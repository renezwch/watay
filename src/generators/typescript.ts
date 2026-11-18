/**
 * Watay – TypeScript SDK generator (owner: dev-codegen).
 *
 * Output: zero-dependency, fully typed fetch client with runtime schema validation.
 * Generated code is "erasable TypeScript" (no enums/namespaces/parameter properties, `.ts` import
 * specifiers) so it runs directly on Node >= 22.18 *and* compiles with tsc >= 5.7
 * (`rewriteRelativeImportExtensions`).
 */
import type { GeneratorOutput, OperationIR, ParameterIR, SchemaIR, WatayIR } from '../types.ts';
import { generateContractTests } from './contract-tests.ts';
import {
  GENERATED_BANNER,
  authRequirements,
  camelCase,
  clientClassName,
  contentKind,
  docLines,
  ext,
  isIdent,
  jsonBlock,
  kebabCase,
  pascalCase,
  propKey,
  requestKind,
  responseList,
  sortedSchemaNames,
  successResponse,
  toDescriptor,
  uniqueName,
} from './shared.ts';
import type { CodegenOptions } from './shared.ts';

const RESERVED_GLOBALS = [
  'Array', 'Record', 'Partial', 'Promise', 'Date', 'Map', 'Set', 'Blob', 'Object', 'String', 'Number',
  'Boolean', 'Symbol', 'Function', 'Headers', 'Response', 'Request', 'Omit', 'Pick', 'Readonly',
];

interface Ctx {
  names: Map<string, string>;
  /** Prefix for schema type references, e.g. "T." inside client.ts. */
  prefix: string;
}

// ------------------------------------------------------------------ type expressions

function paren(t: string): string {
  return /[|&]/.test(t.replace(/"(?:[^"\\]|\\.)*"/g, '""')) && !/^[({]/.test(t) ? '(' + t + ')' : t;
}

function literal(v: string | number | boolean | null): string {
  return v === null ? 'null' : JSON.stringify(v);
}

function tsType(s: SchemaIR, c: Ctx, indent = ''): string {
  let t = tsBase(s, c, indent);
  if (s.nullable && t !== 'null' && t !== 'unknown' && !/\| null$/.test(t)) t += ' | null';
  return t;
}

function tsBase(s: SchemaIR, c: Ctx, indent: string): string {
  if (s.ref !== undefined) return c.prefix + (c.names.get(s.ref) ?? 'unknown');
  const k = ext(s).const;
  if (k !== undefined) return literal(k);
  if (s.enum !== undefined && s.enum.length > 0) return s.enum.map(literal).join(' | ');
  if (s.allOf && s.allOf.length > 0) {
    const parts = s.allOf.map((x) => paren(tsType(x, c, indent)));
    if (s.properties) parts.push(objectType(s, c, indent));
    return parts.join(' & ');
  }
  const alts = s.oneOf ?? s.anyOf;
  if (alts && alts.length > 0) return alts.map((x) => tsType(x, c, indent)).join(' | ');
  switch (s.type) {
    case 'string': return 'string';
    case 'integer':
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'array': return 'Array<' + (s.items ? tsType(s.items, c, indent) : 'unknown') + '>';
    case 'object': return objectType(s, c, indent);
    default:
      if (s.properties) return objectType(s, c, indent);
      return 'unknown';
  }
}

function objectType(s: SchemaIR, c: Ctx, indent: string): string {
  const props = s.properties;
  const ap = s.additionalProperties;
  if (!props || Object.keys(props).length === 0) {
    if (ap && typeof ap === 'object') return 'Record<string, ' + tsType(ap, c, indent) + '>';
    return 'Record<string, unknown>';
  }
  const inner = indent + '  ';
  const req = new Set(s.required ?? []);
  const lines: string[] = ['{'];
  for (const [name, ps] of Object.entries(props)) {
    for (const d of propDoc(ps, inner)) lines.push(d);
    const ro = ps.readOnly ? 'readonly ' : '';
    lines.push(inner + ro + propKey(name) + (req.has(name) ? '' : '?') + ': ' + tsType(ps, c, inner) + ';');
  }
  if (ap === true || (ap && typeof ap === 'object')) lines.push(inner + '[key: string]: unknown;');
  lines.push(indent + '}');
  return lines.join('\n');
}

function propDoc(s: SchemaIR, indent: string): string[] {
  const d = docLines(s.description);
  const tags: string[] = [];
  if (s.deprecated) tags.push('@deprecated');
  if (d.length === 0 && tags.length === 0) return [];
  if (d.length + tags.length === 1) return [indent + '/** ' + (d[0] ?? tags[0]) + ' */'];
  return [indent + '/**', ...d.map((l) => indent + ' * ' + l), ...tags.map((l) => indent + ' * ' + l), indent + ' */'];
}

// ------------------------------------------------------------------ per-operation model

interface OpModel {
  op: OperationIR;
  method: string; // camelCase method name
  paramsType: string; // interface name
  bodyKey: string;
  hasArgs: boolean;
  argsOptional: boolean;
}

function buildNames(ir: WatayIR): { names: Map<string, string>; used: Set<string> } {
  const used = new Set<string>(RESERVED_GLOBALS);
  const names = new Map<string, string>();
  for (const n of sortedSchemaNames(ir)) names.set(n, uniqueName(pascalCase(n), used));
  return { names, used };
}

function buildOps(ir: WatayIR, used: Set<string>): OpModel[] {
  const methodNames = new Set<string>(['constructor', '_request', '_handle', 'toString', 'valueOf']);
  return ir.operations.map((op) => {
    const method = uniqueName(camelCase(op.operationId), methodNames);
    const paramsType = uniqueName(pascalCase(op.operationId) + 'Params', used);
    const bodyKey = op.parameters.some((p) => p.name === 'body') ? 'requestBody' : 'body';
    const hasArgs = op.parameters.length > 0 || op.requestBody !== undefined;
    const argsOptional = !op.parameters.some((p) => p.required) && !(op.requestBody && op.requestBody.required);
    return { op, method, paramsType, bodyKey, hasArgs, argsOptional };
  });
}

function returnType(op: OperationIR, c: Ctx): string {
  const r = successResponse(op);
  if (!r) return 'void';
  const kind = contentKind(r.contentType, r.schema !== undefined);
  if (kind === 'none') return 'void';
  if (kind === 'text') return 'string';
  if (kind === 'binary') return 'Blob';
  return r.schema ? tsType(r.schema, c) : 'unknown';
}

// ------------------------------------------------------------------ files

function genTypes(ir: WatayIR, ops: OpModel[], c: Ctx): string {
  const out: string[] = ['/* ' + GENERATED_BANNER + ' */', ''];
  for (const name of sortedSchemaNames(ir)) {
    const s = ir.schemas[name]!;
    const tn = c.names.get(name)!;
    const doc = propDoc(s, '');
    out.push(...doc);
    const plainObject = s.properties !== undefined && !s.allOf && !s.oneOf && !s.anyOf && !s.enum && !s.nullable && ext(s).const === undefined;
    if (plainObject) out.push('export interface ' + tn + ' ' + objectType(s, c, ''));
    else out.push('export type ' + tn + ' = ' + tsType(s, c, '') + ';');
    out.push('');
  }
  for (const m of ops) {
    if (!m.hasArgs) continue;
    out.push('/** Arguments of `' + m.method + '()`. Path, query, header and cookie parameters are keyed by their wire name. */');
    out.push('export interface ' + m.paramsType + ' {');
    const seen = new Set<string>();
    for (const p of m.op.parameters) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      const d = docLines(p.description);
      if (p.deprecated) d.push('@deprecated');
      if (d.length) out.push('  /** ' + d.join(' ') + ' */');
      out.push('  ' + propKey(p.name) + (p.required ? '' : '?') + ': ' + tsType(p.schema, c, '  ') + ';');
    }
    if (m.op.requestBody) {
      out.push('  /** Request body (' + m.op.requestBody.contentType + '). */');
      out.push('  ' + m.bodyKey + (m.op.requestBody.required ? '' : '?') + ': ' + bodyType(m.op, c) + ';');
    }
    out.push('}');
    out.push('');
  }
  if (out[out.length - 1] !== '') out.push('');
  return out.join('\n').replace(/\n+$/, '\n');
}

function bodyType(op: OperationIR, c: Ctx): string {
  const rb = op.requestBody!;
  const kind = contentKind(rb.contentType);
  if (kind === 'binary') return 'Blob | ArrayBuffer | Uint8Array | string';
  if (kind === 'text') return 'string';
  if (kind === 'multipart') return 'Record<string, unknown>';
  return tsType(rb.schema, c, '  ');
}

function genSchemas(ir: WatayIR): string {
  const body: Record<string, unknown> = {};
  for (const n of sortedSchemaNames(ir)) body[n] = toDescriptor(ir.schemas[n]!);
  return [
    '/* ' + GENERATED_BANNER + ' */',
    "import type { Schema } from './runtime.ts';",
    '',
    '/** Wire-format descriptors of all component schemas (used for runtime validation). */',
    'export const schemas: Record<string, Schema> = ' + jsonBlock(body, '') + ';',
    '',
  ].join('\n');
}

function paramSpec(p: ParameterIR): Record<string, unknown> {
  return { name: p.name, in: p.in, required: p.required };
}

function genOperations(ir: WatayIR, ops: OpModel[]): string {
  const specs: Record<string, unknown> = {};
  for (const m of ops) {
    const op = m.op;
    const spec: Record<string, unknown> = {
      operationId: op.operationId,
      method: op.method.toUpperCase(),
      path: op.path,
      params: op.parameters.map(paramSpec),
    };
    if (op.requestBody) {
      const kind = requestKind(op);
      spec.body = {
        key: m.bodyKey,
        kind,
        contentType: op.requestBody.contentType,
        required: op.requestBody.required,
        ...(kind === 'json' ? { schema: toDescriptor(op.requestBody.schema) } : {}),
      };
    }
    spec.responses = responseList(op).map((r) => {
      const kind = contentKind(r.contentType, r.schema !== undefined);
      return { status: r.status, kind, ...(kind === 'json' && r.schema ? { schema: toDescriptor(r.schema) } : {}) };
    });
    spec.security = authRequirements(ir, op);
    specs[m.method] = spec;
  }
  return [
    '/* ' + GENERATED_BANNER + ' */',
    "import type { Schema } from './runtime.ts';",
    '',
    'export interface ParamSpec {',
    '  name: string;',
    "  in: 'path' | 'query' | 'header' | 'cookie';",
    '  required: boolean;',
    '}',
    '',
    'export interface BodySpec {',
    '  key: string;',
    "  kind: 'json' | 'form' | 'multipart' | 'text' | 'binary';",
    '  contentType: string;',
    '  required: boolean;',
    '  schema?: Schema;',
    '}',
    '',
    'export interface ResponseSpec {',
    '  status: string;',
    "  kind: 'json' | 'form' | 'multipart' | 'text' | 'binary' | 'none';",
    '  schema?: Schema;',
    '}',
    '',
    'export interface SecuritySpec {',
    '  scheme: string;',
    "  kind: 'bearer' | 'basic' | 'apiKey';",
    "  in?: 'query' | 'header' | 'cookie';",
    '  name?: string;',
    '}',
    '',
    'export interface OperationSpec {',
    '  operationId: string;',
    '  method: string;',
    '  path: string;',
    '  params: ParamSpec[];',
    '  body?: BodySpec;',
    '  responses: ResponseSpec[];',
    '  security: SecuritySpec[];',
    '}',
    '',
    'export const operations: Record<string, OperationSpec> = ' + jsonBlock(specs, '') + ';',
    '',
  ].join('\n');
}

function genMethod(m: OpModel, c: Ctx): string {
  const op = m.op;
  const ret = returnType(op, c);
  const doc: string[] = [];
  const summary = docLines(op.summary);
  const desc = docLines(op.description);
  doc.push(...(summary.length ? summary : [op.method.toUpperCase() + ' ' + op.path]));
  if (desc.length) doc.push('', ...desc);
  doc.push('', '`' + op.method.toUpperCase() + ' ' + op.path + '`');
  if (op.deprecated) doc.push('', '@deprecated');
  const lines = ['  /**', ...doc.map((l) => ('  * ' + l).trimEnd().replace('  * ', '   * ')), '   */'];
  lines[0] = '  /**';
  const sig = m.hasArgs
    ? 'params: ' + (c.prefix + m.paramsType) + (m.argsOptional ? ' = {}' : '') + ', options: RequestOptions = {}'
    : 'options: RequestOptions = {}';
  lines.push('  ' + m.method + '(' + sig + '): Promise<' + ret + '> {');
  lines.push(
    '    return this._request<' + ret + ">(operations[" + JSON.stringify(m.method) + '] as OperationSpec, ' + (m.hasArgs ? 'params as Record<string, unknown>' : '{}') + ', options);',
  );
  lines.push('  }');
  return lines.join('\n');
}

function genClient(ir: WatayIR, ops: OpModel[], c: Ctx, className: string): string {
  const server = ir.servers[0] ?? '';
  const methods = ops.map((m) => genMethod(m, c)).join('\n\n');
  return (
    '/* ' + GENERATED_BANNER + ' */\n' + CLIENT_HEAD + '\n' +
    'const DEFAULT_BASE_URL = ' + JSON.stringify(server) + ';\n' + CLIENT_BODY_1 +
    'export class ' + className + ' {\n' + CLIENT_CLASS_HEAD + '\n' +
    (methods ? methods + '\n' : '') + '}\n'
  );
}

const CLIENT_HEAD = String.raw`import { SdkError, ValidationError, validate } from './runtime.ts';
import type { Schema } from './runtime.ts';
import { operations } from './operations.ts';
import type { OperationSpec, ResponseSpec } from './operations.ts';
import { schemas } from './schemas.ts';
import type * as T from './types.ts';
`;

const CLIENT_BODY_1 = String.raw`
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** API base URL. Defaults to the first server of the OpenAPI document. */
  baseUrl?: string;
  /** Custom fetch implementation (tests, proxies, polyfills). Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Headers sent with every request. */
  headers?: Record<string, string>;
  /** Bearer token (or async provider) for bearer / OAuth2 secured operations. */
  bearerToken?: string | (() => string | Promise<string>);
  /** HTTP Basic credentials. */
  basicAuth?: { username: string; password: string };
  /** API key; pass a record to give per-scheme keys. */
  apiKey?: string | Record<string, string>;
  /** Per-request timeout in ms (0 = none). Default 30000. */
  timeoutMs?: number;
  /** Retries for idempotent requests on network errors, 429, 502, 503, 504. Default 2. */
  maxRetries?: number;
  /** Base delay for exponential retry backoff in ms. Default 250. */
  retryDelayMs?: number;
  /** Validate request bodies against the schema before sending. Default true. */
  validateRequests?: boolean;
  /** Validate JSON responses against the schema. Default true. */
  validateResponses?: boolean;
}

export interface RequestOptions {
  /** Extra headers for this request only. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Thrown for non-2xx responses. */
export class ApiError extends SdkError {
  readonly status: number;
  readonly statusText: string;
  /** Parsed JSON body when possible, else raw text. */
  readonly body: unknown;
  readonly headers: Headers;
  readonly operationId: string;
  constructor(operationId: string, status: number, statusText: string, body: unknown, headers: Headers) {
    super('HTTP ' + status + ' ' + statusText + ' (' + operationId + ')');
    this.name = 'ApiError';
    this.status = status;
    this.statusText = statusText;
    this.body = body;
    this.headers = headers;
    this.operationId = operationId;
  }
}

/** Thrown when the request could not be completed (DNS, connection, timeout, abort). */
export class NetworkError extends SdkError {
  readonly operationId: string;
  constructor(operationId: string, cause: unknown) {
    super('Network error (' + operationId + '): ' + (cause instanceof Error ? cause.message : String(cause)), { cause });
    this.name = 'NetworkError';
    this.operationId = operationId;
  }
}

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);
const RETRY_STATUS = new Set([429, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSignal(timeoutMs: number, user?: AbortSignal): AbortSignal | undefined {
  const list: AbortSignal[] = [];
  if (timeoutMs > 0) list.push(AbortSignal.timeout(timeoutMs));
  if (user) list.push(user);
  if (list.length === 0) return undefined;
  return list.length === 1 ? list[0] : AbortSignal.any(list);
}

function serializeValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(serializeValue).join(',');
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function appendQuery(query: URLSearchParams, name: string, value: unknown): void {
  if (Array.isArray(value)) for (const v of value) query.append(name, serializeValue(v));
  else query.append(name, serializeValue(value));
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function matchResponse(op: OperationSpec, status: number): ResponseSpec | undefined {
  return (
    op.responses.find((r) => r.status === String(status)) ??
    op.responses.find((r) => r.status.toUpperCase() === String(Math.floor(status / 100)) + 'XX') ??
    op.responses.find((r) => r.status === 'default')
  );
}

function sniffKind(res: Response): ResponseSpec['kind'] {
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  if (ct === '') return 'none';
  if (ct.includes('json')) return 'json';
  if (ct.startsWith('text/')) return 'text';
  return 'binary';
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // ignore
  }
}

`;

const CLIENT_CLASS_HEAD = String.raw`  private readonly _baseUrl: string;
  private readonly _fetch: FetchLike;
  private readonly _headers: Record<string, string>;
  private readonly _bearerToken: ClientOptions['bearerToken'];
  private readonly _basicAuth: ClientOptions['basicAuth'];
  private readonly _apiKey: ClientOptions['apiKey'];
  private readonly _timeoutMs: number;
  private readonly _maxRetries: number;
  private readonly _retryDelayMs: number;
  private readonly _validateRequests: boolean;
  private readonly _validateResponses: boolean;

  constructor(options: ClientOptions = {}) {
    this._baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const f = options.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);
    if (!f) throw new SdkError('No fetch implementation available; pass options.fetch');
    this._fetch = f as FetchLike;
    this._headers = { accept: 'application/json', ...(options.headers ?? {}) };
    this._bearerToken = options.bearerToken;
    this._basicAuth = options.basicAuth;
    this._apiKey = options.apiKey;
    this._timeoutMs = options.timeoutMs ?? 30000;
    this._maxRetries = options.maxRetries ?? 2;
    this._retryDelayMs = options.retryDelayMs ?? 250;
    this._validateRequests = options.validateRequests ?? true;
    this._validateResponses = options.validateResponses ?? true;
  }

  /** @internal Performs one SDK call: builds the request, retries, validates and maps errors. */
  async _request<R>(op: OperationSpec, args: Record<string, unknown>, options: RequestOptions): Promise<R> {
    const query = new URLSearchParams();
    const headers = new Headers(this._headers);
    const cookies: string[] = [];
    let path = op.path;
    for (const p of op.params) {
      const value = args[p.name];
      if (value === undefined || value === null) {
        if (p.required) throw new SdkError('Missing required ' + p.in + ' parameter "' + p.name + '" for ' + op.operationId);
        continue;
      }
      if (p.in === 'path') path = path.split('{' + p.name + '}').join(encodeURIComponent(serializeValue(value)));
      else if (p.in === 'query') appendQuery(query, p.name, value);
      else if (p.in === 'header') headers.set(p.name, serializeValue(value));
      else cookies.push(p.name + '=' + encodeURIComponent(serializeValue(value)));
    }

    for (const sec of op.security) {
      if (sec.kind === 'bearer') {
        const t = typeof this._bearerToken === 'function' ? await this._bearerToken() : this._bearerToken;
        if (t) headers.set('authorization', 'Bearer ' + t);
      } else if (sec.kind === 'basic') {
        if (this._basicAuth) headers.set('authorization', 'Basic ' + toBase64(this._basicAuth.username + ':' + this._basicAuth.password));
      } else {
        const key = typeof this._apiKey === 'string' ? this._apiKey : this._apiKey?.[sec.scheme];
        if (key) {
          if (sec.in === 'query') query.set(sec.name ?? sec.scheme, key);
          else if (sec.in === 'cookie') cookies.push((sec.name ?? sec.scheme) + '=' + encodeURIComponent(key));
          else headers.set(sec.name ?? sec.scheme, key);
        }
      }
    }
    if (cookies.length) headers.set('cookie', cookies.join('; '));

    let body: BodyInit | undefined;
    if (op.body) {
      const value = args[op.body.key];
      if (value === undefined) {
        if (op.body.required) throw new SdkError('Missing required request body for ' + op.operationId);
      } else {
        if (op.body.schema && this._validateRequests) {
          const issues = validate(op.body.schema, value, schemas);
          if (issues.length) throw new ValidationError('Invalid request body for ' + op.operationId, issues);
        }
        switch (op.body.kind) {
          case 'json':
            body = JSON.stringify(value);
            headers.set('content-type', op.body.contentType);
            break;
          case 'form': {
            const form = new URLSearchParams();
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== undefined && v !== null) appendQuery(form, k, v);
            body = form;
            break;
          }
          case 'multipart': {
            const fd = new FormData();
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
              if (v === undefined || v === null) continue;
              fd.append(k, v instanceof Blob ? v : serializeValue(v));
            }
            body = fd;
            break;
          }
          case 'text':
            body = String(value);
            headers.set('content-type', op.body.contentType);
            break;
          default:
            body = value as BodyInit;
            headers.set('content-type', op.body.contentType);
        }
      }
    }
    for (const [k, v] of Object.entries(options.headers ?? {})) headers.set(k, v);

    const qs = query.toString();
    const url = this._baseUrl + path + (qs ? '?' + qs : '');
    const unresolved = /\{[^}]+\}/.exec(path);
    if (unresolved) throw new SdkError('Unresolved path parameter ' + unresolved[0] + ' for ' + op.operationId);

    const attempts = 1 + (IDEMPOTENT.has(op.method) ? this._maxRetries : 0);
    for (let attempt = 1; ; attempt++) {
      const last = attempt >= attempts;
      let res: Response;
      try {
        res = await this._fetch(url, { method: op.method, headers, body, signal: makeSignal(options.timeoutMs ?? this._timeoutMs, options.signal) });
      } catch (err) {
        if (last || options.signal?.aborted) throw new NetworkError(op.operationId, err);
        await sleep(this._retryDelayMs * 2 ** (attempt - 1));
        continue;
      }
      if (!last && RETRY_STATUS.has(res.status)) {
        const ra = Number(res.headers.get('retry-after'));
        await discard(res);
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30000) : this._retryDelayMs * 2 ** (attempt - 1));
        continue;
      }
      return this._handle<R>(op, res);
    }
  }

  private async _handle<R>(op: OperationSpec, res: Response): Promise<R> {
    const status = res.status;
    const spec = matchResponse(op, status);
    if (status >= 200 && status < 300) {
      const kind = spec ? spec.kind : status === 204 ? 'none' : sniffKind(res);
      if (kind === 'none') {
        await discard(res);
        return undefined as R;
      }
      if (kind === 'text') return (await res.text()) as R;
      if (kind === 'binary' || kind === 'multipart' || kind === 'form') return (await res.blob()) as R;
      const text = await res.text();
      if (text === '') return undefined as R;
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new ValidationError('Response of ' + op.operationId + ' is not valid JSON', [{ path: '$', message: 'invalid JSON' }]);
      }
      if (spec?.schema && this._validateResponses) {
        const issues = validate(spec.schema as Schema, data, schemas);
        if (issues.length) throw new ValidationError('Response of ' + op.operationId + ' violates the API contract', issues);
      }
      return data as R;
    }
    const raw = await res.text().catch(() => '');
    let parsed: unknown = raw;
    try {
      parsed = raw === '' ? undefined : JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    throw new ApiError(op.operationId, status, res.statusText, parsed, res.headers);
  }

`;

const RUNTIME_TS = '/* ' + GENERATED_BANNER + ' */\n' + String.raw`

export interface Schema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object';
  nullable?: boolean;
  enum?: Array<string | number | boolean | null>;
  const?: string | number | boolean | null;
  $ref?: string;
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Base class of all errors thrown by this SDK. */
export class SdkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SdkError';
  }
}

/** Thrown when a request body or a response does not match the API contract. */
export class ValidationError extends SdkError {
  readonly issues: ValidationIssue[];
  constructor(message: string, issues: ValidationIssue[]) {
    super(message + ': ' + issues.slice(0, 5).map((i) => i.path + ' ' + i.message).join('; ') + (issues.length > 5 ? ' (+' + (issues.length - 5) + ' more)' : ''));
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

function typeName(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
}

/** Validate a JSON value against a schema descriptor. Returns the list of issues (empty = valid). */
export function validate(
  schema: Schema,
  value: unknown,
  registry: Record<string, Schema>,
  path = '$',
  issues: ValidationIssue[] = [],
  depth = 0,
): ValidationIssue[] {
  if (depth > 64) return issues;
  if (value === null && (schema.nullable || schema.type === 'null')) return issues;
  if (schema.$ref !== undefined) {
    const target = registry[schema.$ref];
    if (!target) issues.push({ path, message: 'unknown schema ' + schema.$ref });
    else validate(target, value, registry, path, issues, depth + 1);
    return issues;
  }
  if (schema.allOf) for (const s of schema.allOf) validate(s, value, registry, path, issues, depth + 1);
  const alts = schema.oneOf ?? schema.anyOf;
  if (alts && alts.length > 0) {
    if (!alts.some((a) => validate(a, value, registry, path, [], depth + 1).length === 0)) {
      issues.push({ path, message: 'does not match any allowed schema' });
    }
    if (schema.type === undefined) return issues;
  }
  if (schema.const !== undefined && value !== schema.const) issues.push({ path, message: 'expected constant ' + JSON.stringify(schema.const) });
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    issues.push({ path, message: 'must be one of ' + JSON.stringify(schema.enum) });
    return issues;
  }
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') issues.push({ path, message: 'expected string, got ' + typeName(value) });
      else {
        if (schema.minLength !== undefined && value.length < schema.minLength) issues.push({ path, message: 'shorter than ' + schema.minLength });
        if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push({ path, message: 'longer than ' + schema.maxLength });
      }
      break;
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) issues.push({ path, message: 'expected ' + schema.type + ', got ' + typeName(value) });
      else {
        if (schema.type === 'integer' && !Number.isInteger(value)) issues.push({ path, message: 'expected integer' });
        if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path, message: 'below minimum ' + schema.minimum });
        if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path, message: 'above maximum ' + schema.maximum });
        if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) issues.push({ path, message: 'must be > ' + schema.exclusiveMinimum });
        if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) issues.push({ path, message: 'must be < ' + schema.exclusiveMaximum });
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') issues.push({ path, message: 'expected boolean, got ' + typeName(value) });
      break;
    case 'null':
      if (value !== null) issues.push({ path, message: 'expected null, got ' + typeName(value) });
      break;
    case 'array':
      if (!Array.isArray(value)) issues.push({ path, message: 'expected array, got ' + typeName(value) });
      else {
        if (schema.minItems !== undefined && value.length < schema.minItems) issues.push({ path, message: 'fewer than ' + schema.minItems + ' items' });
        if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push({ path, message: 'more than ' + schema.maxItems + ' items' });
        const items = schema.items;
        if (items) value.forEach((v, i) => validate(items, v, registry, path + '[' + i + ']', issues, depth + 1));
      }
      break;
    case 'object':
    default:
      if (schema.type === 'object' || schema.properties !== undefined) validateObject(schema, value, registry, path, issues, depth);
  }
  return issues;
}

function validateObject(schema: Schema, value: unknown, registry: Record<string, Schema>, path: string, issues: ValidationIssue[], depth: number): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path, message: 'expected object, got ' + typeName(value) });
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const r of schema.required ?? []) {
    if (obj[r] === undefined) issues.push({ path: path + '.' + r, message: 'is required' });
  }
  const props = schema.properties ?? {};
  for (const [k, v] of Object.entries(obj)) {
    const ps = props[k];
    if (ps) {
      if (v !== undefined) validate(ps, v, registry, path + '.' + k, issues, depth + 1);
    } else if (typeof schema.additionalProperties === 'object' && v !== undefined) {
      validate(schema.additionalProperties, v, registry, path + '.' + k, issues, depth + 1);
    }
  }
}
`;

function genIndex(className: string): string {
  return [
    '/* ' + GENERATED_BANNER + ' */',
    "export { " + className + ', ApiError, NetworkError } from ' + "'./client.ts';",
    "export type { ClientOptions, RequestOptions, FetchLike } from './client.ts';",
    "export { SdkError, ValidationError, validate } from './runtime.ts';",
    "export type { Schema, ValidationIssue } from './runtime.ts';",
    "export { schemas } from './schemas.ts';",
    "export type * from './types.ts';",
    '',
  ].join('\n');
}

function genPackageJson(ir: WatayIR, opts: CodegenOptions, name: string, withTests: boolean): string {
  const pkg: Record<string, unknown> = {
    name,
    version: opts.sdkVersion ?? ir.version,
    description: ir.description ?? 'TypeScript SDK for ' + ir.title,
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    files: ['dist', 'src', 'README.md'],
    sideEffects: false,
    engines: { node: '>=20.3.0' },
    scripts: {
      build: 'tsc -p tsconfig.json',
      typecheck: 'tsc -p tsconfig.json --noEmit',
      ...(withTests ? { test: 'node --test tests/' } : {}),
    },
    dependencies: {},
    devDependencies: { '@types/node': '^22.0.0', typescript: '^5.7.0' },
    keywords: ['openapi', 'sdk', 'api-client', 'generated', 'watay'],
  };
  return JSON.stringify(pkg, null, 2) + '\n';
}

function genTsconfig(): string {
  return (
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022', 'DOM'],
          strict: true,
          noUncheckedIndexedAccess: false,
          declaration: true,
          sourceMap: true,
          outDir: 'dist',
          rootDir: 'src',
          allowImportingTsExtensions: true,
          rewriteRelativeImportExtensions: true,
          verbatimModuleSyntax: true,
          erasableSyntaxOnly: true,
          skipLibCheck: true,
        },
        include: ['src'],
      },
      null,
      2,
    ) + '\n'
  );
}

function genReadme(ir: WatayIR, pkgName: string, className: string, ops: OpModel[], c: Ctx): string {
  const first = ops[0];
  let example = '';
  if (first) {
    const args = first.hasArgs ? '{ /* ' + first.op.parameters.filter((p) => p.required).map((p) => p.name).join(', ') + ' */ }' : '';
    example = 'const result = await client.' + first.method + '(' + args + ');\n';
  }
  void c;
  return [
    '# ' + pkgName,
    '',
    'Typed TypeScript client for **' + ir.title + '** (API version ' + ir.version + ').',
    'Generated by [Watay](https://watay.dev) - zero runtime dependencies, runtime response validation, retries and typed errors.',
    '',
    '## Usage',
    '',
    '```ts',
    "import { " + className + " } from '" + pkgName + "';",
    '',
    'const client = new ' + className + '({ baseUrl: ' + JSON.stringify(ir.servers[0] ?? 'https://api.example.com') + ' });',
    example + '```',
    '',
    '## Operations',
    '',
    ...ops.map((m) => '- `client.' + m.method + '()` - `' + m.op.method.toUpperCase() + ' ' + m.op.path + '`' + (m.op.summary ? ' - ' + m.op.summary.replace(/\n/g, ' ') : '')),
    '',
    '## Errors',
    '',
    '- `ApiError` - non-2xx response (`status`, `body`, `headers`).',
    '- `ValidationError` - request or response violates the OpenAPI contract (`issues`).',
    '- `NetworkError` - connection problems, timeouts, aborts.',
    '',
  ].join('\n');
}

// ------------------------------------------------------------------ entry point

export function generateTypeScript(ir: WatayIR, opts: CodegenOptions = {}): GeneratorOutput {
  const { names, used } = buildNames(ir);
  const ops = buildOps(ir, used);
  const typesCtx: Ctx = { names, prefix: '' };
  const clientCtx: Ctx = { names, prefix: 'T.' };
  const className = clientClassName(ir.title);
  const pkgName = opts.packageName ?? kebabCase(ir.title) + '-sdk';
  const files: Record<string, string> = {};

  files['package.json'] = genPackageJson(ir, opts, pkgName, opts.withContractTests === true);
  files['tsconfig.json'] = genTsconfig();
  files['README.md'] = genReadme(ir, pkgName, className, ops, clientCtx);
  files['src/types.ts'] = genTypes(ir, ops, typesCtx);
  files['src/schemas.ts'] = genSchemas(ir);
  files['src/operations.ts'] = genOperations(ir, ops);
  files['src/runtime.ts'] = RUNTIME_TS;
  files['src/client.ts'] = genClient(ir, ops, clientCtx, className);
  files['src/index.ts'] = genIndex(className);
  if (opts.withContractTests) {
    const tests = generateContractTests(ir, 'typescript');
    for (const k of Object.keys(tests).sort()) files[k] = tests[k]!;
  }
  return { language: 'typescript', files: sortFiles(files) };
}

function sortFiles(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(files).sort()) out[k] = files[k]!;
  return out;
}

export { isIdent };
