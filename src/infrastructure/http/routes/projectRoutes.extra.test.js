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
      findByProjectId: vi.fn().mockResolvedValue([]),
      ...overrides.taskRepo,
    },
  };
}

function setup(repoOverrides = {}, opts = {}) {
  const repos = buildRepos(repoOverrides);
  const server = createTestServer({
    user: opts.user,
    apiKey: opts.apiKey,
    registerRoutes: (app) => {
      app.register(projectRoutes({ repos }), { prefix: '/' });
    },
  });
  return { ...server, repos };
}

describe('projectRoutes — additional coverage', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('POST /projects returns 400 when name is missing', async () => {
    const { app: a } = setup();
    app = a;
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: authHeader(),
      payload: { repoUrl: 'https://github.com/org/repo' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /projects returns 400 for invalid name pattern', async () => {
    const { app: a } = setup();
    app = a;
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: authHeader(),
      payload: { name: 'Invalid Name!', repoUrl: 'https://github.com/org/repo' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /projects/:name returns 403 when scoped key does not match', async () => {
    const scopedKey = new ApiKey({
      id: '00000000-0000-0000-0000-000000000010',
      name: 'scoped-key',
      keyHash: createHash('sha256').update('test-token-123').digest('hex'),
      userId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000999', // different
      expiresAt: null,
      createdAt: new Date('2025-01-01'),
    });

    const { app: a } = setup({}, { apiKey: scopedKey });
    a._testScopedKey = scopedKey;
    app = a;
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/projects/my-project',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /projects/:name/tasks returns 403 when scoped key does not match', async () => {
    const scopedKey = new ApiKey({
      id: '00000000-0000-0000-0000-000000000010',
      name: 'scoped-key',
      keyHash: createHash('sha256').update('test-token-123').digest('hex'),
      userId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000999',
      expiresAt: null,
      createdAt: new Date('2025-01-01'),
    });

    const { app: a } = setup({}, { apiKey: scopedKey });
    app = a;
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/projects/my-project/tasks',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /projects returns empty when scoped key project not found', async () => {
    const scopedKey = new ApiKey({
      id: '00000000-0000-0000-0000-000000000010',
      name: 'scoped-key',
      keyHash: createHash('sha256').update('test-token-123').digest('hex'),
      userId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000888',
      expiresAt: null,
      createdAt: new Date('2025-01-01'),
    });

    const { app: a } = setup(
      { projectRepo: { findById: vi.fn().mockResolvedValue(null) } },
      { apiKey: scopedKey },
    );
    app = a;
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().projects).toHaveLength(0);
  });

  it('GET /projects/:name/tasks with invalid status enum returns 400', async () => {
    const { app: a } = setup();
    app = a;
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/projects/my-project/tasks?status=bogus',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
  });
});
