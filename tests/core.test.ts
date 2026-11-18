import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseLanguages, runCli, writeGeneratedFiles } from '../src/cli/index.ts';
import { diffSpecs } from '../src/core/differ.ts';
import { loadSpecFile, parseSpec } from '../src/core/parser.ts';
import { WatayError } from '../src/errors.ts';

const EXAMPLES = new URL('../examples/', import.meta.url);
const V1_PATH = new URL('petstore-v1.json', EXAMPLES).pathname;
const V2_PATH = new URL('petstore-v2-breaking.json', EXAMPLES).pathname;
const CLI_PATH = new URL('../src/cli/index.ts', import.meta.url).pathname;

function makeSpec(paths: Record<string, unknown>, schemas: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'TestAPI', version: '1.0.0' },
    paths,
    components: { schemas },
    ...extra,
  });
}

describe('Watay OpenAPI Parser', () => {
  it('parses petstore-v1.json deterministically with $refs and securitySchemes', () => {
    const ir = loadSpecFile(V1_PATH);
    assert.equal(ir.title, 'Petstore');
    assert.equal(ir.version, '1.0.0');
    assert.deepEqual(ir.servers, ['https://api.petstore.example/v1']);
    assert.ok(ir.securitySchemes?.bearerAuth);
    assert.equal(ir.securitySchemes?.bearerAuth.type, 'http');
    assert.equal(ir.securitySchemes?.bearerAuth.scheme, 'bearer');
    assert.deepEqual(
      ir.operations.map((o) => `${o.method.toUpperCase()} ${o.path}`),
      [
        'GET /owners/{ownerId}',
        'GET /pets',
        'POST /pets',
        'GET /pets/{petId}',
        'DELETE /pets/{petId}',
      ],
    );
    const getPet = ir.operations.find((o) => o.operationId === 'getPet')!;
    assert.equal(getPet.parameters[0].name, 'petId');
    assert.equal(getPet.parameters[0].required, true);
    assert.equal(getPet.responses['200']?.schema?.ref, 'Pet');
  });

  it('parses OpenAPI 3.1 YAML specs including nullable array types, const, example, flow and block scalars', () => {
    const yaml = `
openapi: "3.1.0"
info:
  title: YamlApi
  version: 1.2.3
  description: |
    Line one
    Line two
servers:
  - url: https://example.test/api
components:
  securitySchemes:
    apiKeyAuth:
      type: apiKey
      in: header
      name: X-API-Key
  schemas:
    Item:
      type: object
      required: [id, kind]
      properties:
        id:
          type: integer
          example: 42
        kind:
          const: "widget"
        note:
          type: ["string", "null"]
paths:
  /items/{item_id}:
    parameters:
      - name: item_id
        in: path
        required: true
        schema: { type: string }
    get:
      security:
        - apiKeyAuth: []
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Item"
`;
    const ir = parseSpec(yaml, 'yaml');
    assert.equal(ir.title, 'YamlApi');
    assert.equal(ir.version, '1.2.3');
    assert.match(ir.description ?? '', /Line one\nLine two/);
    assert.equal(ir.securitySchemes?.apiKeyAuth?.paramName, 'X-API-Key');
    assert.equal(ir.schemas.Item.properties?.id.example, 42);
    assert.equal(ir.schemas.Item.properties?.kind.const, 'widget');
    assert.equal(ir.schemas.Item.properties?.note.type, 'string');
    assert.equal(ir.schemas.Item.properties?.note.nullable, true);
    assert.equal(ir.operations.length, 1);
    assert.equal(ir.operations[0].operationId, 'getItemsByItemId');
    assert.deepEqual(ir.operations[0].security, ['apiKeyAuth']);
  });

  it('merges path-level and operation-level parameters (operation wins) and synthesizes unique operationIds', () => {
    const ir = parseSpec(
      makeSpec({
        '/users/{id}': {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          get: {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
            responses: { '200': { description: 'ok' } },
          },
        },
        '/users_by_id': {
          get: { operationId: 'getUsersById', responses: { '200': { description: 'ok' } } },
        },
      }),
    );
    const ids = ir.operations.map((o) => o.operationId).sort();
    assert.equal(new Set(ids).size, 2);
    const getByPath = ir.operations.find((o) => o.path === '/users/{id}')!;
    assert.equal(getByPath.parameters[0].schema.type, 'integer');
  });

  it('rejects unresolved $ref, Swagger 2.0, and missing info.title with WatayError', () => {
    assert.throws(
      () => parseSpec(makeSpec({ '/x': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Missing' } } } } } } } })),
      (e: unknown) => e instanceof WatayError && e.code === 'REF_UNRESOLVED',
    );
    assert.throws(
      () => parseSpec(JSON.stringify({ swagger: '2.0', info: { title: 'Old', version: '1' }, paths: {} })),
      (e: unknown) => e instanceof WatayError && e.code === 'SPEC_UNSUPPORTED',
    );
    assert.throws(
      () => parseSpec(JSON.stringify({ openapi: '3.0.3', info: {}, paths: {} })),
      (e: unknown) => e instanceof WatayError && e.code === 'SPEC_INVALID',
    );
  });
});

describe('Watay Contract Differ', () => {
  it('returns zero changes and patch bump for identical specs', () => {
    const v1 = loadSpecFile(V1_PATH);
    const res = diffSpecs(v1, v1);
    assert.equal(res.hasBreaking, false);
    assert.equal(res.breaking.length, 0);
    assert.equal(res.nonBreaking.length, 0);
    assert.equal(res.suggestedBump, 'patch');
    assert.match(res.markdown, /No API changes detected/);
  });

  it('detects breaking and non-breaking changes between petstore-v1 and petstore-v2-breaking (including recursive schemas)', () => {
    const v1 = loadSpecFile(V1_PATH);
    const v2 = loadSpecFile(V2_PATH);
    const res = diffSpecs(v1, v2);
    assert.equal(res.hasBreaking, true);
    assert.equal(res.suggestedBump, 'major');

    const bCodes = new Set(res.breaking.map((c) => c.code));
    const nbCodes = new Set(res.nonBreaking.map((c) => c.code));
    const iCodes = new Set(res.info.map((c) => c.code));

    for (const expected of [
      'operation-removed',
      'required-param-added',
      'request-type-changed',
      'request-max-length-tightened',
      'request-enum-value-removed',
      'request-required-property-added',
      'success-response-removed',
      'response-property-removed',
      'response-type-changed',
      'response-became-nullable',
      'security-requirement-added',
    ]) {
      assert.ok(bCodes.has(expected), `expected breaking code ${expected}, got ${[...bCodes].join(', ')}`);
    }
    for (const expected of [
      'operation-added',
      'optional-param-added',
      'response-added',
      'response-property-added',
      'response-enum-value-added',
    ]) {
      assert.ok(nbCodes.has(expected), `expected non-breaking code ${expected}, got ${[...nbCodes].join(', ')}`);
    }
    assert.ok(iCodes.has('operation-deprecated'));
    const enumAdd = res.nonBreaking.find((c) => c.code === 'response-enum-value-added')!;
    assert.match(enumAdd.message, /exhaustive switch/);
  });

  it('enforces directionality (contravariant request vs covariant response)', () => {
    const baseOp = (reqSchema: unknown, resSchema: unknown) =>
      makeSpec({
        '/items': {
          post: {
            operationId: 'postItem',
            requestBody: { required: true, content: { 'application/json': { schema: reqSchema } } },
            responses: {
              '200': { description: 'ok', content: { 'application/json': { schema: resSchema } } },
            },
          },
        },
      });

    // integer -> number: request widened (non-breaking), response widened (breaking)
    const r1 = diffSpecs(
      parseSpec(baseOp({ type: 'object', properties: { n: { type: 'integer' } } }, { type: 'object', properties: { n: { type: 'integer' } } })),
      parseSpec(baseOp({ type: 'object', properties: { n: { type: 'number' } } }, { type: 'object', properties: { n: { type: 'number' } } })),
    );
    assert.ok(r1.nonBreaking.some((c) => c.code === 'request-type-widened'));
    assert.ok(r1.breaking.some((c) => c.code === 'response-type-widened'));

    // optional -> required property: request breaking, response non-breaking
    const r2 = diffSpecs(
      parseSpec(baseOp({ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { a: { type: 'string' } } })),
      parseSpec(
        baseOp(
          { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
          { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
        ),
      ),
    );
    assert.ok(r2.breaking.some((c) => c.code === 'request-property-became-required'));
    assert.ok(r2.nonBreaking.some((c) => c.code === 'response-property-became-required'));

    // required -> optional property: request non-breaking, response breaking
    const r3 = diffSpecs(
      parseSpec(
        baseOp(
          { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
          { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
        ),
      ),
      parseSpec(baseOp({ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { a: { type: 'string' } } })),
    );
    assert.ok(r3.nonBreaking.some((c) => c.code === 'request-property-became-optional'));
    assert.ok(r3.breaking.some((c) => c.code === 'response-property-became-optional'));
  });

  it('handles allOf composition, path param renames vs removals, and operationId renames', () => {
    const oldIr = parseSpec(
      makeSpec(
        {
          '/orders/{orderId}': {
            get: {
              operationId: 'getOrder',
              parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }],
              responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } },
            },
          },
        },
        {
          Base: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
          Order: { allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { total: { type: 'number' } } }] },
        },
      ),
    );
    const newIr = parseSpec(
      makeSpec(
        {
          '/orders/{id}': {
            get: {
              operationId: 'fetchOrder',
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } },
            },
          },
        },
        {
          Order: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, total: { type: 'number' } } },
        },
      ),
    );
    const res = diffSpecs(oldIr, newIr);
    assert.ok(res.info.some((c) => c.code === 'path-param-renamed'));
    assert.ok(res.breaking.some((c) => c.code === 'operation-id-changed'));
    // Flattened allOf Base+Order matches inline Order cleanly (no spurious property diffs)
    assert.equal(res.breaking.filter((c) => c.code.startsWith('response-')).length, 0);
  });
});

