import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectRegistrar } from './projectRegistrar.js';

// Mock the pg.js module so repos don't need real pool
vi.mock('../../src/infrastructure/persistence/pg.js', () => ({
  getPool: vi.fn(),
  createPool: vi.fn(),
  closePool: vi.fn(),
}));

// We need to intercept repo calls. Since repos use getPool() internally,
// we mock at the pool.query level.
import { getPool } from '../../src/infrastructure/persistence/pg.js';

describe('ProjectRegistrar', () => {
  let registrar;
  let mockQuery;

  beforeEach(() => {
    mockQuery = vi.fn();
    // getPool returns object with query method
    getPool.mockReturnValue({ query: mockQuery });

    // Default: no existing project
    mockQuery.mockResolvedValue({ rows: [] });

    registrar = new ProjectRegistrar({ pool: {} });
  });

  it('registers project, user, and api key', async () => {
    const result = await registrar.register({
      name: 'test-project',
      prefix: 'TP',
      repoUrl: 'https://github.com/user/test',
      workDir: '/root/dev/test',
    });

    expect(result.project).toBeDefined();
    expect(result.project.name).toBe('test-project');
    expect(result.project.prefix).toBe('TP');
    expect(result.project.repoUrl).toBe('https://github.com/user/test');
    expect(result.project.workDir).toBe('/root/dev/test');

    expect(result.user).toBeDefined();
    expect(result.user.name).toBe('test-project-agent');
    expect(result.user.role).toBe('member');

    expect(result.apiKey).toBeDefined();
    expect(result.apiKey.token).toMatch(/^nf_[a-f0-9]{64}$/);
    expect(result.apiKey.name).toBe('test-project-key');

    // Should have called query for: findByName, findByPrefix, save project, save user, save apiKey
    expect(mockQuery).toHaveBeenCalledTimes(5);
  });

  it('throws on duplicate project name', async () => {
    // First query (findByName) returns existing project
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'existing-id', name: 'test-project', prefix: 'TP', repo_url: 'x', work_dir: '/x', created_at: new Date() }],
    });

    await expect(registrar.register({
      name: 'test-project',
      prefix: 'TP',
      repoUrl: 'https://github.com/user/test',
      workDir: '/root/dev/test',
    })).rejects.toThrow('already exists');
  });

  it('throws on duplicate prefix', async () => {
    // findByName returns nothing
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // findByPrefix returns existing
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'existing-id', name: 'other', prefix: 'TP', repo_url: 'x', work_dir: '/x', created_at: new Date() }],
    });

    await expect(registrar.register({
      name: 'test-project',
      prefix: 'TP',
      repoUrl: 'https://github.com/user/test',
      workDir: '/root/dev/test',
    })).rejects.toThrow('prefix');
  });

  it('normalizes prefix to uppercase', async () => {
    const result = await registrar.register({
      name: 'test-project',
      prefix: 'tp',
      repoUrl: 'https://github.com/user/test',
      workDir: '/root/dev/test',
    });

    expect(result.project.prefix).toBe('TP');
  });
});
