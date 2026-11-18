import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkLicense, tierAllows, maskKey, formatLicenseBanner } from '../src/action/license.ts';
import {
  parseActionConfig,
  executeAction,
  runAction,
  normalizeLanguages,
  isSafeRelPath,
} from '../src/action/runner.ts';

test('checkLicense - Free Tier default', async () => {
  const result = await checkLicense(undefined, {});
  assert.equal(result.tier, 'free');
  assert.equal(result.valid, true);
  assert.equal(result.source, 'none');
  assert.ok(result.features?.includes('diff'));
  assert.ok(result.features?.includes('generate:typescript'));
  assert.ok(!result.features?.includes('pr-comment'));
});

test('checkLicense - Offline Pro Demo Key (WATAY-DEMO-PRO)', async () => {
  const result = await checkLicense('WATAY-DEMO-PRO', {});
  assert.equal(result.tier, 'pro');
  assert.equal(result.valid, true);
  assert.equal(result.source, 'offline-demo');
  assert.ok(result.features?.includes('pr-comment'));
  assert.ok(result.features?.includes('contract-guard'));
  assert.ok(result.features?.includes('self-heal'));
});

test('checkLicense - Offline Scale Demo Key', async () => {
  const result = await checkLicense('WATAY-DEMO-SCALE', {});
  assert.equal(result.tier, 'scale');
  assert.equal(result.valid, true);
  assert.equal(result.source, 'offline-demo');
  assert.ok(result.features?.includes('custom-templates'));
  assert.ok(result.features?.includes('multi-tenant'));
});

test('checkLicense - Arbitrary strings with pro/scale substrings do NOT bypass license', async () => {
  const p1 = await checkLicense('my-arbitrary-pro-secret', {});
  assert.equal(p1.tier, 'free');

  const p2 = await checkLicense('my-scale-bypass-test', {});
  assert.equal(p2.tier, 'free');
});

test('checkLicense - Explicit Invalid Key', async () => {
  const result = await checkLicense('INVALID-KEY-12345', {});
  assert.equal(result.valid, false);
  assert.equal(result.tier, 'free');
  assert.equal(result.source, 'offline-demo');
});

test('tierAllows - Feature permissions', () => {
  // Free
  assert.equal(tierAllows('free', 'diff'), true);
  assert.equal(tierAllows('free', 'generate:typescript'), true);
  assert.equal(tierAllows('free', 'pr-comment'), false);
  assert.equal(tierAllows('free', 'self-heal'), false);
  assert.equal(tierAllows('free', 'custom-templates'), false);

  // Pro
  assert.equal(tierAllows('pro', 'diff'), true);
  assert.equal(tierAllows('pro', 'pr-comment'), true);
  assert.equal(tierAllows('pro', 'contract-guard'), true);
  assert.equal(tierAllows('pro', 'self-heal'), true);
  assert.equal(tierAllows('pro', 'custom-templates'), false);

  // Scale
  assert.equal(tierAllows('scale', 'diff'), true);
  assert.equal(tierAllows('scale', 'pr-comment'), true);
  assert.equal(tierAllows('scale', 'custom-templates'), true);
  assert.equal(tierAllows('scale', 'multi-tenant'), true);
});

test('maskKey - Zero-Data-Retention security', () => {
  assert.equal(maskKey(''), '');
  assert.equal(maskKey('short'), '****');
  assert.equal(maskKey('WATAY-DEMO-PRO'), 'WATA-****--PRO');
  assert.equal(maskKey('polar_lkey_9876543210fedcba'), 'pola-****-dcba');
});

test('normalizeLanguages - normalizes aliases', () => {
  assert.deepEqual(normalizeLanguages('ts,python'), ['typescript', 'python']);
  assert.deepEqual(normalizeLanguages('py,ts'), ['python', 'typescript']);
  assert.deepEqual(normalizeLanguages('typescript'), ['typescript']);
});

