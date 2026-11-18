#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { diffSpecs } from '../core/differ.ts';
import { loadSpecFile } from '../core/parser.ts';
import { WatayError } from '../errors.ts';
import type { GeneratorOutput, Language, LicenseStatus, VerifyReport } from '../types.ts';

const VERSION = readPackageVersion();

function readPackageVersion(): string {
  try {
    const pkgPath = new URL('../../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

function maskSecret(key: string): string {
  const t = key.trim();
  if (t.length <= 8) return '****';
  return `${t.slice(0, 5)}****${t.slice(-4)}`;
}

/** Normalize CLI language tokens ("ts" | "typescript" | "py" | "python"). */
export function parseLanguages(raw: string | undefined, fallback: Language[] = ['typescript']): Language[] {
  if (!raw || !raw.trim()) return fallback;
  const out: Language[] = [];
  for (const part of raw.split(',')) {
    const t = part.trim().toLowerCase();
    if (!t) continue;
    if (t === 'ts' || t === 'typescript') {
      if (!out.includes('typescript')) out.push('typescript');
    } else if (t === 'py' || t === 'python') {
      if (!out.includes('python')) out.push('python');
    } else {
      throw new WatayError(`Unsupported target language "${part.trim()}". Supported: ts (typescript), py (python).`, 'INVALID_LANGUAGE');
    }
  }
  if (!out.length) throw new WatayError('No target languages specified. Use --lang ts,python.', 'INVALID_LANGUAGE');
  return out;
}

/**
 * Safely writes generated relative POSIX files strictly beneath outDir.
 * Rejects absolute paths, backslashes, null bytes, empty segments, and ".." traversal.
 */
export function writeGeneratedFiles(outDir: string, files: Record<string, string>): string[] {
  const absOut = resolve(outDir);
  const written: string[] = [];
  for (const [relPath, content] of Object.entries(files)) {
    if (
      !relPath ||
      relPath.includes('\0') ||
      relPath.includes('\\') ||
      relPath.startsWith('/') ||
      /^[A-Za-z]:/.test(relPath)
    ) {
      throw new WatayError(`Unsafe output path "${relPath}": absolute or malformed path is forbidden.`, 'PATH_TRAVERSAL');
    }
    const segs = relPath.split('/');
    if (segs.some((s) => s === '' || s === '.' || s === '..')) {
      throw new WatayError(`Unsafe output path "${relPath}": path traversal ("..") or empty segment is forbidden.`, 'PATH_TRAVERSAL');
    }
    const absFile = resolve(absOut, ...segs);
    if (!absFile.startsWith(absOut + sep)) {
      throw new WatayError(`Unsafe output path "${relPath}": escapes output directory "${absOut}".`, 'PATH_TRAVERSAL');
    }
    mkdirSync(dirname(absFile), { recursive: true });
    writeFileSync(absFile, content, 'utf8');
    written.push(absFile);
  }
  return written;
}

async function generateForLanguage(
  lang: Language,
  specPath: string,
  opts: { packageName?: string; withContractTests: boolean },
): Promise<GeneratorOutput> {
  const ir = loadSpecFile(specPath);
  if (lang === 'typescript') {
    const mod = await import('../generators/typescript.ts');
    return mod.generateTypeScript(ir, opts);
  }
  const mod = await import('../generators/python.ts');
  return mod.generatePython(ir, opts);
}

async function checkCliLicense(key?: string): Promise<LicenseStatus> {
  try {
    const mod = await import('../action/license.ts');
    return await mod.checkLicense(key);
  } catch {
    return { valid: true, tier: 'free', source: 'none', reason: 'license module unavailable; free tier active' };
  }
}

function helpText(): string {
  return `Watay v${VERSION} — Autonomous SDK Generation, Contract Guard & Contract Testing (watay.dev)

Usage:
  watay <command> [options]

Commands:
  diff <old> <new>        Semantic OpenAPI Contract Guard diff (breaking vs non-breaking)
    --old <path>          Old/base OpenAPI spec (alternative to positional <old>)
    --new <path>          New/head OpenAPI spec (alternative to positional <new>)
    --fail-on-breaking    Exit with code 1 if breaking changes are detected
    --json                Output DiffResult as JSON instead of Markdown

  generate <spec>         Generate typed SDKs (+ contract tests) from OpenAPI spec
    -i, --input <path>    OpenAPI spec path (alternative to positional <spec>)
    --lang <list>         Comma-separated: ts,python (default: ts)
    --out <dir>           Output directory (default: ./watay-sdk)
    --package-name <name> Override generated package name
    --no-tests            Skip generating contract tests
    --verify              Verify generated SDKs after writing
    --heal                Run self-healing verification loop on generated SDKs
    --license-key <key>   Optional Watay license key (or WATAY_LICENSE_KEY env)
    --json                Output summary as JSON

  verify <spec>           Validate OpenAPI spec and run SDK/contract verification
    -i, --input <path>    OpenAPI spec path (alternative to positional <spec>)
    --lang <list>         Comma-separated: ts,python (default: ts,python)
    --json                Output verification report as JSON

  license                 Show effective license tier (free/pro/scale)
    --key <key>           License key to evaluate (masked in output)
    --json                Output LicenseStatus as JSON

Options:
  -h, --help              Show this help
  -v, --version           Show version

Exit codes:
  0  Success
  1  Breaking changes detected (diff --fail-on-breaking)
  2  Input, spec, or CLI argument error
  3  Verification failed
  4  License / tier restriction
`;
}

// ------------------------------------------------------------------ subcommands

async function cmdDiff(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      old: { type: 'string' },
      new: { type: 'string' },
      'fail-on-breaking': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(helpText());
    return 0;
  }
  const oldPath = values.old ?? positionals[0];
  const newPath = values.new ?? positionals[1];
  if (!oldPath || !newPath) {
    throw new WatayError('Usage: watay diff <old-spec> <new-spec> [--fail-on-breaking] [--json]', 'CLI_USAGE');
  }
  const oldIr = loadSpecFile(oldPath);
  const newIr = loadSpecFile(newPath);
  const result = diffSpecs(oldIr, newIr);

  if (values.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stdout.write(result.markdown);

  if (values['fail-on-breaking'] && result.hasBreaking) return 1;
  return 0;
}

async function cmdGenerate(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      input: { type: 'string', short: 'i' },
      spec: { type: 'string' },
      lang: { type: 'string', default: 'ts' },
      out: { type: 'string', default: './watay-sdk' },
      'package-name': { type: 'string' },
      'with-tests': { type: 'boolean', default: true },
      'no-tests': { type: 'boolean', default: false },
      verify: { type: 'boolean', default: false },
      heal: { type: 'boolean', default: false },
      'license-key': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(helpText());
    return 0;
  }
  const specPath = values.input ?? values.spec ?? positionals[0];
  if (!specPath) {
    throw new WatayError('Usage: watay generate <spec> [--lang ts,python] [--out <dir>]', 'CLI_USAGE');
  }
  const langs = parseLanguages(values.lang, ['typescript']);
  const outDir = values.out ?? './watay-sdk';
  const withContractTests = values['no-tests'] ? false : values['with-tests'] !== false;
  const license = await checkCliLicense(values['license-key']);

  const ir = loadSpecFile(specPath);
  const summary: Array<{ language: Language; outDir: string; fileCount: number; report?: VerifyReport }> = [];
  let verifyFailed = false;

  for (const lang of langs) {
    let output = await generateForLanguage(lang, specPath, {
      packageName: values['package-name'],
      withContractTests,
    });

    let report: VerifyReport | undefined;
    if (values.heal || values.verify) {
      const healer = await import('../healer/self-heal.ts');
      if (values.heal) {
        const healed = await healer.selfHeal(output);
        output = healed.output;
        report = healed.report;
      } else {
        report = await healer.verifyOutput(output);
      }
      if (!report.ok) verifyFailed = true;
    }

    const targetDir = langs.length > 1 ? join(outDir, lang) : outDir;
    const written = writeGeneratedFiles(targetDir, output.files);
    summary.push({ language: lang, outDir: resolve(targetDir), fileCount: written.length, report });
  }

  if (values.json) {
    process.stdout.write(
      JSON.stringify(
        {
          title: ir.title,
          version: ir.version,
          operations: ir.operations.length,
          tier: license.tier,
          generated: summary,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    for (const s of summary) {
      const vNote = s.report ? (s.report.ok ? ' [verified: ok]' : ' [verified: FAILED]') : '';
      process.stdout.write(`Generated ${s.language} SDK (${s.fileCount} files) -> ${s.outDir}${vNote}\n`);
      if (s.report && !s.report.ok) {
        for (const iss of s.report.issues) {
          process.stderr.write(`  - [${iss.tool}] ${iss.file ?? ''}: ${iss.message}\n`);
        }
      }
    }
  }
  return verifyFailed ? 3 : 0;
}

async function cmdVerify(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      input: { type: 'string', short: 'i' },
      spec: { type: 'string' },
      lang: { type: 'string', default: 'ts,python' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(helpText());
    return 0;
  }
  const specPath = values.input ?? values.spec ?? positionals[0];
  if (!specPath) {
    throw new WatayError('Usage: watay verify <spec> [--lang ts,python] [--json]', 'CLI_USAGE');
  }

  const ir = loadSpecFile(specPath);
  const langs = parseLanguages(values.lang, ['typescript', 'python']);
  const reports: VerifyReport[] = [];
  let healerAvailable = true;

  let verifyOutputFn: ((out: GeneratorOutput) => Promise<VerifyReport>) | undefined;
  try {
    const healer = await import('../healer/self-heal.ts');
    verifyOutputFn = healer.verifyOutput;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') healerAvailable = false;
    else throw e;
  }

  let ok = true;
  for (const lang of langs) {
    const out = await generateForLanguage(lang, specPath, { withContractTests: true });
    if (verifyOutputFn) {
      const rep = await verifyOutputFn(out);
      reports.push(rep);
      if (!rep.ok) ok = false;
    } else {
      reports.push({
        language: lang,
        ok: true,
        checks: [{ name: 'codegen', status: 'passed', detail: `${Object.keys(out.files).length} files generated` }],
        issues: [],
      });
    }
  }

  if (values.json) {
    process.stdout.write(
      JSON.stringify(
        {
          specValid: true,
          title: ir.title,
          version: ir.version,
          operations: ir.operations.length,
          schemas: Object.keys(ir.schemas).length,
          healerAvailable,
          ok,
          reports,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(`Spec OK: ${ir.title} v${ir.version} (${ir.operations.length} operations, ${Object.keys(ir.schemas).length} schemas)\n`);
    for (const rep of reports) {
      const checks = rep.checks.map((c) => `${c.name}=${c.status}`).join(', ');
      process.stdout.write(`  ${rep.language}: ${rep.ok ? 'PASS' : 'FAIL'} (${checks})\n`);
      for (const iss of rep.issues) {
        process.stderr.write(`    ! [${iss.tool}] ${iss.file ?? ''}${iss.line ? `:${iss.line}` : ''}: ${iss.message}\n`);
      }
    }
  }
  return ok ? 0 : 3;
}

async function cmdLicense(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      key: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(helpText());
    return 0;
  }
  const status = await checkCliLicense(values.key);
  if (values.json) {
    process.stdout.write(JSON.stringify(status, null, 2) + '\n');
  } else {
    const keyNote = values.key ? ` (key: ${maskSecret(values.key)})` : '';
    process.stdout.write(`License tier: ${status.tier} | valid: ${status.valid} | source: ${status.source}${keyNote}\n`);
    if (status.reason) process.stdout.write(`Reason: ${status.reason}\n`);
  }
  return 0;
}

export async function runCli(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    process.stdout.write(helpText());
    return 0;
  }
  if (argv[0] === '-v' || argv[0] === '--version') {
    process.stdout.write(`watay/${VERSION}\n`);
    return 0;
  }

  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'diff') return await cmdDiff(rest);
    if (cmd === 'generate' || cmd === 'gen') return await cmdGenerate(rest);
    if (cmd === 'verify') return await cmdVerify(rest);
    if (cmd === 'license') return await cmdLicense(rest);
    throw new WatayError(`Unknown command "${cmd}". Run "watay --help" for usage.`, 'CLI_UNKNOWN_COMMAND');
  } catch (err) {
    if (err instanceof WatayError) {
      process.stderr.write(`Error [${err.code}]: ${err.message}\n`);
      return err.code === 'LICENSE_REQUIRED' ? 4 : 2;
    }
    const e = err as NodeJS.ErrnoException;
    if (e && typeof e.code === 'string' && e.code.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`Error [CLI_ARGS]: ${e.message}\n`);
      return 2;
    }
    process.stderr.write(`Error: ${(err as Error)?.message ?? String(err)}\n`);
    return 2;
  }
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}
