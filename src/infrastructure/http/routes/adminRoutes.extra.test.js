import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestServer, authHeader } from '../testHelper.js';
import { adminRoutes } from './adminRoutes.js';
import { User } from '../../../domain/entities/User.js';
import { ApiKey } from '../../../domain/entities/ApiKey.js';

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

describe('adminRoutes — additional coverage', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('DELETE /users/:id returns 403 for non-admin', async () => {
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
      method: 'DELETE',
      url: `/users/${USER_ID}`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(403);
  });

  it('DELETE /users/:id returns 400 for invalid UUID', async () => {
    const { app: a } = setup();
    app = a;
    await app.ready();

    const res = await app.inject({
      method: 'DELETE',
      url: '/users/not-a-uuid',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api-keys with expiresAt sets expiration', async () => {
    const { app: a, repos } = setup();
    app = a;
    await app.ready();

    const futureDate = '2030-01-01T00:00:00.000Z';
    const res = await app.inject({
      method: 'POST',
      url: '/api-keys',
      headers: authHeader(),
      payload: { name: 'expiring-key', expiresAt: futureDate },
    });

    expect(res.statusCode).toBe(201);
    expect(repos.apiKeyRepo.save).toHaveBeenCalled();
    // The saved key should have an expiresAt date
    const savedKey = repos.apiKeyRepo.save.mock.calls[0][0];
    expect(savedKey.expiresAt).toBeInstanceOf(Date);
  });

  it('POST /api-keys with projectId stores projectId', async () => {
    const { app: a, repos } = setup();
    app = a;
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api-keys',
      headers: authHeader(),
      payload: { name: 'scoped-key', projectId: PROJECT_ID },
    });

    expect(res.statusCode).toBe(201);
    const savedKey = repos.apiKeyRepo.save.mock.calls[0][0];
    expect(savedKey.projectId).toBe(PROJECT_ID);
  });

  it('admin can delete another user API key', async () => {
    const otherKey = new ApiKey({
      id: KEY_ID,
      name: 'other-key',
      keyHash: 'hash',
      userId: '00000000-0000-0000-0000-000000000002', // different user
      projectId: null,
      expiresAt: null,
      createdAt: new Date('2025-01-01'),
    });

    const { app: a, repos } = setup({
      apiKeyRepo: { findById: vi.fn().mockResolvedValue(otherKey) },
    });
    app = a;
    await app.ready();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api-keys/${KEY_ID}`,
      headers: authHeader(),
    });
    // Admin should be able to delete any key
    expect(res.statusCode).toBe(204);
  });

  it('DELETE /api-keys/:id returns 400 for invalid UUID', async () => {
    const { app: a } = setup();
    app = a;
    await app.ready();

    const res = await app.inject({
      method: 'DELETE',
      url: '/api-keys/not-a-uuid',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /users returns 400 when name too short (empty)', async () => {
    const { app: a } = setup();
    app = a;
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: authHeader(),
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /users strips unknown additional properties (Fastify default)', async () => {
    // NOTE: Fastify default AJV removes additional properties rather than rejecting.
    // Schemas have additionalProperties: false but Fastify's removeAdditional strips them.
    const { app: a, repos } = setup();
    app = a;
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: authHeader(),
      payload: { name: 'Test', role: 'member', extraField: 'bad' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Test');
  });

  it('POST /api-keys strips unknown additional properties (Fastify default)', async () => {
    const { app: a } = setup();
    app = a;
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api-keys',
      headers: authHeader(),
      payload: { name: 'k', unknownProp: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('k');
  });
});
