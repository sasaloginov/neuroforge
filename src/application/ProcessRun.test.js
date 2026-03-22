import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProcessRun } from './ProcessRun.js';
import { RunTimeoutError } from '../domain/errors/RunTimeoutError.js';

describe('ProcessRun', () => {
  let processRun;
  let runRepo;
  let runService;
  let taskRepo;
  let chatEngine;
  let sessionRepo;
  let roleRegistry;
  let callbackSender;

  const makeRun = (overrides = {}) => ({
    id: 'run-1',
    taskId: 'task-1',
    roleName: 'analyst',
    prompt: 'Analyze this task',
    status: 'running',
    callbackUrl: 'https://example.com/cb',
    callbackMeta: { chatId: 1 },
    startedAt: new Date(),
    ...overrides,
  });

  beforeEach(() => {
    runRepo = {
      takeNext: vi.fn().mockResolvedValue(makeRun()),
      save: vi.fn().mockResolvedValue(undefined),
    };
    runService = {
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
      timeout: vi.fn().mockResolvedValue(undefined),
    };
    taskRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'task-1', projectId: 'project-1' }),
    };
    chatEngine = {
      runPrompt: vi.fn().mockResolvedValue({ response: 'Analysis result', sessionId: 'cli-session-1' }),
    };
    sessionRepo = {
      findOrCreate: vi.fn().mockResolvedValue({
        id: 'session-1',
        cliSessionId: 'cli-session-old',
        roleName: 'analyst',
      }),
      save: vi.fn().mockResolvedValue(undefined),
    };
    roleRegistry = {
      get: vi.fn().mockReturnValue({ name: 'analyst', timeoutMs: 300000 }),
    };
    callbackSender = {
      send: vi.fn().mockResolvedValue({ ok: true }),
    };

    processRun = new ProcessRun({ runRepo, runService, taskRepo, chatEngine, sessionRepo, roleRegistry, callbackSender });
  });

  it('full lifecycle: takes run, executes, completes, sends callback', async () => {
    const result = await processRun.execute();

    expect(result).not.toBeNull();
    expect(result.run.id).toBe('run-1');
    expect(result.result).toEqual({ response: 'Analysis result', sessionId: 'cli-session-1' });

    expect(runRepo.takeNext).toHaveBeenCalled();
    expect(roleRegistry.get).toHaveBeenCalledWith('analyst');
    expect(chatEngine.runPrompt).toHaveBeenCalledWith('analyst', 'Analyze this task', {
      sessionId: 'cli-session-old',
      timeoutMs: 300000,
      runId: 'run-1',
      taskId: 'task-1',
    });
    expect(runService.complete).toHaveBeenCalledWith('run-1', 'Analysis result');
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'progress', taskId: 'task-1', stage: 'analyst' }),
      { chatId: 1 },
    );
  });

  it('returns null when queue is empty', async () => {
    runRepo.takeNext.mockResolvedValue(null);

    const result = await processRun.execute();

    expect(result).toBeNull();
    expect(chatEngine.runPrompt).not.toHaveBeenCalled();
  });

  it('handles chatEngine timeout', async () => {
    chatEngine.runPrompt.mockRejectedValue(new RunTimeoutError('run-1', 300000));

    const result = await processRun.execute();

    expect(result).not.toBeNull();
    expect(runService.timeout).toHaveBeenCalledWith('run-1');
    expect(runService.fail).not.toHaveBeenCalled();
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'failed' }),
      { chatId: 1 },
    );
  });

  it('handles chatEngine generic error', async () => {
    chatEngine.runPrompt.mockRejectedValue(new Error('Claude CLI crashed'));

    const result = await processRun.execute();

    expect(result).not.toBeNull();
    expect(runService.fail).toHaveBeenCalledWith('run-1', 'Claude CLI crashed');
    expect(runService.timeout).not.toHaveBeenCalled();
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'failed', error: 'Claude CLI crashed' }),
      { chatId: 1 },
    );
  });

  it('binds session to run via runRepo.save before chatEngine call', async () => {
    await processRun.execute();

    expect(sessionRepo.findOrCreate).toHaveBeenCalledWith('project-1', 'analyst');
    expect(runRepo.save).toHaveBeenCalled();
    const savedRun = runRepo.save.mock.calls[0][0];
    expect(savedRun.sessionId).toBe('session-1');
  });

  it('passes cliSessionId to chatEngine', async () => {
    await processRun.execute();

    expect(chatEngine.runPrompt).toHaveBeenCalledWith('analyst', 'Analyze this task', expect.objectContaining({
      sessionId: 'cli-session-old',
    }));
  });

  it('passes null sessionId to chatEngine when cliSessionId is null', async () => {
    sessionRepo.findOrCreate.mockResolvedValue({
      id: 'session-1',
      cliSessionId: null,
      roleName: 'analyst',
    });

    await processRun.execute();

    expect(chatEngine.runPrompt).toHaveBeenCalledWith('analyst', 'Analyze this task', expect.objectContaining({
      sessionId: null,
    }));
  });

  it('updates cliSessionId when chatEngine returns new one', async () => {
    chatEngine.runPrompt.mockResolvedValue({ response: 'result', sessionId: 'cli-session-new' });
    const session = {
      id: 'session-1',
      cliSessionId: 'cli-session-old',
      roleName: 'analyst',
    };
    sessionRepo.findOrCreate.mockResolvedValue(session);

    await processRun.execute();

    expect(session.cliSessionId).toBe('cli-session-new');
    expect(sessionRepo.save).toHaveBeenCalledWith(session);
  });

  it('does not send callback when callbackUrl is null', async () => {
    runRepo.takeNext.mockResolvedValue(makeRun({ callbackUrl: null }));

    await processRun.execute();

    expect(callbackSender.send).not.toHaveBeenCalled();
  });

  it('handles timeout error from string match', async () => {
    chatEngine.runPrompt.mockRejectedValue(new Error('Request timeout after 300000ms'));

    await processRun.execute();

    expect(runService.timeout).toHaveBeenCalledWith('run-1');
  });

  it('calls gitOps.ensureBranch when task has branchName', async () => {
    const gitOps = { ensureBranch: vi.fn().mockResolvedValue(undefined) };
    taskRepo.findById.mockResolvedValue({ id: 'task-1', projectId: 'proj-1', branchName: 'NF-1/feature' });

    const pr = new ProcessRun({
      runRepo, runService, taskRepo, chatEngine, sessionRepo, roleRegistry, callbackSender,
      gitOps, workDir: '/tmp/workspace',
    });

    await pr.execute();

    expect(gitOps.ensureBranch).toHaveBeenCalledWith('NF-1/feature', '/tmp/workspace');
  });

  it('skips gitOps when task has no branchName', async () => {
    const gitOps = { ensureBranch: vi.fn() };
    taskRepo.findById.mockResolvedValue({ id: 'task-1', projectId: 'proj-1', branchName: null });

    const pr = new ProcessRun({
      runRepo, runService, taskRepo, chatEngine, sessionRepo, roleRegistry, callbackSender,
      gitOps, workDir: '/tmp/workspace',
    });

    await pr.execute();

    expect(gitOps.ensureBranch).not.toHaveBeenCalled();
  });

  it('continues processing even if gitOps.ensureBranch fails', async () => {
    const gitOps = { ensureBranch: vi.fn().mockRejectedValue(new Error('git error')) };
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    taskRepo.findById.mockResolvedValue({ id: 'task-1', projectId: 'proj-1', branchName: 'NF-1/feature' });

    const pr = new ProcessRun({
      runRepo, runService, taskRepo, chatEngine, sessionRepo, roleRegistry, callbackSender,
      gitOps, workDir: '/tmp/workspace', logger,
    });

    const result = await pr.execute();

    expect(logger.warn).toHaveBeenCalled();
    expect(runService.complete).toHaveBeenCalled();
    expect(result.result).not.toBeNull();
  });
});
