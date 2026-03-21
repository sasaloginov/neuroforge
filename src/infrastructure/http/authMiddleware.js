import { createHash } from 'node:crypto';

/**
 * Create a Fastify onRequest hook for Bearer token authentication.
 * Looks up the SHA-256 hash of the token in apiKeyRepo,
 * checks expiration, loads user, and decorates the request.
 */
export function authMiddleware({ apiKeyRepo, userRepo }) {
  return async function authenticate(request, reply) {
    // Skip auth for health check
    if (request.url === '/health') return;

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.slice(7);
    if (!token) {
      return reply.code(401).send({ error: 'Missing or invalid Authorization header' });
    }

    const keyHash = createHash('sha256').update(token).digest('hex');

    const apiKey = await apiKeyRepo.findByHash(keyHash);
    if (!apiKey) {
      return reply.code(401).send({ error: 'Invalid API key' });
    }

    if (apiKey.isExpired()) {
      return reply.code(401).send({ error: 'API key expired' });
    }

    const user = await userRepo.findById(apiKey.userId);
    if (!user) {
      return reply.code(401).send({ error: 'User not found' });
    }

    request.user = user;
    request.apiKey = apiKey;
  };
}
