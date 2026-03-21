import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ManagerDecision, parseManagerDecision, buildManagerPrompt } from './ManagerDecision.js';
import { RunNotFoundError } from '../domain/errors/RunNotFoundError.js';
import { TaskNotFoundError } from '../domain/errors/TaskNotFoundError.js';
import { InvalidStateError } from '../domain/errors/InvalidStateError.js';
import { RoleNotFoundError } from '../domain/errors/RoleNotFoundError.js';
import { RevisionLimitError } from '../domain/errors/RevisionLimitError.js';

describe('ManagerDecision', () => {
  let managerDecision;
  let runService;
  let taskService;
  let chatEngine;
  let roleRegistry;
  let callbackSender;
  let runRepo;

  const makeRun = (overrides = {}) => ({
    id: 'run-1',
    taskId: 'task-1',
    roleName: 'analyst',
    status: 'done',
    response: 'Analysis complete',
    error: null,
    createdAt: new Date('2026-01-01'),
    ...overrides,
  });

  const makeTask = (overrides = {}) => ({
    id: 'task-1',
    title: 'Build feature X',
    description: 'Build a REST API',
    status: 'in_progress',
    revisionCount: 0,
    callbackUrl: 'https://example.com/cb',
    callbackMeta: { chatId: 1 },
    ...overrides,
  });

  beforeEach(() => {
    runService = {
      enqueue: vi.fn().mockResolvedValue({ id: 'run-new', status: 'queued' }),
    };
    taskService = {
      getTask: vi.fn().mockResolvedValue(makeTask()),
      requestReply: vi.fn().mockResolvedValue(undefined),
      completeTask: vi.fn().mockResolvedValue(undefined),
      failTask: vi.fn().mockResolvedValue(undefined),
      incrementRevision: vi.fn().mockResolvedValue(undefined),
    };
    chatEngine = {
      runPrompt: vi.fn().mockResolvedValue({
        response: JSON.stringify({ action: 'spawn_run', role: 'developer', prompt: 'Implement the feature' }),
        sessionId: 'mgr-session',
      }),
    };
    roleRegistry = {
      get: vi.fn().mockReturnValue({ name: 'manager', timeoutMs: 600000 }),
    };
    callbackSender = {
      send: vi.fn().mockResolvedValue({ ok: true }),
    };
    runRepo = {
      findById: vi.fn().mockResolvedValue(makeRun()),
      findByTaskId: vi.fn().mockResolvedValue([makeRun()]),
    };

    managerDecision = new ManagerDecision({ runService, taskService, chatEngine, roleRegistry, callbackSender, runRepo });
  });

  it('spawn_run: enqueues new developer run', async () => {
    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('spawn_run');
    expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      roleName: 'developer',
      prompt: 'Implement the feature',
    }));
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'progress', stage: 'developer' }),
      { chatId: 1 },
    );
  });

  it('ask_owner: transitions task to waiting_reply and sends question callback', async () => {
    chatEngine.runPrompt.mockResolvedValue({
      response: JSON.stringify({ action: 'ask_owner', question: 'Which DB to use?', context: 'Need decision' }),
    });

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('ask_owner');
    expect(taskService.requestReply).toHaveBeenCalledWith('task-1');
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'question', question: 'Which DB to use?' }),
      { chatId: 1 },
    );
  });

  it('complete_task: completes task and sends done callback', async () => {
    chatEngine.runPrompt.mockResolvedValue({
      response: JSON.stringify({ action: 'complete_task', summary: 'All done!' }),
    });

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('complete_task');
    expect(taskService.completeTask).toHaveBeenCalledWith('task-1');
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'done', summary: 'All done!' }),
      { chatId: 1 },
    );
  });

  it('fail_task: fails task and sends failure callback', async () => {
    chatEngine.runPrompt.mockResolvedValue({
      response: JSON.stringify({ action: 'fail_task', reason: 'Impossible requirement' }),
    });

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('fail_task');
    expect(taskService.failTask).toHaveBeenCalledWith('task-1');
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'failed', error: 'Impossible requirement' }),
      { chatId: 1 },
    );
  });

  it('waits when parallel runs are still pending', async () => {
    runRepo.findByTaskId.mockResolvedValue([
      makeRun({ id: 'run-1', status: 'done' }),
      makeRun({ id: 'run-2', status: 'running' }),
    ]);

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result).toEqual({ action: 'waiting', details: { pendingCount: 1 } });
    expect(chatEngine.runPrompt).not.toHaveBeenCalled();
  });

  it('fails task when manager returns unparseable response', async () => {
    chatEngine.runPrompt.mockResolvedValue({ response: 'I am not sure what to do next' });

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('fail_task');
    expect(taskService.failTask).toHaveBeenCalledWith('task-1');
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'failed', error: 'Manager returned unparseable response' }),
      { chatId: 1 },
    );
  });

  it('fails task when manager returns no JSON at all', async () => {
    chatEngine.runPrompt.mockResolvedValue({ response: 'No JSON here' });

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('fail_task');
    expect(taskService.failTask).toHaveBeenCalled();
  });

  it('fails task on revision limit exceeded', async () => {
    // Already has a completed developer run
    runRepo.findByTaskId.mockResolvedValue([
      makeRun({ id: 'run-1', roleName: 'developer', status: 'done' }),
    ]);
    chatEngine.runPrompt.mockResolvedValue({
      response: JSON.stringify({ action: 'spawn_run', role: 'developer', prompt: 'Fix the code' }),
    });
    taskService.incrementRevision.mockRejectedValue(new RevisionLimitError('task-1', 5));

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('fail_task');
    expect(result.details.reason).toContain('Revision limit');
  });

  it('skips when task is already cancelled', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ status: 'cancelled' }));

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('skipped');
    expect(chatEngine.runPrompt).not.toHaveBeenCalled();
  });

  it('skips when task is already done', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ status: 'done' }));

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('skipped');
    expect(chatEngine.runPrompt).not.toHaveBeenCalled();
  });

  it('skips when task is already failed', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ status: 'failed' }));

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('skipped');
    expect(chatEngine.runPrompt).not.toHaveBeenCalled();
  });

  it('fails task when spawn_run specifies unknown role', async () => {
    chatEngine.runPrompt.mockResolvedValue({
      response: JSON.stringify({ action: 'spawn_run', role: 'nonexistent', prompt: 'Do something' }),
    });
    roleRegistry.get.mockImplementation((name) => {
      if (name === 'manager') return { name: 'manager', timeoutMs: 600000 };
      throw new RoleNotFoundError(name);
    });

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('fail_task');
    expect(taskService.failTask).toHaveBeenCalledWith('task-1');
  });

  it('throws RunNotFoundError when run does not exist', async () => {
    runRepo.findById.mockResolvedValue(null);

    await expect(managerDecision.execute({ completedRunId: 'nonexistent' })).rejects.toThrow(RunNotFoundError);
  });

  it('throws InvalidStateError when run is not in terminal state', async () => {
    runRepo.findById.mockResolvedValue(makeRun({ status: 'running' }));

    await expect(managerDecision.execute({ completedRunId: 'run-1' })).rejects.toThrow(InvalidStateError);
  });

  it('fails task when chatEngine throws during manager execution', async () => {
    chatEngine.runPrompt.mockRejectedValue(new Error('Manager agent crashed'));

    const result = await managerDecision.execute({ completedRunId: 'run-1' });

    expect(result.action).toBe('fail_task');
    expect(taskService.failTask).toHaveBeenCalledWith('task-1');
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'failed', error: expect.stringContaining('Manager agent failed') }),
      { chatId: 1 },
    );
  });

  it('does not send callback when callbackUrl is null', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ callbackUrl: null }));

    await managerDecision.execute({ completedRunId: 'run-1' });

    expect(callbackSender.send).not.toHaveBeenCalled();
  });
});

