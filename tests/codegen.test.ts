import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSpecFile } from '../src/core/parser.ts';
import { generateContractTests } from '../src/generators/contract-tests.ts';
import { generatePython } from '../src/generators/python.ts';
import { generateTypeScript } from '../src/generators/typescript.ts';
import { isSafeRelPath, selfHeal, verifyOutput } from '../src/healer/self-heal.ts';
import type { WatayIR } from '../src/types.ts';

const PETSTORE_V1 = new URL('../examples/petstore-v1.json', import.meta.url).pathname;
const PETSTORE_V2 = new URL('../examples/petstore-v2-breaking.json', import.meta.url).pathname;

function makeEdgeCaseIR(): WatayIR {
  return {
    title: 'Edge Case API',
    version: '2.1.0',
    description: 'Covers reserved keywords, circular refs, auth schemes, content types & collisions.',
    servers: ['https://edge.example.com/v2'],
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
      basicAuth: { type: 'http', scheme: 'basic' },
      apiKeyHeader: { type: 'apiKey', in: 'header', paramName: 'X-Api-Key' },
      apiKeyQuery: { type: 'apiKey', in: 'query', paramName: 'api_key' },
    },
    schemas: {
      class: {
        type: 'object',
        required: ['from', 'id'],
        properties: {
          from: { type: 'string', minLength: 1 },
          id: { type: 'integer', minimum: 1 },
          import: { type: 'boolean', nullable: true },
          'x-weird.key': { type: 'string' },
          user_id: { type: 'string' },
          'user-id': { type: 'string' },
        },
      },
      ExtendedItem: {
        allOf: [
          { ref: 'class' },
          {
            type: 'object',
            required: ['kind'],
            properties: {
              kind: { type: 'string', enum: ['alpha', 'beta'] },
            },
          },
        ],
      },
      StatusAlias: {
        type: 'string',
        enum: ['active', 'archived'],
      },
      Node: {
        type: 'object',
        required: ['label'],
        properties: {
          label: { type: 'string' },
          next: { ref: 'Node', nullable: true },
        },
      },
    },
    operations: [
      {
        operationId: 'delete',
        method: 'delete',
        path: '/items/{item-id}',
        parameters: [
          { name: 'item-id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'from', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '204': { description: 'Deleted' },
        },
        security: ['bearerAuth'],
      },
      {
        operationId: 'import',
        method: 'post',
        path: '/items/{item-id}',
        parameters: [
          { name: 'item-id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'X-Trace-ID', in: 'header', required: false, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          contentType: 'application/json',
          schema: { ref: 'class' },
        },
        responses: {
          '201': {
            description: 'Imported',
            contentType: 'application/json',
            schema: { ref: 'ExtendedItem' },
          },
        },
        security: ['apiKeyHeader', 'basicAuth'],
      },
      {
        operationId: 'submitForm',
        method: 'post',
        path: '/forms',
        parameters: [],
        requestBody: {
          required: true,
          contentType: 'application/x-www-form-urlencoded',
          schema: {
            type: 'object',
            required: ['field'],
            properties: { field: { type: 'string' } },
          },
        },
        responses: {
          '200': { description: 'OK', contentType: 'text/plain', schema: { type: 'string', example: 'accepted' } },
        },
        security: ['apiKeyQuery'],
      },
      {
        operationId: 'getNode',
        method: 'get',
        path: '/nodes/root',
        parameters: [],
        responses: {
          '200': {
            description: 'Node',
            contentType: 'application/json',
            schema: { ref: 'Node' },
          },
        },
      },
    ],
  };
}

describe('Watay Codegen: Determinism & Path Safety', () => {
  test('TypeScript & Python generation on petstore-v1 are byte-identical across runs', () => {
    const ir = loadSpecFile(PETSTORE_V1);

    const ts1 = generateTypeScript(ir, { withContractTests: true });
    const ts2 = generateTypeScript(ir, { withContractTests: true });
    assert.deepEqual(ts1, ts2);
    assert.equal(Object.keys(ts1.files).length > 5, true);

    const py1 = generatePython(ir, { withContractTests: true });
    const py2 = generatePython(ir, { withContractTests: true });
    assert.deepEqual(py1, py2);
    assert.equal(Object.keys(py1.files).length > 5, true);

    assert.ok(ts1.files['README.md']?.includes('⚡ Generated autonomously by [Watay](https://watay.dev)'));
    assert.ok(py1.files['README.md']?.includes('⚡ Generated autonomously by [Watay](https://watay.dev)'));
    assert.equal(ts1.files['README.md']?.includes('{ /*  */ }'), false);
  });

  test('all generated file paths are safe relative POSIX paths', () => {
    const ir = loadSpecFile(PETSTORE_V1);
    const ts = generateTypeScript(ir, { withContractTests: true });
    const py = generatePython(ir, { withContractTests: true });

    for (const k of [...Object.keys(ts.files), ...Object.keys(py.files)]) {
      assert.equal(isSafeRelPath(k), true, `Unsafe generated path: ${k}`);
    }
  });

  test('generateContractTests produces deterministic standalone test files', () => {
    const ir = loadSpecFile(PETSTORE_V1);
    const tsTests = generateContractTests(ir, 'typescript');
    const pyTests = generateContractTests(ir, 'python');
    assert.ok(tsTests['tests/contract.test.ts']?.includes('node:test'));
    assert.ok(pyTests['tests/test_contract.py']?.includes('unittest'));
  });
});

describe('Watay Codegen: End-to-End Verification & Contract Tests', () => {
  test('TypeScript SDK for petstore-v1 passes syntax + contract tests via verifyOutput', async () => {
    const ir = loadSpecFile(PETSTORE_V1);
    const out = generateTypeScript(ir, { withContractTests: true });
    const report = await verifyOutput(out);

    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.equal(report.checks.find((c) => c.name === 'ts-syntax')?.status, 'passed');
    assert.equal(report.checks.find((c) => c.name === 'ts-contract-tests')?.status, 'passed');
    assert.equal(report.issues.length, 0);
  });

  test('Python SDK for petstore-v1 passes py_compile + unittest contract tests via verifyOutput', async () => {
    const ir = loadSpecFile(PETSTORE_V1);
    const out = generatePython(ir, { withContractTests: true });
    const report = await verifyOutput(out);

    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.equal(report.checks.find((c) => c.name === 'python-syntax')?.status, 'passed');
    assert.equal(report.checks.find((c) => c.name === 'python-contract-tests')?.status, 'passed');
    assert.equal(report.issues.length, 0);
  });

  test('TypeScript & Python SDKs for petstore-v2-breaking pass full contract verification', async () => {
    const ir = loadSpecFile(PETSTORE_V2);
    const tsReport = await verifyOutput(generateTypeScript(ir, { withContractTests: true }));
    const pyReport = await verifyOutput(generatePython(ir, { withContractTests: true }));

    assert.equal(tsReport.ok, true, JSON.stringify(tsReport, null, 2));
    assert.equal(pyReport.ok, true, JSON.stringify(pyReport, null, 2));
  });

  test('Smoke import check passes when withContractTests is omitted', async () => {
    const ir = loadSpecFile(PETSTORE_V1);
    const tsReport = await verifyOutput(generateTypeScript(ir, { withContractTests: false }));
    const pyReport = await verifyOutput(generatePython(ir, { withContractTests: false }));

    assert.equal(tsReport.ok, true, JSON.stringify(tsReport, null, 2));
    assert.equal(tsReport.checks.find((c) => c.name === 'ts-import-smoke')?.status, 'passed');
    assert.equal(pyReport.ok, true, JSON.stringify(pyReport, null, 2));
    assert.equal(pyReport.checks.find((c) => c.name === 'python-import-smoke')?.status, 'passed');
  });
});

describe('Watay Codegen: Identifier Hygiene, Auth, Retries & Wire Mapping', () => {
  test('Edge-case IR with reserved keywords, circular refs & mixed content types passes TS & Python verification', async () => {
    const ir = makeEdgeCaseIR();
    const tsOut = generateTypeScript(ir, { withContractTests: true });
    const pyOut = generatePython(ir, { withContractTests: true });

    const tsReport = await verifyOutput(tsOut);
    const pyReport = await verifyOutput(pyOut);
    assert.equal(tsReport.ok, true, JSON.stringify(tsReport, null, 2));
    assert.equal(pyReport.ok, true, JSON.stringify(pyReport, null, 2));

    // Python wire-name mapping preserves `"from"` <-> `from_`
    const modelsPy = pyOut.files['edge_case_api_sdk/models.py']!;
    assert.ok(modelsPy.includes('from_: str'), 'Python model should escape "from" as "from_"');
    assert.ok(modelsPy.includes('"from": "from_"'), 'Python model should map wire key "from"');
    // Colliding normalized identifiers (`user_id` and `user-id`) are deduplicated
    assert.ok(modelsPy.includes('user_id2'), 'Colliding Python field names should be disambiguated');
  });

  test('Generated TS client validates requests, injects auth, and retries idempotent 503s', async () => {
    const ir = makeEdgeCaseIR();
    const out = generateTypeScript(ir, { withContractTests: false });
    const dir = mkdtempSync(join(tmpdir(), 'watay-ts-rt-'));
    try {
      for (const [rel, content] of Object.entries(out.files)) {
        const p = join(dir, rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content, 'utf8');
      }
      const mod = await import(pathToFileURL(join(dir, 'src/index.ts')).href);
      const { EdgeCaseApiClient, ValidationError, ApiError } = mod;

      let calls = 0;
      const seenHeaders: Array<Record<string, string>> = [];
      const seenUrls: string[] = [];

      const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
        calls++;
        seenUrls.push(url);
        const h: Record<string, string> = {};
        if (init?.headers instanceof Headers) {
          init.headers.forEach((v, k) => {
            h[k] = v;
          });
        }
        seenHeaders.push(h);

        if (url.includes('/nodes/root') && calls === 1) {
          return new Response('temporary overload', { status: 503, statusText: 'Service Unavailable' });
        }
        if (url.includes('/nodes/root')) {
          return new Response(JSON.stringify({ label: 'root', next: null }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/items/')) {
          return new Response(JSON.stringify({ from: 'alice', id: 7, kind: 'alpha' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/forms')) {
          return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
        }
        return new Response(JSON.stringify({ error: 'nope' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      };

      const client = new EdgeCaseApiClient({
        baseUrl: 'https://mock.watay.dev',
        fetch: fakeFetch,
        bearerToken: 'tok-123',
        basicAuth: { username: 'u', password: 'p' },
        apiKey: { apiKeyHeader: 'k-hdr', apiKeyQuery: 'k-qry' },
        maxRetries: 2,
        retryDelayMs: 1,
      });

      // 1. GET retries once on 503 and succeeds
      const node = await client.getNode();
      assert.deepEqual(node, { label: 'root', next: null });
      assert.equal(calls, 2);

      // 2. Request validation catches missing required body field BEFORE calling fetch
      const callsBeforeBad = calls;
      await assert.rejects(
        () => client.import({ 'item-id': 'abc', body: { from: '', id: 0 } }),
        (err: unknown) => err instanceof ValidationError,
      );
      assert.equal(calls, callsBeforeBad, 'ValidationError should short-circuit before network call');

      // 3. Valid POST sends apiKey header and succeeds
      const imported = await client.import({ 'item-id': 'abc', body: { from: 'alice', id: 7 } });
      assert.equal(imported.kind, 'alpha');
      assert.equal(seenHeaders.at(-1)?.['x-api-key'], 'k-hdr');

      // 4. Query apiKey + form-urlencoded body works
      const formRes = await client.submitForm({ body: { field: 'hello' } });
      assert.equal(formRes, 'ok');
      assert.ok(seenUrls.at(-1)?.includes('api_key=k-qry'));

      // 5. Non-2xx maps to ApiError when server returns 404
      const errClient = new EdgeCaseApiClient({
        baseUrl: 'https://mock.watay.dev',
        fetch: async () =>
          new Response(JSON.stringify({ code: 404, message: 'missing' }), {
            status: 404,
            statusText: 'Not Found',
            headers: { 'content-type': 'application/json' },
          }),
        maxRetries: 0,
      });
      await assert.rejects(
        () => errClient.getNode(),
        (err: unknown) => err instanceof ApiError && err.status === 404 && (err.body as { code: number }).code === 404,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Watay Healer: Self-Healing Verification Loop', () => {
  test('Clean SDK returns iterations: 0 and healed: false', async () => {
    const ir = loadSpecFile(PETSTORE_V1);
    const out = generateTypeScript(ir, { withContractTests: true });
    const res = await selfHeal(out);
    assert.equal(res.report.ok, true);
    assert.equal(res.iterations, 0);
    assert.equal(res.healed, false);
  });

  test('Deterministic repair fixes missing .ts extension and trailing JSON comma without LLM hook', async () => {
    const ir = loadSpecFile(PETSTORE_V1);
    const out = generateTypeScript(ir, { withContractTests: false });
    // Break package.json with trailing comma and client.ts with extensionless relative import
    out.files['package.json'] = out.files['package.json']!.replace(/\n\}\s*$/, ',\n}\n');
    out.files['src/client.ts'] = out.files['src/client.ts']!.replace("'./runtime.ts'", "'./runtime'");

    const brokenReport = await verifyOutput(out);
    assert.equal(brokenReport.ok, false);

    const res = await selfHeal(out);
    assert.equal(res.healed, true, JSON.stringify(res.report, null, 2));
    assert.equal(res.report.ok, true);
    assert.equal(res.iterations, 1);
  });

  test('Syntax-broken TS SDK without repair hook returns honest failed report', async () => {
    const ir = loadSpecFile(PETSTORE_V1);
    const out = generateTypeScript(ir, { withContractTests: false });
    const original = out.files['src/client.ts']!;
    out.files['src/client.ts'] = original + '\nexport const brokenSyntax: number = ;\n';

    const res = await selfHeal(out);
    assert.equal(res.healed, false);
    assert.equal(res.report.ok, false);
    assert.ok(res.report.issues.some((i) => i.file === 'src/client.ts'));
  });

  test('Syntax-broken TS SDK with BYOK repair hook is healed and re-verified', async () => {
    const ir = loadSpecFile(PETSTORE_V1);
    const out = generateTypeScript(ir, { withContractTests: true });
    const original = out.files['src/client.ts']!;
    out.files['src/client.ts'] = original + '\nexport const brokenSyntax: number = ;\n';

    let receivedFiles: string[] = [];
    let receivedIssues = 0;

    const res = await selfHeal(out, {
      maxIterations: 3,
      repair: async (files, issues) => {
        receivedFiles = Object.keys(files);
        receivedIssues = issues.length;
        // Also attempt an unsafe traversal patch that must be ignored by selfHeal
        return {
          'src/client.ts': original,
          '../escape.ts': 'evil',
          'src/unauthorized-new.ts': 'evil',
        };
      },
    });

    assert.deepEqual(receivedFiles, ['src/client.ts']);
    assert.ok(receivedIssues > 0);
    assert.equal(res.healed, true);
    assert.equal(res.report.ok, true);
    assert.equal(res.iterations, 1);
    assert.equal(res.output.files['../escape.ts'], undefined);
    assert.equal(res.output.files['src/unauthorized-new.ts'], undefined);
  });

  test('Syntax-broken Python SDK with BYOK repair hook is healed and re-verified', async () => {
    const ir = loadSpecFile(PETSTORE_V1);
    const out = generatePython(ir, { withContractTests: true });
    const clientPath = Object.keys(out.files).find((k) => k.endsWith('/client.py'))!;
    const original = out.files[clientPath]!;
    out.files[clientPath] = original + '\ndef broken_syntax(:\n    pass\n';

    const withoutHook = await selfHeal(out);
    assert.equal(withoutHook.healed, false);
    assert.equal(withoutHook.report.ok, false);
    assert.ok(withoutHook.report.issues.some((i) => i.file === clientPath));

    const withHook = await selfHeal(out, {
      repair: async () => ({ [clientPath]: original }),
    });
    assert.equal(withHook.healed, true);
    assert.equal(withHook.report.ok, true);
    assert.equal(withHook.iterations, 1);
  });

  test('verifyOutput rejects unsafe path traversal keys', async () => {
    const report = await verifyOutput({
      language: 'typescript',
      files: { '../outside.ts': 'export const x = 1;' },
    });
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((c) => c.name === 'path-safety')?.status, 'failed');
  });
});
