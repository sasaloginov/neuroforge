import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestServer, authHeader } from '../testHelper.js';
import { taskRoutes } from './taskRoutes.js';
import { TaskNotFoundError } from '../../../domain/errors/TaskNotFoundError.js';
import { ApiKey } from '../../../domain/entities/ApiKey.js';
import { createHash } from 'node:crypto';

const PROJECT_ID = '00000000-0000-0000-0000-000000000100';
const TASK_ID = '00000000-0000-0000-0000-000000000200';

function buildUseCases(overrides = {}) {
  return {
    createTask: {
      execute: vi.fn().mockResolvedValue({ taskId: TASK_ID, status: 'in_progress' }),
    },
    getTaskStatus: {
      execute: vi.fn().mockResolvedValue({
        task: {
          id: TASK_ID,
          projectId: PROJECT_ID,
          title: 'Test Task',
          status: 'in_progress',
          revisionCount: 0,
          createdAt: new Date('2025-01-01').toISOString(),
          updatedAt: new Date('2025-01-01').toISOString(),
        },
        runs: [],
      }),
    },
    replyToQuestion: {
      execute: vi.fn().mockResolvedValue({ taskId: TASK_ID, status: 'in_progress' }),
    },
    cancelTask: {
      execute: vi.fn().mockResolvedValue({ taskId: TASK_ID, status: 'cancelled', cancelledRuns: 1 }),
    },
    ...overrides,
  };
}

describe('taskRoutes — additional coverage', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('GET /tasks/:id returns 400 for invalid UUID param', async () => {
    const useCases = buildUseCases();
    const server = createTestServer({
      registerRoutes: (a) => a.register(taskRoutes({ useCases }), { prefix: '/' }),
    });
    app = server.app;
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/tasks/not-a-uuid',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /tasks/:id/reply returns 400 for invalid UUID param', async () => {
    const useCases = buildUseCases();
    const server = createTestServer({
      registerRoutes: (a) => a.register(taskRoutes({ useCases }), { prefix: '/' }),
    });
    app = server.app;
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/tasks/not-a-uuid/reply',
      headers: authHeader(),
      payload: { answer: 'Yes' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /tasks/:id/cancel returns 404 when task not found', async () => {
    const useCases = buildUseCases({
      getTaskStatus: {
        execute: vi.fn().mockRejectedValue(new TaskNotFoundError(TASK_ID)),
      },
    });
    const server = createTestServer({
      registerRoutes: (a) => a.register(taskRoutes({ useCases }), { prefix: '/' }),
    });
    app = server.app;
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/cancel`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /tasks/:id returns 403 when scoped key does not match task project', async () => {
    const useCases = buildUseCases(); // task belongs to PROJECT_ID

    const scopedKey = new ApiKey({
      id: '00000000-0000-0000-0000-000000000010',
      name: 'scoped-key',
      keyHash: createHash('sha256').update('test-token-123').digest('hex'),
      userId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000999', // different project
      expiresAt: null,
      createdAt: new Date('2025-01-01'),
    });

    const server = createTestServer({
      apiKey: scopedKey,
      registerRoutes: (a) => a.register(taskRoutes({ useCases }), { prefix: '/' }),
    });

    server.apiKeyRepo.findByHash = async (hash) =>
      hash === server.testKeyHash ? scopedKey : null;

    app = server.app;
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/tasks/${TASK_ID}`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /tasks with callbackUrl passes it to use case', async () => {
    const useCases = buildUseCases();
    const server = createTestServer({
      registerRoutes: (a) => a.register(taskRoutes({ useCases }), { prefix: '/' }),
    });
    app = server.app;
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeader(),
      payload: {
        projectId: PROJECT_ID,
        title: 'Task with callback',
        callbackUrl: 'https://example.com/webhook',
      },
    });

    expect(res.statusCode).toBe(202);
    expect(useCases.createTask.execute).toHaveBeenCalledWith(
      expect.objectContaining({ callbackUrl: 'https://example.com/webhook' }),
    );
  });

  it('POST /tasks ignores additional unknown properties (Fastify default removeAdditional)', async () => {
    // NOTE: Fastify default AJV config removes additional properties rather than rejecting.
    // The schema has additionalProperties: false, but Fastify's removeAdditional strips them.
    // If strict rejection is desired, server must set ajv option removeAdditional: false.
    const useCases = buildUseCases();
    const server = createTestServer({
      registerRoutes: (a) => a.register(taskRoutes({ useCases }), { prefix: '/' }),
    });
    app = server.app;
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeader(),
      payload: { projectId: PROJECT_ID, title: 'T', unknownField: 'xyz' },
    });
    // Additional properties are stripped, not rejected
    expect(res.statusCode).toBe(202);
    // The unknown field should not be passed to the use case
    const callArgs = useCases.createTask.execute.mock.calls[0][0];
    expect(callArgs.unknownField).toBeUndefined();
  });
});
