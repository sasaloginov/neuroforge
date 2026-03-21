import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PgUserRepo } from './PgUserRepo.js';
import { createPool, closePool, getPool } from './pg.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('PgUserRepo (integration)', () => {
  let repo;
  const ids = [];

  beforeAll(async () => {
    createPool(DATABASE_URL);
    repo = new PgUserRepo();
  });

  afterAll(async () => {
    for (const id of ids) {
      await getPool().query('DELETE FROM users WHERE id = $1', [id]);
    }
    await closePool();
  });

  beforeEach(async () => {
    for (const id of ids) {
      await getPool().query('DELETE FROM users WHERE id = $1', [id]);
    }
    ids.length = 0;
  });

  it('save + findById', async () => {
    const user = { id: crypto.randomUUID(), name: 'Test User', role: 'admin', createdAt: new Date() };
    ids.push(user.id);
    await repo.save(user);

    const found = await repo.findById(user.id);
    expect(found).not.toBeNull();
    expect(found.name).toBe('Test User');
    expect(found.role).toBe('admin');
  });

  it('findByRole', async () => {
    const u1 = { id: crypto.randomUUID(), name: 'Admin1', role: 'admin', createdAt: new Date() };
    const u2 = { id: crypto.randomUUID(), name: 'Member1', role: 'member', createdAt: new Date() };
    ids.push(u1.id, u2.id);
    await repo.save(u1);
    await repo.save(u2);

    const admins = await repo.findByRole('admin');
    expect(admins.some((u) => u.id === u1.id)).toBe(true);
    expect(admins.every((u) => u.role === 'admin')).toBe(true);
  });

  it('delete', async () => {
    const user = { id: crypto.randomUUID(), name: 'Del User', role: 'member', createdAt: new Date() };
    ids.push(user.id);
    await repo.save(user);
    await repo.delete(user.id);

    const found = await repo.findById(user.id);
    expect(found).toBeNull();
  });
});
