import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { healthRoutes } from './healthRoutes.js';

function buildApp({ dbResult, schedulerResult, version = '1.2.3', startedAt } = {}) {
  const checkers = {
    database: {
      check: async () => dbResult ?? { status: 'ok', latencyMs: 5 },
    },
    scheduler: {
      check: () => schedulerResult ?? { status: 'ok', activeWorkers: 1 },
    },
  };

  const app = Fastify({ logger: false });
  app.register(healthRoutes({
    checkers,
    version,
    startedAt: startedAt ?? new Date(),
  }));
  return app;
}

describe('GET /health', () => {
  it('returns shallow ok without detailed param', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns detailed ok when all components healthy', async () => {
    const startedAt = new Date(Date.now() - 60_000);
    const app = buildApp({ startedAt, version: '2.0.0' });

    const res = await app.inject({ method: 'GET', url: '/health?detailed' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('2.0.0');
    expect(body.uptime).toBeGreaterThanOrEqual(59);
    expect(body.components.database.status).toBe('ok');
    expect(body.components.scheduler.status).toBe('ok');
  });

  it('returns 503 when database is in error', async () => {
    const app = buildApp({
      dbResult: { status: 'error', latencyMs: 3001, error: 'timeout' },
    });

    const res = await app.inject({ method: 'GET', url: '/health?detailed=true' });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.components.database.status).toBe('error');
    expect(body.components.scheduler.status).toBe('ok');
  });

  it('returns 503 when scheduler is in error', async () => {
    const app = buildApp({
      schedulerResult: { status: 'error', activeWorkers: 0 },
    });

    const res = await app.inject({ method: 'GET', url: '/health?detailed=true' });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.components.scheduler.status).toBe('error');
  });

  it('includes version and uptime fields in detailed response', async () => {
    const startedAt = new Date(Date.now() - 120_000);
    const app = buildApp({ version: '3.1.4', startedAt });

    const res = await app.inject({ method: 'GET', url: '/health?detailed' });
    const body = res.json();

    expect(body.version).toBe('3.1.4');
    expect(body.uptime).toBeGreaterThanOrEqual(119);
  });
});
