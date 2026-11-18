/**
 * Watay – Contract test generator (owner: dev-codegen).
 *
 * Generates self-contained contract test suites (Node `node:test` for TypeScript,
 * stdlib `unittest` for Python) with an embedded local HTTP mock server synthesized from WatayIR.
 * Zero external test dependencies; 100% deterministic.
 */
import type { Language, OperationIR, SchemaIR, WatayIR } from '../types.ts';
import {
  GENERATED_BANNER,
  camelCase,
  clientClassName,
  contentKind,
  exampleValue,
  kebabCase,
  pyLiteral,
  resolveRef,
  snakeCase,
  successResponse,
  uniqueName,
} from './shared.ts';

const PY_HARD_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case',
]);

function pyIdent(raw: string, used: Set<string>): string {
  let id = snakeCase(raw);
  if (PY_HARD_KEYWORDS.has(id) || id === 'self' || id === 'cls') id += '_';
  return uniqueName(id, used);
}

function pyMod(pkgOrTitle: string): string {
  let mod = snakeCase(pkgOrTitle).replace(/^_+/, '');
  if (!mod || /^[0-9]/.test(mod)) mod = 'sdk_' + mod;
  if (PY_HARD_KEYWORDS.has(mod)) mod += '_sdk';
  return mod;
}

interface MockRoute {
  method: string;
  path: string;
  regex: string;
  status: number;
  kind: 'json' | 'text' | 'binary' | 'none';
  contentType: string;
  responseBody: unknown;
  invalidPayload?: unknown;
  hasSchemaConstraint: boolean;
}

function invalidValueFor(ir: WatayIR, schema: SchemaIR | undefined): { hasConstraint: boolean; value: unknown } {
  if (!schema) return { hasConstraint: false, value: null };
  const resolved = schema.ref !== undefined ? resolveRef(ir, schema) : schema;
  if (!resolved) return { hasConstraint: false, value: null };
  if (resolved.enum && resolved.enum.length > 0) {
    return { hasConstraint: true, value: '__watay_invalid_enum__' };
  }
  if (resolved.type === 'string') return { hasConstraint: true, value: 99999 };
  if (resolved.type === 'integer' || resolved.type === 'number') return { hasConstraint: true, value: '__watay_not_a_number__' };
  if (resolved.type === 'boolean') return { hasConstraint: true, value: '__watay_not_a_bool__' };
  if (resolved.type === 'array') return { hasConstraint: true, value: { __watay_not_an_array: true } };
  if (resolved.type === 'object' || resolved.properties || resolved.required) {
    return { hasConstraint: true, value: '__watay_not_an_object__' };
  }
  if (resolved.oneOf || resolved.anyOf || resolved.allOf) {
    return { hasConstraint: true, value: '__watay_invalid_union__' };
  }
  return { hasConstraint: false, value: null };
}

function pathToRegex(path: string): string {
  const parts = path.split(/(\{[^}]+\})/);
  return (
    '^' +
    parts
      .map((part) => {
        if (/^\{[^}]+\}$/.test(part)) return '[^/]+';
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('') +
    '$'
  );
}

function routePriority(path: string): [number, number, string] {
  const segs = path.split('/').filter(Boolean);
  const paramCount = segs.filter((s) => /^\{[^}]+\}$/.test(s)).length;
  const staticCount = segs.length - paramCount;
  return [paramCount, -staticCount, path];
}

