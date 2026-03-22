import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createMcpServer,
  handleReportProgress,
  handleAskQuestion,
  handleComplete,
  startMcpHttpServer,
} from './mcpServer.js';

describe('createMcpServer', () => {
  it('creates an MCP server instance with connect method', () => {
    const server = createMcpServer({
      runRepo: {},
      taskRepo: {},
      callbackSender: {},
      logger: { info: vi.fn(), error: vi.fn() },
    });

    expect(server).toBeDefined();
    expect(server.connect).toBeTypeOf('function');
  });
});

describe('handleReportProgress', () => {
  let deps;
  let mockTask;

  beforeEach(() => {
    mockTask = {
      id: 'task-1',
      callbackUrl: 'https://example.com/callback',
      callbackMeta: { chatId: 123 },
    };

    deps = {
      runRepo: {},
      taskRepo: { findById: vi.fn().mockResolvedValue(mockTask) },
      callbackSender: { send: vi.fn().mockResolvedValue({ ok: true }) },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
  });

  it('sends progress callback and returns success', async () => {
    const result = await handleReportProgress(deps, {
      runId: 'run-1', taskId: 'task-1', stage: 'coding', message: 'Implementing feature X',
    });

    const content = JSON.parse(result.content[0].text);
    expect(content.success).toBe(true);

    expect(deps.taskRepo.findById).toHaveBeenCalledWith('task-1');
    expect(deps.callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/callback',
      { type: 'progress', taskId: 'task-1', stage: 'coding', message: 'Implementing feature X' },
      { chatId: 123 },
    );
  });

  it('skips callback when task has no callbackUrl', async () => {
    mockTask.callbackUrl = null;

    const result = await handleReportProgress(deps, {
      runId: 'run-1', taskId: 'task-1', stage: 'coding', message: 'Working...',
    });

    const content = JSON.parse(result.content[0].text);
    expect(content.success).toBe(true);
    expect(deps.callbackSender.send).not.toHaveBeenCalled();
  });

  it('skips callback when task not found', async () => {
    deps.taskRepo.findById.mockResolvedValue(null);

    const result = await handleReportProgress(deps, {
      runId: 'run-1', taskId: 'task-1', stage: 'coding', message: 'Working...',
    });

    const content = JSON.parse(result.content[0].text);
    expect(content.success).toBe(true);
    expect(deps.callbackSender.send).not.toHaveBeenCalled();
  });

  it('returns generic error on failure (does not leak internal details)', async () => {
    deps.callbackSender.send.mockRejectedValue(new Error('Network error'));

    const result = await handleReportProgress(deps, {
      runId: 'run-1', taskId: 'task-1', stage: 'testing', message: 'Running tests',
    });

    const content = JSON.parse(result.content[0].text);
    expect(content.success).toBe(false);
    expect(content.error).toBe('Internal error');
    expect(result.isError).toBe(true);
    expect(deps.logger.error).toHaveBeenCalled();
  });
});

describe('handleAskQuestion', () => {
  let deps;
  let mockTask;

  beforeEach(() => {
    mockTask = {
      id: 'task-1',
      callbackUrl: 'https://example.com/callback',
      callbackMeta: { chatId: 123 },
      status: 'in_progress',
      canTransitionTo: vi.fn().mockReturnValue(true),
      transitionTo: vi.fn(),
    };

    deps = {
      runRepo: {},
      taskRepo: {
        findById: vi.fn().mockResolvedValue(mockTask),
        save: vi.fn().mockResolvedValue(undefined),
      },
      callbackSender: { send: vi.fn().mockResolvedValue({ ok: true }) },
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
  });

  it('transitions task to waiting_reply and sends callback', async () => {
    const result = await handleAskQuestion(deps, {
      runId: 'run-1', taskId: 'task-1',
      question: 'Which DB to use?',
      context: 'We need a relational store',
    });

    const content = JSON.parse(result.content[0].text);
    expect(content.success).toBe(true);
    expect(content.message).toBe('Question sent to owner');

    expect(mockTask.canTransitionTo).toHaveBeenCalledWith('waiting_reply');
    expect(mockTask.transitionTo).toHaveBeenCalledWith('waiting_reply');
    expect(deps.taskRepo.save).toHaveBeenCalledWith(mockTask);
    expect(deps.callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/callback',
      { type: 'question', taskId: 'task-1', question: 'Which DB to use?', context: 'We need a relational store' },
      { chatId: 123 },
    );
  });

  it('logs question at debug level (not info)', async () => {
    await handleAskQuestion(deps, {
      runId: 'run-1', taskId: 'task-1', question: 'Sensitive question?',
    });

    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('ask_question'),
      expect.anything(),
      expect.anything(),
    );
    // info should NOT have been called with the question text
    for (const call of deps.logger.info.mock.calls) {
      expect(call[0]).not.toContain('ask_question');
    }
  });

  it('returns error when task not found', async () => {
    deps.taskRepo.findById.mockResolvedValue(null);

    const result = await handleAskQuestion(deps, {
      runId: 'run-1', taskId: 'task-1', question: 'Where is the task?',
    });

    const content = JSON.parse(result.content[0].text);
    expect(content.success).toBe(false);
    expect(content.error).toBe('Task not found');
    expect(result.isError).toBe(true);
  });

  it('skips transition when not allowed', async () => {
    mockTask.canTransitionTo.mockReturnValue(false);

    const result = await handleAskQuestion(deps, {
      runId: 'run-1', taskId: 'task-1', question: 'Can I transition?',
    });

    const content = JSON.parse(result.content[0].text);
    expect(content.success).toBe(true);
    expect(mockTask.transitionTo).not.toHaveBeenCalled();
    expect(deps.taskRepo.save).not.toHaveBeenCalled();
    // Still sends callback
    expect(deps.callbackSender.send).toHaveBeenCalled();
  });

  it('handles missing context as empty string', async () => {
    const result = await handleAskQuestion(deps, {
      runId: 'run-1', taskId: 'task-1', question: 'Hello?',
    });

    const content = JSON.parse(result.content[0].text);
    expect(content.success).toBe(true);

    expect(deps.callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/callback',
      expect.objectContaining({ context: '' }),
      expect.anything(),
    );
  });

  it('skips callback when task has no callbackUrl', async () => {
    mockTask.callbackUrl = null;

    const result = await handleAskQuestion(deps, {
      runId: 'run-1', taskId: 'task-1', question: 'Hello?',
    });

    const content = JSON.parse(result.content[0].text);
    expect(content.success).toBe(true);
    expect(deps.callbackSender.send).not.toHaveBeenCalled();
  });

  it('returns generic error on unexpected failure', async () => {
    deps.callbackSender.send.mockRejectedValue(new Error('Connection reset'));

    const result = await handleAskQuestion(deps, {
      runId: 'run-1', taskId: 'task-1', question: 'Boom?',
    });

    const content = JSON.parse(result.content[0].text);
    expect(content.error).toBe('Internal error');
  });
});

describe('handleComplete', () => {
  let deps;
  let mockRun;

  beforeEach(() => {
    mockRun = {
      id: 'run-1',
      status: 'running',
      complete: vi.fn(),
    };

    deps = {
      runRepo: {
        findById: vi.fn().mockResolvedValue(mockRun),
        save: vi.fn().mockResolvedValue(undefined),
      },
      taskRepo: {},
      callbackSender: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
  });

  it('calls run.complete() and saves', async () => {
    const result = await handleComplete(deps, {
      runId: 'run-1', taskId: 'task-1', output: 'Feature implemented successfully',
    });

    const content = JSON.parse(result.content[0].text);
    expect(content.success).toBe(true);

    expect(deps.runRepo.findById).toHaveBeenCalledWith('run-1');
    expect(mockRun.complete).toHaveBeenCalledWith('Feature implemented successfully');
    expect(deps.runRepo.save).toHaveBeenCalledWith(mockRun);
  });

  it('handles missing run gracefully', async () => {
    deps.runRepo.findById.mockResolvedValue(null);

    const result = await handleComplete(deps, {
      runId: 'run-1', taskId: 'task-1', output: 'Done',
    });

    const content = JSON.parse(result.content[0].text);
    expect(content.success).toBe(true);
    expect(deps.runRepo.save).not.toHaveBeenCalled();
  });

  it('returns generic error on save failure', async () => {
    deps.runRepo.save.mockRejectedValue(new Error('DB connection lost'));

    const result = await handleComplete(deps, {
      runId: 'run-1', taskId: 'task-1', output: 'Done',
    });

    const content = JSON.parse(result.content[0].text);
    expect(content.success).toBe(false);
    expect(content.error).toBe('Internal error');
    expect(result.isError).toBe(true);
    expect(deps.logger.error).toHaveBeenCalled();
  });
});

describe('startMcpHttpServer', () => {
  /** Helper to create standard deps */
  function makeDeps() {
    return {
      runRepo: {},
      taskRepo: {},
      callbackSender: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
  }

  it('starts on 127.0.0.1, responds to health, and shuts down', async () => {
    const httpServer = await startMcpHttpServer(makeDeps(), 0);
    const addr = httpServer.address();

    expect(addr.address).toBe('127.0.0.1');
    expect(addr.port).toBeGreaterThan(0);

    // Health endpoint is unauthenticated
    const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.sessions).toBe(0);

    // 404 for unknown paths
    const notFound = await fetch(`http://127.0.0.1:${addr.port}/unknown`);
    expect(notFound.status).toBe(404);

    await httpServer.closeMcp();
  });

  it('exposes auto-generated secret on server instance', async () => {
    const httpServer = await startMcpHttpServer(makeDeps(), 0);

    expect(httpServer.secret).toBeDefined();
    expect(typeof httpServer.secret).toBe('string');
    expect(httpServer.secret.length).toBe(64); // 32 bytes hex

    await httpServer.closeMcp();
  });

  it('uses provided secret when given', async () => {
    const httpServer = await startMcpHttpServer(makeDeps(), 0, { secret: 'my-test-secret' });

    expect(httpServer.secret).toBe('my-test-secret');

    await httpServer.closeMcp();
  });

  it('returns 401 on /sse without Authorization header', async () => {
    const httpServer = await startMcpHttpServer(makeDeps(), 0);
    const addr = httpServer.address();

    const res = await fetch(`http://127.0.0.1:${addr.port}/sse`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');

    await httpServer.closeMcp();
  });

  it('returns 401 on /sse with wrong token', async () => {
    const httpServer = await startMcpHttpServer(makeDeps(), 0);
    const addr = httpServer.address();

    const res = await fetch(`http://127.0.0.1:${addr.port}/sse`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);

    await httpServer.closeMcp();
  });

  it('returns 401 on /messages without Authorization header', async () => {
    const httpServer = await startMcpHttpServer(makeDeps(), 0);
    const addr = httpServer.address();

    const res = await fetch(`http://127.0.0.1:${addr.port}/messages?sessionId=x`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(401);

    await httpServer.closeMcp();
  });

  it('returns 503 when SSE session limit is reached', async () => {
    const httpServer = await startMcpHttpServer(makeDeps(), 0, {
      secret: 'test-secret',
      maxSessions: 0, // limit to 0 to immediately trigger 503
    });
    const addr = httpServer.address();

    const res = await fetch(`http://127.0.0.1:${addr.port}/sse`, {
      headers: { Authorization: 'Bearer test-secret' },
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('Too many sessions');

    await httpServer.closeMcp();
  });
});
