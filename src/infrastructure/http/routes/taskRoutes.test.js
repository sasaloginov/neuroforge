import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestServer, authHeader } from '../testHelper.js';
import { taskRoutes } from './taskRoutes.js';
import { TaskNotFoundError } from '../../../domain/errors/TaskNotFoundError.js';
import { InvalidStateError } from '../../../domain/errors/InvalidStateError.js';
import { InvalidTransitionError } from '../../../domain/errors/InvalidTransitionError.js';
import { ProjectNotFoundError } from '../../../domain/errors/ProjectNotFoundError.js';

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

function setup(useCaseOverrides = {}) {
  const useCases = buildUseCases(useCaseOverrides);
  const server = createTestServer({
    registerRoutes: (app) => {
      app.register(taskRoutes({ useCases }), { prefix: '/' });
    },
  });
  return { ...server, useCases };
}

describe('taskRoutes', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
  });

  // POST /tasks
  describe('POST /tasks', () => {
    it('creates a task and returns 202', async () => {
      const { app: a, useCases } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/tasks',
        headers: authHeader(),
        payload: { projectId: PROJECT_ID, title: 'New Task', description: 'Details' },
      });

      expect(res.statusCode).toBe(202);
      expect(res.json().taskId).toBe(TASK_ID);
      expect(useCases.createTask.execute).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: PROJECT_ID, title: 'New Task' }),
      );
    });

    it('returns 400 when title is missing', async () => {
      const { app: a } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/tasks',
        headers: authHeader(),
        payload: { projectId: PROJECT_ID },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when projectId is invalid format', async () => {
      const { app: a } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/tasks',
        headers: authHeader(),
        payload: { projectId: 'not-a-uuid', title: 'T' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when project not found', async () => {
      const { app: a } = setup({
        createTask: {
          execute: vi.fn().mockRejectedValue(new ProjectNotFoundError(PROJECT_ID)),
        },
      });
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/tasks',
        headers: authHeader(),
        payload: { projectId: PROJECT_ID, title: 'T' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 403 when scope does not match', async () => {
      const { app: a } = setup();
      // Use a scoped API key
      const scopedServer = createTestServer({
        registerRoutes: (f) => {
          f.register(taskRoutes({ useCases: buildUseCases() }), { prefix: '/' });
        },
      });
      // Override the apiKey's projectId to a different project
      const { ApiKey } = await import('../../../domain/entities/ApiKey.js');
      const { createHash } = await import('node:crypto');
      const scopedKey = new ApiKey({
        id: scopedServer.testApiKey.id,
        name: 'scoped-key',
        keyHash: scopedServer.testKeyHash,
        userId: scopedServer.testUser.id,
        projectId: '00000000-0000-0000-0000-000000000999', // different project
        expiresAt: null,
        createdAt: new Date('2025-01-01'),
      });
      scopedServer.apiKeyRepo.findByHash = async (hash) =>
        hash === scopedServer.testKeyHash ? scopedKey : null;

      app = scopedServer.app;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/tasks',
        headers: authHeader(),
        payload: { projectId: PROJECT_ID, title: 'T' },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // GET /tasks/:id
  describe('GET /tasks/:id', () => {
    it('returns task status 200', async () => {
      const { app: a } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: `/tasks/${TASK_ID}`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().task.id).toBe(TASK_ID);
    });

    it('returns 404 when task not found', async () => {
      const { app: a } = setup({
        getTaskStatus: {
          execute: vi.fn().mockRejectedValue(new TaskNotFoundError(TASK_ID)),
        },
      });
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: `/tasks/${TASK_ID}`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // POST /tasks/:id/reply
  describe('POST /tasks/:id/reply', () => {
    it('replies and returns 200', async () => {
      const { app: a, useCases } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/reply`,
        headers: authHeader(),
        payload: { answer: 'Yes, go ahead' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().taskId).toBe(TASK_ID);
      expect(useCases.replyToQuestion.execute).toHaveBeenCalled();
    });

    it('returns 409 when task is not waiting for reply', async () => {
      const { app: a } = setup({
        replyToQuestion: {
          execute: vi.fn().mockRejectedValue(new InvalidStateError('Task is not waiting for reply')),
        },
      });
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/reply`,
        headers: authHeader(),
        payload: { answer: 'Yes' },
      });

      expect(res.statusCode).toBe(409);
    });

    it('returns 400 when answer is missing', async () => {
      const { app: a } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/reply`,
        headers: authHeader(),
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // POST /tasks/:id/cancel
  describe('POST /tasks/:id/cancel', () => {
    it('cancels and returns 200', async () => {
      const { app: a } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/cancel`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().taskId).toBe(TASK_ID);
      expect(res.json().cancelledRuns).toBe(1);
    });

    it('returns 409 when task is already terminal', async () => {
      const { app: a } = setup({
        cancelTask: {
          execute: vi.fn().mockRejectedValue(new InvalidTransitionError('done', 'cancelled')),
        },
      });
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/cancel`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(409);
    });
  });
});
