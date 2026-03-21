import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PgProjectRepo } from './PgProjectRepo.js';
import { createPool, closePool, getPool } from './pg.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('PgProjectRepo (integration)', () => {
  let repo;
  const testPrefix = `test-proj-${Date.now()}`;

  beforeAll(async () => {
    createPool(DATABASE_URL);
    repo = new PgProjectRepo();
  });

  afterAll(async () => {
    await getPool().query(`DELETE FROM projects WHERE name LIKE $1`, [`${testPrefix}%`]);
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`DELETE FROM projects WHERE name LIKE $1`, [`${testPrefix}%`]);
  });

  it('save + findById', async () => {
    const project = {
      id: crypto.randomUUID(),
      name: `${testPrefix}-one`,
      repoUrl: 'https://github.com/test/one',
      workDir: '/tmp/one',
      createdAt: new Date(),
    };
    await repo.save(project);

    const found = await repo.findById(project.id);
    expect(found).not.toBeNull();
    expect(found.name).toBe(project.name);
    expect(found.repoUrl).toBe('https://github.com/test/one');
    expect(found.workDir).toBe('/tmp/one');
  });

  it('findByName', async () => {
    const project = {
      id: crypto.randomUUID(),
      name: `${testPrefix}-named`,
      repoUrl: 'https://github.com/test/named',
      createdAt: new Date(),
    };
    await repo.save(project);

    const found = await repo.findByName(project.name);
    expect(found).not.toBeNull();
    expect(found.id).toBe(project.id);
  });

  it('findAll', async () => {
    const p1 = { id: crypto.randomUUID(), name: `${testPrefix}-a`, repoUrl: 'https://a', createdAt: new Date() };
    const p2 = { id: crypto.randomUUID(), name: `${testPrefix}-b`, repoUrl: 'https://b', createdAt: new Date() };
    await repo.save(p1);
    await repo.save(p2);

    const all = await repo.findAll();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it('save updates existing project', async () => {
    const project = {
      id: crypto.randomUUID(),
      name: `${testPrefix}-update`,
      repoUrl: 'https://original',
      createdAt: new Date(),
    };
    await repo.save(project);

    project.repoUrl = 'https://updated';
    await repo.save(project);

    const found = await repo.findById(project.id);
    expect(found.repoUrl).toBe('https://updated');
  });

  it('findById returns null for non-existent', async () => {
    const found = await repo.findById(crypto.randomUUID());
    expect(found).toBeNull();
  });
});