describe('parseManagerDecision', () => {
  it('parses valid JSON', () => {
    const result = parseManagerDecision('{"action":"spawn_run","role":"developer","prompt":"code it"}');
    expect(result).toEqual({ action: 'spawn_run', role: 'developer', prompt: 'code it' });
  });

  it('parses JSON wrapped in markdown code block', () => {
    const response = '```json\n{"action":"complete_task","summary":"Done"}\n```';
    const result = parseManagerDecision(response);
    expect(result).toEqual({ action: 'complete_task', summary: 'Done' });
  });

  it('returns null for non-JSON response', () => {
    expect(parseManagerDecision('I think we should continue')).toBeNull();
  });

  it('returns null for invalid action', () => {
    expect(parseManagerDecision('{"action":"invalid_action"}')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseManagerDecision('{action: spawn_run}')).toBeNull();
  });
});

describe('buildManagerPrompt', () => {
  it('includes task info and run history', () => {
    const task = {
      title: 'Build API',
      description: 'REST endpoints',
      status: 'in_progress',
      revisionCount: 1,
    };
    const runs = [
      { roleName: 'analyst', status: 'done', response: 'Analysis done', error: null, createdAt: new Date('2026-01-01') },
      { roleName: 'developer', status: 'failed', response: null, error: 'Compile error', createdAt: new Date('2026-01-02') },
    ];

    const prompt = buildManagerPrompt(task, runs);

    expect(prompt).toContain('Build API');
    expect(prompt).toContain('REST endpoints');
    expect(prompt).toContain('[analyst] status=done');
    expect(prompt).toContain('Analysis done');
    expect(prompt).toContain('[developer] status=failed');
    expect(prompt).toContain('Compile error');
    expect(prompt).toContain('Количество ревизий: 1');
  });
});
