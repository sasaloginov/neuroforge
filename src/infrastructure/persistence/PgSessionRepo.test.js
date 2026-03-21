import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Session } from '../../domain/entities/Session.js';
import { PgSessionRepo } from './PgSessionRepo.js';
import { createPool, closePool, getPool } from './pg.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('PgSessionRepo (integration)', () => {
  let repo;
  let projectId;

  beforeAll(async () => {
    createPool(DATABASE_URL);
    repo = new PgSessionRepo();

    projectId = crypto.randomUUID();
    await getPool().query(
      `INSERT INTO projects (id, name, repo_url) VALUES ($1, $2, $3)`,
      [projectId, `test-proj-sess-${projectId.slice(0, 8)}`, 'https://github.com/test/repo'],
    );
  });

  afterAll(async () => {
    await getPool().query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
    await getPool().query('DELETE FROM projects WHERE id = $1', [projectId]);
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
  });

  it('save + findById', async () => {
    const session = Session.create({ projectId, roleName: 'analyst', cliSessionId: 'cli-123' });
    await repo.save(session);

    const found = await repo.findById(session.id);
    expect(found).not.toBeNull();
    expect(found.id).toBe(session.id);
    expect(found.roleName).toBe('analyst');
    expect(found.status).toBe('active');
    expect(found.cliSessionId).toBe('cli-123');
  });

  it('findByProjectAndRole', async () => {
    const session = Session.create({ projectId, roleName: 'developer' });
    await repo.save(session);

    const found = await repo.findByProjectAndRole(projectId, 'developer');
    expect(found).not.toBeNull();
    expect(found.id).toBe(session.id);
  });

  it('findByProjectAndRole returns null for non-existent', async () => {
    const found = await repo.findByProjectAndRole(projectId, 'non-existent');
    expect(found).toBeNull();
  });

  it('save updates existing session', async () => {
    const session = Session.create({ projectId, roleName: 'analyst' });
    await repo.save(session);

    session.close();
    await repo.save(session);

    const found = await repo.findById(session.id);
    expect(found.status).toBe('closed');
  });

  it('delete', async () => {
    const session = Session.create({ projectId, roleName: 'tester' });
    await repo.save(session);
    await repo.delete(session.id);

    const found = await repo.findById(session.id);
    expect(found).toBeNull();
  });
});
