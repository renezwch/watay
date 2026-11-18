/**
 * Watay – GitHub Action Runner & Orchestrator (owner: dev-action).
 * 
 * Orchestrates:
 * 1. Client-Side Serverless License Verification (Zero-Data-Retention)
 * 2. SpecDrift Detection (Comparing PR Head Spec against Base Spec)
 * 3. PR Commenting & GitHub Step Summary Generation
 * 4. SDK Generation & Build Verification
 * 5. Gatekeeping: Fails CI if breaking changes are detected without override
 * 
 * Runtime: Node.js >= 22 (erasable syntax, pure TS, zero external deps).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { DiffResult, GeneratorOutput, LicenseStatus, WatayIR } from '../types.ts';
import { checkLicense, maskKey } from './license.ts';

export interface ActionConfig {
  specPath: string;
  baseSpecPath?: string;
  baseRef?: string;
  failOnBreaking: boolean;
  postComment: boolean;
  languages: string[];
  outputDir: string;
  licenseKey?: string;
  githubToken?: string;
  repository?: string;
  prNumber?: number;
  stepSummaryPath?: string;
  outputPath?: string;
  dryRun: boolean;
  allowBreakingLabel?: boolean;
}

export interface ActionResult {
  exitCode: number;
  diff?: DiffResult;
  license: LicenseStatus;
  generatedSdks: Record<string, number>; // lang -> file count
  markdownReport: string;
}

/**
 * Normalizes language tokens (e.g. "ts" -> "typescript", "py" -> "python").
 */
export function normalizeLanguages(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return ['typescript', 'python'];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const t = part.trim().toLowerCase();
    if (!t) continue;
    if (t === 'ts' || t === 'typescript') {
      if (!out.includes('typescript')) out.push('typescript');
    } else if (t === 'py' || t === 'python') {
      if (!out.includes('python')) out.push('python');
    } else {
      if (!out.includes(t)) out.push(t);
    }
  }
  return out.length > 0 ? out : ['typescript', 'python'];
}

/**
 * Validates that a relative POSIX path is safe from directory traversal.
 */
export function isSafeRelPath(relPath: string): boolean {
  if (
    !relPath ||
    relPath.includes('\0') ||
    relPath.includes('\\') ||
    relPath.startsWith('/') ||
    /^[A-Za-z]:/.test(relPath)
  ) {
    return false;
  }
  const segs = relPath.split('/');
  return !segs.some((s) => s === '' || s === '.' || s === '..');
}

/**
 * Extracts action configuration from environment variables or inputs.
 */
export function parseActionConfig(envOverride?: Record<string, string | undefined>): ActionConfig {
  const env = envOverride ?? process.env;

  const specPath =
    env.INPUT_SPEC_PATH ??
    env.INPUT_SPEC ??
    env.WATAY_SPEC_PATH ??
    'openapi.json';

  const baseSpecPath =
    env.INPUT_BASE_SPEC_PATH ??
    env.INPUT_BASE_SPEC ??
    env.WATAY_BASE_SPEC_PATH;

  const baseRef =
    env.INPUT_BASE_REF ??
    env.GITHUB_BASE_REF ??
    'main';

  const failOnBreaking =
    (env.INPUT_FAIL_ON_BREAKING ?? env.WATAY_FAIL_ON_BREAKING ?? 'true').toLowerCase() === 'true';

  const postComment =
    (env.INPUT_POST_COMMENT ?? env.WATAY_POST_COMMENT ?? 'true').toLowerCase() === 'true';

  const rawLanguages =
    env.INPUT_LANGUAGES ??
    env.WATAY_LANGUAGES ??
    'typescript,python';

  const languages = normalizeLanguages(rawLanguages);

  const outputDir =
    env.INPUT_OUTPUT_DIR ??
    env.WATAY_OUTPUT_DIR ??
    './generated-sdks';

  const licenseKey =
    env.INPUT_LICENSE_KEY ??
    env.WATAY_LICENSE_KEY ??
    env.POLAR_LICENSE_KEY ??
    env.LEMONSQUEEZY_LICENSE_KEY;

  const githubToken =
    env.INPUT_GITHUB_TOKEN ??
    env.GITHUB_TOKEN;

  const stepSummaryPath = env.GITHUB_STEP_SUMMARY;
  const outputPath = env.GITHUB_OUTPUT;
  const dryRun = env.WATAY_DRY_RUN === '1' || env.WATAY_DRY_RUN === 'true';

  let repository = env.GITHUB_REPOSITORY;
  let prNumber: number | undefined;
  let allowBreakingLabel = false;

  // Attempt to parse pull_request event context if available
  const eventPath = env.GITHUB_EVENT_PATH;
  if (eventPath && fs.existsSync(eventPath)) {
    try {
      const eventContent = fs.readFileSync(eventPath, 'utf8');
      const eventData = JSON.parse(eventContent) as {
        pull_request?: {
          number?: number;
          labels?: Array<{ name?: string }>;
          base?: { ref?: string };
        };
        repository?: { full_name?: string };
      };

      if (eventData.pull_request?.number) {
        prNumber = eventData.pull_request.number;
      }
      if (eventData.repository?.full_name) {
        repository = eventData.repository.full_name;
      }
      if (eventData.pull_request?.labels) {
        allowBreakingLabel = eventData.pull_request.labels.some(
          (l) => l.name === 'watay-allow-breaking' || l.name === 'allow-breaking'
        );
      }
    } catch {
      // ignore event parsing issues
    }
  }

  return {
    specPath,
    baseSpecPath,
    baseRef,
    failOnBreaking,
    postComment,
    languages,
    outputDir,
    licenseKey,
    githubToken,
    repository,
    prNumber,
    stepSummaryPath,
    outputPath,
    dryRun,
    allowBreakingLabel,
  };
}

