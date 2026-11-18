import type {
  DiffChange,
  DiffResult,
  OperationIR,
  ParameterIR,
  ResponseIR,
  SchemaIR,
  Severity,
  WatayIR,
} from '../types.ts';

/**
 * SpecDrift: semantic, direction-aware comparison of two WatayIRs.
 *
 * Request side (params, request body): the NEW schema must accept everything the OLD one accepted,
 * so *narrowing* is breaking. Response side: clients were written against the OLD schema, so the
 * NEW schema must not produce anything outside it, so *widening* is breaking.
 */

type Dir = 'request' | 'response';
type Effect = 'wider' | 'narrower';

const fmt = (v: unknown): string => {
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v);
  return JSON.stringify(v);
};

function normalizePath(p: string): string {
  return p.replace(/\{[^}]+\}/g, '{}');
}
function pathParamNames(p: string): string[] {
  return [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}
function isSuccess(status: string): boolean {
  return /^2\d\d$/.test(status) || /^2XX$/i.test(status);
}

class Differ {
  oldIr: WatayIR;
  newIr: WatayIR;
  changes: DiffChange[] = [];
  rootLabel = 'body';
  private seen = new Set<string>();

  constructor(oldIr: WatayIR, newIr: WatayIR) {
    this.oldIr = oldIr;
    this.newIr = newIr;
  }

  add(code: string, severity: Severity, location: string, message: string, before?: unknown, after?: unknown): void {
    const key = `${code}|${location}|${message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const c: DiffChange = { code, severity, location, message };
    if (before !== undefined) c.before = typeof before === 'string' ? before : fmt(before);
    if (after !== undefined) c.after = typeof after === 'string' ? after : fmt(after);
    this.changes.push(c);
  }

  /** Flag a schema change that makes the type wider/narrower, deciding severity by direction. */
  flag(dir: Dir, effect: Effect, code: string, loc: string, what: string, before?: unknown, after?: unknown, note = ''): void {
    const breaking = (dir === 'request' && effect === 'narrower') || (dir === 'response' && effect === 'wider');
    const side = dir === 'request' ? 'request' : 'response';
    const msg = `${what} (${side} ${effect === 'wider' ? 'widened' : 'narrowed'}${breaking ? ', breaks existing clients' : ''})${note}`;
    this.add(`${dir}-${code}`, breaking ? 'breaking' : 'non-breaking', loc, msg, before, after);
  }

  // ------------------------------------------------------------ schema helpers
  flatten(ir: WatayIR, s: SchemaIR | undefined, depth = 0): SchemaIR {
    let cur: SchemaIR = s ?? {};
    let hops = 0;
    let nullable = !!cur.nullable;
    while (cur.ref !== undefined && hops++ < 32) {
      cur = ir.schemas[cur.ref] ?? {};
      nullable = nullable || !!cur.nullable;
    }
    if (nullable && !cur.nullable) cur = { ...cur, nullable: true };
    if (cur.allOf && depth < 16) {
      const { allOf, ...rest } = cur;
      const merged: SchemaIR = { ...rest };
      for (const part of allOf) {
        const f = this.flatten(ir, part, depth + 1);
        for (const [k, v] of Object.entries(f)) {
          if (k === 'properties') merged.properties = { ...(merged.properties ?? {}), ...(v as Record<string, SchemaIR>), ...(rest.properties ?? {}) };
          else if (k === 'required') merged.required = [...new Set([...(merged.required ?? []), ...(v as string[])])];
          else if (k === 'description' || k === 'nullable') continue;
          else if ((merged as any)[k] === undefined) (merged as any)[k] = v;
        }
      }
      if (!merged.type && merged.properties) merged.type = 'object';
      return merged;
    }
    return cur;
  }

  variantSig(v: SchemaIR, idx: number, used: Set<string>): string {
    let base = v.ref ?? (v.type ? v.type + (v.format ? ':' + v.format : '') : v.properties ? 'object' : 'any');
    let sig = base;
    let n = 2;
    while (used.has(sig)) sig = `${base}#${n++}`;
    used.add(sig);
    void idx;
    return sig;
  }

  compareSchema(o: SchemaIR | undefined, n: SchemaIR | undefined, loc: string, dir: Dir, path: string, stack: string[] = []): void {
    const oS = o ?? {};
    const nS = n ?? {};
    const pairKey = `${oS.ref ?? ''}|${nS.ref ?? ''}`;
    if (pairKey !== '|' && stack.includes(pairKey)) return;
    const st = pairKey !== '|' ? [...stack, pairKey] : stack;
    if (!path && (oS.ref || nS.ref)) path = nS.ref ?? oS.ref ?? '';
    const where = path ? `${loc} > ${path}` : loc;

    const fo = this.flatten(this.oldIr, oS);
    const fn = this.flatten(this.newIr, nS);
    const label = path || this.rootLabel;

    // unions
    const oVars = fo.oneOf ?? fo.anyOf;
    const nVars = fn.oneOf ?? fn.anyOf;
    if (oVars || nVars) {
      const ov = oVars ?? [fo];
      const nv = nVars ?? [fn];
      const oSigs = new Map<string, SchemaIR>();
      const nSigs = new Map<string, SchemaIR>();
      const uo = new Set<string>();
      const un = new Set<string>();
      ov.forEach((v, i) => oSigs.set(this.variantSig(v, i, uo), v));
      nv.forEach((v, i) => nSigs.set(this.variantSig(v, i, un), v));
      for (const [sig, v] of oSigs) {
        const m = nSigs.get(sig);
        if (m) this.compareSchema(v, m, loc, dir, path, st);
        else this.flag(dir, 'narrower', 'variant-removed', where, `Variant "${sig}" removed from ${label}`, sig, undefined);
      }
      for (const sig of nSigs.keys()) {
        if (!oSigs.has(sig)) {
          this.flag(dir, 'wider', 'variant-added', where, `Variant "${sig}" added to ${label}`, undefined, sig, dir === 'response' ? ' - clients must handle the new variant' : '');
        }
      }
      if (fo.nullable !== fn.nullable) this.nullableChange(dir, where, label, !!fo.nullable, !!fn.nullable);
      return;
    }

    // type
    if (fo.type !== fn.type) {
      if (fo.type && fn.type) {
        if (fo.type === 'integer' && fn.type === 'number') {
          this.flag(dir, 'wider', 'type-widened', where, `${label} type widened integer -> number`, fo.type, fn.type);
        } else if (fo.type === 'number' && fn.type === 'integer') {
          this.flag(dir, 'narrower', 'type-narrowed', where, `${label} type narrowed number -> integer`, fo.type, fn.type);
        } else {
          this.add(`${dir}-type-changed`, 'breaking', where, `${label} type changed ${fo.type} -> ${fn.type}`, fo.type, fn.type);
          return;
        }
      } else if (fn.type) {
        this.flag(dir, 'narrower', 'type-constrained', where, `${label} is now constrained to type ${fn.type}`, undefined, fn.type);
      } else {
        this.flag(dir, 'wider', 'type-unconstrained', where, `${label} no longer constrained to type ${fo.type}`, fo.type, undefined);
      }
    }

    if (!!fo.nullable !== !!fn.nullable) this.nullableChange(dir, where, label, !!fo.nullable, !!fn.nullable);

    // format
    if (fo.format !== fn.format) {
      const widen: Array<[string, string]> = [
        ['int32', 'int64'],
        ['float', 'double'],
      ];
      if (fo.format === undefined) this.flag(dir, 'narrower', 'format-added', where, `${label} format ${fn.format} added`, undefined, fn.format);
      else if (fn.format === undefined) this.flag(dir, 'wider', 'format-removed', where, `${label} format ${fo.format} removed`, fo.format, undefined);
      else if (widen.some(([a, b]) => a === fo.format && b === fn.format)) this.flag(dir, 'wider', 'format-widened', where, `${label} format ${fo.format} -> ${fn.format}`, fo.format, fn.format);
      else if (widen.some(([a, b]) => b === fo.format && a === fn.format)) this.flag(dir, 'narrower', 'format-narrowed', where, `${label} format ${fo.format} -> ${fn.format}`, fo.format, fn.format);
      else this.add(`${dir}-format-changed`, 'breaking', where, `${label} format changed ${fo.format} -> ${fn.format}`, fo.format, fn.format);
    }

    // enum
    if (fo.enum || fn.enum) {
      if (!fo.enum) this.flag(dir, 'narrower', 'enum-added', where, `${label} is now restricted to an enum`, undefined, fn.enum);
      else if (!fn.enum) this.flag(dir, 'wider', 'enum-removed', where, `${label} enum restriction removed`, fo.enum, undefined);
      else {
        const oSet = new Set(fo.enum.map((x) => JSON.stringify(x)));
        const nSet = new Set(fn.enum.map((x) => JSON.stringify(x)));
        for (const v of fo.enum) {
          if (!nSet.has(JSON.stringify(v))) this.flag(dir, 'narrower', 'enum-value-removed', where, `Enum value ${fmt(v)} removed from ${label}`, v, undefined);
        }
        for (const v of fn.enum) {
          if (!oSet.has(JSON.stringify(v))) {
            // Per spec: a new enum value in a response is flagged non-breaking with a warning (exhaustive-switch risk).
            if (dir === 'response') this.add('response-enum-value-added', 'non-breaking', where, `Enum value ${fmt(v)} added to ${label} (warning: clients with exhaustive switch/match may need an update)`, undefined, v);
            else this.flag(dir, 'wider', 'enum-value-added', where, `Enum value ${fmt(v)} added to ${label}`, undefined, v);
          }
        }
      }
    }

    // bounds
    const bounds: Array<[keyof SchemaIR, 'lower' | 'upper', string, number]> = [
      ['minimum', 'lower', 'minimum', -Infinity],
      ['exclusiveMinimum', 'lower', 'exclusive-minimum', -Infinity],
      ['minLength', 'lower', 'min-length', 0],
      ['minItems', 'lower', 'min-items', 0],
      ['maximum', 'upper', 'maximum', Infinity],
      ['exclusiveMaximum', 'upper', 'exclusive-maximum', Infinity],
      ['maxLength', 'upper', 'max-length', Infinity],
      ['maxItems', 'upper', 'max-items', Infinity],
    ];
    for (const [field, kind, code, dflt] of bounds) {
      const ov = (fo[field] as number | undefined) ?? dflt;
      const nv = (fn[field] as number | undefined) ?? dflt;
      if (ov === nv) continue;
      const tighter = kind === 'lower' ? nv > ov : nv < ov;
      const b = fo[field] as number | undefined;
      const a = fn[field] as number | undefined;
      this.flag(dir, tighter ? 'narrower' : 'wider', `${code}-${tighter ? 'tightened' : 'relaxed'}`, where, `${label} ${field} ${b === undefined ? 'unset' : b} -> ${a === undefined ? 'unset' : a}`, b, a);
    }
    if (fo.pattern !== fn.pattern) {
      if (fo.pattern === undefined) this.flag(dir, 'narrower', 'pattern-added', where, `${label} pattern ${fmt(fn.pattern)} added`, undefined, fn.pattern);
      else if (fn.pattern === undefined) this.flag(dir, 'wider', 'pattern-removed', where, `${label} pattern removed`, fo.pattern, undefined);
      else this.add(`${dir}-pattern-changed`, 'breaking', where, `${label} pattern changed`, fo.pattern, fn.pattern);
    }
    if (!!fo.uniqueItems !== !!fn.uniqueItems) {
      if (fn.uniqueItems) this.flag(dir, 'narrower', 'unique-items-added', where, `${label} must now contain unique items`);
      else this.flag(dir, 'wider', 'unique-items-removed', where, `${label} no longer requires unique items`);
    }

    // objects
    const oProps = fo.properties ?? {};
    const nProps = fn.properties ?? {};
    const oReq = new Set(fo.required ?? []);
    const nReq = new Set(fn.required ?? []);
    const sub = (p: string) => (path ? `${path}.${p}` : p);
    for (const p of Object.keys(oProps)) {
      const pw = `${loc} > ${sub(p)}`;
      if (!(p in nProps)) {
        if (dir === 'response') this.add('response-property-removed', 'breaking', pw, `Response property "${sub(p)}" removed`, oProps[p].type ?? oProps[p].ref);
        else if (fn.additionalProperties === false) this.add('request-property-removed', 'breaking', pw, `Request property "${sub(p)}" removed and unknown properties are rejected`, oProps[p].type ?? oProps[p].ref);
        else this.add('request-property-removed', 'non-breaking', pw, `Request property "${sub(p)}" removed (now ignored by server; SDK field disappears)`, oProps[p].type ?? oProps[p].ref);
        continue;
      }
      // requiredness
      const wasReq = oReq.has(p);
      const isReq = nReq.has(p);
      if (!wasReq && isReq) {
        if (dir === 'request') this.add('request-property-became-required', 'breaking', pw, `Request property "${sub(p)}" became required`);
        else this.add('response-property-became-required', 'non-breaking', pw, `Response property "${sub(p)}" is now always present`);
      } else if (wasReq && !isReq) {
        if (dir === 'response') this.add('response-property-became-optional', 'breaking', pw, `Response property "${sub(p)}" became optional (clients may read undefined)`);
        else this.add('request-property-became-optional', 'non-breaking', pw, `Request property "${sub(p)}" became optional`);
      }
      this.compareSchema(oProps[p], nProps[p], loc, dir, sub(p), st);
    }
    for (const p of Object.keys(nProps)) {
      if (p in oProps) continue;
      const pw = `${loc} > ${sub(p)}`;
      const req = nReq.has(p);
      if (dir === 'request' && req) this.add('request-required-property-added', 'breaking', pw, `Required request property "${sub(p)}" added`, undefined, nProps[p].type ?? nProps[p].ref);
      else if (dir === 'request') this.add('request-optional-property-added', 'non-breaking', pw, `Optional request property "${sub(p)}" added`, undefined, nProps[p].type ?? nProps[p].ref);
      else this.add('response-property-added', 'non-breaking', pw, `Response property "${sub(p)}" added`, undefined, nProps[p].type ?? nProps[p].ref);
    }
    // additionalProperties
    const ap = (x: SchemaIR) => (x.additionalProperties === false ? 'closed' : typeof x.additionalProperties === 'object' ? 'schema' : 'open');
    const oAp = ap(fo);
    const nAp = ap(fn);
    if (oAp !== nAp) {
      if (nAp === 'closed') this.flag(dir, 'narrower', 'additional-properties-forbidden', where, `${label} no longer allows additional properties`);
      else if (oAp === 'closed') this.flag(dir, 'wider', 'additional-properties-allowed', where, `${label} now allows additional properties`);
      else if (oAp === 'open') this.flag(dir, 'narrower', 'additional-properties-constrained', where, `${label} additional properties are now schema-constrained`);
      else this.flag(dir, 'wider', 'additional-properties-unconstrained', where, `${label} additional properties are no longer schema-constrained`);
    } else if (oAp === 'schema') {
      this.compareSchema(fo.additionalProperties as SchemaIR, fn.additionalProperties as SchemaIR, loc, dir, `${path || label}{}`, st);
    }

    // arrays
    if (fo.items || fn.items) {
      if (fo.items && fn.items) this.compareSchema(fo.items, fn.items, loc, dir, `${path || label}[]`, st);
    }
  }

  nullableChange(dir: Dir, where: string, label: string, was: boolean, now: boolean): void {
    if (now && !was) this.flag(dir, 'wider', 'became-nullable', where, `${label} became nullable`);
    else this.flag(dir, 'narrower', 'became-non-nullable', where, `${label} is no longer nullable`);
  }

  // ------------------------------------------------------------ operations
  opKey(o: OperationIR): string {
    return `${o.method} ${normalizePath(o.path)}`;
  }
  opLabel(o: OperationIR): string {
    return `${o.method.toUpperCase()} ${o.path}`;
  }

  run(): void {
    const oldOps = new Map(this.oldIr.operations.map((o) => [this.opKey(o), o]));
    const newOps = new Map(this.newIr.operations.map((o) => [this.opKey(o), o]));

    for (const [k, o] of oldOps) {
      if (!newOps.has(k)) this.add('operation-removed', 'breaking', this.opLabel(o), `Operation ${this.opLabel(o)} (${o.operationId}) was removed`, this.opLabel(o));
    }
    for (const [k, n] of newOps) {
      if (!oldOps.has(k)) this.add('operation-added', 'non-breaking', this.opLabel(n), `Operation ${this.opLabel(n)} (${n.operationId}) was added`, undefined, this.opLabel(n));
    }
    for (const [k, o] of oldOps) {
      const n = newOps.get(k);
      if (n) this.compareOperation(o, n);
    }

    // components (informational; usage-based impacts are reported via operations)
    for (const name of Object.keys(this.oldIr.schemas)) {
      if (!(name in this.newIr.schemas)) this.add('schema-removed', 'info', `components.schemas.${name}`, `Component schema "${name}" removed (generated SDK type disappears)`);
    }
    for (const name of Object.keys(this.newIr.schemas)) {
      if (!(name in this.oldIr.schemas)) this.add('schema-added', 'info', `components.schemas.${name}`, `Component schema "${name}" added`);
    }

    if (this.oldIr.version !== this.newIr.version) {
      this.add('version-changed', 'info', 'info.version', `API version ${this.oldIr.version} -> ${this.newIr.version}`, this.oldIr.version, this.newIr.version);
    }
    if (JSON.stringify(this.oldIr.servers) !== JSON.stringify(this.newIr.servers)) {
      this.add('servers-changed', 'info', 'servers', 'Server URLs changed', this.oldIr.servers.join(', '), this.newIr.servers.join(', '));
    }
  }

  compareOperation(o: OperationIR, n: OperationIR): void {
    const loc = this.opLabel(n);

    if (o.operationId !== n.operationId) {
      this.add('operation-id-changed', 'breaking', loc, `operationId changed ${o.operationId} -> ${n.operationId} (generated SDK method is renamed)`, o.operationId, n.operationId);
    }
    if (!o.deprecated && n.deprecated) this.add('operation-deprecated', 'info', loc, `Operation ${loc} was marked deprecated`);
    if (o.deprecated && !n.deprecated) this.add('operation-undeprecated', 'info', loc, `Operation ${loc} is no longer deprecated`);
    if (JSON.stringify(o.tags ?? []) !== JSON.stringify(n.tags ?? [])) {
      this.add('tags-changed', 'info', loc, 'Tags changed (SDK grouping may change)', (o.tags ?? []).join(', '), (n.tags ?? []).join(', '));
    }

    // path templates
    const renames = new Map<string, string>(); // old name -> new name
    const oNames = pathParamNames(o.path);
    const nNames = pathParamNames(n.path);
    oNames.forEach((name, i) => {
      if (nNames[i] !== undefined && nNames[i] !== name) {
        renames.set(name, nNames[i]);
        this.add('path-param-renamed', 'info', loc, `Path parameter {${name}} renamed to {${nNames[i]}} (same position, wire-compatible)`, name, nNames[i]);
      }
    });

    this.compareParams(o, n, loc, renames);

    // request body
    const ob = o.requestBody;
    const nb = n.requestBody;
    const bl = `${loc} > request body`;
    if (!ob && nb) {
      if (nb.required) this.add('required-request-body-added', 'breaking', bl, 'A required request body was added');
      else this.add('optional-request-body-added', 'non-breaking', bl, 'An optional request body was added');
    } else if (ob && !nb) {
      this.add('request-body-removed', 'non-breaking', bl, 'Request body was removed (now ignored by server)');
    } else if (ob && nb) {
      if (!ob.required && nb.required) this.add('request-body-became-required', 'breaking', bl, 'Request body became required');
      if (ob.required && !nb.required) this.add('request-body-became-optional', 'non-breaking', bl, 'Request body became optional');
      this.compareContentTypes(ob.contentTypes ?? [ob.contentType], nb.contentTypes ?? [nb.contentType], bl, 'request');
      this.compareSchema(ob.schema, nb.schema, bl, 'request', '');
    }

    // responses
    const statuses = new Set([...Object.keys(o.responses), ...Object.keys(n.responses)]);
    for (const status of statuses) {
      const or = o.responses[status];
      const nr = n.responses[status];
      const rl = `${loc} > response ${status}`;
      if (or && !nr) {
        if (isSuccess(status)) this.add('success-response-removed', 'breaking', rl, `Success response ${status} was removed`, status);
        else this.add('response-removed', 'non-breaking', rl, `Response ${status} was removed`, status);
      } else if (!or && nr) {
        this.add('response-added', 'non-breaking', rl, `Response ${status} was added`, undefined, status);
      } else if (or && nr) {
        this.compareResponse(or, nr, rl);
      }
    }

    // security
    const oSec = new Set(o.security ?? []);
    const nSec = new Set(n.security ?? []);
    for (const s of nSec) {
      if (!oSec.has(s)) this.add('security-requirement-added', 'breaking', loc, `Security requirement "${s}" added`, undefined, s);
    }
    for (const s of oSec) {
      if (!nSec.has(s)) this.add('security-requirement-removed', 'non-breaking', loc, `Security requirement "${s}" removed`, s);
    }
  }

  compareContentTypes(o: string[], n: string[], loc: string, dir: Dir): void {
    for (const ct of o) if (!n.includes(ct)) this.add(`${dir}-content-type-removed`, dir === 'request' ? 'breaking' : 'breaking', loc, `Content type ${ct} no longer supported in ${dir}`, ct);
    for (const ct of n) if (!o.includes(ct)) this.add(`${dir}-content-type-added`, 'non-breaking', loc, `Content type ${ct} added to ${dir}`, undefined, ct);
  }

  compareResponse(o: ResponseIR, n: ResponseIR, loc: string): void {
    if (o.schema && !n.schema) {
      this.add('response-body-removed', 'breaking', loc, 'Response body was removed');
      return;
    }
    if (!o.schema && n.schema) {
      this.add('response-body-added', 'non-breaking', loc, 'Response body was added');
      return;
    }
    if (o.schema && n.schema) {
      this.compareContentTypes(o.contentTypes ?? (o.contentType ? [o.contentType] : []), n.contentTypes ?? (n.contentType ? [n.contentType] : []), loc, 'response');
      this.compareSchema(o.schema, n.schema, loc, 'response', '');
    }
  }

  compareParams(o: OperationIR, n: OperationIR, loc: string, renames: Map<string, string>): void {
    const key = (p: ParameterIR) => `${p.in}:${p.name}`;
    const nMap = new Map(n.parameters.map((p) => [key(p), p]));
    const oMap = new Map<string, ParameterIR>();
    for (const p of o.parameters) {
      const name = p.in === 'path' && renames.has(p.name) ? renames.get(p.name)! : p.name;
      oMap.set(`${p.in}:${name}`, p);
    }
    for (const [k, p] of oMap) {
      const np = nMap.get(k);
      const pl = `${loc} > parameter ${k}`;
      if (!np) {
        if (p.in === 'path') this.add('path-param-removed', 'breaking', pl, `Path parameter "${p.name}" removed`, p.name);
        else this.add('param-removed', 'non-breaking', pl, `${cap(p.in)} parameter "${p.name}" removed (no longer sent/accepted)`, p.name);
        continue;
      }
      if (!p.required && np.required) this.add('param-became-required', 'breaking', pl, `${cap(p.in)} parameter "${p.name}" became required`);
      if (p.required && !np.required) this.add('param-became-optional', 'non-breaking', pl, `${cap(p.in)} parameter "${p.name}" became optional`);
      if (!p.deprecated && np.deprecated) this.add('param-deprecated', 'info', pl, `${cap(p.in)} parameter "${p.name}" deprecated`);
      this.rootLabel = 'value';
      this.compareSchema(p.schema, np.schema, pl, 'request', '');
      this.rootLabel = 'body';
    }
    for (const [k, np] of nMap) {
      if (oMap.has(k)) continue;
      const pl = `${loc} > parameter ${k}`;
      if (np.required) this.add('required-param-added', 'breaking', pl, `Required ${np.in} parameter "${np.name}" added`, undefined, np.schema.type ?? np.schema.ref);
      else this.add('optional-param-added', 'non-breaking', pl, `Optional ${np.in} parameter "${np.name}" added`, undefined, np.schema.type ?? np.schema.ref);
    }
  }
}

function cap(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}

// ------------------------------------------------------------------ report

function renderMarkdown(oldIr: WatayIR, newIr: WatayIR, r: Omit<DiffResult, 'markdown'>): string {
  const lines: string[] = [];
  lines.push('## Watay SpecDrift Report');
  lines.push('');
  lines.push(`**${newIr.title}** \`${oldIr.version}\` → \`${newIr.version}\` · suggested SemVer bump: **${r.suggestedBump}**`);
  lines.push('');
  const total = r.breaking.length + r.nonBreaking.length + r.info.length;
  if (total === 0) {
    lines.push('✅ No API changes detected.');
    return lines.join('\n') + '\n';
  }
  lines.push(`| Breaking | Non-breaking | Info |`);
  lines.push(`| :-: | :-: | :-: |`);
  lines.push(`| ${r.breaking.length} | ${r.nonBreaking.length} | ${r.info.length} |`);
  lines.push('');
  const section = (title: string, list: DiffChange[]) => {
    if (!list.length) return;
    lines.push(`### ${title} (${list.length})`);
    lines.push('');
    for (const c of list) lines.push(`- \`${c.code}\` **${c.location}** — ${c.message}`);
    lines.push('');
  };
  section('🚨 Breaking changes', r.breaking);
  section('✅ Non-breaking changes', r.nonBreaking);
  section('ℹ️ Informational', r.info);
  lines.push('<sub>Generated by [Watay](https://watay.dev) SpecDrift — runs 100% on your runner, no spec data leaves it.</sub>');
  return lines.join('\n') + '\n';
}

export function diffSpecs(oldIr: WatayIR, newIr: WatayIR): DiffResult {
  const d = new Differ(oldIr, newIr);
  d.run();
  const breaking = d.changes.filter((c) => c.severity === 'breaking');
  const nonBreaking = d.changes.filter((c) => c.severity === 'non-breaking');
  const info = d.changes.filter((c) => c.severity === 'info');
  const base = {
    breaking,
    nonBreaking,
    info,
    hasBreaking: breaking.length > 0,
    suggestedBump: (breaking.length ? 'major' : nonBreaking.length ? 'minor' : 'patch') as DiffResult['suggestedBump'],
  };
  return { ...base, markdown: renderMarkdown(oldIr, newIr, base) };
}
