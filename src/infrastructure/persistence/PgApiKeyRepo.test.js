import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PgApiKeyRepo } from './PgApiKeyRepo.js';
import { createPool, closePool, getPool } from './pg.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('PgApiKeyRepo (integration)', () => {
  let repo;
  let userId;
  const keyIds = [];

  beforeAll(async () => {
    createPool(DATABASE_URL);
    repo = new PgApiKeyRepo();

    userId = crypto.randomUUID();
    await getPool().query(
      `INSERT INTO users (id, name, role) VALUES ($1, $2, $3)`,
      [userId, 'API Key Test User', 'admin'],
    );
  });

  afterAll(async () => {
    for (const id of keyIds) {
      await getPool().query('DELETE FROM api_keys WHERE id = $1', [id]);
    }
    await getPool().query('DELETE FROM users WHERE id = $1', [userId]);
    await closePool();
  });

  beforeEach(async () => {
    for (const id of keyIds) {
      await getPool().query('DELETE FROM api_keys WHERE id = $1', [id]);
    }
    keyIds.length = 0;
  });

  it('save + findByHash', async () => {
    const apiKey = {
      id: crypto.randomUUID(),
      name: 'test-key',
      keyHash: 'hash-' + crypto.randomUUID(),
      userId,
      projectId: null,
      expiresAt: null,
      createdAt: new Date(),
    };
    keyIds.push(apiKey.id);
    await repo.save(apiKey);

    const found = await repo.findByHash(apiKey.keyHash);
    expect(found).not.toBeNull();
    expect(found.name).toBe('test-key');
    expect(found.userId).toBe(userId);
  });

  it('findByUserId', async () => {
    const k1 = {
      id: crypto.randomUUID(),
      name: 'key1',
      keyHash: 'hash1-' + crypto.randomUUID(),
      userId,
      createdAt: new Date(),
    };
    const k2 = {
      id: crypto.randomUUID(),
      name: 'key2',
      keyHash: 'hash2-' + crypto.randomUUID(),
      userId,
      createdAt: new Date(),
    };
    keyIds.push(k1.id, k2.id);
    await repo.save(k1);
    await repo.save(k2);

    const keys = await repo.findByUserId(userId);
    expect(keys).toHaveLength(2);
  });

  it('delete', async () => {
    const apiKey = {
      id: crypto.randomUUID(),
      name: 'del-key',
      keyHash: 'hash-del-' + crypto.randomUUID(),
      userId,
      createdAt: new Date(),
    };
    keyIds.push(apiKey.id);
    await repo.save(apiKey);
    await repo.delete(apiKey.id);

    const found = await repo.findByHash(apiKey.keyHash);
    expect(found).toBeNull();
  });

  it('findByHash returns null for non-existent', async () => {
    const found = await repo.findByHash('nonexistent-hash');
    expect(found).toBeNull();
  });
});