test('isSafeRelPath - blocks path traversal', () => {
  assert.equal(isSafeRelPath('src/client.ts'), true);
  assert.equal(isSafeRelPath('models/user.ts'), true);
  assert.equal(isSafeRelPath('../evil.ts'), false);
  assert.equal(isSafeRelPath('foo/../../bar.ts'), false);
  assert.equal(isSafeRelPath('/absolute/path.ts'), false);
  assert.equal(isSafeRelPath(''), false);
});

test('formatLicenseBanner - Generates informative string', async () => {
  const free = await checkLicense(undefined, {});
  const banner = formatLicenseBanner(free);
  assert.ok(banner.includes('FREE'));
  assert.ok(banner.includes('Features:'));
});

test('parseActionConfig - Default values and overrides', () => {
  const configDefault = parseActionConfig({});
  assert.equal(configDefault.specPath, 'openapi.json');
  assert.equal(configDefault.failOnBreaking, true);
  assert.equal(configDefault.postComment, true);
  assert.deepEqual(configDefault.languages, ['typescript', 'python']);

  const configOverride = parseActionConfig({
    INPUT_SPEC_PATH: 'my-spec.yaml',
    INPUT_FAIL_ON_BREAKING: 'false',
    INPUT_LANGUAGES: 'ts,python',
    INPUT_OUTPUT_DIR: './custom-sdks',
    INPUT_LICENSE_KEY: 'WATAY-DEMO-PRO',
    WATAY_DRY_RUN: '1',
  });
  assert.equal(configOverride.specPath, 'my-spec.yaml');
  assert.equal(configOverride.failOnBreaking, false);
  assert.deepEqual(configOverride.languages, ['typescript', 'python']);
  assert.equal(configOverride.outputDir, './custom-sdks');
  assert.equal(configOverride.licenseKey, 'WATAY-DEMO-PRO');
  assert.equal(configOverride.dryRun, true);
});

test('executeAction - Missing spec returns exitCode 2', async () => {
  const result = await executeAction({
    INPUT_SPEC_PATH: 'nonexistent-path-12345.json',
  });
  assert.equal(result.exitCode, 2);
  assert.ok(result.markdownReport.includes('Spec file not found'));
});

test('executeAction - Invalid spec returns exitCode 2', async (t) => {
  const tmpDir = path.join(process.cwd(), 'tmp-test-invalid');
  fs.mkdirSync(tmpDir, { recursive: true });
  t.after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const invalidSpec = path.join(tmpDir, 'invalid.json');
  fs.writeFileSync(invalidSpec, 'NOT_VALID_JSON', 'utf8');

  const result = await executeAction({
    INPUT_SPEC_PATH: invalidSpec,
  });
  assert.equal(result.exitCode, 2);
  assert.ok(result.markdownReport.includes('Invalid OpenAPI specification'));
});

test('executeAction - Clean run with mock spec', async (t) => {
  const tmpDir = path.join(process.cwd(), 'tmp-test-action-clean');
  fs.mkdirSync(tmpDir, { recursive: true });
  t.after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const specPath = path.join(tmpDir, 'test-spec.json');
  fs.writeFileSync(
    specPath,
    JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Test PetStore API', version: '1.0.0' },
      paths: {
        '/pets': {
          get: {
            operationId: 'listPets',
            responses: {
              '200': { description: 'Success' },
            },
          },
        },
      },
    }),
    'utf8'
  );

  const result = await executeAction({
    INPUT_SPEC_PATH: specPath,
    INPUT_LANGUAGES: 'ts,python',
    INPUT_OUTPUT_DIR: path.join(tmpDir, 'sdks'),
    INPUT_LICENSE_KEY: 'WATAY-DEMO-PRO',
    WATAY_DRY_RUN: '1',
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.license.tier, 'pro');
  assert.ok(result.markdownReport.includes('Watay Contract Guard & SDK Report'));
  assert.ok(result.markdownReport.includes('Test PetStore API'));
});
