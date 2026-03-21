import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestServer, authHeader } from '../testHelper.js';
import { projectRoutes } from './projectRoutes.js';
import { User } from '../../../domain/entities/User.js';
import { ApiKey } from '../../../domain/entities/ApiKey.js';
import { Project } from '../../../domain/entities/Project.js';
import { createHash } from 'node:crypto';

const PROJECT_ID = '00000000-0000-0000-0000-000000000100';

const testProject = new Project({
  id: PROJECT_ID,
  name: 'my-project',
  repoUrl: 'https://github.com/org/repo',
  workDir: '/work',
  createdAt: new Date('2025-01-01'),
});

function buildRepos(overrides = {}) {
  return {
    projectRepo: {
      findById: vi.fn().mockResolvedValue(testProject),
      findByName: vi.fn().mockResolvedValue(testProject),
      findAll: vi.fn().mockResolvedValue([testProject]),
      save: vi.fn().mockResolvedValue(undefined),
      ...overrides.projectRepo,
    },
    taskRepo: {
      findByProjectId: vi.fn().mockResolvedValue([
        {
          id: '00000000-0000-0000-0000-000000000200',
          title: 'Test Task',
          status: 'in_progress',
          createdAt: new Date('2025-01-01'),
          updatedAt: new Date('2025-01-01'),
        },
      ]),
      ...overrides.taskRepo,
    },
  };
}

function setup(repoOverrides = {}, opts = {}) {
  const repos = buildRepos(repoOverrides);
  const userOpts = opts.user ?? undefined;
  const apiKeyOpts = opts.apiKey ?? undefined;

  const server = createTestServer({
    user: userOpts,
    apiKey: apiKeyOpts,
    registerRoutes: (app) => {
      app.register(projectRoutes({ repos }), { prefix: '/' });
    },
  });
  return { ...server, repos };
}

describe('projectRoutes', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
  });

  // POST /projects
  describe('POST /projects', () => {
    it('creates a project and returns 201 (admin)', async () => {
      const { app: a, repos } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/projects',
        headers: authHeader(),
        payload: { name: 'new-project', repoUrl: 'https://github.com/org/new' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().name).toBe('new-project');
      expect(repos.projectRepo.save).toHaveBeenCalled();
    });

    it('returns 403 for non-admin', async () => {
      const memberUser = new User({
        id: '00000000-0000-0000-0000-000000000001',
        name: 'Member',
        role: 'member',
        createdAt: new Date('2025-01-01'),
      });

      const { app: a } = setup({}, { user: memberUser });
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/projects',
        headers: authHeader(),
        payload: { name: 'new-proj', repoUrl: 'https://github.com/org/new' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 409 for duplicate name', async () => {
      const pgError = new Error('unique violation');
      pgError.code = '23505';

      const { app: a } = setup({
        projectRepo: { save: vi.fn().mockRejectedValue(pgError) },
      });
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/projects',
        headers: authHeader(),
        payload: { name: 'existing', repoUrl: 'https://github.com/org/dup' },
      });

      expect(res.statusCode).toBe(409);
    });
  });

  // GET /projects
  describe('GET /projects', () => {
    it('returns all projects (no scope)', async () => {
      const { app: a } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/projects',
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().projects).toHaveLength(1);
    });

    it('returns only scoped project when key has projectId', async () => {
      const scopedKey = new ApiKey({
        id: '00000000-0000-0000-0000-000000000010',
        name: 'scoped-key',
        keyHash: createHash('sha256').update('test-token-123').digest('hex'),
        userId: '00000000-0000-0000-0000-000000000001',
        projectId: PROJECT_ID,
        expiresAt: null,
        createdAt: new Date('2025-01-01'),
      });

      const { app: a, repos } = setup({}, { apiKey: scopedKey });
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/projects',
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      expect(repos.projectRepo.findById).toHaveBeenCalledWith(PROJECT_ID);
    });
  });

  // GET /projects/:name
  describe('GET /projects/:name', () => {
    it('returns project by name', async () => {
      const { app: a } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/projects/my-project',
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('my-project');
    });

    it('returns 404 when project not found', async () => {
      const { app: a } = setup({
        projectRepo: { findByName: vi.fn().mockResolvedValue(null) },
      });
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/projects/missing',
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // GET /projects/:name/tasks
  describe('GET /projects/:name/tasks', () => {
    it('returns tasks for project', async () => {
      const { app: a } = setup();
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/projects/my-project/tasks',
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().tasks).toHaveLength(1);
    });

    it('filters by status query param', async () => {
      const { app: a, repos } = setup();
      app = a;
      await app.ready();

      await app.inject({
        method: 'GET',
        url: '/projects/my-project/tasks?status=done',
        headers: authHeader(),
      });

      expect(repos.taskRepo.findByProjectId).toHaveBeenCalledWith(
        PROJECT_ID,
        { status: 'done' },
      );
    });

    it('returns 404 when project not found', async () => {
      const { app: a } = setup({
        projectRepo: { findByName: vi.fn().mockResolvedValue(null) },
      });
      app = a;
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/projects/missing/tasks',
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
