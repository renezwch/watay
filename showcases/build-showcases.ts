#!/usr/bin/env node
/**
 * Watay Showcase Builder — generates & verifies TypeScript + Python SDKs and
 * Contract Guard reports (v1 -> v2) for all 3 real-world showcase APIs.
 */
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeGeneratedFiles } from '../src/cli/index.ts';
import { diffSpecs } from '../src/core/differ.ts';
import { loadSpecFile } from '../src/core/parser.ts';
import { generatePython } from '../src/generators/python.ts';
import { generateTypeScript } from '../src/generators/typescript.ts';
import { selfHeal } from '../src/healer/self-heal.ts';
import type { DiffResult, HealResult, WatayIR } from '../src/types.ts';

export interface ShowcaseSpec {
  id: string;
  label: string;
  v1Spec: string;
  v2Spec: string;
}

const SHOWCASE_DIR = dirname(fileURLToPath(import.meta.url));
export const SPECS_DIR = join(SHOWCASE_DIR, 'specs');
export const GENERATED_DIR = join(SHOWCASE_DIR, 'generated');

export const SHOWCASES: readonly ShowcaseSpec[] = [
  {
    id: 'llm-gateway',
    label: 'NexusAI LLM Gateway',
    v1Spec: join(SPECS_DIR, 'llm-gateway-v1.json'),
    v2Spec: join(SPECS_DIR, 'llm-gateway-v2.json'),
  },
  {
    id: 'fintech-ledger',
    label: 'Aurelia FinTech Ledger',
    v1Spec: join(SPECS_DIR, 'fintech-ledger-v1.json'),
    v2Spec: join(SPECS_DIR, 'fintech-ledger-v2.json'),
  },
  {
    id: 'cloud-deploy',
    label: 'Stratos Cloud Deploy',
    v1Spec: join(SPECS_DIR, 'cloud-deploy-v1.json'),
    v2Spec: join(SPECS_DIR, 'cloud-deploy-v2.json'),
  },
];

export interface ShowcaseBuildResult {
  id: string;
  label: string;
  v1: WatayIR;
  v2: WatayIR;
  diff: DiffResult;
  typescript: HealResult;
  python: HealResult;
  outDir: string;
}

export async function buildShowcases(outRoot = GENERATED_DIR): Promise<ShowcaseBuildResult[]> {
  const results: ShowcaseBuildResult[] = [];
  mkdirSync(outRoot, { recursive: true });

  for (const item of SHOWCASES) {
    const v1 = loadSpecFile(item.v1Spec);
    const v2 = loadSpecFile(item.v2Spec);
    const diff = diffSpecs(v1, v2);

    const tsRaw = generateTypeScript(v2, { withContractTests: true });
    const pyRaw = generatePython(v2, { withContractTests: true });

    const tsHealed = await selfHeal(tsRaw);
    const pyHealed = await selfHeal(pyRaw);

    if (!tsHealed.report.ok) {
      throw new Error(
        `TypeScript verification failed for ${item.id}: ${tsHealed.report.issues.map((i) => i.message).join('; ')}`,
      );
    }
    if (!pyHealed.report.ok) {
      throw new Error(
        `Python verification failed for ${item.id}: ${pyHealed.report.issues.map((i) => i.message).join('; ')}`,
      );
    }

    const apiOutDir = resolve(outRoot, item.id);
    rmSync(apiOutDir, { recursive: true, force: true });
    mkdirSync(apiOutDir, { recursive: true });

    writeGeneratedFiles(join(apiOutDir, 'typescript'), tsHealed.output.files);
    writeGeneratedFiles(join(apiOutDir, 'python'), pyHealed.output.files);
    writeFileSync(join(apiOutDir, 'BREAKING_CHANGES.md'), diff.markdown, 'utf8');

    results.push({
      id: item.id,
      label: item.label,
      v1,
      v2,
      diff,
      typescript: tsHealed,
      python: pyHealed,
      outDir: apiOutDir,
    });
  }

  return results;
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
  const results = await buildShowcases();
  for (const r of results) {
    const tsFiles = Object.keys(r.typescript.output.files).length;
    const pyFiles = Object.keys(r.python.output.files).length;
    process.stdout.write(
      `[OK] ${r.id} (${r.label} v${r.v1.version} -> v${r.v2.version}): ` +
        `Contract Guard ${r.diff.breaking.length} breaking / ${r.diff.nonBreaking.length} non-breaking (${r.diff.suggestedBump}) | ` +
        `TS=${tsFiles} files, Python=${pyFiles} files\n`,
    );
  }
}
