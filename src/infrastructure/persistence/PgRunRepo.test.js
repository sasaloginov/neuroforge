import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Run } from '../../domain/entities/Run.js';
import { PgRunRepo } from './PgRunRepo.js';
import { createPool, closePool, getPool } from './pg.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('PgRunRepo (integration)', () => {
  let repo;
  let projectId;
  let taskId;
  let sessionId;

  beforeAll(async () => {
    createPool(DATABASE_URL);
    repo = new PgRunRepo();

    projectId = crypto.randomUUID();
    taskId = crypto.randomUUID();
    sessionId = crypto.randomUUID();

    await getPool().query(
      `INSERT INTO projects (id, name, prefix, repo_url) VALUES ($1, $2, $3, $4)`,
      [projectId, `test-proj-run-${projectId.slice(0, 8)}`, 'TSTRUN', 'https://github.com/test/repo'],
    );
    await getPool().query(
      `INSERT INTO tasks (id, project_id, title, seq_number) VALUES ($1, $2, $3, $4)`,
      [taskId, projectId, 'Test Task for Runs', 1],
    );
    await getPool().query(
      `INSERT INTO sessions (id, project_id, role_name, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, projectId, 'analyst', 'active', new Date(), new Date()],
    );
  });

  afterAll(async () => {
    await getPool().query('DELETE FROM runs WHERE task_id = $1', [taskId]);
    await getPool().query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    await getPool().query('DELETE FROM tasks WHERE id = $1', [taskId]);
    await getPool().query('DELETE FROM projects WHERE id = $1', [projectId]);
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query('DELETE FROM runs WHERE task_id = $1', [taskId]);
  });

  it('save + findById', async () => {
    const run = Run.create({
      taskId,
      roleName: 'analyst',
      prompt: 'Analyze this',
      callbackUrl: 'https://example.com/cb',
      callbackMeta: { chatId: 42 },
    });

    await repo.save(run);
    const found = await repo.findById(run.id);

    expect(found).not.toBeNull();
    expect(found.id).toBe(run.id);
    expect(found.roleName).toBe('analyst');
    expect(found.status).toBe('queued');
    expect(found.callbackMeta).toEqual({ chatId: 42 });
  });

  it('preserves null callbackMeta', async () => {
    const run = Run.create({ taskId, roleName: 'analyst', prompt: 'p' });
    await repo.save(run);
    const found = await repo.findById(run.id);
    expect(found.callbackMeta).toBeNull();
  });

  it('findByTaskId', async () => {
    const r1 = Run.create({ taskId, roleName: 'analyst', prompt: 'p1' });
    const r2 = Run.create({ taskId, roleName: 'developer', prompt: 'p2' });
    await repo.save(r1);
    await repo.save(r2);

    const runs = await repo.findByTaskId(taskId);
    expect(runs).toHaveLength(2);
  });

  it('findRunning', async () => {
    const r1 = Run.create({ taskId, roleName: 'analyst', prompt: 'p1' });
    r1.start(sessionId);
    await repo.save(r1);

    const running = await repo.findRunning();
    expect(running.length).toBeGreaterThanOrEqual(1);
    expect(running.some((r) => r.id === r1.id)).toBe(true);
  });

  it('save updates existing run', async () => {
    const run = Run.create({ taskId, roleName: 'analyst', prompt: 'p1' });
    await repo.save(run);

    run.start(sessionId);
    await repo.save(run);

    const found = await repo.findById(run.id);
    expect(found.status).toBe('running');
    expect(found.sessionId).toBe(sessionId);
  });

  it('takeNext dequeues the oldest queued run', async () => {
    const r1 = Run.create({ taskId, roleName: 'analyst', prompt: 'first' });
    const r2 = Run.create({ taskId, roleName: 'developer', prompt: 'second' });
    await repo.save(r1);
    // small delay to ensure ordering
    await new Promise((r) => setTimeout(r, 10));
    await repo.save(r2);

    const taken = await repo.takeNext();
    expect(taken).not.toBeNull();
    expect(taken.id).toBe(r1.id);
    expect(taken.status).toBe('running');
    expect(taken.startedAt).toBeInstanceOf(Date);

    // verify it's no longer queued in DB
    const afterTake = await repo.findById(r1.id);
    expect(afterTake.status).toBe('running');
  });

  it('takeNext returns null when queue is empty', async () => {
    const taken = await repo.takeNext();
    expect(taken).toBeNull();
  });

  it('takeNext skips locked rows', async () => {
    const r1 = Run.create({ taskId, roleName: 'analyst', prompt: 'p1' });
    const r2 = Run.create({ taskId, roleName: 'developer', prompt: 'p2' });
    await repo.save(r1);
    await new Promise((r) => setTimeout(r, 10));
    await repo.save(r2);

    // Take both concurrently — they should get different runs
    const [taken1, taken2] = await Promise.all([
      repo.takeNext(),
      repo.takeNext(),
    ]);

    const ids = [taken1?.id, taken2?.id].filter(Boolean);
    // Each should be unique (no duplicates)
    expect(new Set(ids).size).toBe(ids.length);
  });
});
