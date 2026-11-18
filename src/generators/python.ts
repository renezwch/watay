/**
 * Watay – Python SDK generator (owner: dev-codegen).
 *
 * Output: zero-dependency Python 3.10+ package using dataclasses + stdlib urllib,
 * complete with runtime schema validation, retries, typed errors and wire-name mapping.
 */
import type { GeneratorOutput, OperationIR, ParameterIR, SchemaIR, WatayIR } from '../types.ts';
import { generateContractTests } from './contract-tests.ts';
import {
  GENERATED_BANNER,
  authRequirements,
  clientClassName,
  contentKind,
  docLines,
  ext,
  kebabCase,
  mergeAllOf,
  pascalCase,
  pyLiteral,
  requestKind,
  responseList,
  snakeCase,
  sortedSchemaNames,
  successResponse,
  toDescriptor,
  uniqueName,
} from './shared.ts';
import type { CodegenOptions } from './shared.ts';

const PY_HARD_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case',
]);

const PY_RESERVED_BUILTINS = new Set(['self', 'cls']);

export function pyModuleName(pkgOrTitle: string): string {
  let mod = snakeCase(pkgOrTitle).replace(/^_+/, '');
  if (!mod || /^[0-9]/.test(mod)) mod = 'sdk_' + mod;
  if (PY_HARD_KEYWORDS.has(mod)) mod += '_sdk';
  return mod;
}

function safePyIdent(raw: string, used: Set<string>): string {
  let id = snakeCase(raw);
  if (PY_HARD_KEYWORDS.has(id) || PY_RESERVED_BUILTINS.has(id)) id += '_';
  return uniqueName(id, used);
}

function safePyClass(raw: string, used: Set<string>): string {
  let id = pascalCase(raw);
  if (PY_HARD_KEYWORDS.has(id)) id += 'Model';
  return uniqueName(id, used);
}

// ------------------------------------------------------------------ type annotations

interface PyCtx {
  modelNames: Map<string, string>;
  /** Prefix when referencing models from outside models.py (e.g. "models."). */
  prefix: string;
}

function pyType(s: SchemaIR, c: PyCtx): string {
  const base = pyBaseType(s, c);
  if (s.nullable && base !== 'None' && base !== 'Any' && !base.endsWith(' | None')) {
    return base + ' | None';
  }
  return base;
}

function pyBaseType(s: SchemaIR, c: PyCtx): string {
  if (s.ref !== undefined) return c.prefix + (c.modelNames.get(s.ref) ?? 'Any');
  const k = ext(s).const;
  if (k !== undefined) return k === null ? 'None' : 'Literal[' + pyLiteral(k) + ']';
  if (s.enum !== undefined && s.enum.length > 0) {
    const nonNull = s.enum.filter((v) => v !== null);
    const hasNull = s.enum.some((v) => v === null);
    if (nonNull.length === 0) return 'None';
    const lit = 'Literal[' + nonNull.map((v) => pyLiteral(v)).join(', ') + ']';
    return hasNull ? lit + ' | None' : lit;
  }
  if (s.allOf && s.allOf.length > 0) {
    // If allOf resolves to a single ref, reference it; otherwise dict[str, Any]
    if (s.allOf.length === 1 && s.allOf[0]!.ref !== undefined) return pyType(s.allOf[0]!, c);
    return 'dict[str, Any]';
  }
  const alts = s.oneOf ?? s.anyOf;
  if (alts && alts.length > 0) {
    const parts: string[] = [];
    for (const a of alts) {
      const t = pyType(a, c);
      if (!parts.includes(t)) parts.push(t);
    }
    return parts.join(' | ');
  }
  switch (s.type) {
    case 'string': return 'str';
    case 'integer': return 'int';
    case 'number': return 'float';
    case 'boolean': return 'bool';
    case 'null': return 'None';
    case 'array': return 'list[' + (s.items ? pyType(s.items, c) : 'Any') + ']';
    case 'object': return 'dict[str, Any]';
    default:
      if (s.properties) return 'dict[str, Any]';
      return 'Any';
  }
}

// ------------------------------------------------------------------ models

interface FieldPlan {
  wireName: string;
  pyName: string;
  required: boolean;
  typeHint: string;
  schema: SchemaIR;
  doc?: string;
}

interface ModelPlan {
  schemaName: string;
  className: string;
  kind: 'dataclass' | 'alias';
  fields: FieldPlan[];
  aliasType?: string;
  doc: string[];
}

