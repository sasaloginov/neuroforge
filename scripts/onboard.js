#!/usr/bin/env node

/**
 * Onboarding scaffold script.
 *
 * Phase 1 of the two-phase onboarding process:
 *   1. Validates input (workDir, name, prefix, repoUrl)
 *   2. Registers project in DB (project + user + api_key)
 *   3. Creates .neuroforge/ structure in project workDir
 *   4. Copies onboarding templates
 *   5. Outputs API key and instructions for Phase 2 (LLM agent)
 *
 * Usage:
 *   node scripts/onboard.js --work-dir /root/dev/my_project
 *   node scripts/onboard.js --work-dir /path --name my-project --prefix MP --no-interactive
 *   node scripts/onboard.js --work-dir /path --dry-run
 */

import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createPool, closePool } from '../src/infrastructure/persistence/pg.js';
import { ProjectRegistrar } from './lib/projectRegistrar.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const NEUROFORGE_ROOT = resolve(__dirname, '..');
const TEMPLATES_DIR = resolve(NEUROFORGE_ROOT, 'docs/templates/onboarding');

// --- Argument parsing ---

function parseArgs(argv) {
  const args = {
    workDir: null,
    name: null,
    prefix: null,
    repoUrl: null,
    interactive: true,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--work-dir':
        args.workDir = argv[++i];
        break;
      case '--name':
        args.name = argv[++i];
        break;
      case '--prefix':
        args.prefix = argv[++i];
        break;
      case '--repo-url':
        args.repoUrl = argv[++i];
        break;
      case '--no-interactive':
        args.interactive = false;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }

  return args;
}

function printUsage() {
  console.log(`
Usage: node scripts/onboard.js --work-dir <path> [options]

Options:
  --work-dir <path>    Path to the project directory (required)
  --name <slug>        Project slug (default: directory name, lowercased)
  --prefix <PREFIX>    Task prefix, e.g. FS (default: auto from name)
  --repo-url <url>     Git remote URL (default: from git remote)
  --no-interactive     Skip confirmation prompt
  --dry-run            Show plan without executing
  -h, --help           Show this help
`);
}

// --- Auto-detection helpers ---

