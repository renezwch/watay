import { readFileSync } from 'node:fs';
import { WatayError } from '../errors.ts';
import type {
  HttpMethod,
  OperationIR,
  ParameterIR,
  ResponseIR,
  SchemaIR,
  SecuritySchemeIR,
  WatayIR,
} from '../types.ts';
import { parseYaml } from './yaml.ts';

type Obj = Record<string, any>;

const METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const MAX_REF_DEPTH = 32;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse an OpenAPI 3.0/3.1 document (JSON or YAML text) into WatayIR. */
export function parseSpec(text: string, hint?: 'json' | 'yaml'): WatayIR {
  let doc: unknown;
  const trimmed = text.replace(/^\uFEFF/, '').trimStart();
  const asJson = hint ? hint === 'json' : trimmed.startsWith('{');
  try {
    doc = asJson ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw new WatayError(`Could not parse spec as ${asJson ? 'JSON' : 'YAML'}: ${(e as Error).message}`, 'SPEC_PARSE_ERROR');
  }
  return parseSpecObject(doc);
}

export function loadSpecFile(path: string): WatayIR {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new WatayError(`Cannot read spec file "${path}": ${(e as Error).message}`, 'SPEC_READ_ERROR');
  }
  const hint = /\.json$/i.test(path) ? 'json' : /\.ya?ml$/i.test(path) ? 'yaml' : undefined;
  return parseSpec(text, hint);
}

export function parseSpecObject(doc: unknown): WatayIR {
  if (!isObj(doc)) throw new WatayError('Spec root must be an object.', 'SPEC_INVALID');
  if (typeof doc.swagger === 'string') {
    throw new WatayError(`Swagger ${doc.swagger} is not supported. Convert to OpenAPI 3.x first (e.g. via swagger2openapi).`, 'SPEC_UNSUPPORTED');
  }
  if (typeof doc.openapi !== 'string' || !/^3\.[01]\./.test(doc.openapi + '.')) {
    throw new WatayError(`Missing or unsupported "openapi" field (got ${JSON.stringify(doc.openapi)}); expected 3.0.x or 3.1.x.`, 'SPEC_UNSUPPORTED');
  }
  const ctx = new Ctx(doc);
  return ctx.build();
}

class Ctx {
  doc: Obj;
  usedIds = new Set<string>();
  constructor(doc: Obj) {
    this.doc = doc;
  }

  // ---------------------------------------------------------------- $ref
  resolvePointer(ref: string): unknown {
    if (!ref.startsWith('#/')) {
      throw new WatayError(`Unresolved $ref "${ref}": only local references (#/...) are supported. Bundle your spec first (e.g. redocly bundle).`, 'REF_UNRESOLVED');
    }
    let cur: any = this.doc;
    for (const raw of ref.slice(2).split('/')) {
      const seg = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
      if (cur == null || typeof cur !== 'object' || !(seg in cur)) {
        throw new WatayError(`Unresolved $ref "${ref}": "${seg}" not found.`, 'REF_UNRESOLVED');
      }
      cur = cur[seg];
    }
    return cur;
  }

  /** Follow $ref chains for non-schema objects (parameters, responses, requestBodies). */
  deref(node: any, depth = 0): any {
    if (isObj(node) && typeof node.$ref === 'string') {
      if (depth > MAX_REF_DEPTH) throw new WatayError(`$ref chain too deep / cyclic at "${node.$ref}".`, 'REF_CYCLE');
      return this.deref(this.resolvePointer(node.$ref), depth + 1);
    }
    return node;
  }

