import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CancelTask } from './CancelTask.js';
import { TaskNotFoundError } from '../domain/errors/TaskNotFoundError.js';
import { InvalidTransitionError } from '../domain/errors/InvalidTransitionError.js';

describe('CancelTask', () => {
  let cancelTask;
  let taskService;
  let runRepo;
  let runService;
  let projectRepo;
  let callbackSender;
  let runAbortRegistry;

  const makeTask = (overrides = {}) => ({
    id: 'task-1',
    projectId: 'proj-1',
    seqNumber: 1,
    status: 'in_progress',
    callbackUrl: 'https://example.com/cb',
    callbackMeta: { chatId: 1 },
    ...overrides,
  });

  const makeRun = (overrides = {}) => ({
    id: 'run-1',
    taskId: 'task-1',
    status: 'queued',
    transitionTo: vi.fn(),
    ...overrides,
  });

  beforeEach(() => {
    taskService = {
      getTask: vi.fn().mockResolvedValue(makeTask()),
      cancelTask: vi.fn().mockResolvedValue(makeTask({ status: 'cancelled' })),
    };
    runRepo = {
      findByTaskId: vi.fn().mockResolvedValue([]),
      save: vi.fn().mockResolvedValue(undefined),
    };
    runService = {
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    projectRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'proj-1', prefix: 'NF' }),
    };
    callbackSender = {
      send: vi.fn().mockResolvedValue({ ok: true }),
    };
    runAbortRegistry = {
      abort: vi.fn().mockReturnValue(true),
    };

    cancelTask = new CancelTask({
      taskService, runRepo, runService, projectRepo, callbackSender, runAbortRegistry,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
  });

  it('cancels task with queued runs', async () => {
    const queuedRun1 = makeRun({ id: 'run-1' });
    const queuedRun2 = makeRun({ id: 'run-2' });
    runRepo.findByTaskId.mockResolvedValue([queuedRun1, queuedRun2]);

    const result = await cancelTask.execute({ taskId: 'task-1' });

    expect(result).toEqual({ taskId: 'task-1', shortId: 'NF-1', status: 'cancelled', cancelledRuns: 2 });
    expect(queuedRun1.transitionTo).toHaveBeenCalledWith('cancelled');
    expect(queuedRun2.transitionTo).toHaveBeenCalledWith('cancelled');
    expect(runRepo.save).toHaveBeenCalledTimes(2);
    expect(taskService.cancelTask).toHaveBeenCalledWith('task-1');
  });

  it('cancels task without runs', async () => {
    runRepo.findByTaskId.mockResolvedValue([]);

    const result = await cancelTask.execute({ taskId: 'task-1' });

    expect(result).toEqual({ taskId: 'task-1', shortId: 'NF-1', status: 'cancelled', cancelledRuns: 0 });
    expect(taskService.cancelTask).toHaveBeenCalledWith('task-1');
  });

  it('throws TaskNotFoundError when task does not exist', async () => {
    taskService.getTask.mockRejectedValue(new TaskNotFoundError('task-1'));

    await expect(cancelTask.execute({ taskId: 'task-1' })).rejects.toThrow(TaskNotFoundError);
  });

  it('throws InvalidTransitionError when task is already done', async () => {
    taskService.cancelTask.mockRejectedValue(new InvalidTransitionError('done', 'cancelled', 'Task'));

    await expect(cancelTask.execute({ taskId: 'task-1' })).rejects.toThrow(InvalidTransitionError);
  });

  it('throws InvalidTransitionError when task is already cancelled', async () => {
    taskService.cancelTask.mockRejectedValue(new InvalidTransitionError('cancelled', 'cancelled', 'Task'));

    await expect(cancelTask.execute({ taskId: 'task-1' })).rejects.toThrow(InvalidTransitionError);
  });

  it('aborts and cancels running runs', async () => {
    const runningRun = makeRun({ id: 'run-3', status: 'running' });
    const queuedRun = makeRun({ id: 'run-4', status: 'queued' });
    runRepo.findByTaskId.mockResolvedValue([runningRun, queuedRun]);

    const result = await cancelTask.execute({ taskId: 'task-1' });

    expect(result.cancelledRuns).toBe(2);
    expect(runAbortRegistry.abort).toHaveBeenCalledWith('run-3');
    expect(runService.cancel).toHaveBeenCalledWith('run-3');
    expect(queuedRun.transitionTo).toHaveBeenCalledWith('cancelled');
  });

  it('handles running run that already completed (race condition)', async () => {
    const runningRun = makeRun({ id: 'run-3', status: 'running' });
    runRepo.findByTaskId.mockResolvedValue([runningRun]);
    runService.cancel.mockRejectedValue(new InvalidTransitionError('done', 'cancelled', 'Run'));

    const result = await cancelTask.execute({ taskId: 'task-1' });

    // Should not throw — gracefully handles race
    expect(result.cancelledRuns).toBe(1);
    expect(runAbortRegistry.abort).toHaveBeenCalledWith('run-3');
  });

  it('works without runAbortRegistry (null)', async () => {
    cancelTask = new CancelTask({
      taskService, runRepo, runService, projectRepo, callbackSender,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    const runningRun = makeRun({ id: 'run-3', status: 'running' });
    runRepo.findByTaskId.mockResolvedValue([runningRun]);

    const result = await cancelTask.execute({ taskId: 'task-1' });

    expect(result.cancelledRuns).toBe(1);
    expect(runService.cancel).toHaveBeenCalledWith('run-3');
  });

  it('sends callback on cancellation', async () => {
    await cancelTask.execute({ taskId: 'task-1' });

    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'failed', taskId: 'task-1', shortId: 'NF-1', error: 'Task cancelled by user' }),
      { chatId: 1 },
    );
  });

  it('does not send callback when callbackUrl is null', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ callbackUrl: null }));

    await cancelTask.execute({ taskId: 'task-1' });

    expect(callbackSender.send).not.toHaveBeenCalled();
  });

  it('calls startNextPendingTask after cancellation', async () => {
    const startNextPendingTask = { execute: vi.fn().mockResolvedValue({ started: false }) };
    cancelTask = new CancelTask({
      taskService, runRepo, runService, projectRepo, callbackSender, startNextPendingTask, runAbortRegistry,
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    await cancelTask.execute({ taskId: 'task-1' });

    expect(startNextPendingTask.execute).toHaveBeenCalledWith({ projectId: 'proj-1' });
  });
});
