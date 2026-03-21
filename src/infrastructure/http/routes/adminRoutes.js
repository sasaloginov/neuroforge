import { createHash, randomBytes } from 'node:crypto';
import { User } from '../../../domain/entities/User.js';
import { ApiKey } from '../../../domain/entities/ApiKey.js';
import { assertAdmin } from '../scopeHelpers.js';

const createUserSchema = {
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 128 },
      role: { type: 'string', enum: ['admin', 'member'], default: 'member' },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        role: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  },
};

const deleteUserSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
};

const createApiKeySchema = {
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 128 },
      projectId: { type: 'string', format: 'uuid' },
      expiresAt: { type: 'string', format: 'date-time' },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        token: { type: 'string' },
        projectId: { type: 'string', nullable: true },
        expiresAt: { type: 'string', format: 'date-time', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  },
};

const deleteApiKeySchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
};

export function adminRoutes({ repos }) {
  const { userRepo, apiKeyRepo, projectRepo } = repos;

  return async function (fastify) {
    // --- User management (admin only) ---

    fastify.post('/users', { schema: createUserSchema }, async (request, reply) => {
      assertAdmin(request.user);
      const user = User.create({
        name: request.body.name,
        role: request.body.role,
      });
      await userRepo.save(user);
      return reply.code(201).send({
        id: user.id,
        name: user.name,
        role: user.role,
        createdAt: user.createdAt,
      });
    });

    fastify.get('/users', async (request, reply) => {
      assertAdmin(request.user);
      const users = await userRepo.findAll();
      return reply.send({
        users: users.map(u => ({
          id: u.id,
          name: u.name,
          role: u.role,
          createdAt: u.createdAt,
        })),
      });
    });

    fastify.delete('/users/:id', { schema: deleteUserSchema }, async (request, reply) => {
      assertAdmin(request.user);
      await userRepo.delete(request.params.id);
      return reply.code(204).send();
    });

    // --- API key management ---

    fastify.post('/api-keys', { schema: createApiKeySchema }, async (request, reply) => {
      const { name, projectId, expiresAt } = request.body;

      // If projectId is specified, verify the project exists
      if (projectId) {
        const project = await projectRepo.findById(projectId);
        if (!project) {
          const err = new Error('Project not found');
          err.statusCode = 404;
          throw err;
        }
      }

      const rawToken = 'nf_' + randomBytes(32).toString('hex');
      const keyHash = createHash('sha256').update(rawToken).digest('hex');

      const apiKey = ApiKey.create({
        name,
        keyHash,
        userId: request.user.id,
        projectId: projectId ?? null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      });

      await apiKeyRepo.save(apiKey);

      return reply.code(201).send({
        id: apiKey.id,
        name: apiKey.name,
        token: rawToken,
        projectId: apiKey.projectId,
        expiresAt: apiKey.expiresAt,
        createdAt: apiKey.createdAt,
      });
    });

    fastify.get('/api-keys', async (request, reply) => {
      const keys = await apiKeyRepo.findByUserId(request.user.id);
      return reply.send({
        apiKeys: keys.map(k => ({
          id: k.id,
          name: k.name,
          projectId: k.projectId,
          expiresAt: k.expiresAt,
          createdAt: k.createdAt,
        })),
      });
    });

    fastify.delete('/api-keys/:id', { schema: deleteApiKeySchema }, async (request, reply) => {
      const key = await apiKeyRepo.findById(request.params.id);
      if (!key) {
        const err = new Error('API key not found');
        err.statusCode = 404;
        throw err;
      }

      // Only owner or admin can delete
      if (key.userId !== request.user.id && request.user.role !== 'admin') {
        const err = new Error('Access denied: not your API key');
        err.statusCode = 403;
        throw err;
      }

      await apiKeyRepo.delete(request.params.id);
      return reply.code(204).send();
    });
  };
}
