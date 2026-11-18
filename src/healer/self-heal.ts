/**
 * Watay – Self-Healing Verification & Repair Engine (owner: dev-codegen).
 *
 * Implements the tiered verifier + repair loop from ARCHITECTURE.md §3 & hybrid-ast-self-healing.md:
 *   1. Path-safety guard (relative POSIX paths only, no traversal)
 *   2. Config & Syntax checks (TS: erasable-TS strip + `node --check`; Python: `py_compile` + `tomllib`)
 *   3. Optional static typecheck (`tsc` / `mypy` via feature-detect; `skipped` when absent)
 *   4. Behavioral verification (runs generated contract tests against embedded mock server, or import smoke check)
 *   5. Deterministic repairs (missing `.ts` import extensions, JSON trailing commas, missing Python `__future__`/`__init__.py`)
 *   6. Optional BYOK repair hook (`HealOptions.repair`), strictly scoped to safe paths, re-verified every iteration.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type {
  GeneratorOutput,
  HealOptions,
  HealResult,
  VerifyIssue,
  VerifyReport,
} from '../types.ts';

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 30_000;

interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
  notFound?: boolean;
}

async function runCmd(cmd: string, args: string[], cwd: string): Promise<CmdResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    if (e.code === 'ENOENT') {
      return { code: 127, stdout: '', stderr: e.message ?? 'command not found', notFound: true };
    }
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: (e.stderr ?? '') || (e.message ?? ''),
    };
  }
}

// ------------------------------------------------------------------ path safety

export function isSafeRelPath(relPath: string): boolean {
  if (!relPath || relPath.includes('\0') || relPath.includes('\\') || relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) {
    return false;
  }
  const segs = relPath.split('/');
  return !segs.some((s) => s === '' || s === '.' || s === '..');
}

function materializeTempDir(files: Record<string, string>): { dir: string; issues: VerifyIssue[] } {
  const dir = mkdtempSync(join(tmpdir(), 'watay-verify-'));
  const absRoot = resolve(dir);
  const issues: VerifyIssue[] = [];
  for (const [relPath, content] of Object.entries(files)) {
    if (!isSafeRelPath(relPath)) {
      issues.push({ file: relPath, tool: 'path-guard', message: `Unsafe relative path "${relPath}"` });
      continue;
    }
    const segs = relPath.split('/');
    const target = resolve(absRoot, ...segs);
    if (!target.startsWith(absRoot + sep)) {
      issues.push({ file: relPath, tool: 'path-guard', message: `Path escapes workspace "${relPath}"` });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return { dir, issues };
}

// ------------------------------------------------------------------ TypeScript verification

const TS_STRIP_SCRIPT = `
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const dir = process.argv[1];
const scratch = process.argv[2];
const files = JSON.parse(process.argv[3]);
const errors = [];

for (const rel of files) {
  try {
    const src = readFileSync(join(dir, rel), 'utf8');
    const js = stripTypeScriptTypes(src, { mode: 'strip' });
    const out = join(scratch, rel.replace(/\\.ts$/, '.mjs'));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, js, 'utf8');
  } catch (err) {
    errors.push({ file: rel, message: err instanceof Error ? err.message : String(err) });
  }
}
process.stdout.write(JSON.stringify(errors));
`;

function extractLineNumber(text: string): number | undefined {
  const m = /:(\d+)(?::\d+)?/.exec(text) ?? /line\s+(\d+)/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

async function verifyTypeScript(dir: string, files: Record<string, string>, report: VerifyReport): Promise<void> {
  // 1. Validate JSON manifests
  for (const jsonFile of Object.keys(files).filter((k) => k.endsWith('.json')).sort()) {
    try {
      JSON.parse(files[jsonFile]!);
    } catch (err) {
      report.issues.push({
        file: jsonFile,
        tool: 'json-parse',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2. Strip TypeScript types + `node --check` on stripped ESM
  const tsFiles = Object.keys(files).filter((k) => k.endsWith('.ts')).sort();
  if (tsFiles.length === 0) {
    report.checks.push({ name: 'ts-syntax', status: 'failed', detail: 'no .ts files generated' });
    report.issues.push({ tool: 'ts-syntax', message: 'No TypeScript files found in output' });
    return;
  }

  const scratch = join(dir, '.watay-check');
  mkdirSync(scratch, { recursive: true });
  const stripRes = await runCmd(
    process.execPath,
    ['--no-warnings', '--input-type=module', '-e', TS_STRIP_SCRIPT, dir, scratch, JSON.stringify(tsFiles)],
    dir,
  );

  let syntaxFailed = false;
  if (stripRes.code !== 0) {
    syntaxFailed = true;
    report.issues.push({ tool: 'ts-strip', message: stripRes.stderr || stripRes.stdout || 'TypeScript syntax check failed' });
  } else {
    try {
      const stripErrors = JSON.parse(stripRes.stdout || '[]') as Array<{ file: string; message: string }>;
      for (const e of stripErrors) {
        syntaxFailed = true;
        report.issues.push({
          file: e.file,
          line: extractLineNumber(e.message),
          tool: 'ts-strip',
          message: e.message,
        });
      }
    } catch {
      syntaxFailed = true;
      report.issues.push({ tool: 'ts-strip', message: 'Failed to parse syntax checker output' });
    }
  }

  // Run `node --check` on stripped .mjs files that passed stripping
  if (!syntaxFailed) {
    for (const rel of tsFiles) {
      const mjsRel = join('.watay-check', rel.replace(/\.ts$/, '.mjs'));
      const chk = await runCmd(process.execPath, ['--check', mjsRel], dir);
      if (chk.code !== 0) {
        syntaxFailed = true;
        const msg = (chk.stderr || chk.stdout).trim();
        report.issues.push({
          file: rel,
          line: extractLineNumber(msg),
          tool: 'node-check',
          message: msg.split('\n').slice(0, 4).join(' '),
        });
      }
    }
  }
  rmSync(scratch, { recursive: true, force: true });

  report.checks.push({
    name: 'ts-syntax',
    status: syntaxFailed ? 'failed' : 'passed',
    detail: syntaxFailed ? 'syntax or erasable-TS error' : `${tsFiles.length} file(s) clean`,
  });

  // 3. Optional tsc typecheck (feature-detect)
  if (files['tsconfig.json']) {
    const tscCheck = await runCmd('tsc', ['--version'], dir);
    if (tscCheck.notFound) {
      report.checks.push({ name: 'ts-typecheck', status: 'skipped', detail: 'tsc not installed' });
    } else if (!syntaxFailed) {
      const tc = await runCmd('tsc', ['-p', 'tsconfig.json', '--noEmit'], dir);
      if (tc.code === 0) {
        report.checks.push({ name: 'ts-typecheck', status: 'passed', detail: tc.stdout.trim() || 'ok' });
      } else {
        report.checks.push({ name: 'ts-typecheck', status: 'failed', detail: 'type errors found' });
        const out = (tc.stdout + '\n' + tc.stderr).trim();
        for (const line of out.split('\n').slice(0, 10)) {
          if (!line.trim()) continue;
          const m = /^([^(]+)\((\d+),\d+\):\s*(.+)$/.exec(line);
          report.issues.push({
            file: m?.[1],
            line: m ? Number(m[2]) : undefined,
            tool: 'tsc',
            message: m ? m[3]! : line,
          });
        }
      }
    } else {
      report.checks.push({ name: 'ts-typecheck', status: 'skipped', detail: 'skipped due to syntax error' });
    }
  }

  // 4. Behavioral check: contract tests or module import smoke test
  if (syntaxFailed) {
    report.checks.push({ name: 'ts-behavior', status: 'skipped', detail: 'skipped due to syntax error' });
    return;
  }

  const testFiles = Object.keys(files).filter((k) => /^tests\/.*\.test\.ts$/.test(k)).sort();
  if (testFiles.length > 0) {
    const tr = await runCmd(process.execPath, ['--no-warnings', '--test', ...testFiles], dir);
    if (tr.code === 0) {
      report.checks.push({ name: 'ts-contract-tests', status: 'passed', detail: `${testFiles.length} test file(s) passed` });
    } else {
      report.checks.push({ name: 'ts-contract-tests', status: 'failed', detail: 'contract tests failed' });
      const msg = (tr.stderr || tr.stdout).trim();
      report.issues.push({
        file: testFiles[0],
        tool: 'node-test',
        message: msg.split('\n').slice(-8).join(' | ') || 'contract tests failed',
      });
    }
  } else if (files['src/index.ts']) {
    const imp = await runCmd(
      process.execPath,
      ['--no-warnings', '--input-type=module', '-e', "await import('./src/index.ts');"],
      dir,
    );
    if (imp.code === 0) {
      report.checks.push({ name: 'ts-import-smoke', status: 'passed', detail: 'src/index.ts imported cleanly' });
    } else {
      report.checks.push({ name: 'ts-import-smoke', status: 'failed', detail: 'failed to import src/index.ts' });
      report.issues.push({
        file: 'src/index.ts',
        tool: 'node-import',
        message: (imp.stderr || imp.stdout).trim().split('\n').slice(0, 5).join(' '),
      });
    }
  }
}

// ------------------------------------------------------------------ Python verification

async function verifyPython(dir: string, files: Record<string, string>, report: VerifyReport): Promise<void> {
  // 1. Validate pyproject.toml if present
  if (files['pyproject.toml']) {
    const tomlRes = await runCmd(
      'python3',
      ['-c', 'import sys, tomllib; tomllib.loads(open(sys.argv[1], "rb").read().decode("utf-8"))', 'pyproject.toml'],
      dir,
    );
    if (tomlRes.notFound) {
      report.checks.push({ name: 'python-syntax', status: 'skipped', detail: 'python3 not installed' });
      return;
    }
    if (tomlRes.code !== 0) {
      report.issues.push({
        file: 'pyproject.toml',
        tool: 'tomllib',
        message: (tomlRes.stderr || tomlRes.stdout).trim(),
      });
    }
  }

  // 2. Compile all .py files with py_compile
  const pyFiles = Object.keys(files).filter((k) => k.endsWith('.py')).sort();
  if (pyFiles.length === 0) {
    report.checks.push({ name: 'python-syntax', status: 'failed', detail: 'no .py files generated' });
    report.issues.push({ tool: 'py_compile', message: 'No Python files found in output' });
    return;
  }

  let syntaxFailed = false;
  for (const rel of pyFiles) {
    const res = await runCmd('python3', ['-m', 'py_compile', rel], dir);
    if (res.notFound) {
      report.checks.push({ name: 'python-syntax', status: 'skipped', detail: 'python3 not installed' });
      return;
    }
    if (res.code !== 0) {
      syntaxFailed = true;
      const msg = (res.stderr || res.stdout).trim();
      const lineMatch = /line\s+(\d+)/i.exec(msg);
      report.issues.push({
        file: rel,
        line: lineMatch ? Number(lineMatch[1]) : undefined,
        tool: 'py_compile',
        message: msg.split('\n').slice(-3).join(' '),
      });
    }
  }

  report.checks.push({
    name: 'python-syntax',
    status: syntaxFailed ? 'failed' : 'passed',
    detail: syntaxFailed ? 'py_compile failed' : `${pyFiles.length} file(s) compiled`,
  });

  // 3. Optional mypy typecheck (feature-detect)
  const mypyCheck = await runCmd('mypy', ['--version'], dir);
  if (mypyCheck.notFound) {
    report.checks.push({ name: 'python-typecheck', status: 'skipped', detail: 'mypy not installed' });
  } else if (!syntaxFailed) {
    const pkgDirs = [...new Set(pyFiles.filter((f) => f.endsWith('/__init__.py')).map((f) => f.slice(0, -'/__init__.py'.length)))];
    const targets = pkgDirs.length > 0 ? pkgDirs : pyFiles;
    const mp = await runCmd('mypy', ['--ignore-missing-imports', ...targets], dir);
    if (mp.code === 0) {
      report.checks.push({ name: 'python-typecheck', status: 'passed', detail: 'ok' });
    } else {
      report.checks.push({ name: 'python-typecheck', status: 'failed', detail: 'mypy errors found' });
      for (const line of (mp.stdout + '\n' + mp.stderr).trim().split('\n').slice(0, 10)) {
        if (!line.trim() || /^Found \d+ error/.test(line)) continue;
        const m = /^([^:]+):(\d+):\s*(.+)$/.exec(line);
        report.issues.push({
          file: m?.[1],
          line: m ? Number(m[2]) : undefined,
          tool: 'mypy',
          message: m ? m[3]! : line,
        });
      }
    }
  } else {
    report.checks.push({ name: 'python-typecheck', status: 'skipped', detail: 'skipped due to syntax error' });
  }

  // 4. Behavioral check: contract tests or package import smoke check
  if (syntaxFailed) {
    report.checks.push({ name: 'python-behavior', status: 'skipped', detail: 'skipped due to syntax error' });
    return;
  }

  const testFiles = Object.keys(files).filter((k) => /^tests\/test_.*\.py$/.test(k)).sort();
  if (testFiles.length > 0) {
    const tr = await runCmd('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'], dir);
    if (tr.code === 0) {
      report.checks.push({ name: 'python-contract-tests', status: 'passed', detail: `${testFiles.length} test file(s) passed` });
    } else {
      report.checks.push({ name: 'python-contract-tests', status: 'failed', detail: 'unittest failed' });
      const msg = (tr.stderr || tr.stdout).trim();
      report.issues.push({
        file: testFiles[0],
        tool: 'unittest',
        message: msg.split('\n').slice(-8).join(' | ') || 'unittest failed',
      });
    }
  } else {
    const initFile = pyFiles.find((f) => f.endsWith('/__init__.py'));
    if (initFile) {
      const modName = initFile.split('/')[0]!;
      const imp = await runCmd('python3', ['-c', `import ${modName}`], dir);
      if (imp.code === 0) {
        report.checks.push({ name: 'python-import-smoke', status: 'passed', detail: `import ${modName} succeeded` });
      } else {
        report.checks.push({ name: 'python-import-smoke', status: 'failed', detail: `import ${modName} failed` });
        report.issues.push({
          file: initFile,
          tool: 'python-import',
          message: (imp.stderr || imp.stdout).trim().split('\n').slice(-3).join(' '),
        });
      }
    }
  }
}

// ------------------------------------------------------------------ deterministic repairs

function deterministicRepair(output: GeneratorOutput): Record<string, string> | undefined {
  const patched: Record<string, string> = {};
  let changed = false;

  if (output.language === 'typescript') {
    for (const [rel, content] of Object.entries(output.files)) {
      if (rel.endsWith('.json')) {
        const cleaned = content.replace(/,\s*([}\]])/g, '$1');
        if (cleaned !== content) {
          patched[rel] = cleaned;
          changed = true;
        }
      } else if (rel.endsWith('.ts')) {
        // Fix relative ESM imports missing `.ts` extension when the target `.ts` file exists
        const fixed = content.replace(
          /((?:from|import)\s+['"])(\.\.?\/[^'"]+?)(['"])/g,
          (full, pre: string, spec: string, post: string) => {
            if (/\.(ts|js|mjs|cjs|json)$/.test(spec)) return full;
            const resolved = join(dirname(rel), spec + '.ts').replace(/\\/g, '/');
            if (Object.prototype.hasOwnProperty.call(output.files, resolved)) {
              return pre + spec + '.ts' + post;
            }
            return full;
          },
        );
        if (fixed !== content) {
          patched[rel] = fixed;
          changed = true;
        }
      }
    }
  } else if (output.language === 'python') {
    for (const [rel, content] of Object.entries(output.files)) {
      if (!rel.endsWith('.py')) continue;
      let next = content;
      // Normalize leading tabs to 4 spaces
      if (/^\t+/m.test(next)) {
        next = next.replace(/^\t+/gm, (tabs) => '    '.repeat(tabs.length));
      }
      // Ensure `from __future__ import annotations` when PEP 604 union syntax is used
      if (/\b[A-Za-z_][A-Za-z0-9_]*\s*\|\s*(?:None|str|int|float|bool|dict|list|Any)\b/.test(next) && !next.includes('from __future__ import annotations')) {
        const lines = next.split('\n');
        let idx = 0;
        while (idx < lines.length && (lines[idx]!.startsWith('#') || lines[idx]!.trim() === '')) idx++;
        lines.splice(idx, 0, 'from __future__ import annotations', '');
        next = lines.join('\n');
      }
      if (next !== content) {
        patched[rel] = next;
        changed = true;
      }
    }
    // Ensure __init__.py exists for package directory if client.py exists without __init__.py
    for (const rel of Object.keys(output.files)) {
      if (rel.endsWith('/client.py')) {
        const pkg = rel.slice(0, -'/client.py'.length);
        const initPath = pkg + '/__init__.py';
        if (!Object.prototype.hasOwnProperty.call(output.files, initPath)) {
          patched[initPath] = 'from __future__ import annotations\n';
          changed = true;
        }
      }
    }
  }

  return changed ? patched : undefined;
}

function selectAffectedFiles(files: Record<string, string>, issues: VerifyIssue[]): Record<string, string> {
  const affected: Record<string, string> = {};
  let allNamed = issues.length > 0;
  for (const iss of issues) {
    if (!iss.file || !Object.prototype.hasOwnProperty.call(files, iss.file)) {
      allNamed = false;
      break;
    }
    affected[iss.file] = files[iss.file]!;
  }
  return allNamed && Object.keys(affected).length > 0 ? affected : { ...files };
}

function applySafePatches(base: Record<string, string>, patches: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = { ...base };
  for (const [k, v] of Object.entries(patches)) {
    // Reject path traversal or attempts to create arbitrary new files outside the SDK output
    if (!isSafeRelPath(k)) continue;
    if (!Object.prototype.hasOwnProperty.call(base, k)) continue;
    if (typeof v === 'string') next[k] = v;
  }
  return next;
}

// ------------------------------------------------------------------ public API

/**
 * Verifies a generated SDK (`GeneratorOutput`) in an isolated temp directory:
 * path safety, syntax/strip checks, optional static typechecks (`tsc`/`mypy`), and contract tests.
 */
