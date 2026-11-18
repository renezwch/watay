#!/usr/bin/env node
/**
 * Interactive Watay Showcase Demo — builds all 3 showcase SDKs, displays
 * SpecDrift breaking-change reports, and runs all 6 contract-test suites live.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildShowcases } from './build-showcases.ts';

interface ContractRun {
  language: 'typescript' | 'python';
  ok: boolean;
  summary: string;
}

function runCommand(cmd: string, args: string[], cwd: string): { ok: boolean; output: string } {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
  return { ok: res.status === 0, output };
}

function extractTestCount(output: string, lang: 'typescript' | 'python'): string {
  if (lang === 'typescript') {
    const m = /ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)/.exec(output);
    return m ? `${m[2]}/${m[1]} passed` : 'passed';
  }
  const m = /Ran (\d+) tests? in [\d.]+s[\s\S]*?OK/.exec(output);
  return m ? `${m[1]}/${m[1]} passed` : 'passed';
}

export async function runDemo(): Promise<number> {
  process.stdout.write('============================================================\n');
  process.stdout.write('  Watay (watay.dev) — Autonomous Showcase Ecosystem Demo\n');
  process.stdout.write('  100% Client-Side · Zero-Data-Retention · Zero Dependencies\n');
  process.stdout.write('============================================================\n\n');

  const built = await buildShowcases();
  let allOk = true;

  for (const sc of built) {
    process.stdout.write(`▶ ${sc.label} (${sc.id})\n`);
    process.stdout.write(
      `  Spec: v${sc.v1.version} -> v${sc.v2.version} | ${sc.v2.operations.length} operations, ${Object.keys(sc.v2.schemas).length} schemas\n`,
    );
    process.stdout.write(
      `  SpecDrift: ${sc.diff.breaking.length} breaking, ${sc.diff.nonBreaking.length} non-breaking, ${sc.diff.info.length} info (bump: ${sc.diff.suggestedBump})\n`,
    );
    for (const c of sc.diff.breaking.slice(0, 4)) {
      process.stdout.write(`    - [BREAKING] ${c.code}: ${c.location}\n`);
    }
    if (sc.diff.breaking.length > 4) {
      process.stdout.write(`    - ... (+${sc.diff.breaking.length - 4} more in SPECDRIFT_REPORT.md)\n`);
    }

    const runs: ContractRun[] = [];
    const tsDir = join(sc.outDir, 'typescript');
    const tsRes = runCommand(process.execPath, ['--test', 'tests/contract.test.ts'], tsDir);
    runs.push({
      language: 'typescript',
      ok: tsRes.ok,
      summary: tsRes.ok ? extractTestCount(tsRes.output, 'typescript') : tsRes.output,
    });

    const pyDir = join(sc.outDir, 'python');
    const pyRes = runCommand('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-v'], pyDir);
    runs.push({
      language: 'python',
      ok: pyRes.ok,
      summary: pyRes.ok ? extractTestCount(pyRes.output, 'python') : pyRes.output,
    });

    for (const r of runs) {
      if (!r.ok) allOk = false;
      process.stdout.write(`  Contract Tests (${r.language}): ${r.ok ? 'PASS' : 'FAIL'} (${r.summary})\n`);
    }
    process.stdout.write('\n');
  }

  process.stdout.write(
    allOk
      ? '✅ All 3 showcases (6 generated SDKs + SpecDrift reports + live mock contract tests) PASSED.\n'
      : '❌ One or more showcase contract test suites FAILED.\n',
  );
  return allOk ? 0 : 1;
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
  const code = await runDemo();
  process.exitCode = code;
}