function buildModelPlans(ir: WatayIR, modelNames: Map<string, string>, c: PyCtx): ModelPlan[] {
  const plans: ModelPlan[] = [];
  for (const name of sortedSchemaNames(ir)) {
    const raw = ir.schemas[name]!;
    const className = modelNames.get(name)!;
    const merged = raw.allOf ? mergeAllOf(ir, raw) : undefined;
    const s = merged ?? raw;
    const isObject = s.properties !== undefined && !s.oneOf && !s.anyOf && !s.enum && !s.nullable && ext(s).const === undefined;
    if (!isObject) {
      plans.push({
        schemaName: name,
        className,
        kind: 'alias',
        fields: [],
        aliasType: pyType(raw, c),
        doc: docLines(raw.description),
      });
      continue;
    }
    const reqSet = new Set(s.required ?? []);
    const usedFields = new Set<string>(['to_dict', 'from_dict']);
    const fields: FieldPlan[] = [];
    for (const [wireName, propSchema] of Object.entries(s.properties ?? {})) {
      const pyName = safePyIdent(wireName, usedFields);
      const isReq = reqSet.has(wireName);
      const baseHint = pyType(propSchema, c);
      const typeHint = isReq || baseHint.endsWith(' | None') || baseHint === 'None' || baseHint === 'Any'
        ? baseHint
        : baseHint + ' | None';
      fields.push({
        wireName,
        pyName,
        required: isReq,
        typeHint,
        schema: propSchema,
        doc: propSchema.description,
      });
    }
    // Dataclass rule: required fields (no default) must precede optional fields (default=None)
    const ordered = [...fields.filter((f) => f.required), ...fields.filter((f) => !f.required)];
    plans.push({
      schemaName: name,
      className,
      kind: 'dataclass',
      fields: ordered,
      doc: docLines(s.description),
    });
  }
  return plans;
}

function pyHydrateExpr(s: SchemaIR, expr: string, c: PyCtx, dataclassesSet: Set<string>): string {
  if (s.ref !== undefined && dataclassesSet.has(s.ref)) {
    const target = c.modelNames.get(s.ref);
    if (target) return target + '.from_dict(' + expr + ') if isinstance(' + expr + ', dict) else ' + expr;
  }
  if (s.type === 'array' && s.items?.ref !== undefined && dataclassesSet.has(s.items.ref)) {
    const target = c.modelNames.get(s.items.ref);
    if (target) {
      return '[' + target + '.from_dict(x) if isinstance(x, dict) else x for x in ' + expr + '] if isinstance(' + expr + ', list) else ' + expr;
    }
  }
  return expr;
}