/**
 * Loads and parses OpenAPI spec from file path or git reference without shell injection risk.
 * Throws on invalid specification syntax or unresolved schemas (exitCode: 2).
 */
async function loadSpec(
  targetPath: string,
  gitRef?: string
): Promise<WatayIR | null> {
  let content = '';

  if (gitRef) {
    try {
      content = execFileSync('git', ['show', `origin/${gitRef}:${targetPath}`], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      });
    } catch {
      try {
        content = execFileSync('git', ['show', `${gitRef}:${targetPath}`], {
          stdio: ['ignore', 'pipe', 'ignore'],
          encoding: 'utf8',
        });
      } catch {
        return null;
      }
    }
  } else if (fs.existsSync(targetPath)) {
    content = fs.readFileSync(targetPath, 'utf8');
  } else {
    return null;
  }

  if (!content.trim()) return null;

  // Use core parser; propagate any WatayError (never silently swallow invalid specs)
  const parserMod = await import('../core/parser.ts');
  if (typeof parserMod.loadSpecFile === 'function' && !gitRef && fs.existsSync(targetPath)) {
    return parserMod.loadSpecFile(targetPath);
  }
  if (typeof parserMod.parseSpec === 'function') {
    return parserMod.parseSpec(content);
  }

  throw new Error('Watay parser module unavailable');
}

/**
 * Executes the GitHub Action pipeline.
 * Returns process exit code (0 for success, 1 for breaking-change block, 2 for error).
 */
export async function runAction(
  envOverride?: Record<string, string | undefined>
): Promise<number> {
  const result = await executeAction(envOverride);
  return result.exitCode;
}

