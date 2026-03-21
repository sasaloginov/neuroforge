import { describe, it, expect, afterEach } from 'vitest';
import { createTestServer, authHeader } from './testHelper.js';

describe('authMiddleware — additional coverage', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns 401 for "Bearer " with empty token value', async () => {
    const server = createTestServer({
      registerRoutes: (f) => f.get('/test', async () => ({ ok: true })),
    });
    app = server.app;
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: 'Bearer ' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/Missing or invalid/);
  });

  it('returns 401 for "bearer" (lowercase scheme)', async () => {
    const server = createTestServer({
      registerRoutes: (f) => f.get('/test', async () => ({ ok: true })),
    });
    app = server.app;
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: 'bearer some-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('decorates request.apiKey with correct projectId for scoped key', async () => {
    const { ApiKey } = await import('../../domain/entities/ApiKey.js');
    const { createHash } = await import('node:crypto');

    const scopedKey = new ApiKey({
      id: '00000000-0000-0000-0000-000000000010',
      name: 'scoped',
      keyHash: createHash('sha256').update('test-token-123').digest('hex'),
      userId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000999',
      expiresAt: null,
      createdAt: new Date('2025-01-01'),
    });

    const server = createTestServer({
      registerRoutes: (f) => {
        f.get('/test', async (req) => ({
          scopedProjectId: req.apiKey.projectId,
        }));
      },
      apiKey: scopedKey,
    });

    // Override findByHash to return our scopedKey
    server.apiKeyRepo.findByHash = async (hash) =>
      hash === server.testKeyHash ? scopedKey : null;

    app = server.app;
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().scopedProjectId).toBe('00000000-0000-0000-0000-000000000999');
  });
});