function genModelsPy(ir: WatayIR, plans: ModelPlan[], c: PyCtx): string {
  const dataclassesSet = new Set(plans.filter((p) => p.kind === 'dataclass').map((p) => p.schemaName));
  const out: string[] = [
    '# ' + GENERATED_BANNER,
    'from __future__ import annotations',
    '',
    'from dataclasses import dataclass',
    'from typing import Any, ClassVar, Literal, TypeAlias',
    '',
    'from .runtime import WatayModel, _serialize_value',
    '',
  ];
  for (const p of plans) {
    if (p.kind === 'alias') {
      if (p.doc.length) out.push('# ' + p.doc.join(' '));
      out.push(p.className + ': TypeAlias = ' + (p.aliasType ?? 'Any'));
      out.push('');
      continue;
    }
    out.push('@dataclass');
    out.push('class ' + p.className + '(WatayModel):');
    if (p.doc.length) {
      out.push('    """' + p.doc.join(' ').replace(/"""/g, '\\"\\"\\"') + '"""');
    }
    const wireToPy: Record<string, string> = {};
    const pyToWire: Record<string, string> = {};
    for (const f of p.fields) {
      wireToPy[f.wireName] = f.pyName;
      pyToWire[f.pyName] = f.wireName;
    }
    out.push('    _wire_to_py: ClassVar[dict[str, str]] = ' + pyLiteral(wireToPy, '    '));
    out.push('    _py_to_wire: ClassVar[dict[str, str]] = ' + pyLiteral(pyToWire, '    '));
    for (const f of p.fields) {
      const def = f.required ? '' : ' = None';
      out.push('    ' + f.pyName + ': ' + f.typeHint + def);
    }
    out.push('');
    out.push('    @classmethod');
    out.push('    def from_dict(cls, data: dict[str, Any]) -> ' + p.className + ':');
    out.push('        if not isinstance(data, dict):');
    out.push('            raise TypeError(f"Expected dict for ' + p.className + ', got {type(data).__name__}")');
    out.push('        kwargs: dict[str, Any] = {}');
    for (const f of p.fields) {
      const keyLit = pyLiteral(f.wireName);
      if (f.required) {
        out.push('        if ' + keyLit + ' in data:');
        out.push('            v = data[' + keyLit + ']');
        out.push('            kwargs[' + pyLiteral(f.pyName) + '] = ' + pyHydrateExpr(f.schema, 'v', c, dataclassesSet));
        out.push('        else:');
        out.push('            kwargs[' + pyLiteral(f.pyName) + '] = None');
      } else {
        out.push('        if ' + keyLit + ' in data and data[' + keyLit + '] is not None:');
        out.push('            v = data[' + keyLit + ']');
        out.push('            kwargs[' + pyLiteral(f.pyName) + '] = ' + pyHydrateExpr(f.schema, 'v', c, dataclassesSet));
      }
    }
    out.push('        return cls(**kwargs)');
    out.push('');
    out.push('    def to_dict(self) -> dict[str, Any]:');
    out.push('        out: dict[str, Any] = {}');
    for (const f of p.fields) {
      const keyLit = pyLiteral(f.wireName);
      if (f.required) {
        out.push('        out[' + keyLit + '] = _serialize_value(self.' + f.pyName + ')');
      } else {
        out.push('        if self.' + f.pyName + ' is not None:');
        out.push('            out[' + keyLit + '] = _serialize_value(self.' + f.pyName + ')');
      }
    }
    out.push('        return out');
    out.push('');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

// ------------------------------------------------------------------ operation planning

interface PyParamPlan {
  param: ParameterIR;
  pyName: string;
}

interface PyOpPlan {
  op: OperationIR;
  methodName: string;
  params: PyParamPlan[];
  bodyParamName?: string;
}

function buildPyOps(ir: WatayIR): PyOpPlan[] {
  const usedMethods = new Set<string>(['__init__', '_request', '_handle', 'close']);
  return ir.operations.map((op) => {
    const methodName = safePyIdent(op.operationId, usedMethods);
    const usedParams = new Set<string>(['self', 'request_options']);
    const params: PyParamPlan[] = [];
    for (const p of op.parameters) {
      params.push({ param: p, pyName: safePyIdent(p.name, usedParams) });
    }
    let bodyParamName: string | undefined;
    if (op.requestBody) {
      bodyParamName = usedParams.has('body') ? uniqueName('request_body', usedParams) : (usedParams.add('body'), 'body');
    }
    return { op, methodName, params, bodyParamName };
  });
}

function genSchemasPy(ir: WatayIR, ops: PyOpPlan[]): string {
  const schemasObj: Record<string, unknown> = {};
  for (const n of sortedSchemaNames(ir)) schemasObj[n] = toDescriptor(ir.schemas[n]!);

  const opsObj: Record<string, unknown> = {};
  for (const m of ops) {
    const op = m.op;
    const spec: Record<string, unknown> = {
      operation_id: op.operationId,
      method: op.method.toUpperCase(),
      path: op.path,
      params: m.params.map((p) => ({
        name: p.param.name,
        py_name: p.pyName,
        in: p.param.in,
        required: p.param.required,
      })),
    };
    if (op.requestBody && m.bodyParamName) {
      const kind = requestKind(op);
      spec.body = {
        key: m.bodyParamName,
        kind,
        content_type: op.requestBody.contentType,
        required: op.requestBody.required,
        ...(kind === 'json' ? { schema: toDescriptor(op.requestBody.schema) } : {}),
      };
    }
    spec.responses = responseList(op).map((r) => {
      const kind = contentKind(r.contentType, r.schema !== undefined);
      return {
        status: r.status,
        kind,
        ...(kind === 'json' && r.schema ? { schema: toDescriptor(r.schema) } : {}),
      };
    });
    spec.security = authRequirements(ir, op);
    opsObj[m.methodName] = spec;
  }

  return [
    '# ' + GENERATED_BANNER,
    'from __future__ import annotations',
    '',
    'from typing import Any',
    '',
    'SCHEMAS: dict[str, dict[str, Any]] = ' + pyLiteral(schemasObj),
    '',
    'OPERATIONS: dict[str, dict[str, Any]] = ' + pyLiteral(opsObj),
    '',
  ].join('\n');
}

// ------------------------------------------------------------------ runtime.py

const RUNTIME_PY = '# ' + GENERATED_BANNER + '\n' + String.raw`from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from typing import Any


class WatayModel:
    """Base class for generated dataclass models."""

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)  # type: ignore[arg-type]


def _serialize_value(value: Any) -> Any:
    if isinstance(value, WatayModel):
        return value.to_dict()
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {f.name: _serialize_value(getattr(value, f.name)) for f in dataclasses.fields(value)}
    if isinstance(value, list):
        return [_serialize_value(v) for v in value]
    if isinstance(value, dict):
        return {k: _serialize_value(v) for k, v in value.items()}
    return value


@dataclass
class ValidationIssue:
    path: str
    message: str


class SdkError(Exception):
    """Base class of all errors raised by this SDK."""


class ValidationError(SdkError):
    """Raised when a request body or response violates the OpenAPI contract."""

    def __init__(self, message: str, issues: list[ValidationIssue]) -> None:
        summary = "; ".join(f"{i.path} {i.message}" for i in issues[:5])
        if len(issues) > 5:
            summary += f" (+{len(issues) - 5} more)"
        super().__init__(f"{message}: {summary}")
        self.issues = issues


class ApiError(SdkError):
    """Raised for non-2xx HTTP responses."""

    def __init__(
        self,
        operation_id: str,
        status: int,
        reason: str,
        body: Any,
        headers: dict[str, str],
    ) -> None:
        super().__init__(f"HTTP {status} {reason} ({operation_id})")
        self.operation_id = operation_id
        self.status = status
        self.reason = reason
        self.body = body
        self.headers = headers


class NetworkError(SdkError):
    """Raised when the HTTP request could not complete."""

    def __init__(self, operation_id: str, cause: Exception) -> None:
        super().__init__(f"Network error ({operation_id}): {cause}")
        self.operation_id = operation_id
        self.cause = cause


def _type_name(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, float):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "object"
    return type(v).__name__


def validate(
    schema: dict[str, Any],
    value: Any,
    registry: dict[str, dict[str, Any]],
    path: str = "$",
    issues: list[ValidationIssue] | None = None,
    depth: int = 0,
) -> list[ValidationIssue]:
    if issues is None:
        issues = []
    if depth > 64:
        return issues

    if value is None and (schema.get("nullable") or schema.get("type") == "null"):
        return issues

    ref = schema.get("$ref")
    if ref is not None:
        target = registry.get(ref)
        if target is None:
            issues.append(ValidationIssue(path, f"unknown schema {ref}"))
        else:
            validate(target, value, registry, path, issues, depth + 1)
        return issues

    for sub in schema.get("allOf") or ():
        validate(sub, value, registry, path, issues, depth + 1)

    alts = schema.get("oneOf") or schema.get("anyOf")
    if alts:
        if not any(len(validate(a, value, registry, path, [], depth + 1)) == 0 for a in alts):
            issues.append(ValidationIssue(path, "does not match any allowed schema"))
        if "type" not in schema:
            return issues

    if "const" in schema and value != schema["const"]:
        issues.append(ValidationIssue(path, f"expected constant {schema['const']!r}"))

    if "enum" in schema:
        if not any(value == e and type(value) is type(e) for e in schema["enum"]):
            issues.append(ValidationIssue(path, f"must be one of {schema['enum']!r}"))
            return issues

    stype = schema.get("type")
    if stype == "string":
        if not isinstance(value, str):
            issues.append(ValidationIssue(path, f"expected string, got {_type_name(value)}"))
        else:
            if "minLength" in schema and len(value) < schema["minLength"]:
                issues.append(ValidationIssue(path, f"shorter than {schema['minLength']}"))
            if "maxLength" in schema and len(value) > schema["maxLength"]:
                issues.append(ValidationIssue(path, f"longer than {schema['maxLength']}"))
    elif stype in ("integer", "number"):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            issues.append(ValidationIssue(path, f"expected {stype}, got {_type_name(value)}"))
        else:
            if stype == "integer" and not isinstance(value, int):
                issues.append(ValidationIssue(path, "expected integer"))
            if "minimum" in schema and value < schema["minimum"]:
                issues.append(ValidationIssue(path, f"below minimum {schema['minimum']}"))
            if "maximum" in schema and value > schema["maximum"]:
                issues.append(ValidationIssue(path, f"above maximum {schema['maximum']}"))
            if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
                issues.append(ValidationIssue(path, f"must be > {schema['exclusiveMinimum']}"))
            if "exclusiveMaximum" in schema and value >= schema["exclusiveMaximum"]:
                issues.append(ValidationIssue(path, f"must be < {schema['exclusiveMaximum']}"))
    elif stype == "boolean":
        if not isinstance(value, bool):
            issues.append(ValidationIssue(path, f"expected boolean, got {_type_name(value)}"))
    elif stype == "null":
        if value is not None:
            issues.append(ValidationIssue(path, f"expected null, got {_type_name(value)}"))
    elif stype == "array":
        if not isinstance(value, list):
            issues.append(ValidationIssue(path, f"expected array, got {_type_name(value)}"))
        else:
            if "minItems" in schema and len(value) < schema["minItems"]:
                issues.append(ValidationIssue(path, f"fewer than {schema['minItems']} items"))
            if "maxItems" in schema and len(value) > schema["maxItems"]:
                issues.append(ValidationIssue(path, f"more than {schema['maxItems']} items"))
            items = schema.get("items")
            if isinstance(items, dict):
                for idx, item in enumerate(value):
                    validate(items, item, registry, f"{path}[{idx}]", issues, depth + 1)
    elif stype == "object" or "properties" in schema:
        if not isinstance(value, dict):
            issues.append(ValidationIssue(path, f"expected object, got {_type_name(value)}"))
        else:
            for req in schema.get("required") or ():
                if req not in value or value[req] is None:
                    issues.append(ValidationIssue(f"{path}.{req}", "is required"))
            props = schema.get("properties") or {}
            ap = schema.get("additionalProperties")
            for k, v in value.items():
                if k in props:
                    if v is not None:
                        validate(props[k], v, registry, f"{path}.{k}", issues, depth + 1)
                elif isinstance(ap, dict) and v is not None:
                    validate(ap, v, registry, f"{path}.{k}", issues, depth + 1)

    return issues
`;

// ------------------------------------------------------------------ client.py

function pyReturnType(op: OperationIR, c: PyCtx): string {
  const r = successResponse(op);
  if (!r) return 'None';
  const kind = contentKind(r.contentType, r.schema !== undefined);
  if (kind === 'none') return 'None';
  if (kind === 'text') return 'str';
  if (kind === 'binary') return 'bytes';
  return r.schema ? pyType(r.schema, c) : 'Any';
}

function pyBodyType(op: OperationIR, c: PyCtx): string {
  const rb = op.requestBody!;
  const kind = contentKind(rb.contentType);
  if (kind === 'binary') return 'bytes | str';
  if (kind === 'text') return 'str';
  if (kind === 'multipart') return 'dict[str, Any]';
  const t = pyType(rb.schema, c);
  // Allow dicts everywhere a dataclass model is accepted
  if (rb.schema.ref !== undefined && !t.includes('dict')) return t + ' | dict[str, Any]';
  return t;
}

function pyReturnHydrator(op: OperationIR, plans: Map<string, ModelPlan>, c: PyCtx): string | undefined {
  const r = successResponse(op);
  if (!r || !r.schema) return undefined;
  const s = r.schema;
  if (s.ref !== undefined) {
    const plan = plans.get(s.ref);
    if (plan && plan.kind === 'dataclass') return 'models.' + plan.className + '.from_dict';
  }
  if (s.type === 'array' && s.items?.ref !== undefined) {
    const plan = plans.get(s.items.ref);
    if (plan && plan.kind === 'dataclass') {
      const cls = c.prefix + plan.className;
      return 'lambda rows: [' + cls + '.from_dict(x) if isinstance(x, dict) else x for x in rows]';
    }
  }
  return undefined;
}

function genPyMethod(m: PyOpPlan, plans: Map<string, ModelPlan>, c: PyCtx): string {
  const op = m.op;
  const reqArgs: string[] = [];
  const optArgs: string[] = [];
  for (const p of m.params) {
    const t = pyType(p.param.schema, c);
    if (p.param.required) reqArgs.push(p.pyName + ': ' + t);
    else optArgs.push(p.pyName + ': ' + (t.endsWith(' | None') || t === 'Any' ? t : t + ' | None') + ' = None');
  }
  if (op.requestBody && m.bodyParamName) {
    const bt = pyBodyType(op, c);
    if (op.requestBody.required) reqArgs.push(m.bodyParamName + ': ' + bt);
    else optArgs.push(m.bodyParamName + ': ' + (bt.endsWith(' | None') || bt === 'Any' ? bt : bt + ' | None') + ' = None');
  }
  optArgs.push('request_options: RequestOptions | None = None');

  const sig = ['self', ...reqArgs, ...optArgs].join(', ');
  const ret = pyReturnType(op, c);

  const lines: string[] = [];
  lines.push('    def ' + m.methodName + '(' + sig + ') -> ' + ret + ':');
  const docParts: string[] = [];
  if (op.summary) docParts.push(op.summary.replace(/"""/g, '\\"\\"\\"'));
  else docParts.push(op.method.toUpperCase() + ' ' + op.path);
  if (op.description) docParts.push('', op.description.replace(/"""/g, '\\"\\"\\"'));
  docParts.push('', op.method.toUpperCase() + ' ' + op.path);
  if (op.deprecated) docParts.push('', 'Deprecated.');
  lines.push('        """' + docParts.join('\n        ') + '"""');

  lines.push('        _args: dict[str, Any] = {');
  for (const p of m.params) {
    lines.push('            ' + pyLiteral(p.pyName) + ': ' + p.pyName + ',');
  }
  if (op.requestBody && m.bodyParamName) {
    lines.push('            ' + pyLiteral(m.bodyParamName) + ': ' + m.bodyParamName + ',');
  }
  lines.push('        }');
  const hydrator = pyReturnHydrator(op, plans, c);
  const hydratorArg = hydrator ? ', hydrator=' + hydrator : '';
  lines.push(
    '        return self._request(OPERATIONS[' + pyLiteral(m.methodName) + '], _args, request_options' + hydratorArg + ')',
  );
  return lines.join('\n');
}

function genClientPy(ir: WatayIR, ops: PyOpPlan[], plans: Map<string, ModelPlan>, c: PyCtx, className: string): string {
  const server = ir.servers[0] ?? '';
  const methods = ops.map((m) => genPyMethod(m, plans, c)).join('\n\n');
  return [
    '# ' + GENERATED_BANNER,
    CLIENT_PY_HEAD,
    'DEFAULT_BASE_URL = ' + pyLiteral(server),
    CLIENT_PY_BODY,
    'class ' + className + ':',
    CLIENT_PY_CLASS_BODY,
    methods || '    pass',
    '',
  ].join('\n');
}

const CLIENT_PY_HEAD = String.raw`from __future__ import annotations

import base64
from dataclasses import dataclass
import json
import time
from typing import Any, Callable
import urllib.error
import urllib.parse
import urllib.request
import uuid

from . import models
from .runtime import ApiError, NetworkError, SdkError, ValidationError, ValidationIssue, _serialize_value, validate
from .schemas import OPERATIONS, SCHEMAS
`;

const CLIENT_PY_BODY = String.raw`
IDEMPOTENT_METHODS = {"GET", "HEAD", "PUT", "DELETE", "OPTIONS"}
RETRY_STATUSES = {429, 502, 503, 504}


@dataclass
class RequestOptions:
    headers: dict[str, str] | None = None
    timeout: float | None = None


def _encode_multipart(fields: dict[str, Any]) -> tuple[bytes, str]:
    boundary = f"----watay-{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for key, val in fields.items():
        if val is None:
            continue
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        if isinstance(val, bytes):
            chunks.append(
                f'Content-Disposition: form-data; name="{key}"; filename="{key}"\r\n'
                f"Content-Type: application/octet-stream\r\n\r\n".encode("utf-8")
            )
            chunks.append(val)
        else:
            chunks.append(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode("utf-8"))
            chunks.append(_serialize_scalar(val).encode("utf-8"))
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _serialize_scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, tuple)):
        return ",".join(_serialize_scalar(v) for v in value)
    if isinstance(value, dict):
        return json.dumps(value)
    return str(value)


def _match_response(op: dict[str, Any], status: int) -> dict[str, Any] | None:
    responses: list[dict[str, Any]] = op.get("responses") or []
    s = str(status)
    for r in responses:
        if r["status"] == s:
            return r
    prefix = f"{status // 100}XX"
    for r in responses:
        if str(r["status"]).upper() == prefix:
            return r
    for r in responses:
        if r["status"] == "default":
            return r
    return None


def _sniff_kind(content_type: str) -> str:
    ct = content_type.lower()
    if not ct:
        return "none"
    if "json" in ct:
        return "json"
    if ct.startswith("text/"):
        return "text"
    return "binary"


TransportFn = Callable[[urllib.request.Request, float], tuple[int, str, dict[str, str], bytes]]


def _default_transport(req: urllib.request.Request, timeout: float) -> tuple[int, str, dict[str, str], bytes]:
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            headers = {k.lower(): v for k, v in resp.headers.items()}
            return resp.status, getattr(resp, "reason", "OK"), headers, resp.read()
    except urllib.error.HTTPError as err:
        try:
            headers = {k.lower(): v for k, v in (err.headers.items() if err.headers else [])}
            body = err.read() if err.fp else b""
            return err.code, str(err.reason), headers, body
        finally:
            err.close()
`;

const CLIENT_PY_CLASS_BODY = String.raw`    def __init__(
        self,
        base_url: str | None = None,
        *,
        headers: dict[str, str] | None = None,
        bearer_token: str | Callable[[], str] | None = None,
        basic_auth: tuple[str, str] | None = None,
        api_key: str | dict[str, str] | None = None,
        timeout: float = 30.0,
        max_retries: int = 2,
        retry_delay: float = 0.25,
        validate_requests: bool = True,
        validate_responses: bool = True,
        transport: TransportFn | None = None,
    ) -> None:
        self.base_url = (base_url if base_url is not None else DEFAULT_BASE_URL).rstrip("/")
        self._headers = {"accept": "application/json", **(headers or {})}
        self._bearer_token = bearer_token
        self._basic_auth = basic_auth
        self._api_key = api_key
        self._timeout = timeout
        self._max_retries = max_retries
        self._retry_delay = retry_delay
        self._validate_requests = validate_requests
        self._validate_responses = validate_responses
        self._transport = transport or _default_transport

    def _request(
        self,
        op: dict[str, Any],
        args: dict[str, Any],
        request_options: RequestOptions | None = None,
        hydrator: Callable[[Any], Any] | None = None,
    ) -> Any:
        op_id = op["operation_id"]
        method = op["method"]
        path = op["path"]
        query_items: list[tuple[str, str]] = []
        headers = dict(self._headers)
        cookies: list[str] = []

        for p in op.get("params") or ():
            val = args.get(p["py_name"])
            if val is None:
                if p["required"]:
                    raise SdkError(f'Missing required {p["in"]} parameter "{p["name"]}" for {op_id}')
                continue
            where = p["in"]
            if where == "path":
                path = path.replace("{" + p["name"] + "}", urllib.parse.quote(_serialize_scalar(val), safe=""))
            elif where == "query":
                if isinstance(val, (list, tuple)):
                    for item in val:
                        query_items.append((p["name"], _serialize_scalar(item)))
                else:
                    query_items.append((p["name"], _serialize_scalar(val)))
            elif where == "header":
                headers[p["name"]] = _serialize_scalar(val)
            elif where == "cookie":
                cookies.append(f'{p["name"]}={urllib.parse.quote(_serialize_scalar(val))}')

        for sec in op.get("security") or ():
            kind = sec["kind"]
            if kind == "bearer":
                tok = self._bearer_token() if callable(self._bearer_token) else self._bearer_token
                if tok:
                    headers["authorization"] = f"Bearer {tok}"
            elif kind == "basic":
                if self._basic_auth:
                    raw_cred = f"{self._basic_auth[0]}:{self._basic_auth[1]}".encode("utf-8")
                    headers["authorization"] = "Basic " + base64.b64encode(raw_cred).decode("ascii")
            else:
                key_val = self._api_key if isinstance(self._api_key, str) else (self._api_key or {}).get(sec["scheme"])
                if key_val:
                    loc = sec.get("in", "header")
                    kname = sec.get("name") or sec["scheme"]
                    if loc == "query":
                        query_items.append((kname, key_val))
                    elif loc == "cookie":
                        cookies.append(f"{kname}={urllib.parse.quote(key_val)}")
                    else:
                        headers[kname] = key_val

        if cookies:
            headers["cookie"] = "; ".join(cookies)

        body_bytes: bytes | None = None
        body_spec = op.get("body")
        if body_spec is not None:
            raw_body = args.get(body_spec["key"])
            if raw_body is None:
                if body_spec["required"]:
                    raise SdkError(f"Missing required request body for {op_id}")
            else:
                wire_body = _serialize_value(raw_body)
                if body_spec.get("schema") and self._validate_requests:
                    issues = validate(body_spec["schema"], wire_body, SCHEMAS)
                    if issues:
                        raise ValidationError(f"Invalid request body for {op_id}", issues)
                bkind = body_spec["kind"]
                if bkind == "json":
                    body_bytes = json.dumps(wire_body).encode("utf-8")
                    headers["content-type"] = body_spec["content_type"]
                elif bkind == "form":
                    form_items: list[tuple[str, str]] = []
                    for fk, fv in (wire_body or {}).items():
                        if fv is not None:
                            form_items.append((fk, _serialize_scalar(fv)))
                    body_bytes = urllib.parse.urlencode(form_items).encode("utf-8")
                    headers["content-type"] = "application/x-www-form-urlencoded"
                elif bkind == "multipart":
                    body_bytes, mp_ct = _encode_multipart(wire_body or {})
                    headers["content-type"] = mp_ct
                elif bkind == "text":
                    body_bytes = str(raw_body).encode("utf-8")
                    headers["content-type"] = body_spec["content_type"]
                else:
                    body_bytes = raw_body if isinstance(raw_body, bytes) else str(raw_body).encode("utf-8")
                    headers["content-type"] = body_spec["content_type"]

        if request_options and request_options.headers:
            headers.update(request_options.headers)

        qs = urllib.parse.urlencode(query_items)
        url = f"{self.base_url}{path}" + (f"?{qs}" if qs else "")
        timeout = request_options.timeout if request_options and request_options.timeout is not None else self._timeout

        attempts = 1 + (self._max_retries if method in IDEMPOTENT_METHODS else 0)
        for attempt in range(1, attempts + 1):
            last = attempt >= attempts
            req = urllib.request.Request(url, data=body_bytes, headers=headers, method=method)
            try:
                status, reason, resp_headers, raw_resp = self._transport(req, timeout)
            except Exception as err:
                if last:
                    raise NetworkError(op_id, err) from err
                time.sleep(self._retry_delay * (2 ** (attempt - 1)))
                continue

            if not last and status in RETRY_STATUSES:
                ra = resp_headers.get("retry-after")
                delay = self._retry_delay * (2 ** (attempt - 1))
                if ra and ra.isdigit():
                    delay = min(float(ra), 30.0)
                time.sleep(delay)
                continue

            return self._handle(op, status, reason, resp_headers, raw_resp, hydrator)

        raise SdkError(f"Unreachable retry state for {op_id}")

    def _handle(
        self,
        op: dict[str, Any],
        status: int,
        reason: str,
        resp_headers: dict[str, str],
        raw_resp: bytes,
        hydrator: Callable[[Any], Any] | None,
    ) -> Any:
        op_id = op["operation_id"]
        spec = _match_response(op, status)
        if 200 <= status < 300:
            kind = spec["kind"] if spec else ("none" if status == 204 else _sniff_kind(resp_headers.get("content-type", "")))
            if kind == "none":
                return None
            if kind == "text":
                return raw_resp.decode("utf-8", errors="replace")
            if kind in ("binary", "multipart", "form"):
                return raw_resp
            text = raw_resp.decode("utf-8", errors="replace").strip()
            if not text:
                return None
            try:
                data = json.loads(text)
            except json.JSONDecodeError as err:
                raise ValidationError(
                    f"Response of {op_id} is not valid JSON",
                    [ValidationIssue("$", f"invalid JSON: {err}")],
                ) from err
            if spec and spec.get("schema") and self._validate_responses:
                issues = validate(spec["schema"], data, SCHEMAS)
                if issues:
                    raise ValidationError(f"Response of {op_id} violates the API contract", issues)
            return hydrator(data) if hydrator is not None else data

        raw_text = raw_resp.decode("utf-8", errors="replace")
        parsed: Any = raw_text
        if raw_text:
            try:
                parsed = json.loads(raw_text)
            except json.JSONDecodeError:
                parsed = raw_text
        else:
            parsed = None
        raise ApiError(op_id, status, reason, parsed, resp_headers)
`;

function genInitPy(className: string, plans: ModelPlan[]): string {
  const modelExports = plans.map((p) => p.className);
  const allList = [className, 'RequestOptions', 'SdkError', 'ApiError', 'NetworkError', 'ValidationError', 'ValidationIssue', ...modelExports];
  const lines: string[] = [
    '# ' + GENERATED_BANNER,
    'from __future__ import annotations',
    '',
    'from .client import ' + className + ', RequestOptions',
    'from .runtime import ApiError, NetworkError, SdkError, ValidationError, ValidationIssue',
  ];
  if (modelExports.length > 0) {
    lines.push('from .models import ' + modelExports.join(', '));
  }
  lines.push('');
  lines.push('__all__ = [');
  for (const sym of allList) lines.push('    ' + pyLiteral(sym) + ',');
  lines.push(']');
  lines.push('');
  return lines.join('\n');
}

function genPyprojectToml(ir: WatayIR, opts: CodegenOptions, pkgName: string, modName: string): string {
  const version = opts.sdkVersion ?? ir.version;
  const desc = (ir.description ?? 'Python SDK for ' + ir.title).replace(/\n/g, ' ');
  return [
    '# ' + GENERATED_BANNER,
    '[build-system]',
    'requires = ["setuptools>=61.0"]',
    'build-backend = "setuptools.build_meta"',
    '',
    '[project]',
    'name = ' + JSON.stringify(pkgName),
    'version = ' + JSON.stringify(version),
    'description = ' + JSON.stringify(desc),
    'readme = "README.md"',
    'requires-python = ">=3.10"',
    'dependencies = []',
    'keywords = ["openapi", "sdk", "api-client", "watay"]',
    '',
    '[tool.setuptools.packages.find]',
    'include = [' + JSON.stringify(modName + '*') + ']',
    '',
  ].join('\n');
}

function genPythonReadme(ir: WatayIR, pkgName: string, modName: string, className: string, ops: PyOpPlan[]): string {
  const first = ops[0];
  const example = first ? 'result = client.' + first.methodName + '()\n' : '';
  return [
    '# ' + pkgName,
    '',
    'Typed Python client for **' + ir.title + '** (API version ' + ir.version + ').',
    'Generated by [Watay](https://watay.io) - zero runtime dependencies (dataclasses + stdlib urllib), runtime contract validation, retries and typed errors.',
    '',
    '## Usage',
    '',
    '```python',
    'from ' + modName + ' import ' + className,
    '',
    'client = ' + className + '(base_url=' + JSON.stringify(ir.servers[0] ?? 'https://api.example.com') + ')',
    example + '```',
    '',
    '## Operations',
    '',
    ...ops.map((m) => '- `client.' + m.methodName + '()` - `' + m.op.method.toUpperCase() + ' ' + m.op.path + '`' + (m.op.summary ? ' - ' + m.op.summary.replace(/\n/g, ' ') : '')),
    '',
  ].join('\n');
}

// ------------------------------------------------------------------ entry point

export function generatePython(ir: WatayIR, opts: CodegenOptions = {}): GeneratorOutput {
  const pkgName = opts.packageName ?? kebabCase(ir.title) + '-sdk';
  const modName = pyModuleName(pkgName);
  const className = clientClassName(ir.title);

  const usedClasses = new Set<string>([className, 'RequestOptions', 'SdkError', 'ApiError', 'NetworkError', 'ValidationError', 'ValidationIssue', 'WatayModel', 'Any', 'Literal', 'TypeAlias']);
  const modelNames = new Map<string, string>();
  for (const n of sortedSchemaNames(ir)) modelNames.set(n, safePyClass(n, usedClasses));

  const modelsCtx: PyCtx = { modelNames, prefix: '' };
  const clientCtx: PyCtx = { modelNames, prefix: 'models.' };

  const plans = buildModelPlans(ir, modelNames, modelsCtx);
  const planMap = new Map<string, ModelPlan>(plans.map((p) => [p.schemaName, p]));
  const ops = buildPyOps(ir);

  const files: Record<string, string> = {};
  files['pyproject.toml'] = genPyprojectToml(ir, opts, pkgName, modName);
  files['README.md'] = genPythonReadme(ir, pkgName, modName, className, ops);
  files[modName + '/__init__.py'] = genInitPy(className, plans);
  files[modName + '/runtime.py'] = RUNTIME_PY;
  files[modName + '/models.py'] = genModelsPy(ir, plans, modelsCtx);
  files[modName + '/schemas.py'] = genSchemasPy(ir, ops);
  files[modName + '/client.py'] = genClientPy(ir, ops, planMap, clientCtx, className);

  if (opts.withContractTests) {
    const tests = generateContractTests(ir, 'python', pkgName);
    for (const k of Object.keys(tests).sort()) files[k] = tests[k]!;
  }

  const sorted: Record<string, string> = {};
  for (const k of Object.keys(files).sort()) sorted[k] = files[k]!;
  return { language: 'python', files: sorted };
}