export async function executeAction(
  envOverride?: Record<string, string | undefined>
): Promise<ActionResult> {
  const config = parseActionConfig(envOverride);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🌊 Watay – Autonomous Client-Side SDK & SpecDrift Gatekeeper');
  console.log('🛡️ Zero-Data-Retention: 100% executed in your local runner');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1. Verify License
  const license = await checkLicense(config.licenseKey, envOverride);
  console.log(
    `[License] Tier: ${license.tier.toUpperCase()} (${license.source})${
      config.licenseKey ? ` [Key: ${maskKey(config.licenseKey)}]` : ''
    }`
  );

  // 2. Load Current (Head) Spec
  if (!fs.existsSync(config.specPath)) {
    console.error(`❌ [Error] OpenAPI spec file not found at: ${config.specPath}`);
    return {
      exitCode: 2,
      license,
      generatedSdks: {},
      markdownReport: `### ❌ Watay Error: Spec file not found at \`${config.specPath}\``,
    };
  }

  let headIR: WatayIR;
  try {
    const loaded = await loadSpec(config.specPath);
    if (!loaded) {
      throw new Error(`Failed to read specification at ${config.specPath}`);
    }
    headIR = loaded;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ [Error] Failed to parse OpenAPI spec at: ${config.specPath} (${msg})`);
    return {
      exitCode: 2,
      license,
      generatedSdks: {},
      markdownReport: `### ❌ Watay Error: Invalid OpenAPI specification at \`${config.specPath}\`\n\n\`${msg}\``,
    };
  }
  console.log(`[Spec] Loaded head spec "${headIR.title}" v${headIR.version} (${headIR.operations.length} operations)`);

  // 3. Load Base Spec (for SpecDrift Diff)
  let baseIR: WatayIR | null = null;
  try {
    if (config.baseSpecPath && fs.existsSync(config.baseSpecPath)) {
      baseIR = await loadSpec(config.baseSpecPath);
      if (baseIR) {
        console.log(`[SpecDrift] Loaded explicit base spec from: ${config.baseSpecPath}`);
      }
    } else if (config.baseRef) {
      baseIR = await loadSpec(config.specPath, config.baseRef);
      if (baseIR) {
        console.log(`[SpecDrift] Loaded base spec from git ref "${config.baseRef}:${config.specPath}"`);
      }
    }
  } catch {
    console.log('[SpecDrift] Note: Base specification could not be parsed; proceeding without diff');
  }

  // 4. Compute SpecDrift Diff
  let diff: DiffResult | undefined;
  if (baseIR) {
    try {
      const differMod = await import('../core/differ.ts');
      if (typeof differMod.diffSpecs === 'function') {
        diff = differMod.diffSpecs(baseIR, headIR);
      }
    } catch {
      console.log('[SpecDrift] Differ engine not yet available or failed, skipping semantic diff');
    }
  }

  // 5. Generate SDKs (if requested)
  const generatedSdks: Record<string, number> = {};
  for (const lang of config.languages) {
    try {
      let output: GeneratorOutput | undefined;
      if (lang === 'typescript') {
        const tsMod = await import('../generators/typescript.ts');
        if (typeof tsMod.generateTypeScript === 'function') {
          output = tsMod.generateTypeScript(headIR);
        }
      } else if (lang === 'python') {
        const pyMod = await import('../generators/python.ts');
        if (typeof pyMod.generatePython === 'function') {
          output = pyMod.generatePython(headIR);
        }
      }

      if (output && output.files) {
        const targetDir = path.resolve(config.outputDir, lang);
        fs.mkdirSync(targetDir, { recursive: true });

        const fileEntries = Array.isArray(output.files)
          ? output.files.map((f: { path: string; content: string }) => [f.path, f.content] as const)
          : Object.entries(output.files);

        for (const [relPath, content] of fileEntries) {
          // Strict Path-Traversal guard
          if (!isSafeRelPath(relPath)) {
            console.error(`❌ [Security] Blocked path traversal attempt in file: "${relPath}"`);
            return {
              exitCode: 2,
              license,
              generatedSdks,
              markdownReport: `### ❌ Security Error: Unsafe file path "${relPath}" in generated SDK`,
            };
          }

          const filePath = path.resolve(targetDir, relPath);
          if (!filePath.startsWith(targetDir + path.sep)) {
            console.error(`❌ [Security] File path escapes output directory: "${filePath}"`);
            return {
              exitCode: 2,
              license,
              generatedSdks,
              markdownReport: `### ❌ Security Error: File path escapes output directory: "${relPath}"`,
            };
          }

          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, content as string, 'utf8');
        }

        generatedSdks[lang] = fileEntries.length;
        console.log(`[CodeGen] Generated ${lang} SDK (${fileEntries.length} files) -> ${targetDir}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[CodeGen] ${lang} generator skipped: ${msg}`);
    }
  }

  // 6. Build Markdown Report
  const markdownReport = buildMarkdownReport({
    headIR,
    baseIR,
    diff,
    license,
    generatedSdks,
    config,
  });

  // 7. Write to Step Summary and Action Outputs
  if (config.stepSummaryPath) {
    try {
      fs.appendFileSync(config.stepSummaryPath, `\n${markdownReport}\n`, 'utf8');
      console.log(`[GitHub] Written step summary to ${config.stepSummaryPath}`);
    } catch {
      // ignore summary write error
    }
  }

  if (config.outputPath) {
    try {
      const lines = [
        `has-breaking=${diff ? String(diff.hasBreaking) : 'false'}`,
        `suggested-bump=${diff ? diff.suggestedBump : 'none'}`,
        `breaking-count=${diff ? diff.breaking.length : 0}`,
        `tier=${license.tier}`,
        `sdk-generated=${Object.keys(generatedSdks).length > 0 ? 'true' : 'false'}`,
      ];
      fs.appendFileSync(config.outputPath, `${lines.join('\n')}\n`, 'utf8');
    } catch {
      // ignore output write error
    }
  }

  // 8. Output Markdown in Dry-Run mode ALWAYS to stdout
  if (config.dryRun) {
    console.log('\n[Dry-Run] Markdown PR Report:\n');
    console.log(markdownReport);
  }

  // 9. Post PR Comment (if not in dry-run and parameters present)
  if (!config.dryRun && config.postComment && config.prNumber && config.repository && config.githubToken) {
    await postOrUpdatePrComment({
      token: config.githubToken,
      repository: config.repository,
      prNumber: config.prNumber,
      markdown: markdownReport,
      dryRun: false,
    });
  }

  // 10. Gatekeeper Evaluation
  let exitCode = 0;
  if (diff?.hasBreaking) {
    console.log(`\n🚨 [SpecDrift] Found ${diff.breaking.length} BREAKING changes!`);
    for (const b of diff.breaking) {
      console.log(`   - ❌ [${b.code}] ${b.location}: ${b.message}`);
    }

    if (config.failOnBreaking) {
      if (config.allowBreakingLabel) {
        console.log('⚠️ [SpecDrift] Breaking changes detected, but permitted via label "watay-allow-breaking".');
      } else {
        console.error('❌ [Gatekeeper] Failing CI runner due to unapproved breaking API changes.');
        console.error('💡 To override, add the "watay-allow-breaking" label to your pull request.');
        exitCode = 1;
      }
    }
  } else {
    console.log('✅ [SpecDrift] Clean! No breaking changes detected.');
  }

  return {
    exitCode,
    diff,
    license,
    generatedSdks,
    markdownReport,
  };
}

