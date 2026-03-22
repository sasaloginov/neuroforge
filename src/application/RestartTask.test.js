import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RestartTask } from './RestartTask.js';
import { TaskNotFoundError } from '../domain/errors/TaskNotFoundError.js';
import { InvalidStateError } from '../domain/errors/InvalidStateError.js';

describe('RestartTask', () => {
  let restartTask;
  let taskService;
  let runRepo;
  let projectRepo;
  let managerDecision;
  let callbackSender;

  const makeTask = (overrides = {}) => ({
    id: 'task-1',
    projectId: 'proj-1',
    seqNumber: 3,
    title: 'Build feature X',
    description: 'Details',
    status: 'failed',
    callbackUrl: 'https://example.com/cb',
    callbackMeta: { chatId: 1 },
    ...overrides,
  });

  const makeRun = (overrides = {}) => ({
    id: 'run-1',
    taskId: 'task-1',
    roleName: 'developer',
    status: 'failed',
    response: 'Failed to compile',
    createdAt: new Date('2026-01-01T10:00:00'),
    ...overrides,
  });

  beforeEach(() => {
    taskService = {
      getTask: vi.fn().mockResolvedValue(makeTask()),
      restartTask: vi.fn().mockResolvedValue(makeTask({ status: 'in_progress' })),
    };
    runRepo = {
      findByTaskId: vi.fn().mockResolvedValue([makeRun()]),
    };
    projectRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'proj-1', prefix: 'NF' }),
    };
    managerDecision = {
      execute: vi.fn().mockResolvedValue({ action: 'spawn_run', role: 'developer', prompt: 'Fix the code' }),
    };
    callbackSender = {
      send: vi.fn().mockResolvedValue({ ok: true }),
    };

    restartTask = new RestartTask({ taskService, runRepo, projectRepo, managerDecision, callbackSender });
  });

  it('returns shortId in response', async () => {
    const result = await restartTask.execute({ taskId: 'task-1' });

    expect(result.taskId).toBe('task-1');
    expect(result.shortId).toBe('NF-3');
    expect(result.status).toBe('in_progress');
  });

  it('sends callback with shortId', async () => {
    await restartTask.execute({ taskId: 'task-1' });

    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'progress', taskId: 'task-1', shortId: 'NF-3', stage: 'restarted' }),
      { chatId: 1 },
    );
  });

  it('throws InvalidStateError when task is not in failed status', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ status: 'in_progress' }));

    await expect(restartTask.execute({ taskId: 'task-1' })).rejects.toThrow(InvalidStateError);
    expect(taskService.restartTask).not.toHaveBeenCalled();
  });

  it('throws TaskNotFoundError when task does not exist', async () => {
    taskService.getTask.mockRejectedValue(new TaskNotFoundError('task-1'));

    await expect(restartTask.execute({ taskId: 'task-1' })).rejects.toThrow(TaskNotFoundError);
  });

  it('does not send callback when callbackUrl is null', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ callbackUrl: null }));

    await restartTask.execute({ taskId: 'task-1' });

    expect(callbackSender.send).not.toHaveBeenCalled();
  });

  it('returns undefined shortId when seqNumber is null', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ seqNumber: null }));

    const result = await restartTask.execute({ taskId: 'task-1' });

    expect(result.shortId).toBeUndefined();
  });

  it('delegates to managerDecision when terminal runs exist', async () => {
    runRepo.findByTaskId.mockResolvedValue([makeRun({ status: 'done' })]);

    await restartTask.execute({ taskId: 'task-1' });

    expect(managerDecision.execute).toHaveBeenCalledWith({ completedRunId: 'run-1' });
  });

  it('returns decision from managerDecision in result', async () => {
    const decision = { action: 'spawn_run', role: 'tester', prompt: 'Run tests' };
    managerDecision.execute.mockResolvedValue(decision);

    const result = await restartTask.execute({ taskId: 'task-1' });

    expect(result.decision).toEqual(decision);
  });
});
