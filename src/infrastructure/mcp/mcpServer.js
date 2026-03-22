import crypto from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

/** Maximum concurrent SSE sessions before returning 503 */
const MAX_SSE_SESSIONS = 100;

/**
 * @typedef {object} McpDeps
 * @property {import('../../domain/ports/IRunRepo.js').IRunRepo} runRepo
 * @property {import('../../domain/ports/ITaskRepo.js').ITaskRepo} taskRepo
 * @property {import('../../domain/ports/ICallbackSender.js').ICallbackSender} callbackSender
 * @property {object} logger
 */

/**
 * Handler for report_progress tool.
 * @param {McpDeps} deps
 * @param {{ runId: string, taskId: string, stage: string, message: string }} args
 */
export async function handleReportProgress(deps, { runId, taskId, stage, message }) {
  const { taskRepo, callbackSender, logger } = deps;
  logger.info('[MCP] report_progress runId=%s stage=%s', runId, stage);

  try {
    const task = await taskRepo.findById(taskId);
    if (task && task.callbackUrl) {
      await callbackSender.send(
        task.callbackUrl,
        { type: 'progress', taskId, stage, message },
        task.callbackMeta,
      );
    }

    return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
  } catch (err) {
    logger.error('[MCP] report_progress error: %s', err.message);
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Internal error' }) }], isError: true };
  }
}

/**
 * Handler for ask_question tool.
 * @param {McpDeps} deps
 * @param {{ runId: string, taskId: string, question: string, context?: string }} args
 */
export async function handleAskQuestion(deps, { runId, taskId, question, context }) {
  const { taskRepo, callbackSender, logger } = deps;
  logger.debug?.('[MCP] ask_question runId=%s question=%s', runId, question);

  try {
    const task = await taskRepo.findById(taskId);
    if (!task) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Task not found' }) }], isError: true };
    }

    if (task.canTransitionTo('waiting_reply')) {
      task.transitionTo('waiting_reply');
      await taskRepo.save(task);
    }

    if (task.callbackUrl) {
      await callbackSender.send(
        task.callbackUrl,
        { type: 'question', taskId, question, context: context || '' },
        task.callbackMeta,
      );
    }

    return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Question sent to owner' }) }] };
  } catch (err) {
    logger.error('[MCP] ask_question error: %s', err.message);
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Internal error' }) }], isError: true };
  }
}

/**
 * Handler for complete tool.
 * @param {McpDeps} deps
 * @param {{ runId: string, taskId: string, output: string }} args
 */
export async function handleComplete(deps, { runId, taskId, output }) {
  const { runRepo, logger } = deps;
  logger.info('[MCP] complete runId=%s', runId);

  try {
    const run = await runRepo.findById(runId);
    if (run) {
      run.complete(output);
      await runRepo.save(run);
    }

    return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
  } catch (err) {
    logger.error('[MCP] complete error: %s', err.message);
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Internal error' }) }], isError: true };
  }
}

/**
 * Creates and configures MCP server with Neuroforge tools.
 * Tools accept runId and taskId as input parameters.
 *
 * @param {McpDeps} deps
 * @returns {McpServer}
 */
export function createMcpServer(deps) {
  const server = new McpServer({
    name: 'neuroforge',
    version: '1.0.0',
  });

  server.tool(
    'report_progress',
    'Report progress mid-run to the task owner',
    {
      runId: z.string().max(200).describe('Run ID'),
      taskId: z.string().max(200).describe('Task ID'),
      stage: z.string().max(1000).describe('Current stage of work'),
      message: z.string().max(4000).describe('Progress message'),
    },
    (args) => handleReportProgress(deps, args),
  );

  server.tool(
    'ask_question',
    'Ask a question to the task owner and pause execution',
    {
      runId: z.string().max(200).describe('Run ID'),
      taskId: z.string().max(200).describe('Task ID'),
      question: z.string().max(4000).describe('Question to ask the owner'),
      context: z.string().max(8000).optional().describe('Additional context for the question'),
    },
    (args) => handleAskQuestion(deps, args),
  );

  server.tool(
    'complete',
    'Report successful completion of the agent run',
    {
      runId: z.string().max(200).describe('Run ID'),
      taskId: z.string().max(200).describe('Task ID'),
      output: z.string().max(65536).describe('Structured output / result of the run'),
    },
    (args) => handleComplete(deps, args),
  );

  return server;
}

/**
 * Verify Bearer token from Authorization header.
 * @param {import('node:http').IncomingMessage} req
 * @param {string} expectedToken
 * @returns {boolean}
 */
function verifyAuth(req, expectedToken) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  // Constant-time comparison to prevent timing attacks
  if (token.length !== expectedToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken));
}

/**
 * Start a long-lived MCP HTTP server using SSE transport.
 * Binds to 127.0.0.1 only. Requires Bearer token on /sse and /messages.
 *
 * @param {McpDeps} deps
 * @param {number} [port=3100]
 * @param {object} [options]
 * @param {string} [options.secret] - shared secret for Bearer auth (auto-generated if omitted)
 * @param {number} [options.maxSessions] - max concurrent SSE sessions (default 100)
 * @returns {Promise<import('node:http').Server & { closeMcp: () => Promise<void>, secret: string }>}
 */
export async function startMcpHttpServer(deps, port = 3100, options = {}) {
  const { logger } = deps;
  const secret = options.secret || crypto.randomBytes(32).toString('hex');
  const maxSessions = options.maxSessions ?? MAX_SSE_SESSIONS;
  /** @type {Map<string, { transport: SSEServerTransport, server: McpServer }>} */
  const sessions = new Map();

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // /health is unauthenticated (no sensitive data)
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
      return;
    }

    if (url.pathname === '/sse' && req.method === 'GET') {
      if (!verifyAuth(req, secret)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      if (sessions.size >= maxSessions) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many sessions' }));
        return;
      }

      const transport = new SSEServerTransport('/messages', res);
      const perSessionServer = createMcpServer(deps);
      sessions.set(transport.sessionId, { transport, server: perSessionServer });

      transport.onclose = () => {
        sessions.delete(transport.sessionId);
        perSessionServer.close().catch(() => {});
      };

      await perSessionServer.connect(transport);
      return;
    }

    if (url.pathname === '/messages' && req.method === 'POST') {
      if (!verifyAuth(req, secret)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      const sessionId = url.searchParams.get('sessionId');
      const session = sessions.get(sessionId);

      if (!session) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unknown session' }));
        return;
      }

      await session.transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  await new Promise((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(port, '127.0.0.1', () => {
      logger.info('[MCP] HTTP server listening on 127.0.0.1:%d', port);
      resolve();
    });
  });

  // Expose the secret so callers can write it into mcp-config
  httpServer.secret = secret;

  // Attach cleanup helper for graceful shutdown
  httpServer.closeMcp = async () => {
    for (const { transport, server } of sessions.values()) {
      await transport.close();
      await server.close().catch(() => {});
    }
    sessions.clear();
    await new Promise((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  };

  return httpServer;
}