  // ---------------------------------------------------------------- schema
  schema(node: any, stack: string[] = []): SchemaIR {
    if (!isObj(node)) return {}; // true / false / missing => "any"
    if (typeof node.$ref === 'string') {
      const m = /^#\/components\/schemas\/(.+)$/.exec(node.$ref);
      if (m) {
        const name = decodeURIComponent(m[1]).replace(/~1/g, '/').replace(/~0/g, '~');
        if (!isObj(this.doc.components?.schemas) || !(name in this.doc.components.schemas)) {
          throw new WatayError(`Unresolved $ref "${node.$ref}": schema "${name}" not found in components.schemas.`, 'REF_UNRESOLVED');
        }
        const out: SchemaIR = { ref: name };
        if (typeof node.description === 'string') out.description = node.description;
        return out;
      }
      // Other local pointer: inline it (cycle-guarded)
      if (stack.includes(node.$ref)) throw new WatayError(`Cyclic $ref "${node.$ref}" outside components.schemas is not supported.`, 'REF_CYCLE');
      return this.schema(this.resolvePointer(node.$ref), [...stack, node.$ref]);
    }

    const out: SchemaIR = {};
    let nullable = node.nullable === true;

    // type (3.1 may be an array)
    let types: string[] = [];
    if (typeof node.type === 'string') types = [node.type];
    else if (Array.isArray(node.type)) types = node.type.filter((t: unknown) => typeof t === 'string');
    if (types.includes('null') && types.length > 1) {
      nullable = true;
      types = types.filter((t) => t !== 'null');
    }
    let extraAnyOf: SchemaIR[] | undefined;
    if (types.length === 1) out.type = types[0] as SchemaIR['type'];
    else if (types.length > 1) {
      extraAnyOf = types.map((t) => ({ type: t as SchemaIR['type'] }));
    }
    if (node.format !== undefined) out.format = String(node.format);

    if (Array.isArray(node.enum)) {
      let e = node.enum as Array<string | number | boolean | null>;
      if (e.includes(null) && !types.includes('null')) nullable = nullable || e.includes(null);
      out.enum = e;
    }
    if ('const' in node) {
      out.const = node.const;
      out.enum = [node.const];
    }

    const recurse = (n: any) => this.schema(n, stack);

    if (isObj(node.properties)) {
      out.properties = {};
      for (const k of Object.keys(node.properties)) out.properties[k] = recurse(node.properties[k]);
    }
    if (Array.isArray(node.required)) out.required = node.required.filter((x: unknown) => typeof x === 'string');
    if (node.items !== undefined) out.items = recurse(node.items);
    if (typeof node.additionalProperties === 'boolean') out.additionalProperties = node.additionalProperties;
    else if (isObj(node.additionalProperties)) out.additionalProperties = recurse(node.additionalProperties);

    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
      if (Array.isArray(node[key])) {
        let list: SchemaIR[] = node[key].map(recurse);
        if (key !== 'allOf') {
          const nullIdx = list.findIndex((s) => s.type === 'null' && Object.keys(s).length === 1);
          if (nullIdx >= 0) {
            nullable = true;
            list = list.filter((_, i) => i !== nullIdx);
          }
        }
        if (list.length === 1 && key !== 'allOf' && !out.type && !out.properties) {
          // collapse single-variant union
          const only = list[0];
          Object.assign(out, only);
        } else if (list.length > 0) out[key] = list;
      }
    }
    if (extraAnyOf && !out.anyOf) out.anyOf = extraAnyOf;

    if (isObj(node.discriminator) && typeof node.discriminator.propertyName === 'string') {
      out.discriminator = { propertyName: node.discriminator.propertyName };
      if (isObj(node.discriminator.mapping)) out.discriminator.mapping = { ...node.discriminator.mapping };
    }

    if (typeof node.description === 'string') out.description = node.description;
    if ('default' in node) out.default = node.default;
    if ('example' in node) out.example = node.example;
    const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
    let minimum = num(node.minimum);
    let maximum = num(node.maximum);
    let exMin = num(node.exclusiveMinimum);
    let exMax = num(node.exclusiveMaximum);
    if (node.exclusiveMinimum === true && minimum !== undefined) {
      exMin = minimum;
      minimum = undefined;
    }
    if (node.exclusiveMaximum === true && maximum !== undefined) {
      exMax = maximum;
      maximum = undefined;
    }
    if (minimum !== undefined) out.minimum = minimum;
    if (maximum !== undefined) out.maximum = maximum;
    if (exMin !== undefined) out.exclusiveMinimum = exMin;
    if (exMax !== undefined) out.exclusiveMaximum = exMax;
    for (const k of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
      const v = num(node[k]);
      if (v !== undefined) out[k] = v;
    }
    if (typeof node.pattern === 'string') out.pattern = node.pattern;
    if (node.uniqueItems === true) out.uniqueItems = true;
    if (node.readOnly === true) out.readOnly = true;
    if (node.writeOnly === true) out.writeOnly = true;
    if (node.deprecated === true) out.deprecated = true;