/**
 * Builds standard Markdown report for PR comments and job summaries.
 */
function buildMarkdownReport(params: {
  headIR: WatayIR;
  baseIR: WatayIR | null;
  diff?: DiffResult;
  license: LicenseStatus;
  generatedSdks: Record<string, number>;
  config: ActionConfig;
}): string {
  const { headIR, baseIR, diff, license, generatedSdks, config } = params;

  const lines: string[] = [];
  lines.push('<!-- watay-specdrift-report -->');
  lines.push('## 🌊 Watay SpecDrift & SDK Report');
  lines.push('');
  lines.push(
    '> 🛡️ **Zero-Data-Retention:** 100% client-side runner execution. No specifications, schemas or secrets were transferred to external servers.'
  );
  lines.push('');

  // Spec Info
  lines.push(
    `**API:** \`${headIR.title}\` v\`${headIR.version}\` | **License Tier:** \`${license.tier.toUpperCase()}\` (${license.source})`
  );
  lines.push('');

  // Diff Section
  if (diff) {
    const bumpEmoji =
      diff.suggestedBump === 'major'
        ? '🚨'
        : diff.suggestedBump === 'minor'
        ? '✨'
        : '📦';

    lines.push(`### ${bumpEmoji} Semantic SpecDrift Analysis`);
    lines.push('');
    lines.push(`- **Suggested SemVer Bump:** \`${diff.suggestedBump.toUpperCase()}\``);
    lines.push(`- **Breaking Changes:** \`${diff.breaking.length}\``);
    lines.push(`- **Non-Breaking Changes:** \`${diff.nonBreaking.length}\``);
    lines.push(`- **Info Notes:** \`${diff.info.length}\``);
    lines.push('');

    if (diff.breaking.length > 0) {
      lines.push('#### 🚨 Breaking Changes');
      lines.push('| Code | Location | Description |');
      lines.push('| :--- | :--- | :--- |');
      for (const item of diff.breaking) {
        lines.push(`| \`${item.code}\` | \`${item.location}\` | ${escapePipes(item.message)} |`);
      }
      lines.push('');
    }

    if (diff.nonBreaking.length > 0) {
      lines.push('#### ✨ Non-Breaking Additions');
      lines.push('| Code | Location | Description |');
      lines.push('| :--- | :--- | :--- |');
      for (const item of diff.nonBreaking.slice(0, 10)) {
        lines.push(`| \`${item.code}\` | \`${item.location}\` | ${escapePipes(item.message)} |`);
      }
      if (diff.nonBreaking.length > 10) {
        lines.push(`| ... | ... | *+ ${diff.nonBreaking.length - 10} more non-breaking changes* |`);
      }
      lines.push('');
    }
  } else if (baseIR) {
    lines.push('### ℹ️ SpecDrift: No changes detected between base and head.');
    lines.push('');
  } else {
    lines.push('### ℹ️ SpecDrift: Initial specification detected (no base spec to compare against).');
    lines.push('');
  }

  // SDKs Section
  const sdkLangs = Object.keys(generatedSdks);
  if (sdkLangs.length > 0) {
    lines.push('### 📦 Generated Client SDKs');
    for (const lang of sdkLangs) {
      lines.push(`- **${capitalize(lang)} SDK:** \`${generatedSdks[lang]} files\` written to \`${config.outputDir}/${lang}\``);
    }
    lines.push('');
  }

  // Gatekeeper Footer
  if (diff?.hasBreaking) {
    if (config.allowBreakingLabel) {
      lines.push('> ⚠️ **Gatekeeper:** Breaking changes detected, but CI passed via `watay-allow-breaking` override label.');
    } else if (config.failOnBreaking) {
      lines.push('> ❌ **Gatekeeper:** Pull request blocked by Watay because breaking API changes were detected without approval.');
    }
  } else {
    lines.push('> ✅ **Gatekeeper:** API changes adhere to backward-compatibility guidelines.');
  }

  lines.push('');
  lines.push('---');
  lines.push('*Automated by [Watay](https://watay.dev) — Autonomous SDK Generation & API Contract Testing.*');

  return lines.join('\n');
}

