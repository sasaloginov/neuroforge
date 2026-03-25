import { describe, it, expect } from 'vitest';
import { resolveWorkDir, assertBranchMatchesProject } from './resolveWorkDir.js';

describe('resolveWorkDir', () => {
  it('returns project.workDir when available', async () => {
    const result = await resolveWorkDir({ project: { workDir: '/root/bot/mybot' }, fallback: '/root/dev' });
    expect(result).toBe('/root/bot/mybot');
  });

  it('falls back to global workDir when project has no workDir', async () => {
    const result = await resolveWorkDir({ project: { workDir: null }, fallback: '/root/dev' });
    expect(result).toBe('/root/dev');
  });

  it('resolves from projectRepo when project not provided', async () => {
    const projectRepo = { findById: async () => ({ workDir: '/root/bot/mybot' }) };
    const result = await resolveWorkDir({ projectRepo, projectId: 'uuid', fallback: '/root/dev' });
    expect(result).toBe('/root/bot/mybot');
  });

  it('returns fallback when projectRepo returns null', async () => {
    const projectRepo = { findById: async () => null };
    const result = await resolveWorkDir({ projectRepo, projectId: 'uuid', fallback: '/root/dev' });
    expect(result).toBe('/root/dev');
  });

  it('returns null when nothing available', async () => {
    const result = await resolveWorkDir({});
    expect(result).toBeNull();
  });
});

describe('assertBranchMatchesProject', () => {
  it('passes when prefixes match', () => {
    expect(() => assertBranchMatchesProject('NF-23/some-feature', 'NF')).not.toThrow();
  });

  it('throws on prefix mismatch', () => {
    expect(() => assertBranchMatchesProject('BOT-19/knowledge-graph', 'NF'))
      .toThrow('Branch prefix mismatch');
  });

  it('includes both prefixes in error message', () => {
    expect(() => assertBranchMatchesProject('BOT-19/knowledge-graph', 'NF'))
      .toThrow(/prefix "BOT".*expects "NF"/);
  });

  it('skips check for non-standard branch names', () => {
    expect(() => assertBranchMatchesProject('feature/something', 'NF')).not.toThrow();
    expect(() => assertBranchMatchesProject('main', 'NF')).not.toThrow();
  });

  it('skips check when branchName is null/empty', () => {
    expect(() => assertBranchMatchesProject(null, 'NF')).not.toThrow();
    expect(() => assertBranchMatchesProject('', 'NF')).not.toThrow();
  });

  it('skips check when prefix is null/empty', () => {
    expect(() => assertBranchMatchesProject('BOT-19/something', null)).not.toThrow();
    expect(() => assertBranchMatchesProject('BOT-19/something', '')).not.toThrow();
  });

  it('handles multi-letter prefixes', () => {
    expect(() => assertBranchMatchesProject('MYBOT-5/fix', 'MYBOT')).not.toThrow();
    expect(() => assertBranchMatchesProject('MYBOT-5/fix', 'NF')).toThrow('Branch prefix mismatch');
  });
});
