import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestServer, authHeader } from '../testHelper.js';
import { adminRoutes } from './adminRoutes.js';
import { User } from '../../../domain/entities/User.js';
import { ApiKey } from '../../../domain/entities/ApiKey.js';
import { createHash } from 'node:crypto';

const USER_ID = '00000000-0000-0000-0000-000000000001';
const KEY_ID = '00000000-0000-0000-0000-000000000010';
const PROJECT_ID = '00000000-0000-0000-0000-000000000100';

function buildRepos(overrides = {}) {
  const testApiKeyObj = new ApiKey({
    id: KEY_ID,
    name: 'test-key',
    keyHash: 'somehash',
    userId: USER_ID,
    projectId: null,
    expiresAt: null,
    createdAt: new Date('2025-01-01'),
  });

  return {
    userRepo: {
      findById: vi.fn().mockResolvedValue(null),
      findAll: vi.fn().mockResolvedValue([
        new User({ id: USER_ID, name: 'Admin', role: 'admin', createdAt: new Date('2025-01-01') }),
      ]),
      findByRole: vi.fn().mockResolvedValue([]),
      save: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      ...overrides.userRepo,
    },
    apiKeyRepo: {
      findByHash: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockResolvedValue(testApiKeyObj),
      findByUserId: vi.fn().mockResolvedValue([testApiKeyObj]),
      save: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      ...overrides.apiKeyRepo,
    },
    projectRepo: {
      findById: vi.fn().mockResolvedValue({ id: PROJECT_ID, name: 'test' }),
      ...overrides.projectRepo,
    },
  };
}

function setup(repoOverrides = {}, opts = {}) {
  const repos = buildRepos(repoOverrides);
  const server = createTestServer({
    user: opts.user,
    apiKey: opts.apiKey,
    registerRoutes: (app) => {
      app.register(adminRoutes({ repos }), { prefix: '/' });
    },
  });
  return { ...server, repos };
}

describe('adminRoutes', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
  });

  // POST /users
  describe('POST /users', () => {
    it('creates a user and returns 201 (admin)', async () => {
      const { app: a, repos } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeader(),
        payload: { name: 'New User', role: 'member' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().name).toBe('New User');
      expect(res.json().role).toBe('member');
      expect(repos.userRepo.save).toHaveBeenCalled();
    });

    it('returns 403 for non-admin', async () => {
      const memberUser = new User({
        id: USER_ID,
        name: 'Member',
        role: 'member',
        createdAt: new Date('2025-01-01'),
      });
      const { app: a } = setup({}, { user: memberUser });
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeader(),
        payload: { name: 'Test' },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // GET /users
  describe('GET /users', () => {
    it('lists users for admin', async () => {
      const { app: a } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/users',
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().users).toHaveLength(1);
    });

    it('returns 403 for non-admin', async () => {
      const memberUser = new User({
        id: USER_ID,
        name: 'Member',
        role: 'member',
        createdAt: new Date('2025-01-01'),
      });
      const { app: a } = setup({}, { user: memberUser });
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/users',
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // DELETE /users/:id
  describe('DELETE /users/:id', () => {
    it('deletes user for admin', async () => {
      const { app: a, repos } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'DELETE',
        url: `/users/${USER_ID}`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(204);
      expect(repos.userRepo.delete).toHaveBeenCalledWith(USER_ID);
    });
  });

  // POST /api-keys
  describe('POST /api-keys', () => {
    it('creates API key and returns token', async () => {
      const { app: a, repos } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/api-keys',
        headers: authHeader(),
        payload: { name: 'my-key' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().token).toMatch(/^nf_/);
      expect(res.json().name).toBe('my-key');
      expect(repos.apiKeyRepo.save).toHaveBeenCalled();
    });

    it('returns 404 for invalid projectId', async () => {
      const { app: a } = setup({
        projectRepo: { findById: vi.fn().mockResolvedValue(null) },
      });
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/api-keys',
        headers: authHeader(),
        payload: { name: 'key', projectId: PROJECT_ID },
      });

      expect(res.statusCode).toBe(404);
    });

    it('allows any authenticated user (member)', async () => {
      const memberUser = new User({
        id: USER_ID,
        name: 'Member',
        role: 'member',
        createdAt: new Date('2025-01-01'),
      });
      const { app: a } = setup({}, { user: memberUser });
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/api-keys',
        headers: authHeader(),
        payload: { name: 'member-key' },
      });

      expect(res.statusCode).toBe(201);
    });
  });

  // GET /api-keys
  describe('GET /api-keys', () => {
    it('lists own keys', async () => {
      const { app: a } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/api-keys',
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().apiKeys).toHaveLength(1);
      // Should NOT have token/keyHash in response
      expect(res.json().apiKeys[0].token).toBeUndefined();
      expect(res.json().apiKeys[0].keyHash).toBeUndefined();
    });
  });

  // DELETE /api-keys/:id
  describe('DELETE /api-keys/:id', () => {
    it('deletes own key', async () => {
      const { app: a, repos } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'DELETE',
        url: `/api-keys/${KEY_ID}`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(204);
      expect(repos.apiKeyRepo.delete).toHaveBeenCalledWith(KEY_ID);
    });

    it('returns 403 when deleting other user key (non-admin)', async () => {
      const memberUser = new User({
        id: '00000000-0000-0000-0000-000000000002', // different user
        name: 'Member',
        role: 'member',
        createdAt: new Date('2025-01-01'),
      });

      const otherKey = new ApiKey({
        id: KEY_ID,
        name: 'other-key',
        keyHash: 'hash',
        userId: USER_ID, // belongs to USER_ID, not the member
        projectId: null,
        expiresAt: null,
        createdAt: new Date('2025-01-01'),
      });

      const { app: a } = setup(
        { apiKeyRepo: { findById: vi.fn().mockResolvedValue(otherKey) } },
        { user: memberUser },
      );
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'DELETE',
        url: `/api-keys/${KEY_ID}`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 404 when key not found', async () => {
      const { app: a } = setup({
        apiKeyRepo: { findById: vi.fn().mockResolvedValue(null) },
      });
      app = a;
      await app.ready();

      const unknownId = '00000000-0000-0000-0000-000000000099';
      const res = await app.inject({
        method: 'DELETE',
        url: `/api-keys/${unknownId}`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