function detectRepoUrl(workDir) {
  try {
    return execSync('git remote get-url origin', { cwd: workDir, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function deriveSlug(workDir) {
  return basename(resolve(workDir))
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function derivePrefix(slug) {
  // Take first letter of each word (split by - or _), uppercase, max 5 chars
  const words = slug.split(/[-_]/);
  let prefix = words.map(w => w[0] || '').join('').toUpperCase();
  if (prefix.length < 2 && slug.length >= 2) {
    prefix = slug.slice(0, 3).toUpperCase();
  }
  // Ensure starts with letter
  if (!/^[A-Z]/.test(prefix)) {
    prefix = 'P' + prefix;
  }
  return prefix.slice(0, 5);
}

function isValidRepoUrl(url) {
  // Accept https://, git://, ssh://, or git@host:path (SCP-style)
  return /^(https?:\/\/|git:\/\/|ssh:\/\/|git@[\w.-]+:)/.test(url);
}

// --- Interactive prompt ---

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function confirmParams(params) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n  Onboarding plan:');
  console.log(`  Project:   ${params.name}`);
  console.log(`  Prefix:    ${params.prefix}`);
  console.log(`  Repo:      ${params.repoUrl || '(not detected)'}`);
  console.log(`  workDir:   ${params.workDir}`);
  console.log();

  const nameAnswer = await ask(rl, `  Name [${params.name}]: `);
  if (nameAnswer) params.name = nameAnswer;

  const prefixAnswer = await ask(rl, `  Prefix [${params.prefix}]: `);
  if (prefixAnswer) params.prefix = prefixAnswer.toUpperCase();

  const repoAnswer = await ask(rl, `  Repo URL [${params.repoUrl || 'none'}]: `);
  if (repoAnswer) params.repoUrl = repoAnswer;

  const confirm = await ask(rl, '  Confirm? [Y/n] ');
  rl.close();

  if (confirm && confirm.toLowerCase() !== 'y' && confirm !== '') {
    console.log('  Aborted.');
    process.exit(0);
  }

  return params;
}

// --- Scaffold: create .neuroforge/ structure ---

function scaffoldStructure(workDir, projectMeta) {
  const neuroforgeDir = resolve(workDir, '.neuroforge');
  mkdirSync(neuroforgeDir, { recursive: true });
  mkdirSync(resolve(neuroforgeDir, 'docs'), { recursive: true });

  // Write project.json metadata
  writeFileSync(
    resolve(neuroforgeDir, 'project.json'),
    JSON.stringify(projectMeta, null, 2) + '\n',
  );

  // Copy onboarding checklist
  copyFileSync(
    resolve(TEMPLATES_DIR, 'onboarding-checklist.md'),
    resolve(neuroforgeDir, 'onboarding-checklist.md'),
  );
}

// --- Validation ---

function validate(params) {
  const errors = [];

  if (!params.workDir) {
    errors.push('--work-dir is required');
  } else if (!existsSync(params.workDir)) {
    errors.push(`workDir does not exist: ${params.workDir}`);
  }

  if (!params.name) {
    errors.push('Could not determine project name. Use --name.');
  } else if (!/^[a-z0-9_-]+$/.test(params.name)) {
    errors.push(`Invalid name "${params.name}". Must match [a-z0-9_-]+`);
  }

  if (!params.prefix) {
    errors.push('Could not determine prefix. Use --prefix.');
  } else if (!/^[A-Z][A-Z0-9]{0,9}$/.test(params.prefix.toUpperCase())) {
    errors.push(`Invalid prefix "${params.prefix}". Must be 1-10 uppercase letters/digits, starting with letter.`);
  }

  if (!params.repoUrl) {
    errors.push('Could not detect repo URL. Use --repo-url or run from a git directory.');
  } else if (!isValidRepoUrl(params.repoUrl)) {
    errors.push(`Invalid repo URL "${params.repoUrl}". Expected https://, git://, or ssh:// URL.`);
  }

  return errors;
}

// --- Main ---

async function main() {
  const args = parseArgs(process.argv);

  if (!args.workDir) {
    console.error('Error: --work-dir is required');
    printUsage();
    process.exit(1);
  }

  args.workDir = resolve(args.workDir);

  // Auto-detect defaults
  if (!args.name) args.name = deriveSlug(args.workDir);
  if (!args.prefix) args.prefix = derivePrefix(args.name);
  if (!args.repoUrl) args.repoUrl = detectRepoUrl(args.workDir);

  // Normalize prefix
  args.prefix = args.prefix ? args.prefix.toUpperCase() : args.prefix;

  // Interactive confirmation
  if (args.interactive && !args.dryRun) {
    await confirmParams(args);
  }

  // Validate
  const errors = validate(args);
  if (errors.length > 0) {
    console.error('\nValidation errors:');
    errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  }

  // Dry run
  if (args.dryRun) {
    console.log('\n  DRY RUN — no changes will be made\n');
    console.log(`  Would register project:`);
    console.log(`    name:    ${args.name}`);
    console.log(`    prefix:  ${args.prefix}`);
    console.log(`    repoUrl: ${args.repoUrl}`);
    console.log(`    workDir: ${args.workDir}`);
    console.log(`  Would create: ${args.workDir}/.neuroforge/`);
    console.log(`    - project.json`);
    console.log(`    - onboarding-checklist.md`);
    console.log();
    process.exit(0);
  }

  // --- Execute ---

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Error: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const pool = createPool(databaseUrl);
  const registrar = new ProjectRegistrar({ pool });

  try {
    // 1. Register in DB
    const result = await registrar.register({
      name: args.name,
      prefix: args.prefix,
      repoUrl: args.repoUrl,
      workDir: args.workDir,
    });

    console.log('\n  Project registered in DB');

    // 2. Create .neuroforge/ structure
    scaffoldStructure(args.workDir, {
      projectId: result.project.id,
      name: args.name,
      slug: args.name,
      prefix: result.project.prefix,
      repoUrl: args.repoUrl,
      createdAt: result.project.createdAt.toISOString(),
    });

    console.log('  .neuroforge/ created');
    console.log();
    console.log(`  API Key: ${result.apiKey.token}`);
    console.log('  (save it — it will not be shown again)');
    console.log();
    console.log('  Next step — run the onboarder agent:');
    console.log(`  cd "${args.workDir}" && claude -p "Выполни онбординг проекта" --system-prompt "${NEUROFORGE_ROOT}/.neuroforge/roles/onboarder.md"`);
    console.log();
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  } finally {
    await closePool();
  }
}

// Only run main() when executed directly, not when imported for testing
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('onboard.js') ||
  process.argv[1].endsWith('scripts/onboard')
);
if (isDirectRun) {
  main();
}

export { parseArgs, deriveSlug, derivePrefix, detectRepoUrl, isValidRepoUrl, validate, scaffoldStructure };
