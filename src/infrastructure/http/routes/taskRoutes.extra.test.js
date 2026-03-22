import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestServer, authHeader } from '../testHelper.js';
import { taskRoutes } from './taskRoutes.js';
import { TaskNotFoundError } from '../../../domain/errors/TaskNotFoundError.js';
import { ProjectNotFoundError } from '../../../domain/errors/ProjectNotFoundError.js';
import { ApiKey } from '../../../domain/entities/ApiKey.js';
import { createHash } from 'node:crypto';

const PROJECT_ID = '00000000-0000-0000-0000-000000000100';
const TASK_ID = '00000000-0000-0000-0000-000000000200';

function buildUseCases(overrides = {}) {
  return {
    createTask: {
      execute: vi.fn().mockResolvedValue({ taskId: TASK_ID, shortId: 'NF-1', status: 'in_progress' }),
    },
    getTaskStatus: {
      execute: vi.fn().mockResolvedValue({
        task: {
          id: TASK_ID,
          shortId: 'NF-1',
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
      execute: vi.fn().mockResolvedValue({ taskId: TASK_ID, shortId: 'NF-1', status: 'in_progress' }),
    },
    cancelTask: {
      execute: vi.fn().mockResolvedValue({ taskId: TASK_ID, shortId: 'NF-1', status: 'cancelled', cancelledRuns: 1 }),
    },
    ...overrides,
  };
}

function setup(useCaseOverrides = {}) {
  const useCases = buildUseCases(useCaseOverrides);
  const server = createTestServer({
    registerRoutes: (a) => a.register(taskRoutes({ useCases }), { prefix: '/' }),
  });
  return { ...server, useCases };
}

describe('taskRoutes — additional coverage', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('GET /tasks/:id passes short ID to getTaskStatus use case', async () => {
    const { app: a, useCases } = setup();
    app = a;
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/tasks/NF-3',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    // Short ID resolution now happens inside GetTaskStatus use case
    expect(useCases.getTaskStatus.execute).toHaveBeenCalledWith({ taskId: 'NF-3' });
  });

  it('GET /tasks/:id returns 404 when GetTaskStatus throws ProjectNotFoundError for unknown prefix', async () => {
    const { app: a } = setup({
      getTaskStatus: {
        execute: vi.fn().mockRejectedValue(new ProjectNotFoundError('UNKNOWN')),
      },
    });
    app = a;
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/tasks/UNKNOWN-1',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /tasks/:id/reply passes short ID through getTaskStatus', async () => {
    const { app: a, useCases } = setup();
    app = a;
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/tasks/NF-1/reply',
      headers: authHeader(),
      payload: { answer: 'Yes' },
    });
    expect(res.statusCode).toBe(200);
    expect(useCases.getTaskStatus.execute).toHaveBeenCalledWith({ taskId: 'NF-1' });
  });

  it('POST /tasks/:id/cancel returns 404 when task not found', async () => {
    const { app: a } = setup({
      getTaskStatus: {
        execute: vi.fn().mockRejectedValue(new TaskNotFoundError(TASK_ID)),
      },
    });
    app = a;
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
    const { app: a, useCases } = setup();
    app = a;
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
    const { app: a, useCases } = setup();
    app = a;
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeader(),
      payload: { projectId: PROJECT_ID, title: 'T', unknownField: 'xyz' },
    });
    expect(res.statusCode).toBe(202);
    const callArgs = useCases.createTask.execute.mock.calls[0][0];
    expect(callArgs.unknownField).toBeUndefined();
  });
});

// ─── POST /tasks/:id/restart — shortId coverage ───────────────────────────

describe('taskRoutes — restart endpoint', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
  });

  function setupWithRestart(overrides = {}) {
    const useCases = {
      createTask: {
        execute: vi.fn().mockResolvedValue({ taskId: TASK_ID, shortId: 'NF-1', status: 'in_progress' }),
      },
      getTaskStatus: {
        execute: vi.fn().mockResolvedValue({
          task: {
            id: TASK_ID,
            shortId: 'NF-1',
            projectId: PROJECT_ID,
            title: 'Test Task',
            status: 'failed',
            revisionCount: 0,
            createdAt: new Date('2025-01-01').toISOString(),
            updatedAt: new Date('2025-01-01').toISOString(),
          },
          runs: [],
        }),
      },
      getRunDetail: {
        execute: vi.fn().mockResolvedValue({}),
      },
      replyToQuestion: {
        execute: vi.fn().mockResolvedValue({ taskId: TASK_ID, shortId: 'NF-1', status: 'in_progress' }),
      },
      cancelTask: {
        execute: vi.fn().mockResolvedValue({ taskId: TASK_ID, shortId: 'NF-1', status: 'cancelled', cancelledRuns: 0 }),
      },
      restartTask: {
        execute: vi.fn().mockResolvedValue({
          taskId: TASK_ID,
          shortId: 'NF-1',
          status: 'in_progress',
          decision: { action: 'spawn_run', role: 'developer' },
        }),
      },
      ...overrides,
    };
    const server = createTestServer({
      registerRoutes: (f) => f.register(taskRoutes({ useCases }), { prefix: '/' }),
    });
    return { ...server, useCases };
  }

  it('POST /tasks/:id/restart returns 200 with shortId', async () => {
    const { app: a, useCases } = setupWithRestart();
    app = a;
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/restart`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().taskId).toBe(TASK_ID);
    expect(res.json().shortId).toBe('NF-1');
    expect(useCases.restartTask.execute).toHaveBeenCalledWith({ taskId: TASK_ID });
  });

  it('POST /tasks/NF-1/restart passes short ID through getTaskStatus', async () => {
    const { app: a, useCases } = setupWithRestart();
    app = a;
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/tasks/NF-1/restart',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(useCases.getTaskStatus.execute).toHaveBeenCalledWith({ taskId: 'NF-1' });
  });
});
