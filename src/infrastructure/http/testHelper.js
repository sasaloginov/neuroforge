import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { authMiddleware } from './authMiddleware.js';
import { errorHandler } from './errorHandler.js';
import { User } from '../../domain/entities/User.js';
import { ApiKey } from '../../domain/entities/ApiKey.js';

/**
 * Create a test Fastify instance with auth middleware and error handler.
 * Uses mock repos and injects a valid token/user by default.
 */
export function createTestServer({
  registerRoutes,
  user,
  apiKey,
  apiKeyRepo: apiKeyRepoOverride,
  userRepo: userRepoOverride,
} = {}) {
  const testUser = user ?? new User({
    id: '00000000-0000-0000-0000-000000000001',
    name: 'Test User',
    role: 'admin',
    createdAt: new Date('2025-01-01'),
  });

  const testToken = 'test-token-123';
  const testKeyHash = createHash('sha256').update(testToken).digest('hex');

  const testApiKey = apiKey ?? new ApiKey({
    id: '00000000-0000-0000-0000-000000000010',
    name: 'test-key',
    keyHash: testKeyHash,
    userId: testUser.id,
    projectId: null,
    expiresAt: null,
    createdAt: new Date('2025-01-01'),
  });

  const apiKeyRepo = apiKeyRepoOverride ?? {
    findByHash: async (hash) => hash === testKeyHash ? testApiKey : null,
    findByUserId: async () => [testApiKey],
    findById: async (id) => id === testApiKey.id ? testApiKey : null,
    save: async () => {},
    delete: async () => {},
  };

  const userRepo = userRepoOverride ?? {
    findById: async (id) => id === testUser.id ? testUser : null,
    findAll: async () => [testUser],
    findByRole: async () => [testUser],
    save: async () => {},
    delete: async () => {},
  };

  const app = Fastify({ logger: false });

  app.decorateRequest('user', null);
  app.decorateRequest('apiKey', null);

  app.get('/health', async () => ({ status: 'ok' }));

  app.addHook('onRequest', authMiddleware({ apiKeyRepo, userRepo }));

  if (registerRoutes) {
    registerRoutes(app);
  }

  app.setErrorHandler(errorHandler);

  return { app, testUser, testApiKey, testToken, testKeyHash, apiKeyRepo, userRepo };
}

/**
 * Returns the Authorization header for the test token.
 */
export function authHeader(token = 'test-token-123') {
  return { authorization: `Bearer ${token}` };
}
