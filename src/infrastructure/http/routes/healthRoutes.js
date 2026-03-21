/**
 * Health check routes — Fastify plugin.
 *
 * GET /health           — shallow check (always 200)
 * GET /health?detailed  — deep check with component status
 */

/**
 * @param {{ checkers: { database: import('../healthCheckers.js').DatabaseHealthChecker, scheduler: import('../healthCheckers.js').SchedulerHealthChecker }, version: string, startedAt: Date }} deps
 * @returns {import('fastify').FastifyPluginCallback}
 */
export function healthRoutes({ checkers, version, startedAt }) {
  return function plugin(app, _opts, done) {
    app.get('/health', async (request, reply) => {
      const detailed = request.query.detailed !== undefined;

      if (!detailed) {
        return { status: 'ok' };
      }

      // Deep check — run database (async) and scheduler (sync) in parallel
      const [database, scheduler] = await Promise.all([
        checkers.database.check(),
        Promise.resolve(checkers.scheduler.check()),
      ]);

      const allOk = database.status === 'ok' && scheduler.status === 'ok';
      const status = allOk ? 'ok' : 'degraded';
      const code = allOk ? 200 : 503;

      reply.code(code);
      return {
        status,
        version,
        uptime: Math.floor((Date.now() - startedAt.getTime()) / 1000),
        components: {
          database,
          scheduler,
        },
      };
    });

    done();
  };
}
