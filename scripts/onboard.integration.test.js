import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import pg from 'pg';
import { ProjectRegistrar } from './lib/projectRegistrar.js';
import { scaffoldStructure } from './onboard.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://bot:bot@localhost:5432/neuroforge';

/**
 * Integration tests — require running PostgreSQL.
 * Uses pg.Pool directly (not the singleton from pg.js) to avoid conflicts.
 * Skip individual tests if DB is not available.
 */

let pool;
let dbAvailable = false;

describe('onboard integration', () => {
  const createdProjectNames = [];

  beforeAll(async () => {
    try {
      pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
      await pool.query('SELECT 1');
      dbAvailable = true;
    } catch (err) {
      console.warn('[integration] DB not available, skipping tests:', err.message);
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  afterEach(async () => {
    if (!dbAvailable) return;
    // Cleanup created test data in reverse order (FK constraints)
    for (const name of createdProjectNames) {
      try {
        const { rows } = await pool.query('SELECT id FROM projects WHERE name = $1', [name]);
        if (rows.length > 0) {
          const projectId = rows[0].id;
          await pool.query('DELETE FROM api_keys WHERE project_id = $1', [projectId]);
          await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
        }
        await pool.query('DELETE FROM users WHERE name = $1', [`${name}-agent`]);
      } catch {
        // ignore cleanup errors
      }
    }
    createdProjectNames.length = 0;
  });

  it('full scaffold flow: register project in DB + create .neuroforge/', async ({ skip }) => {
    if (!dbAvailable) skip();

    const tmpDir = mkdtempSync(resolve(tmpdir(), 'onboard-int-'));
    const uniqueName = `test-int-${Date.now()}`;
    createdProjectNames.push(uniqueName);

    // Initialize as git repo for repoUrl detection
    execSync('git init && git remote add origin https://github.com/test/repo.git', {
      cwd: tmpDir,
      stdio: 'ignore',
    });

    const registrar = new ProjectRegistrar({ pool });

    // Register in DB
    const result = await registrar.register({
      name: uniqueName,
      prefix: 'TI',
      repoUrl: 'https://github.com/test/repo.git',
      workDir: tmpDir,
    });

    expect(result.project.id).toBeDefined();
    expect(result.project.name).toBe(uniqueName);
    expect(result.project.prefix).toBe('TI');
    expect(result.apiKey.token).toMatch(/^nf_/);

    // Verify in DB
    const { rows } = await pool.query('SELECT * FROM projects WHERE name = $1', [uniqueName]);
    expect(rows).toHaveLength(1);
    expect(rows[0].prefix).toBe('TI');
    expect(rows[0].work_dir).toBe(tmpDir);

    // Scaffold filesystem
    scaffoldStructure(tmpDir, {
      projectId: result.project.id,
      name: uniqueName,
      slug: uniqueName,
      prefix: 'TI',
      repoUrl: 'https://github.com/test/repo.git',
      createdAt: result.project.createdAt.toISOString(),
    });

    expect(existsSync(resolve(tmpDir, '.neuroforge/project.json'))).toBe(true);
    expect(existsSync(resolve(tmpDir, '.neuroforge/onboarding-checklist.md'))).toBe(true);

    const projectJson = JSON.parse(readFileSync(resolve(tmpDir, '.neuroforge/project.json'), 'utf-8'));
    expect(projectJson.projectId).toBe(result.project.id);
    expect(projectJson.prefix).toBe('TI');

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('duplicate name returns clear error', async ({ skip }) => {
    if (!dbAvailable) skip();

    const uniqueName = `test-dup-${Date.now()}`;
    createdProjectNames.push(uniqueName);

    const registrar = new ProjectRegistrar({ pool });

    await registrar.register({
      name: uniqueName,
      prefix: 'DU',
      repoUrl: 'https://github.com/test/dup.git',
      workDir: '/tmp',
    });

    await expect(registrar.register({
      name: uniqueName,
      prefix: 'DX',
      repoUrl: 'https://github.com/test/dup2.git',
      workDir: '/tmp',
    })).rejects.toThrow('already exists');
  });

  it('duplicate prefix returns clear error', async ({ skip }) => {
    if (!dbAvailable) skip();

    const uniqueName1 = `test-pfx1-${Date.now()}`;
    const uniqueName2 = `test-pfx2-${Date.now()}`;
    createdProjectNames.push(uniqueName1, uniqueName2);

    const registrar = new ProjectRegistrar({ pool });

    await registrar.register({
      name: uniqueName1,
      prefix: 'PX',
      repoUrl: 'https://github.com/test/pfx1.git',
      workDir: '/tmp',
    });

    await expect(registrar.register({
      name: uniqueName2,
      prefix: 'PX',
      repoUrl: 'https://github.com/test/pfx2.git',
      workDir: '/tmp',
    })).rejects.toThrow('prefix');
  });

  it('transaction rolls back all changes on failure', async ({ skip }) => {
    if (!dbAvailable) skip();

    const uniqueName = `test-rollback-${Date.now()}`;
    createdProjectNames.push(uniqueName);

    const registrar = new ProjectRegistrar({ pool });

    await registrar.register({
      name: uniqueName,
      prefix: 'RB',
      repoUrl: 'https://github.com/test/rb.git',
      workDir: '/tmp',
    });

    // Second register should fail on duplicate prefix — verify no partial data
    const uniqueName2 = `test-rollback2-${Date.now()}`;
    createdProjectNames.push(uniqueName2);

    await expect(registrar.register({
      name: uniqueName2,
      prefix: 'RB',
      repoUrl: 'https://github.com/test/rb2.git',
      workDir: '/tmp',
    })).rejects.toThrow('prefix');

    // Verify second project was NOT created (rolled back)
    const { rows } = await pool.query('SELECT * FROM projects WHERE name = $1', [uniqueName2]);
    expect(rows).toHaveLength(0);

    // Verify second user was NOT created (rolled back)
    const { rows: userRows } = await pool.query('SELECT * FROM users WHERE name = $1', [`${uniqueName2}-agent`]);
    expect(userRows).toHaveLength(0);
  });
});