function buildRoutes(ir: WatayIR): { routes: MockRoute[]; byOpId: Map<string, MockRoute> } {
  const byOpId = new Map<string, MockRoute>();
  const list: Array<{ op: OperationIR; route: MockRoute }> = [];

  for (const op of ir.operations) {
    const resp = successResponse(op);
    const statusStr = resp?.status ?? '200';
    const status = /^\d{3}$/.test(statusStr) ? Number(statusStr) : 200;
    const kindRaw = resp ? contentKind(resp.contentType, resp.schema !== undefined) : 'none';
    const kind: MockRoute['kind'] =
      status === 204 || kindRaw === 'none'
        ? 'none'
        : kindRaw === 'text'
          ? 'text'
          : kindRaw === 'binary'
            ? 'binary'
            : 'json';
    const contentType = resp?.contentType ?? (kind === 'json' ? 'application/json' : kind === 'text' ? 'text/plain' : 'application/octet-stream');
    let responseBody: unknown = null;
    if (kind === 'json') {
      const ev = resp?.schema ? exampleValue(ir, resp.schema) : { ok: true };
      responseBody = ev === undefined ? {} : ev;
    } else if (kind === 'text') responseBody = typeof resp?.schema?.example === 'string' ? resp.schema.example : 'ok';
    else if (kind === 'binary') responseBody = 'watay-binary';

    const inv = kind === 'json' ? invalidValueFor(ir, resp?.schema) : { hasConstraint: false, value: null };
    const route: MockRoute = {
      method: op.method.toUpperCase(),
      path: op.path,
      regex: pathToRegex(op.path),
      status,
      kind,
      contentType,
      responseBody,
      invalidPayload: inv.value,
      hasSchemaConstraint: inv.hasConstraint,
    };
    byOpId.set(op.operationId, route);
    list.push({ op, route });
  }

  list.sort((a, b) => {
    const pa = routePriority(a.route.path);
    const pb = routePriority(b.route.path);
    return pa[0] - pb[0] || pa[1] - pb[1] || (pa[2] < pb[2] ? -1 : pa[2] > pb[2] ? 1 : 0);
  });

  return { routes: list.map((x) => x.route), byOpId };
}

function sampleParamValue(ir: WatayIR, schema: SchemaIR): unknown {
  const v = exampleValue(ir, schema);
  if (v === undefined || v === null) return 'sample';
  return v;
}

// ------------------------------------------------------------------ TypeScript contract tests