export async function verifyOutput(out: GeneratorOutput): Promise<VerifyReport> {
  const report: VerifyReport = {
    language: out.language,
    ok: false,
    checks: [],
    issues: [],
  };

  const { dir, issues: pathIssues } = materializeTempDir(out.files);
  try {
    if (pathIssues.length > 0) {
      report.checks.push({ name: 'path-safety', status: 'failed', detail: `${pathIssues.length} unsafe path(s)` });
      report.issues.push(...pathIssues);
      return report;
    }
    report.checks.push({ name: 'path-safety', status: 'passed', detail: `${Object.keys(out.files).length} file(s)` });

    if (out.language === 'typescript') {
      await verifyTypeScript(dir, out.files, report);
    } else if (out.language === 'python') {
      await verifyPython(dir, out.files, report);
    } else {
      report.issues.push({ tool: 'verifier', message: `Unsupported language "${String(out.language)}"` });
    }

    report.ok = report.issues.length === 0 && !report.checks.some((c) => c.status === 'failed');
    return report;
  } finally {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Runs the self-healing verification loop on `out`:
 *   - verifies initially
 *   - applies deterministic AST/pattern repairs if needed
 *   - invokes optional BYOK `opts.repair` hook up to `maxIterations` (default 3)
 *   - always re-verifies before claiming success.
 */
export async function selfHeal(out: GeneratorOutput, opts: HealOptions = {}): Promise<HealResult> {
  const maxIterations = opts.maxIterations ?? 3;
  let current: GeneratorOutput = { language: out.language, files: { ...out.files } };
  let report = await verifyOutput(current);

  if (report.ok) {
    return { output: current, report, iterations: 0, healed: false };
  }

  let iterations = 0;

  // Step 1: deterministic repairs (zero LLM cost)
  if (maxIterations > 0) {
    const det = deterministicRepair(current);
    if (det) {
      iterations++;
      current = {
        language: current.language,
        files: { ...current.files, ...Object.fromEntries(Object.entries(det).filter(([k]) => isSafeRelPath(k))) },
      };
      report = await verifyOutput(current);
      if (report.ok) {
        return { output: current, report, iterations, healed: true };
      }
    }
  }

  // Step 2: optional BYOK repair hook loop
  if (opts.repair) {
    while (iterations < maxIterations && !report.ok) {
      iterations++;
      const scope = selectAffectedFiles(current.files, report.issues);
      const patched = await opts.repair(scope, report.issues);
      if (!patched || typeof patched !== 'object') break;
      const nextFiles = applySafePatches(current.files, patched);
      current = { language: current.language, files: nextFiles };
      report = await verifyOutput(current);
      if (report.ok) {
        return { output: current, report, iterations, healed: true };
      }
    }
  }

  return { output: current, report, iterations, healed: false };
}