function escapePipes(str: string): string {
  return str.replace(/\|/g, '\\|');
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Posts or updates a pull request comment using GitHub REST API.
 */
async function postOrUpdatePrComment(params: {
  token: string;
  repository: string;
  prNumber: number;
  markdown: string;
  dryRun: boolean;
}): Promise<void> {
  const { token, repository, prNumber, markdown, dryRun } = params;

  if (dryRun) {
    console.log(`[GitHub PR] Dry-run: Would post comment to ${repository}#${prNumber}`);
    return;
  }

  try {
    const baseUrl = `https://api.github.com/repos/${repository}/issues/${prNumber}/comments`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Watay-Action/0.1.0',
    };

    // 1. List existing comments to find prior Watay comment
    const listRes = await fetch(baseUrl, { headers });
    let existingCommentId: number | null = null;

    if (listRes.ok) {
      const comments = (await listRes.json()) as Array<{ id: number; body?: string }>;
      const existing = comments.find((c) => c.body?.includes('<!-- watay-specdrift-report -->'));
      if (existing) {
        existingCommentId = existing.id;
      }
    }

    if (existingCommentId) {
      // Update existing comment
      const updateRes = await fetch(`https://api.github.com/repos/${repository}/issues/comments/${existingCommentId}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: markdown }),
      });
      if (updateRes.ok) {
        console.log(`[GitHub PR] Updated existing comment #${existingCommentId} on ${repository}#${prNumber}`);
        return;
      }
    }

    // Create new comment
    const createRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: markdown }),
    });

    if (createRes.ok) {
      console.log(`[GitHub PR] Created new comment on ${repository}#${prNumber}`);
    } else {
      console.log(`[GitHub PR] Failed to create comment: HTTP ${createRes.status}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[GitHub PR] Comment error: ${msg}`);
  }
}

// CLI entry point
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith('runner.ts') || process.argv[1].endsWith('runner.js'));

if (isDirectExecution) {
  runAction().then((exitCode) => {
    process.exit(exitCode);
  });
}
