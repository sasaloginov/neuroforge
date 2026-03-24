import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseArgs, deriveSlug, derivePrefix, validate, scaffoldStructure } from './onboard.js';

describe('parseArgs', () => {
  it('parses --work-dir', () => {
    const args = parseArgs(['node', 'script', '--work-dir', '/root/dev/test']);
    expect(args.workDir).toBe('/root/dev/test');
  });

  it('parses --name', () => {
    const args = parseArgs(['node', 'script', '--work-dir', '/x', '--name', 'my-project']);
    expect(args.name).toBe('my-project');
  });

  it('parses --prefix', () => {
    const args = parseArgs(['node', 'script', '--work-dir', '/x', '--prefix', 'MP']);
    expect(args.prefix).toBe('MP');
  });

  it('parses --repo-url', () => {
    const args = parseArgs(['node', 'script', '--work-dir', '/x', '--repo-url', 'https://github.com/test']);
    expect(args.repoUrl).toBe('https://github.com/test');
  });

  it('parses --no-interactive', () => {
    const args = parseArgs(['node', 'script', '--work-dir', '/x', '--no-interactive']);
    expect(args.interactive).toBe(false);
  });

  it('parses --dry-run', () => {
    const args = parseArgs(['node', 'script', '--work-dir', '/x', '--dry-run']);
    expect(args.dryRun).toBe(true);
  });

  it('defaults interactive to true', () => {
    const args = parseArgs(['node', 'script', '--work-dir', '/x']);
    expect(args.interactive).toBe(true);
  });
});

describe('deriveSlug', () => {
  it('derives slug from directory name', () => {
    expect(deriveSlug('/root/dev/flower_shop')).toBe('flower_shop');
  });

  it('lowercases and sanitizes', () => {
    expect(deriveSlug('/root/dev/My Project')).toBe('my-project');
  });

  it('removes leading/trailing hyphens', () => {
    expect(deriveSlug('/root/dev/-test-')).toBe('test');
  });

  it('collapses multiple hyphens', () => {
    expect(deriveSlug('/root/dev/a--b--c')).toBe('a-b-c');
  });
});

describe('derivePrefix', () => {
  it('derives prefix from multi-word slug', () => {
    expect(derivePrefix('flower-shop')).toBe('FS');
  });

  it('derives prefix from single word', () => {
    const result = derivePrefix('app');
    expect(result).toMatch(/^[A-Z]/);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('returns uppercase', () => {
    const result = derivePrefix('my-cool-project');
    expect(result).toBe(result.toUpperCase());
  });

  it('max 5 chars', () => {
    const result = derivePrefix('a-b-c-d-e-f-g');
    expect(result.length).toBeLessThanOrEqual(5);
  });
});

describe('validate', () => {
  it('returns empty array for valid params', () => {
    const errors = validate({
      workDir: '/root/dev',  // exists
      name: 'test-project',
      prefix: 'TP',
      repoUrl: 'https://github.com/test',
    });
    expect(errors).toEqual([]);
  });

  it('returns error for missing workDir', () => {
    const errors = validate({ workDir: null, name: 'test', prefix: 'TP', repoUrl: 'x' });
    expect(errors).toContainEqual(expect.stringContaining('--work-dir'));
  });

  it('returns error for non-existent workDir', () => {
    const errors = validate({ workDir: '/nonexistent/path', name: 'test', prefix: 'TP', repoUrl: 'x' });
    expect(errors).toContainEqual(expect.stringContaining('does not exist'));
  });

  it('returns error for invalid name', () => {
    const errors = validate({ workDir: '/root/dev', name: 'INVALID NAME!', prefix: 'TP', repoUrl: 'x' });
    expect(errors).toContainEqual(expect.stringContaining('Invalid name'));
  });

  it('returns error for invalid prefix', () => {
    const errors = validate({ workDir: '/root/dev', name: 'test', prefix: '123', repoUrl: 'x' });
    expect(errors).toContainEqual(expect.stringContaining('Invalid prefix'));
  });

  it('returns error for missing repoUrl', () => {
    const errors = validate({ workDir: '/root/dev', name: 'test', prefix: 'TP', repoUrl: null });
    expect(errors).toContainEqual(expect.stringContaining('repo URL'));
  });
});

describe('scaffoldStructure', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'onboard-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates .neuroforge directory', () => {
    scaffoldStructure(tmpDir, { projectId: 'test-id', slug: 'test', prefix: 'TP' });
    expect(existsSync(resolve(tmpDir, '.neuroforge'))).toBe(true);
  });

  it('creates project.json with metadata', () => {
    const meta = { projectId: 'uuid-123', slug: 'test', prefix: 'TP', repoUrl: 'https://x' };
    scaffoldStructure(tmpDir, meta);

    const content = JSON.parse(readFileSync(resolve(tmpDir, '.neuroforge/project.json'), 'utf-8'));
    expect(content.projectId).toBe('uuid-123');
    expect(content.slug).toBe('test');
    expect(content.prefix).toBe('TP');
  });

  it('copies onboarding checklist', () => {
    scaffoldStructure(tmpDir, { projectId: 'test-id' });
    const checklistPath = resolve(tmpDir, '.neuroforge/onboarding-checklist.md');
    expect(existsSync(checklistPath)).toBe(true);

    const content = readFileSync(checklistPath, 'utf-8');
    expect(content).toContain('Onboarding Checklist');
    expect(content).toContain('CLAUDE.md');
  });

  it('is idempotent (can run twice)', () => {
    const meta = { projectId: 'test-id' };
    scaffoldStructure(tmpDir, meta);
    scaffoldStructure(tmpDir, meta);
    expect(existsSync(resolve(tmpDir, '.neuroforge/project.json'))).toBe(true);
  });
});