    // infer type
    if (!out.type && !out.anyOf && !out.oneOf && !out.allOf && !out.ref) {
      if (out.properties || out.additionalProperties !== undefined) out.type = 'object';
      else if (out.items) out.type = 'array';
    }
    if (nullable) out.nullable = true;
    return out;
  }

  // ---------------------------------------------------------------- operations
  pickContent(content: any): { contentType: string; schema: SchemaIR; all: Record<string, SchemaIR> } | undefined {
    if (!isObj(content)) return undefined;
    const types = Object.keys(content);
    if (!types.length) return undefined;
    const pref =
      types.find((t) => t.toLowerCase() === 'application/json') ??
      types.find((t) => /\+json$/i.test(t) || /json/i.test(t)) ??
      types[0];
    const all: Record<string, SchemaIR> = {};
    for (const t of types) all[t] = this.schema(content[t]?.schema);
    return { contentType: pref, schema: all[pref], all };
  }

  parameter(raw: any): ParameterIR | undefined {
    const p = this.deref(raw);
    if (!isObj(p) || typeof p.name !== 'string' || typeof p.in !== 'string') return undefined;
    if (!['path', 'query', 'header', 'cookie'].includes(p.in)) return undefined;
    const out: ParameterIR = {
      name: p.name,
      in: p.in as ParameterIR['in'],
      required: p.in === 'path' ? true : p.required === true,
      schema: p.schema !== undefined ? this.schema(p.schema) : this.pickContent(p.content)?.schema ?? {},
    };
    if (typeof p.description === 'string') out.description = p.description;
    if (p.deprecated === true) out.deprecated = true;
    return out;
  }

  makeId(raw: unknown, method: string, path: string): string {
    let base: string;
    if (typeof raw === 'string' && raw.trim()) base = camel(raw);
    else {
      const segs = path
        .split('/')
        .filter(Boolean)
        .map((s) => {
          const m = /^\{(.+)\}$/.exec(s);
          return m ? 'By' + pascal(m[1]) : pascal(s);
        });
      base = method + segs.join('');
    }
    if (!base || /^[0-9]/.test(base)) base = '_' + base;
    let id = base;
    let n = 2;
    while (this.usedIds.has(id)) id = base + n++;
    this.usedIds.add(id);
    return id;
  }

  build(): WatayIR {
    const doc = this.doc;
    if (!isObj(doc.info) || typeof doc.info.title !== 'string') {
      throw new WatayError('Spec is missing required "info.title".', 'SPEC_INVALID');
    }
    const ir: WatayIR = {
      title: doc.info.title,
      version: String(doc.info.version ?? '0.0.0'),
      servers: [],
      schemas: {},
      operations: [],
    };
    if (typeof doc.info.description === 'string') ir.description = doc.info.description;
    if (Array.isArray(doc.servers)) ir.servers = doc.servers.filter((s: any) => isObj(s) && typeof s.url === 'string').map((s: any) => s.url);

    // components
    const comps = doc.components?.schemas;
    if (isObj(comps)) for (const name of Object.keys(comps).sort()) ir.schemas[name] = this.schema(comps[name]);

    const secSchemes = doc.components?.securitySchemes;
    if (isObj(secSchemes)) {
      ir.securitySchemes = {};
      for (const name of Object.keys(secSchemes).sort()) {
        const s = this.deref(secSchemes[name]);
        if (!isObj(s) || typeof s.type !== 'string') continue;
        const entry: SecuritySchemeIR = { type: s.type as SecuritySchemeIR['type'] };
        if (typeof s.scheme === 'string') entry.scheme = s.scheme;
        if (typeof s.bearerFormat === 'string') entry.bearerFormat = s.bearerFormat;
        if (typeof s.in === 'string') entry.in = s.in as SecuritySchemeIR['in'];
        if (typeof s.name === 'string') entry.paramName = s.name;
        ir.securitySchemes[name] = entry;
      }
    }

    // operations: collect first (deterministic id assignment in sorted order)
    const paths = isObj(doc.paths) ? doc.paths : {};
    const globalSecurity = this.securityNames(doc.security);
    const pathKeys = Object.keys(paths).sort();
    for (const path of pathKeys) {
      const item = this.deref(paths[path]);
      if (!isObj(item)) continue;
      if (!path.startsWith('/')) throw new WatayError(`Invalid path "${path}": must start with "/".`, 'SPEC_INVALID');
      const pathParams = (Array.isArray(item.parameters) ? item.parameters : []).map((p: any) => this.parameter(p)).filter(Boolean) as ParameterIR[];
      for (const method of METHODS) {
        const op = item[method];
        if (!isObj(op)) continue;
        const params = new Map<string, ParameterIR>();
        for (const p of pathParams) params.set(`${p.in}:${p.name}`, p);
        for (const raw of Array.isArray(op.parameters) ? op.parameters : []) {
          const p = this.parameter(raw);
          if (p) params.set(`${p.in}:${p.name}`, p);
        }
        const parameters = [...params.values()];
        // Ensure every {template} param exists
        for (const m of path.matchAll(/\{([^}]+)\}/g)) {
          if (!params.has(`path:${m[1]}`)) parameters.push({ name: m[1], in: 'path', required: true, schema: { type: 'string' } });
        }
        parameters.sort((a, b) => order(a.in) - order(b.in));

        const o: OperationIR = {
          operationId: this.makeId(op.operationId, method, path),
          method,
          path,
          parameters,
          responses: {},
        };
        if (typeof op.summary === 'string') o.summary = op.summary;
        if (typeof op.description === 'string') o.description = op.description;
        if (op.deprecated === true) o.deprecated = true;
        if (Array.isArray(op.tags) && op.tags.length) o.tags = op.tags.filter((t: unknown) => typeof t === 'string');

        const rb = this.deref(op.requestBody);
        if (isObj(rb)) {
          const picked = this.pickContent(rb.content);
          if (picked) {
            o.requestBody = {
              required: rb.required === true,
              contentType: picked.contentType,
              schema: picked.schema,
              contentTypes: Object.keys(picked.all),
            };
          } else {
            o.requestBody = { required: rb.required === true, contentType: 'application/json', schema: {}, contentTypes: [] };
          }
        }

        const responses = isObj(op.responses) ? op.responses : {};
        for (const status of Object.keys(responses).sort(statusCmp)) {
          const r = this.deref(responses[status]);
          const out: ResponseIR = {};
          if (isObj(r)) {
            if (typeof r.description === 'string') out.description = r.description;
            const picked = this.pickContent(r.content);
            if (picked) {
              out.schema = picked.schema;
              out.contentType = picked.contentType;
              out.contentTypes = Object.keys(picked.all);
            }
          }
          o.responses[String(status)] = out;
        }

        const sec = op.security !== undefined ? this.securityNames(op.security) : globalSecurity;
        if (sec.length) o.security = sec;
        ir.operations.push(o);
      }
    }
    ir.operations.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : METHODS.indexOf(a.method) - METHODS.indexOf(b.method)));
    return ir;
  }

  securityNames(sec: unknown): string[] {
    const names = new Set<string>();
    if (Array.isArray(sec)) for (const req of sec) if (isObj(req)) for (const k of Object.keys(req)) names.add(k);
    return [...names].sort();
  }
}

function order(i: string): number {
  return ['path', 'query', 'header', 'cookie'].indexOf(i);
}

function statusCmp(a: string, b: string): number {
  const rank = (s: string) => (/^\d{3}$/.test(s) ? 0 : /^\dXX$/i.test(s) ? 1 : 2);
  return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}
function pascal(s: string): string {
  return words(s)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}
function camel(s: string): string {
  const w = words(s);
  if (!w.length) return '';
  // keep already-camelCase ids intact
  if (/^[a-z][A-Za-z0-9]*$/.test(s)) return s;
  return w[0].toLowerCase() + w.slice(1).map((x) => x[0].toUpperCase() + x.slice(1)).join('');
}
