import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Task } from '../../domain/entities/Task.js';
import { PgTaskRepo } from './PgTaskRepo.js';
import { createPool, closePool, getPool } from './pg.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('PgTaskRepo (integration)', () => {
  let repo;
  let projectId;

  beforeAll(async () => {
    createPool(DATABASE_URL);
    repo = new PgTaskRepo();

    // ensure a project exists for FK
    projectId = crypto.randomUUID();
    await getPool().query(
      `INSERT INTO projects (id, name, repo_url) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [projectId, `test-project-${projectId.slice(0, 8)}`, 'https://github.com/test/repo'],
    );
  });

  afterAll(async () => {
    await getPool().query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
    await getPool().query('DELETE FROM projects WHERE id = $1', [projectId]);
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
  });

  it('save + findById', async () => {
    const task = Task.create({
      projectId,
      title: 'Test Task',
      description: 'A test',
      callbackUrl: 'https://example.com/cb',
      callbackMeta: { key: 'value' },
    });

    await repo.save(task);
    const found = await repo.findById(task.id);

    expect(found).not.toBeNull();
    expect(found.id).toBe(task.id);
    expect(found.title).toBe('Test Task');
    expect(found.description).toBe('A test');
    expect(found.status).toBe('pending');
    expect(found.callbackMeta).toEqual({ key: 'value' });
  });

  it('save updates existing task', async () => {
    const task = Task.create({ projectId, title: 'Original' });
    await repo.save(task);

    task.title = 'Updated';
    task.transitionTo('in_progress');
    await repo.save(task);

    const found = await repo.findById(task.id);
    expect(found.title).toBe('Updated');
    expect(found.status).toBe('in_progress');
  });

  it('findByProjectId', async () => {
    const t1 = Task.create({ projectId, title: 'T1' });
    const t2 = Task.create({ projectId, title: 'T2' });
    await repo.save(t1);
    await repo.save(t2);

    const tasks = await repo.findByProjectId(projectId);
    expect(tasks).toHaveLength(2);
  });

  it('findByProjectId with status filter', async () => {
    const t1 = Task.create({ projectId, title: 'T1' });
    const t2 = Task.create({ projectId, title: 'T2' });
    t2.transitionTo('in_progress');
    await repo.save(t1);
    await repo.save(t2);

    const tasks = await repo.findByProjectId(projectId, { status: 'in_progress' });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('T2');
  });

  it('delete', async () => {
    const task = Task.create({ projectId, title: 'To Delete' });
    await repo.save(task);
    await repo.delete(task.id);

    const found = await repo.findById(task.id);
    expect(found).toBeNull();
  });

  it('findById returns null for non-existent', async () => {
    const found = await repo.findById(crypto.randomUUID());
    expect(found).toBeNull();
  });
});
