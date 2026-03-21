import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, authHeader } from './testHelper.js';
import { createHash } from 'node:crypto';
import { ApiKey } from '../../domain/entities/ApiKey.js';

describe('authMiddleware', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns 401 when no Authorization header', async () => {
    const server = createTestServer({
      registerRoutes: (f) => f.get('/test', async (req) => ({ ok: true })),
    });
    app = server.app;
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/Missing or invalid/);
  });

  it('returns 401 for malformed Authorization header', async () => {
    const server = createTestServer({
      registerRoutes: (f) => f.get('/test', async () => ({ ok: true })),
    });
    app = server.app;
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: 'Token abc' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for unknown token', async () => {
    const server = createTestServer({
      registerRoutes: (f) => f.get('/test', async () => ({ ok: true })),
    });
    app = server.app;
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: 'Bearer unknown-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/Invalid API key/);
  });

  it('returns 401 for expired token', async () => {
    const expiredApiKey = new ApiKey({
      id: '00000000-0000-0000-0000-000000000099',
      name: 'expired-key',
      keyHash: createHash('sha256').update('expired-token').digest('hex'),
      userId: '00000000-0000-0000-0000-000000000001',
      projectId: null,
      expiresAt: new Date('2020-01-01'),
      createdAt: new Date('2019-01-01'),
    });

    const server = createTestServer({
      registerRoutes: (f) => f.get('/test', async () => ({ ok: true })),
      apiKeyRepo: {
        findByHash: async () => expiredApiKey,
      },
    });
    app = server.app;
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: 'Bearer expired-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/expired/);
  });

  it('returns 401 when user not found', async () => {
    const server = createTestServer({
      registerRoutes: (f) => f.get('/test', async () => ({ ok: true })),
      userRepo: {
        findById: async () => null,
      },
    });
    app = server.app;
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/User not found/);
  });

  it('passes auth for valid token and decorates request', async () => {
    const server = createTestServer({
      registerRoutes: (f) => {
        f.get('/test', async (req) => ({
          userId: req.user.id,
          keyId: req.apiKey.id,
        }));
      },
    });
    app = server.app;
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe(server.testUser.id);
    expect(res.json().keyId).toBe(server.testApiKey.id);
  });

  it('skips auth for /health endpoint', async () => {
    const server = createTestServer();
    app = server.app;
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
});