function genTsContractTests(ir: WatayIR): string {
  const className = clientClassName(ir.title);
  const { routes, byOpId } = buildRoutes(ir);
  const methodNames = new Set<string>(['constructor', '_request', '_handle', 'toString', 'valueOf']);

  const opCases: string[] = [];
  let firstErrorOp: { method: string; argsExpr: string } | undefined;
  let firstInvalidOp: { method: string; argsExpr: string } | undefined;

  for (const op of ir.operations) {
    const method = uniqueName(camelCase(op.operationId), methodNames);
    const bodyKey = op.parameters.some((p) => p.name === 'body') ? 'requestBody' : 'body';
    const argsObj: Record<string, unknown> = {};
    for (const p of op.parameters) {
      if (p.required || p.in === 'path') {
        argsObj[p.name] = sampleParamValue(ir, p.schema);
      }
    }
    if (op.requestBody) {
      const bKind = contentKind(op.requestBody.contentType);
      if (bKind === 'text') argsObj[bodyKey] = 'sample text';
      else if (bKind === 'binary') argsObj[bodyKey] = 'sample-bytes';
      else argsObj[bodyKey] = exampleValue(ir, op.requestBody.schema);
    }
    const hasArgs = op.parameters.length > 0 || op.requestBody !== undefined;
    const argsExpr = hasArgs ? JSON.stringify(argsObj) : '';
    const route = byOpId.get(op.operationId)!;

    if (!firstErrorOp) firstErrorOp = { method, argsExpr };
    if (!firstInvalidOp && route.hasSchemaConstraint) firstInvalidOp = { method, argsExpr };

    const callExpr = hasArgs ? `await client.${method}(${argsExpr})` : `await client.${method}()`;
    opCases.push(
      `  test(${JSON.stringify(op.method.toUpperCase() + ' ' + op.path + ' (' + method + ')')}, async () => {\n` +
        `    const res = ${callExpr};\n` +
        (route.kind === 'none'
          ? `    assert.equal(res, undefined);\n`
          : route.kind === 'json'
            ? `    assert.deepEqual(res, ${JSON.stringify(route.responseBody)});\n`
            : `    assert.ok(res !== undefined);\n`) +
        `  });`,
    );
  }

  const extraTests: string[] = [];
  if (firstErrorOp) {
    const call = firstErrorOp.argsExpr
      ? `client.${firstErrorOp.method}(${firstErrorOp.argsExpr}, { headers: { 'x-watay-mock-mode': 'error' } })`
      : `client.${firstErrorOp.method}({ headers: { 'x-watay-mock-mode': 'error' } })`;
    extraTests.push(
      `  test('maps non-2xx responses to ApiError', async () => {\n` +
        `    await assert.rejects(() => ${call}, (err) => err instanceof ApiError && err.status === 500);\n` +
        `  });`,
    );
  }
  if (firstInvalidOp) {
    const call = firstInvalidOp.argsExpr
      ? `client.${firstInvalidOp.method}(${firstInvalidOp.argsExpr}, { headers: { 'x-watay-mock-mode': 'invalid' } })`
      : `client.${firstInvalidOp.method}({ headers: { 'x-watay-mock-mode': 'invalid' } })`;
    extraTests.push(
      `  test('rejects contract-violating responses with ValidationError', async () => {\n` +
        `    await assert.rejects(() => ${call}, (err) => err instanceof ValidationError);\n` +
        `  });`,
    );
  }

  return [
    `/* ${GENERATED_BANNER} */`,
    `import { describe, test, before, after } from 'node:test';`,
    `import assert from 'node:assert/strict';`,
    `import http from 'node:http';`,
    `import { ${className}, ApiError, ValidationError } from '../src/index.ts';`,
    ``,
    `const MOCK_ROUTES = ${JSON.stringify(routes, null, 2)};`,
    ``,
    `describe(${JSON.stringify(ir.title + ' Contract Tests')}, () => {`,
    `  let server;`,
    `  let client;`,
    ``,
    `  before(async () => {`,
    `    server = http.createServer((req, res) => {`,
    `      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');`,
    `      const mode = req.headers['x-watay-mock-mode'];`,
    `      req.resume();`,
    `      req.on('end', () => {`,
    `        if (mode === 'error') {`,
    `          res.writeHead(500, { 'content-type': 'application/json' });`,
    `          res.end(JSON.stringify({ error: 'simulated server error' }));`,
    `          return;`,
    `        }`,
    `        const route = MOCK_ROUTES.find((r) => r.method === req.method && new RegExp(r.regex).test(reqUrl.pathname));`,
    `        if (!route) {`,
    `          res.writeHead(404, { 'content-type': 'application/json' });`,
    `          res.end(JSON.stringify({ error: 'route not mocked', method: req.method, path: reqUrl.pathname }));`,
    `          return;`,
    `        }`,
    `        if (mode === 'invalid' && route.hasSchemaConstraint) {`,
    `          res.writeHead(route.status, { 'content-type': 'application/json' });`,
    `          res.end(JSON.stringify(route.invalidPayload));`,
    `          return;`,
    `        }`,
    `        if (route.kind === 'none') {`,
    `          res.writeHead(route.status);`,
    `          res.end();`,
    `          return;`,
    `        }`,
    `        res.writeHead(route.status, { 'content-type': route.contentType });`,
    `        res.end(route.kind === 'json' ? JSON.stringify(route.responseBody) : String(route.responseBody ?? ''));`,
    `      });`,
    `    });`,
    `    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));`,
    `    const addr = server.address();`,
    `    client = new ${className}({`,
    `      baseUrl: \`http://127.0.0.1:\${addr.port}\`,`,
    `      bearerToken: 'watay-test-token',`,
    `      basicAuth: { username: 'watay', password: 'secret' },`,
    `      apiKey: 'watay-api-key',`,
    `      maxRetries: 0,`,
    `    });`,
    `  });`,
    ``,
    `  after(async () => {`,
    `    server.closeAllConnections?.();`,
    `    await new Promise((resolve) => server.close(resolve));`,
    `  });`,
    ``,
    `  test('client instantiates cleanly', () => {`,
    `    assert.ok(client instanceof ${className});`,
    `  });`,
    ...(opCases.length ? ['', ...opCases] : []),
    ...(extraTests.length ? ['', ...extraTests] : []),
    `});`,
    ``,
  ].join('\n');
}

// ------------------------------------------------------------------ Python contract tests

