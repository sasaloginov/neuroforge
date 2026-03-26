import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestServer, authHeader } from '../testHelper.js';
import { taskRoutes } from './taskRoutes.js';
import { TaskNotFoundError } from '../../../domain/errors/TaskNotFoundError.js';
import { RunNotFoundError } from '../../../domain/errors/RunNotFoundError.js';
import { InvalidStateError } from '../../../domain/errors/InvalidStateError.js';
import { InvalidTransitionError } from '../../../domain/errors/InvalidTransitionError.js';
import { ProjectNotFoundError } from '../../../domain/errors/ProjectNotFoundError.js';

const PROJECT_ID = '00000000-0000-0000-0000-000000000100';
const TASK_ID = '00000000-0000-0000-0000-000000000200';
const RUN_ID = '00000000-0000-0000-0000-000000000300';
const CALLBACK_URL = 'https://example.com/callback';

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
    getRunDetail: {
      execute: vi.fn().mockResolvedValue({
        task: { id: TASK_ID, projectId: PROJECT_ID },
        run: {
          id: RUN_ID,
          taskId: TASK_ID,
          roleName: 'analyst',
          status: 'done',
          response: 'Analysis result',
          error: null,
          startedAt: new Date('2025-01-01T10:00:00').toISOString(),
          finishedAt: new Date('2025-01-01T10:05:00').toISOString(),
          durationMs: 300000,
          createdAt: new Date('2025-01-01').toISOString(),
        },
      }),
    },
    replyToQuestion: {
      execute: vi.fn().mockResolvedValue({ taskId: TASK_ID, shortId: 'NF-1', status: 'in_progress' }),
    },
    resumeResearch: {
      execute: vi.fn().mockResolvedValue({ taskId: TASK_ID, shortId: 'NF-1', status: 'in_progress' }),
    },
    resumeTask: {
      execute: vi.fn().mockResolvedValue({ taskId: TASK_ID, shortId: 'NF-1', status: 'in_progress', decision: { action: 'spawn_run', role: 'developer' } }),
    },
    enqueueTask: {
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
        payload: { projectId: PROJECT_ID, title: 'New Task', description: 'Details', callbackUrl: CALLBACK_URL },
      });

      expect(res.statusCode).toBe(202);
      expect(res.json().taskId).toBe(TASK_ID);
      expect(useCases.createTask.execute).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: PROJECT_ID, title: 'New Task' }),
      );
    });

    it('passes callbackMeta to createTask use case', async () => {
      const { app: a, useCases } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/tasks',
        headers: authHeader(),
        payload: {
          projectId: PROJECT_ID,
          title: 'Test Task',
          callbackUrl: 'https://example.com/cb',
          callbackMeta: { telegramChatId: 555, threadId: 42 },
        },
      });

      expect(res.statusCode).toBe(202);
      expect(useCases.createTask.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackMeta: { telegramChatId: 555, threadId: 42 },
        }),
      );
    });

    it('works without callbackMeta in request body', async () => {
      const { app: a, useCases } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/tasks',
        headers: authHeader(),
        payload: { projectId: PROJECT_ID, title: 'No meta task', callbackUrl: CALLBACK_URL },
      });

      expect(res.statusCode).toBe(202);
      expect(useCases.createTask.execute).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'No meta task' }),
      );
    });

    it('accepts mode: research and passes to use case', async () => {
      const { app: a, useCases } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/tasks',
        headers: authHeader(),
        payload: { projectId: PROJECT_ID, title: 'Research task', mode: 'research', callbackUrl: CALLBACK_URL },
      });

      expect(res.statusCode).toBe(202);
      expect(useCases.createTask.execute).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'research' }),
      );
    });

    it('rejects invalid mode value', async () => {
      const { app: a } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/tasks',
        headers: authHeader(),
        payload: { projectId: PROJECT_ID, title: 'T', mode: 'invalid', callbackUrl: CALLBACK_URL },
      });

      expect(res.statusCode).toBe(400);
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

    it('returns 400 when callbackUrl is missing', async () => {
      const { app: a } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/tasks',
        headers: authHeader(),
        payload: { projectId: PROJECT_ID, title: 'Task without callback' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when callbackUrl uses non-http scheme', async () => {
      const { app: a } = setup();
      app = a;
      await app.ready();

      for (const url of ['file:///etc/passwd', 'ftp://internal/data', 'gopher://evil']) {
        const res = await app.inject({
          method: 'POST',
          url: '/tasks',
          headers: authHeader(),
          payload: { projectId: PROJECT_ID, title: 'T', callbackUrl: url },
        });

        expect(res.statusCode).toBe(400);
      }
    });

    it('returns 400 when callbackUrl points to private/internal IP', async () => {
      const { app: a } = setup();
      app = a;
      await app.ready();

      const privateUrls = [
        'https://127.0.0.1/callback',
        'https://10.0.0.1/callback',
        'https://172.16.0.1/callback',
        'https://192.168.1.1/callback',
        'https://169.254.169.254/latest/meta-data/',
        'https://localhost/callback',
      ];

      for (const callbackUrl of privateUrls) {
        const res = await app.inject({
          method: 'POST',
          url: '/tasks',
          headers: authHeader(),
          payload: { projectId: PROJECT_ID, title: 'T', callbackUrl },
        });

        expect(res.statusCode, `Expected 400 for ${callbackUrl}`).toBe(400);
      }
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
        payload: { projectId: PROJECT_ID, title: 'T', callbackUrl: CALLBACK_URL },
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
        payload: { projectId: PROJECT_ID, title: 'T', callbackUrl: CALLBACK_URL },
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

  // GET /tasks/:id/runs/:runId
  describe('GET /tasks/:id/runs/:runId', () => {
    it('returns 200 with run detail', async () => {
      const { app: a } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: `/tasks/${TASK_ID}/runs/${RUN_ID}`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().run.id).toBe(RUN_ID);
      expect(res.json().run.response).toBe('Analysis result');
    });

    it('returns 404 when not found', async () => {
      const { app: a } = setup({
        getRunDetail: {
          execute: vi.fn().mockRejectedValue(new RunNotFoundError(RUN_ID)),
        },
      });
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: `/tasks/${TASK_ID}/runs/${RUN_ID}`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(404);
    });

    it('validates UUID params', async () => {
      const { app: a } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/tasks/not-uuid/runs/also-not-uuid',
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(400);
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
      expect(res.json().shortId).toBe('NF-1');
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

  // POST /tasks/:id/resume (universal ResumeTask)
  describe('POST /tasks/:id/resume', () => {
    it('resumes task and returns 200 with optional instruction', async () => {
      const { app: a, useCases } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/resume`,
        headers: authHeader(),
        payload: { instruction: 'Retry with fixes' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().taskId).toBe(TASK_ID);
      expect(useCases.resumeTask.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: TASK_ID,
          instruction: 'Retry with fixes',
        }),
      );
    });

    it('works without body (instruction is optional)', async () => {
      const { app: a, useCases } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/resume`,
        headers: authHeader(),
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(useCases.resumeTask.execute).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: TASK_ID }),
      );
    });

    it('returns 409 when task status is not allowed', async () => {
      const { app: a } = setup({
        resumeTask: {
          execute: vi.fn().mockRejectedValue(new InvalidStateError('Cannot resume task in status in_progress')),
        },
      });
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/resume`,
        headers: authHeader(),
        payload: {},
      });

      expect(res.statusCode).toBe(409);
    });
  });

  // POST /tasks/:id/resume-research (renamed from /resume)
  describe('POST /tasks/:id/resume-research', () => {
    it('resumes research and returns 200 with instruction', async () => {
      const { app: a, useCases } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/resume-research`,
        headers: authHeader(),
        payload: { instruction: 'Передай в разработку' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().taskId).toBe(TASK_ID);
      expect(useCases.resumeResearch.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: TASK_ID,
          instruction: 'Передай в разработку',
        }),
      );
    });

    it('returns 400 when instruction is missing', async () => {
      const { app: a } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/resume-research`,
        headers: authHeader(),
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 409 when task is not research_done', async () => {
      const { app: a } = setup({
        resumeResearch: {
          execute: vi.fn().mockRejectedValue(new InvalidStateError('Cannot resume task in status in_progress')),
        },
      });
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/resume-research`,
        headers: authHeader(),
        payload: { instruction: 'Go' },
      });

      expect(res.statusCode).toBe(409);
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
      expect(res.json().shortId).toBe('NF-1');
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
