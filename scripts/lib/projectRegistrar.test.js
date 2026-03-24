import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectRegistrar } from './projectRegistrar.js';

describe('ProjectRegistrar', () => {
  let registrar;
  let mockClient;
  let mockPool;

  beforeEach(() => {
    mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
    };
    registrar = new ProjectRegistrar({ pool: mockPool });
  });

  it('registers project, user, and api key within a transaction', async () => {
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

    // Verify transaction flow: BEGIN, findByName, findByPrefix, INSERT project, INSERT user, INSERT apiKey, COMMIT
    const calls = mockClient.query.mock.calls.map(c => {
      const sql = c[0];
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return sql;
      if (sql.includes('SELECT') && sql.includes('name')) return 'SELECT_BY_NAME';
      if (sql.includes('SELECT') && sql.includes('prefix')) return 'SELECT_BY_PREFIX';
      if (sql.includes('INSERT INTO projects')) return 'INSERT_PROJECT';
      if (sql.includes('INSERT INTO users')) return 'INSERT_USER';
      if (sql.includes('INSERT INTO api_keys')) return 'INSERT_APIKEY';
      return sql;
    });
    expect(calls).toEqual([
      'BEGIN',
      'SELECT_BY_NAME',
      'SELECT_BY_PREFIX',
      'INSERT_PROJECT',
      'INSERT_USER',
      'INSERT_APIKEY',
      'COMMIT',
    ]);

    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it('throws on duplicate project name and rolls back', async () => {
    // findByName returns existing project
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'existing-id' }] }); // SELECT by name

    await expect(registrar.register({
      name: 'test-project',
      prefix: 'TP',
      repoUrl: 'https://github.com/user/test',
      workDir: '/root/dev/test',
    })).rejects.toThrow('already exists');

    // Verify ROLLBACK was called
    const lastQueryBeforeRelease = mockClient.query.mock.calls;
    expect(lastQueryBeforeRelease.some(c => c[0] === 'ROLLBACK')).toBe(true);
    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it('throws on duplicate prefix and rolls back', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT by name — none
      .mockResolvedValueOnce({ rows: [{ id: 'existing-id' }] }); // SELECT by prefix — exists

    await expect(registrar.register({
      name: 'test-project',
      prefix: 'TP',
      repoUrl: 'https://github.com/user/test',
      workDir: '/root/dev/test',
    })).rejects.toThrow('prefix');

    expect(mockClient.query.mock.calls.some(c => c[0] === 'ROLLBACK')).toBe(true);
    expect(mockClient.release).toHaveBeenCalledOnce();
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

  it('rolls back on insert failure', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT by name
      .mockResolvedValueOnce({ rows: [] }) // SELECT by prefix
      .mockRejectedValueOnce(new Error('DB write error')); // INSERT project fails

    await expect(registrar.register({
      name: 'test-project',
      prefix: 'TP',
      repoUrl: 'https://github.com/user/test',
      workDir: '/root/dev/test',
    })).rejects.toThrow('DB write error');

    expect(mockClient.query.mock.calls.some(c => c[0] === 'ROLLBACK')).toBe(true);
    expect(mockClient.release).toHaveBeenCalledOnce();
  });
});
