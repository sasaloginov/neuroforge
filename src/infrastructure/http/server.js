import Fastify from 'fastify';
import cors from '@fastify/cors';
import { authMiddleware } from './authMiddleware.js';
import { errorHandler } from './errorHandler.js';
import { healthRoutes } from './routes/healthRoutes.js';
import { taskRoutes } from './routes/taskRoutes.js';
import { projectRoutes } from './routes/projectRoutes.js';
import { adminRoutes } from './routes/adminRoutes.js';

/**
 * Create and configure the Fastify server.
 * @param {{ useCases, repos, checkers?, version?, startedAt?, logger? }} deps
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function createServer({ useCases, repos, checkers, version, startedAt, logger }) {
  const app = Fastify({
    logger: logger ?? {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  // CORS
  await app.register(cors, { origin: true });

  // Decorate request with auth properties
  app.decorateRequest('user', null);
  app.decorateRequest('apiKey', null);

  // Health check (before auth hook)
  if (checkers) {
    app.register(healthRoutes({ checkers, version: version ?? '0.0.0', startedAt: startedAt ?? new Date() }));
  } else {
    app.get('/health', async () => ({ status: 'ok' }));
  }

  // Auth middleware (onRequest hook)
  app.addHook('onRequest', authMiddleware({
    apiKeyRepo: repos.apiKeyRepo,
    userRepo: repos.userRepo,
  }));

  // Routes
  app.register(taskRoutes({ useCases }), { prefix: '/' });
  app.register(projectRoutes({ repos }), { prefix: '/' });
  app.register(adminRoutes({ repos }), { prefix: '/' });

  // Error handler
  app.setErrorHandler(errorHandler);

  return app;
}
