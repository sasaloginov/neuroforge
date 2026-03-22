import { Project } from '../../../domain/entities/Project.js';
import { DuplicatePrefixError } from '../../../domain/errors/DuplicatePrefixError.js';
import { assertProjectScope, assertAdmin } from '../scopeHelpers.js';

const createProjectSchema = {
  body: {
    type: 'object',
    required: ['name', 'prefix', 'repoUrl'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-z0-9_-]+$' },
      prefix: { type: 'string', minLength: 1, maxLength: 10, pattern: '^[A-Za-z][A-Za-z0-9]{0,9}$' },
      repoUrl: { type: 'string', format: 'uri', maxLength: 512 },
      workDir: { type: 'string', maxLength: 512 },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        prefix: { type: 'string' },
        repoUrl: { type: 'string' },
        workDir: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  },
};

const getProjectSchema = {
  params: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
    },
  },
};

const projectTasksSchema = {
  params: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
    },
  },
  querystring: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'waiting_reply', 'needs_escalation', 'done', 'failed', 'cancelled'],
      },
    },
  },
};

export function projectRoutes({ repos }) {
  const { projectRepo, taskRepo } = repos;

  return async function (fastify) {
    fastify.post('/projects', { schema: createProjectSchema }, async (request, reply) => {
      assertAdmin(request.user);

      const project = Project.create(request.body);
      try {
        await projectRepo.save(project);
      } catch (err) {
        if (err.code === '23505') {
          // Unique constraint violation — distinguish prefix vs name
          if (err.constraint === 'uq_projects_prefix') {
            throw new DuplicatePrefixError(request.body.prefix);
          }
          const conflict = new Error(`Project with name "${request.body.name}" already exists`);
          conflict.statusCode = 409;
          throw conflict;
        }
        throw err;
      }

      return reply.code(201).send({
        id: project.id,
        name: project.name,
        prefix: project.prefix,
        repoUrl: project.repoUrl,
        workDir: project.workDir,
        createdAt: project.createdAt,
      });
    });

    fastify.get('/projects', async (request, reply) => {
      let projects;
      if (request.apiKey.projectId) {
        const project = await projectRepo.findById(request.apiKey.projectId);
        projects = project ? [project] : [];
      } else {
        projects = await projectRepo.findAll();
      }

      return reply.send({
        projects: projects.map(p => ({
          id: p.id,
          name: p.name,
          prefix: p.prefix,
          repoUrl: p.repoUrl,
        })),
      });
    });

    fastify.get('/projects/:name', { schema: getProjectSchema }, async (request, reply) => {
      const project = await projectRepo.findByName(request.params.name);
      if (!project) {
        const err = new Error(`Project not found: ${request.params.name}`);
        err.statusCode = 404;
        throw err;
      }

      assertProjectScope(request.apiKey, project.id);

      return reply.send({
        id: project.id,
        name: project.name,
        prefix: project.prefix,
        repoUrl: project.repoUrl,
        workDir: project.workDir,
        createdAt: project.createdAt,
      });
    });

    fastify.get('/projects/:name/tasks', { schema: projectTasksSchema }, async (request, reply) => {
      const project = await projectRepo.findByName(request.params.name);
      if (!project) {
        const err = new Error(`Project not found: ${request.params.name}`);
        err.statusCode = 404;
        throw err;
      }

      assertProjectScope(request.apiKey, project.id);

      const filters = {};
      if (request.query.status) {
        filters.status = request.query.status;
      }

      const tasks = await taskRepo.findByProjectId(project.id, filters);

      return reply.send({
        tasks: tasks.map(t => ({
          id: t.id,
          shortId: project.prefix && t.seqNumber != null
            ? `${project.prefix}-${t.seqNumber}`
            : undefined,
          title: t.title,
          status: t.status,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        })),
      });
    });
  };
}