function genPyContractTests(ir: WatayIR, packageName?: string): string {
  const pkgName = packageName ?? kebabCase(ir.title) + '-sdk';
  const modName = pyMod(pkgName);
  const className = clientClassName(ir.title);
  const { routes, byOpId } = buildRoutes(ir);

  const usedMethods = new Set<string>(['__init__', '_request', '_handle', 'close']);
  const testMethods: string[] = [];
  let firstErrorOp: { method: string; argsKw: string[] } | undefined;
  let firstInvalidOp: { method: string; argsKw: string[] } | undefined;

  for (const op of ir.operations) {
    const methodName = pyIdent(op.operationId, usedMethods);
    const usedParams = new Set<string>(['self', 'request_options']);
    const argsKw: string[] = [];
    for (const p of op.parameters) {
      const pName = pyIdent(p.name, usedParams);
      if (p.required || p.in === 'path') {
        argsKw.push(`${pName}=${pyLiteral(sampleParamValue(ir, p.schema))}`);
      }
    }
    if (op.requestBody) {
      const bName = usedParams.has('body') ? uniqueName('request_body', usedParams) : (usedParams.add('body'), 'body');
      const bKind = contentKind(op.requestBody.contentType);
      const bVal = bKind === 'text' ? 'sample text' : bKind === 'binary' ? 'sample-bytes' : exampleValue(ir, op.requestBody.schema);
      argsKw.push(`${bName}=${pyLiteral(bVal)}`);
    }

    const route = byOpId.get(op.operationId)!;
    if (!firstErrorOp) firstErrorOp = { method: methodName, argsKw };
    if (!firstInvalidOp && route.hasSchemaConstraint) firstInvalidOp = { method: methodName, argsKw };

    const testName = uniqueName('test_' + methodName, new Set(['test_client_instantiates', 'test_api_error_mapping', 'test_response_validation_error']));
    const callArgs = argsKw.join(', ');
    let assertion: string;
    if (route.kind === 'none') {
      assertion = `        self.assertIsNone(res)`;
    } else if (route.kind === 'json') {
      assertion = [
        `        actual = res.to_dict() if hasattr(res, "to_dict") else [x.to_dict() if hasattr(x, "to_dict") else x for x in res] if isinstance(res, list) else res`,
        `        self.assertEqual(actual, ${pyLiteral(route.responseBody)})`,
      ].join('\n');
    } else {
      assertion = `        self.assertIsNotNone(res)`;
    }
    testMethods.push(
      `    def ${testName}(self) -> None:\n` +
        `        res = self.client.${methodName}(${callArgs})\n` +
        assertion,
    );
  }

  const extraMethods: string[] = [];
  if (firstErrorOp) {
    const callArgs = [...firstErrorOp.argsKw, 'request_options=RequestOptions(headers={"x-watay-mock-mode": "error"})'].join(', ');
    extraMethods.push(
      `    def test_api_error_mapping(self) -> None:\n` +
        `        with self.assertRaises(ApiError) as ctx:\n` +
        `            self.client.${firstErrorOp.method}(${callArgs})\n` +
        `        self.assertEqual(ctx.exception.status, 500)`,
    );
  }
  if (firstInvalidOp) {
    const callArgs = [...firstInvalidOp.argsKw, 'request_options=RequestOptions(headers={"x-watay-mock-mode": "invalid"})'].join(', ');
    extraMethods.push(
      `    def test_response_validation_error(self) -> None:\n` +
        `        with self.assertRaises(ValidationError):\n` +
        `            self.client.${firstInvalidOp.method}(${callArgs})`,
    );
  }

  return [
    `# ${GENERATED_BANNER}`,
    `from __future__ import annotations`,
    ``,
    `from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer`,
    `import json`,
    `from pathlib import Path`,
    `import re`,
    `import sys`,
    `import threading`,
    `import unittest`,
    `from urllib.parse import urlparse`,
    ``,
    `ROOT = Path(__file__).resolve().parent.parent`,
    `if str(ROOT) not in sys.path:`,
    `    sys.path.insert(0, str(ROOT))`,
    ``,
    `from ${modName} import ${className}, ApiError, RequestOptions, ValidationError`,
    ``,
    `MOCK_ROUTES = ${pyLiteral(routes)}`,
    ``,
    ``,
    `class _MockHandler(BaseHTTPRequestHandler):`,
    `    def log_message(self, format: str, *args: object) -> None:`,
    `        return`,
    ``,
    `    def _dispatch(self, method: str) -> None:`,
    `        length = int(self.headers.get("content-length") or "0")`,
    `        if length > 0:`,
    `            self.rfile.read(length)`,
    `        mode = self.headers.get("x-watay-mock-mode")`,
    `        if mode == "error":`,
    `            payload = json.dumps({"error": "simulated server error"}).encode("utf-8")`,
    `            self.send_response(500)`,
    `            self.send_header("content-type", "application/json")`,
    `            self.send_header("content-length", str(len(payload)))`,
    `            self.end_headers()`,
    `            self.wfile.write(payload)`,
    `            return`,
    `        path = urlparse(self.path).path`,
    `        route = next((r for r in MOCK_ROUTES if r["method"] == method and re.match(r["regex"], path)), None)`,
    `        if route is None:`,
    `            payload = json.dumps({"error": "route not mocked", "method": method, "path": path}).encode("utf-8")`,
    `            self.send_response(404)`,
    `            self.send_header("content-type", "application/json")`,
    `            self.send_header("content-length", str(len(payload)))`,
    `            self.end_headers()`,
    `            self.wfile.write(payload)`,
    `            return`,
    `        if mode == "invalid" and route["hasSchemaConstraint"]:`,
    `            payload = json.dumps(route["invalidPayload"]).encode("utf-8")`,
    `            self.send_response(route["status"])`,
    `            self.send_header("content-type", "application/json")`,
    `            self.send_header("content-length", str(len(payload)))`,
    `            self.end_headers()`,
    `            self.wfile.write(payload)`,
    `            return`,
    `        if route["kind"] == "none":`,
    `            self.send_response(route["status"])`,
    `            self.end_headers()`,
    `            return`,
    `        body = json.dumps(route["responseBody"]).encode("utf-8") if route["kind"] == "json" else str(route["responseBody"] or "").encode("utf-8")`,
    `        self.send_response(route["status"])`,
    `        self.send_header("content-type", route["contentType"])`,
    `        self.send_header("content-length", str(len(body)))`,
    `        self.end_headers()`,
    `        if method != "HEAD":`,
    `            self.wfile.write(body)`,
    ``,
    `    def do_GET(self) -> None: self._dispatch("GET")`,
    `    def do_POST(self) -> None: self._dispatch("POST")`,
    `    def do_PUT(self) -> None: self._dispatch("PUT")`,
    `    def do_PATCH(self) -> None: self._dispatch("PATCH")`,
    `    def do_DELETE(self) -> None: self._dispatch("DELETE")`,
    `    def do_HEAD(self) -> None: self._dispatch("HEAD")`,
    `    def do_OPTIONS(self) -> None: self._dispatch("OPTIONS")`,
    ``,
    ``,
    `class ContractTests(unittest.TestCase):`,
    `    server: ThreadingHTTPServer`,
    `    thread: threading.Thread`,
    `    client: ${className}`,
    ``,
    `    @classmethod`,
    `    def setUpClass(cls) -> None:`,
    `        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _MockHandler)`,
    `        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)`,
    `        cls.thread.start()`,
    `        port = cls.server.server_address[1]`,
    `        cls.client = ${className}(`,
    `            base_url=f"http://127.0.0.1:{port}",`,
    `            bearer_token="watay-test-token",`,
    `            basic_auth=("watay", "secret"),`,
    `            api_key="watay-api-key",`,
    `            max_retries=0,`,
    `        )`,
    ``,
    `    @classmethod`,
    `    def tearDownClass(cls) -> None:`,
    `        cls.server.shutdown()`,
    `        cls.server.server_close()`,
    ``,
    `    def test_client_instantiates(self) -> None:`,
    `        self.assertIsInstance(self.client, ${className})`,
    ...(testMethods.length ? ['', ...testMethods] : []),
    ...(extraMethods.length ? ['', ...extraMethods] : []),
    ``,
    ``,
    `if __name__ == "__main__":`,
    `    unittest.main()`,
    ``,
  ].join('\n');
}

// ------------------------------------------------------------------ entry point

export function generateContractTests(ir: WatayIR, lang: Language, packageName?: string): Record<string, string> {
  if (lang === 'typescript') {
    return { 'tests/contract.test.ts': genTsContractTests(ir) };
  }
  return { 'tests/test_contract.py': genPyContractTests(ir, packageName) };
}