describe('Watay CLI & Path Security', () => {
  it('blocks path traversal and absolute paths in writeGeneratedFiles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watay-path-test-'));
    try {
      for (const bad of ['../escape.txt', 'sub/../../escape.txt', '/etc/passwd', 'a\\b.ts', 'C:drive.ts', 'a//b.ts', './a.ts', '']) {
        assert.throws(
          () => writeGeneratedFiles(dir, { [bad]: 'bad' }),
          (e: unknown) => e instanceof WatayError && e.code === 'PATH_TRAVERSAL',
          `expected PATH_TRAVERSAL for "${bad}"`,
        );
      }
      const written = writeGeneratedFiles(dir, { 'src/client.ts': 'export const ok = 1;\n' });
      assert.equal(written.length, 1);
      assert.equal(readFileSync(join(dir, 'src/client.ts'), 'utf8'), 'export const ok = 1;\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes and validates target languages', () => {
    assert.deepEqual(parseLanguages('ts,python,ts'), ['typescript', 'python']);
    assert.deepEqual(parseLanguages('py'), ['python']);
    assert.throws(
      () => parseLanguages('rust'),
      (e: unknown) => e instanceof WatayError && e.code === 'INVALID_LANGUAGE',
    );
  });

  it('runs watay diff via CLI subprocess with exit code 1 on --fail-on-breaking and 0 when clean', () => {
    const breakingRun = spawnSync(process.execPath, [CLI_PATH, 'diff', V1_PATH, V2_PATH, '--fail-on-breaking'], {
      encoding: 'utf8',
    });
    assert.equal(breakingRun.status, 1);
    assert.match(breakingRun.stdout, /Watay Breaking-Change Report/);
    assert.match(breakingRun.stdout, /Breaking changes/);

    const cleanRun = spawnSync(process.execPath, [CLI_PATH, 'diff', '--old', V1_PATH, '--new', V1_PATH, '--fail-on-breaking'], {
      encoding: 'utf8',
    });
    assert.equal(cleanRun.status, 0);
    assert.match(cleanRun.stdout, /No API changes detected/);

    const jsonOut = execFileSync(process.execPath, [CLI_PATH, 'diff', V1_PATH, V2_PATH, '--json'], { encoding: 'utf8' });
    const parsed = JSON.parse(jsonOut) as { hasBreaking: boolean; suggestedBump: string };
    assert.equal(parsed.hasBreaking, true);
    assert.equal(parsed.suggestedBump, 'major');

    const badFileRun = spawnSync(process.execPath, [CLI_PATH, 'diff', '/nonexistent/spec.json', V2_PATH], {
      encoding: 'utf8',
    });
    assert.equal(badFileRun.status, 2);
  });

  it('runs watay license and masks secret key in text output', async () => {
    const res = spawnSync(process.execPath, [CLI_PATH, 'license', '--key', 'WATAY-DEMO-PRO'], { encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /tier: pro/);
    assert.doesNotMatch(res.stdout, /WATAY-DEMO-PRO/);
    assert.match(res.stdout, /WATAY\*\*\*\*-PRO/);

    const code = await runCli(['--version']);
    assert.equal(code, 0);
    assert.ok(existsSync(CLI_PATH));
  });

  it('runs watay generate and watay verify deterministically', () => {
    const out1 = mkdtempSync(join(tmpdir(), 'watay-gen1-'));
    const out2 = mkdtempSync(join(tmpdir(), 'watay-gen2-'));
    try {
      const g1 = spawnSync(process.execPath, [CLI_PATH, 'generate', V1_PATH, '--lang', 'ts,python', '--out', out1], { encoding: 'utf8' });
      assert.equal(g1.status, 0, g1.stderr);
      assert.ok(existsSync(join(out1, 'typescript', 'src', 'client.ts')));
      assert.ok(existsSync(join(out1, 'python', 'petstore_sdk', 'client.py')));

      const g2 = spawnSync(process.execPath, [CLI_PATH, 'generate', V1_PATH, '--lang', 'ts,python', '--out', out2], { encoding: 'utf8' });
      assert.equal(g2.status, 0, g2.stderr);
      assert.equal(
        readFileSync(join(out1, 'typescript', 'src', 'client.ts'), 'utf8'),
        readFileSync(join(out2, 'typescript', 'src', 'client.ts'), 'utf8'),
      );
      assert.equal(
        readFileSync(join(out1, 'python', 'petstore_sdk', 'client.py'), 'utf8'),
        readFileSync(join(out2, 'python', 'petstore_sdk', 'client.py'), 'utf8'),
      );

      const v = spawnSync(process.execPath, [CLI_PATH, 'verify', V1_PATH, '--lang', 'ts,python', '--json'], { encoding: 'utf8' });
      assert.equal(v.status, 0, v.stderr);
      const vJson = JSON.parse(v.stdout) as { specValid: boolean; ok: boolean };
      assert.equal(vJson.specValid, true);
      assert.equal(vJson.ok, true);
    } finally {
      rmSync(out1, { recursive: true, force: true });
      rmSync(out2, { recursive: true, force: true });
    }
  });
});
